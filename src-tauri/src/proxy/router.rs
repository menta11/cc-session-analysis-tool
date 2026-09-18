//! The localhost HTTP surface: observability endpoints + byte-exact passthrough.
//!
//! Routing mirrors `proxy.js` exactly: the *raw request target* (`path?query`) is
//! compared against the literal endpoint strings, so `/status?x=1` is NOT the
//! status endpoint (it is proxied), just like `req.url === '/status'`.
//!
//! Passthrough rules (CONTRACT §3):
//! - upstream path = `API_PATH_PREFIX + raw_request_target`, prefix = the target
//!   URL's pathname with a single trailing `/` stripped;
//! - every client header is forwarded verbatim except `host`, which is replaced
//!   by the upstream hostname only (no port). `content-length` is neither
//!   injected nor removed;
//! - the request body is buffered as raw bytes (no UTF-8 round-trip);
//! - the response status and headers are forwarded. Hop-by-hop headers
//!   (`transfer-encoding`, `connection`, `keep-alive`, `upgrade`, `proxy-*`) are
//!   dropped and hyper re-frames the body — a deliberate, documented deviation;
//! - the response body is streamed incrementally via `bytes_stream()`, never
//!   buffered, and an upstream error mid-stream tears the client stream down
//!   rather than hanging;
//! - upstream connect failure -> `502` `{"error":"proxy_error","message":...}`.
//!
//! No global mutable request state exists: every value lives in `AppState`
//! (immutable, `Arc`-shared) or on the request's own stack, so 8 concurrent
//! requests cannot cross streams (C11).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::{to_bytes, Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use serde_json::{json, Map, Value};
use tiktoken_rs::CoreBPE;
use tokio::sync::oneshot;

use futures_util::{Stream, StreamExt};

use crate::proxy::agents::{self, AgentRegistry};
use crate::proxy::assets;
use crate::proxy::broadcast::{self, RequestEvent};
use crate::proxy::capture;
use crate::proxy::env::Env;
use crate::proxy::events::{EventFrame, EventInput};
use crate::proxy::session;
use crate::proxy::settings;
use crate::proxy::sse;
use crate::proxy::state;

/// Upper bound on a buffered request body. The contract exercises 256 KiB; this
/// is intentionally generous because the Node reference buffers fully too.
const MAX_BODY_BYTES: usize = 512 * 1024 * 1024;

/// SSE 流中向 `/requests/stream` 推「字节增长」帧的最小间隔（`proxy.js:505` 的
/// `REQUEST_BROADCAST_THROTTLE_MS`）。Node 在 `proxyRes.on('data')` 里按它节流广播，
/// 让长流的 `sseBytesSize`（SSE 的 `respBodySize` 按 Node 恒为 0）不必等到流结束才更新；
/// 结束帧仍由 `CaptureEndGuard` 强制广播。
const REQUEST_BROADCAST_THROTTLE_MS: i64 = 500;

/// Parsed upstream target: scheme, authority (host[:port]), Host-header value and
/// the path prefix that must be prepended to every proxied request.
#[derive(Debug, Clone)]
pub struct Upstream {
    pub scheme: String,
    pub authority: String,
    /// Node uses `parsed.hostname` — no port. IPv6 keeps its brackets.
    pub host_header: String,
    pub path_prefix: String,
    pub direct_url: String,
}

impl Upstream {
    pub fn parse(direct_url: &str) -> Result<Upstream, String> {
        let base = url::Url::parse(direct_url)
            .map_err(|e| format!("invalid upstream URL {direct_url:?}: {e}"))?;
        let scheme = base.scheme().to_string();
        let host = base.host_str().unwrap_or("").to_string();
        if host.is_empty() {
            return Err(format!("upstream URL {direct_url:?} has no host"));
        }
        // `Url::host_str()` already renders IPv6 with brackets, which is exactly
        // what Node's `new URL(...).hostname` produces. Guard against an
        // unbracketed colon-bearing host defensively.
        let host_display = if host.starts_with('[') || !host.contains(':') {
            host.clone()
        } else {
            format!("[{host}]")
        };
        let authority = match base.port() {
            Some(p) => format!("{host_display}:{p}"),
            None => host_display.clone(),
        };
        // `parsed.pathname.replace(/\/$/, '')` — strip ONE trailing slash.
        let pathname = base.path().to_string();
        let path_prefix = pathname
            .strip_suffix('/')
            .map(|s| s.to_string())
            .unwrap_or(pathname);
        Ok(Upstream {
            scheme,
            authority,
            host_header: host_display,
            path_prefix,
            direct_url: direct_url.to_string(),
        })
    }

    pub fn is_loopback(&self) -> bool {
        // Reuse the same predicate shape as isProxySelf; port is irrelevant here.
        matches!(self.host_header.as_str(), "localhost" | "127.0.0.1" | "[::1]")
            || self.host_header == "::1"
    }
}

#[derive(Clone)]
pub struct AppState {
    pub env: Arc<Env>,
    pub client: reqwest::Client,
    pub upstream: Arc<Upstream>,
    /// o200k_base BPE, built once at startup from ranks embedded at compile time.
    pub bpe: Arc<CoreBPE>,
    /// 请求捕获环（诊断层数据源）。进程内共享，`/requests/*` 与 `/events*` 都读它。
    pub capture: Arc<crate::proxy::capture::CaptureRing>,
    /// `/requests/stream` 的广播器：捕获生命周期节点（响应头到达、流结束、清空）向所有
    /// 订阅者多播一帧。
    pub requests: broadcast::RequestBroadcaster,
    /// 异常事件环（`/events`、`/events/stream`、`/events/clear` 的数据源）。
    /// **独立于捕获环** —— 见 `events.rs` 模块头。
    pub events_log: Arc<crate::proxy::events::EventLog>,
    /// `/events/stream` 的广播器（与 `requests` 是两个独立频道，不能混用）。
    pub events: crate::proxy::events::EventsBroadcaster,
    /// `/event/detail/stream` 的广播器：按 **cid** 推送逐字 delta（`{kind,text,ts}`）与
    /// `{done:true}`。帧里带 cid，订阅流按 cid 过滤（Node 的 `detailClients: Map<cid,Set>`）。
    pub detail: crate::proxy::detail::DetailBroadcaster,
    /// agent 表：身份解析、每流 `lastDeltaType`（`phase`）、活跃流句柄、实时 prompt。
    /// 见 `agents.rs` 模块头。
    pub agents: Arc<AgentRegistry>,
    /// `IDLE_CLEANUP_MS_MAIN`（Node 的模块级可变变量）。`/config/idle` 读写它；
    /// 目前**没有**消费者（idle cleanup 循环未迁移，见 `agents.rs` 模块头）。
    pub idle_cleanup_ms_main: Arc<std::sync::Mutex<f64>>,
    /// 请求日志落盘（Node `proxy.js` 的 `logLine`）。每个 LLM 请求写一行
    /// `[<ISO8601>] get到一条请求` —— 见 `log.rs` 模块头。
    pub log: Arc<crate::proxy::log::ProxyLog>,
}

pub fn router(state: AppState) -> Router {
    Router::new().fallback(any(handle)).with_state(state)
}

fn json_response(status: StatusCode, value: &Value) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(value.to_string()))
        .expect("json response")
}

async fn handle(State(state): State<AppState>, req: axum::extract::Request) -> Response {
    let (parts, body) = req.into_parts();
    let method = parts.method.clone();
    let uri = parts.uri.clone();
    let headers = parts.headers.clone();
    // Raw request target including the query, exactly like Node's `req.url`.
    let target = uri
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| uri.path().to_string());

    // Node `proxy.js:1385`：`createServer` 回调的**第一行**就是
    // `if (isLLMRequest(req)) logLine('get到一条请求')` —— 位置与 Node 一致：
    // 在路由判断之前、在读取 body 之前（所以 body 读失败也照样已记一行）。
    // 判据复用 `agents::is_llm_request`，与 `getAgentId` 用同一个函数，避免两份漂移。
    if agents::is_llm_request(method.as_str(), &target) {
        state.log.llm_request();
    }

    let body_bytes = match to_bytes(body, MAX_BODY_BYTES).await {
        Ok(b) => b,
        Err(e) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": format!("request body read failed: {e}") }),
            )
        }
    };

    // Status endpoint —— Node `proxy.js:1387` 与 `/status` 精确比较**没有方法守卫**
    // （POST 也走这一支），且是**纯内存、零 I/O**：`buildStatus()` 的完整形状
    // （`ts` / `agents` / `idleCleanupMsMain`）。dashboard 每 200ms 轮询它读
    // `data.agents[]` 的 state/tps/streamTokens/sessionId…，见 `agents::status_payload`。
    if target == "/status" {
        let now = capture::now_ms();
        let idle = current_idle_cleanup_ms_main(&state);
        return json_response(StatusCode::OK, &state.agents.status_payload(now, idle));
    }
    if method == Method::GET && target == "/config/baseurl" {
        return json_response(StatusCode::OK, &settings::get_base_url_status(&state.env));
    }
    if method == Method::POST && target == "/config/baseurl" {
        return handle_config_baseurl(&state, &body_bytes);
    }
    if method == Method::POST && target == "/tokencount" {
        return handle_tokencount(&state, &body_bytes);
    }

    // ── `IDLE_CLEANUP_MS_MAIN` 配置（Node `/config/idle`，GET 读 / POST 写）──
    // POST 会落盘到 `~/.claude/cc-monitor-state.json`。**注意**：该值目前没有消费者
    // （idle cleanup 循环与 `/cleanup/debug` 未迁移 —— 见 agents.rs 模块头），
    // 这里只保证读写与回显的形状、校验、上限与 Node 一致。
    if method == Method::GET && target == "/config/idle" {
        let main = current_idle_cleanup_ms_main(&state);
        return json_response(StatusCode::OK, &json!({ "main": state::js_number_value(main) }));
    }
    if method == Method::POST && target == "/config/idle" {
        return handle_config_idle_post(&state, &body_bytes);
    }

    // ── 诊断层：捕获环（dashboard 的"请求"列表）──
    // 环里只会有 passthrough 注册的条目。空环时返回 `{"requests":[]}` 是**正确**语义，
    // dashboard 会渲染空列表而不是报错。
    if method == Method::GET && target == "/requests/recent" {
        let now = crate::proxy::capture::now_ms();
        let mut payload = state.capture.recent(now);
        // phase 由 agent 表**读时**补（见 capture.rs 模块头与 `apply_phase`）。
        if let Some(arr) = payload.get_mut("requests").and_then(|v| v.as_array_mut()) {
            for s in arr.iter_mut() {
                apply_phase(&state.agents, s);
            }
        }
        return json_response(StatusCode::OK, &payload);
    }
    // `/requests/stream`：SSE 推送捕获环的 summary（dashboard 流请求 tab）。
    //
    // 顺序讲究（见 broadcast::sse_body_stream）：**先**取积压快照（`ts` 升序、末尾
    // SSE_EVENT_BACKLOG 条），**再**订阅实时广播 —— 这样回放一定排在实时帧之前，
    // 且实时帧不会在回放中途插队。快照与订阅都在这里同步完成，随后交给流的
    // 「回放 → 实时 → 心跳」状态机。
    if method == Method::GET && target == "/requests/stream" {
        return handle_requests_stream(&state);
    }
    if method == Method::POST && target == "/requests/clear" {
        let cleared = state.capture.clear();
        // 清空后必须通知订阅者清本地视图，否则 dashboard 会留着已失效的行（Node 的
        // `_broadcastRequestClear`）。控制帧带 `event: clear` 事件名。
        state.requests.send(RequestEvent::Clear);
        return json_response(StatusCode::OK, &json!({ "ok": true, "cleared": cleared }));
    }

    // ── 诊断层：异常事件流（dashboard 顶部事件流带）──
    // 数据源是**另一个**定容环（events，容量 200、FIFO 淘汰、60s 同 type+agent 去重），
    // 与捕获环无关 —— 依据是 `proxy.js:1401` 回放的是 `events.slice(-50)`。
    //
    // 注意方法判定：Node 对 `/events` 与 `/events/stream` **没有方法判断**
    // （`if (req.url === '/events/stream')`），所以 POST 也走 SSE；只有 `/events/clear`
    // 限 `POST`（`req.url === '/events/clear' && req.method === 'POST'`）。这里逐字跟随，
    // 不"顺手"加 GET 守卫。
    if target == "/events/stream" {
        return handle_events_stream(&state);
    }
    if target == "/events" {
        return json_response(StatusCode::OK, &state.events_log.list());
    }
    if method == Method::POST && target == "/events/clear" {
        state.events_log.clear();
        // 与 `/requests/clear` 同款：清空后广播 `event: clear` 让订阅者清本地视图。
        state.events.send(EventFrame::Clear);
        // Node 的响应体是字面量 `{ ok: true, cleared: 0 }`（即使清掉了很多条也是 0 ——
        // `/requests/clear` 才回报真实条数，两个端点刻意不同，别"修正"成 events.length）。
        return json_response(StatusCode::OK, &json!({ "ok": true, "cleared": 0 }));
    }

    // ── agent 层（下一步 3）：kill / prompts / session ──
    //
    // 顺序与路径判定逐字跟随 Node：`/agent/kill` 是**精确路径 + POST**，
    // `/agent/prompts` 与 `/session` 都是 **`startsWith`（无方法守卫）**。
    // 注意 Node 里 `/agent/prompts`（`proxy.js:1572`）与 `/session`（`1592`）都在
    // `/agent/kill`（`1550`）之后，且互不前缀重叠，所以这里同序即可。
    if method == Method::POST && target == "/agent/kill" {
        return handle_agent_kill(&state, &body_bytes);
    }
    // 实时请求 prompt：返回该 agent 拦截到的所有请求体（内存，跟 agent 生灭）
    if target.starts_with("/agent/prompts") {
        let aid = query_param(&target, "id").filter(|s| !s.is_empty());
        let Some(aid) = aid else {
            return json_response(StatusCode::BAD_REQUEST, &json!({ "error": "missing id" }));
        };
        return match state.agents.prompts_payload(&aid) {
            Some(payload) => json_response(StatusCode::OK, &payload),
            None => json_response(
                StatusCode::NOT_FOUND,
                &json!({ "error": "agent 不存在或已被清理" }),
            ),
        };
    }
    // Session 时间线：读 cc session 文件，返回对话流（用户输入/思考/回复）
    if target.starts_with("/session") {
        let sid = query_param(&target, "id").filter(|s| session::is_valid_session_id(s));
        let Some(sid) = sid else {
            return json_response(StatusCode::BAD_REQUEST, &json!({ "error": "invalid sessionId" }));
        };
        return match session::load_session_timeline(&state.env.home, &sid) {
            Some(payload) => json_response(StatusCode::OK, &payload),
            None => json_response(StatusCode::NOT_FOUND, &json!({ "error": "session 文件未找到" })),
        };
    }

    // ── 异常事件 HTTP 详情（dashboard 点 ev-row / req-row 打开详情抽屉）──
    //
    // Node 顺序（`proxy.js:1614` / `1671`）里 `/event/detail` 在前、`/event/detail/stream`
    // 在后，靠前者的 `!startsWith('/event/detail/stream')` 排除条件给后者让路。这里直接
    // 把 stream 分支放前面判断 —— 语义等价且不依赖排除条件。
    // 两条都**没有方法守卫**（Node 是 `startsWith`），逐字跟随。
    if target.starts_with("/event/detail/stream") {
        return handle_event_detail_stream(&state, &target);
    }
    if target.starts_with("/event/detail") {
        return handle_event_detail(&state, &target);
    }
    // `/cleanup/debug`（Node `proxy.js:1529`）：立刻跑一轮 idle cleanup，
    // 把 candidates/saved 全打回来。方法守卫是 **GET**（Node 是
    // `req.url === '/cleanup/debug' && req.method === 'GET'`）。
    if method == Method::GET && target == "/cleanup/debug" {
        return handle_cleanup_debug(&state);
    }
    // ── 内嵌页面（dashboard / mini）──
    //
    // 位置**必须**在 passthrough 之前：否则 `GET /` 会被当成 API 请求转发到上游。
    // 这不是假设 —— 提升前的 spike 没有这段，实测 iframe 里拿到的是上游的报错页
    // （内容长度 390 的空白/报错文档），而不是 dashboard。
    // 注意：**不按方法过滤** —— 与 Node 对齐。Node 的页面路由（`/`、`/index.html`、`/mini.html`）
    // 与 `STREAM_REQUEST_BLOCKLIST`（两个 dev 端点）都**没有**方法守卫，任何方法都走同一分支。
    // 之前这里套了 `if method == Method::GET`，于是 `POST /` 之类会落到 passthrough 被转发到上游
    // （与刚修掉的 dev 端点名 bug 是同一类危害：多余的上游请求）。
    {
        if let Some(html) = assets::page_for(&target) {
            return Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, assets::CONTENT_TYPE_HTML)
                .body(Body::from(html))
                .expect("html response");
        }
        // dev 热加载端点：明确 404，**绝不**转发给上游（内嵌模式没有 mtime 可言）
        if assets::is_dev_mtime_endpoint(&target) {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::empty())
                .expect("404 response");
        }
    }

    proxy(&state, method, uri, headers, body_bytes).await
}

/// `/requests/stream` 的 SSE 响应。
///
/// 响应头与 `proxy.js` 逐字对齐：`Content-Type: text/event-stream`、
/// `Cache-Control: no-cache, no-transform`、`Connection: keep-alive`、`X-Accel-Buffering: no`
/// （最后一条是给反向代理的：别缓冲 SSE）。
///
/// 快照先于订阅：积压取的是**当前**环内容，之后 `subscribe()` 收到的实时帧由流排在其后，
/// 保证"回放旧→新，实时继续往后 append"的观感与 Node 一致。
fn handle_requests_stream(state: &AppState) -> Response {
    let backlog: Vec<Value> = state
        .capture
        .summaries_sorted(broadcast::SSE_EVENT_BACKLOG, capture::now_ms())
        .into_iter()
        .map(|s| with_phase(&state.agents, s))
        .collect();
    let rx = state.requests.subscribe();
    sse_response(Body::from_stream(broadcast::sse_body_stream(
        backlog,
        rx,
        Duration::from_millis(broadcast::SSE_HEARTBEAT_MS),
    )))
}

/// `/events/stream` 的 SSE 响应。与 `/requests/stream` 同款响应头与「回放→实时→心跳」
/// 状态机，差别只有两处：积压来自**事件环**（`events.slice(-50)`，插入序末尾 50 条），
/// 广播频道是独立的事件频道（`/requests/clear` 不会通知事件订阅者，反之亦然）。
fn handle_events_stream(state: &AppState) -> Response {
    let backlog = state.events_log.backlog(broadcast::SSE_EVENT_BACKLOG);
    let rx = state.events.subscribe();
    sse_response(Body::from_stream(broadcast::sse_body_stream(
        backlog,
        rx,
        Duration::from_millis(broadcast::SSE_HEARTBEAT_MS),
    )))
}

/// 两个 SSE 端点共用的响应构造（四条响应头逐字对齐 `proxy.js`）。
fn sse_response(body: Body) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache, no-transform")
        .header(header::CONNECTION, "keep-alive")
        .header("X-Accel-Buffering", "no")
        .body(body)
        .expect("sse response")
}

/// cid 合法性：Node `/^[a-f0-9-]{8,64}$/i`（放宽到 8-64 兼容未来格式）。
fn is_valid_cid(cid: &str) -> bool {
    let len = cid.len();
    (8..=64).contains(&len)
        && cid
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// Node `req.headers` / `proxyRes.headers` 的键值对快照：键小写（hyper 已小写）、
/// 同名多值按 Node 的 `, ` 拼接（Node 对大多数重复头就是这么合并的）。
fn header_pairs(headers: &HeaderMap) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (name, value) in headers.iter() {
        let k = name.as_str().to_string();
        let v = match value.to_str() {
            Ok(s) => s.to_string(),
            Err(_) => String::from_utf8_lossy(value.as_bytes()).into_owned(),
        };
        if let Some(slot) = out.iter_mut().find(|(ek, _)| *ek == k) {
            slot.1 = format!("{}, {}", slot.1, v);
        } else {
            out.push((k, v));
        }
    }
    out
}

/// `GET /event/detail?cid=&hex=`（`proxy.js:1614`）：按 cid 查捕获环，返回
/// `{cid, agentId, method, url, ts, req, resp, sse, details}` 完整快照。
/// 形状与 `?hex=1` 的语义见 `capture::CaptureEntry::detail_payload`。
fn handle_event_detail(state: &AppState, target: &str) -> Response {
    // Node: `let cidQ = null` + try/catch → 解析失败按"缺失"处理
    let Some(cid) = query_param(target, "cid").filter(|c| is_valid_cid(c)) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "invalid or missing cid" }),
        );
    };
    let hex = query_param(target, "hex").as_deref() == Some("1");
    match state.capture.detail_of(&cid, hex) {
        Some(payload) => json_response(StatusCode::OK, &payload),
        None => json_response(
            StatusCode::NOT_FOUND,
            &json!({ "error": "capture 已淘汰或不存在" }),
        ),
    }
}

/// `GET /event/detail/stream?cid=`（`proxy.js:1671`）：SSE 逐字推送该 cid 的
/// `{kind,text,ts}` delta；新订阅者先收到历史 delta 回放（`ts` 固定 0），
/// 流已结束时再推一帧 `{done:true}` 并关闭连接，否则进入实时推送 + 15s 心跳。
fn handle_event_detail_stream(state: &AppState, target: &str) -> Response {
    let Some(cid) = query_param(target, "cid").filter(|c| is_valid_cid(c)) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "invalid or missing cid" }),
        );
    };
    // 先订阅再取快照：Node 在单事件循环里"检查 _streamEnded → 注册"之间不可能插入
    // 收尾帧；Rust 里若先取快照（ended=false）再订阅，就可能漏掉紧随其后的 done 帧
    // 而让客户端永远挂着。订阅在前时，即使流已结束，多收到的那几帧也会被 ended 分支
    // 忽略，语义不变。
    let rx = state.detail.subscribe();
    let Some((ended, sse_bytes, _blocks)) = state.capture.stream_snapshot(&cid) else {
        return json_response(
            StatusCode::NOT_FOUND,
            &json!({ "error": "capture 已淘汰或不存在" }),
        );
    };
    let replay = crate::proxy::detail::replay_deltas(&sse_bytes);
    sse_response(Body::from_stream(crate::proxy::detail::detail_body_stream(
        cid,
        replay,
        ended,
        rx,
        Duration::from_millis(broadcast::SSE_HEARTBEAT_MS),
    )))
}

/// 记录一条异常事件并推给 `/events/stream` 订阅者 —— 对齐 Node 的 `recordEvent(ev, cid)`：
/// 定容环内部完成去重合并/追加，返回最终对象，然后广播它（合并后的 count 也要推出去）。
/// 另外，**只有新事件**（未命中去重合并）才把快照写进捕获条目的 `details`
/// （`/event/detail` 的"诊断详情"tab 数据源）—— Node 的去重分支提前 return，不写详情。
///
/// `pub(crate)` 的唯一外部消费者是 `mod.rs` 的 idle cleanup timer（状态转换事件）。
pub(crate) fn record_event(state: &AppState, ev: EventInput, cid: Option<&str>) {
    events_sink_record(&state.events_log, &state.events, &state.capture, ev, cid);
}

/// `record_event` 的免 `AppState` 版本：SSE 流的 `inspect` 闭包是 `'static` 的，拿不到
/// `&AppState`，只能带一份 `Arc<EventLog>` + 广播器 + 捕获环句柄进去（见 `EventSink`）。
fn events_sink_record(
    log: &crate::proxy::events::EventLog,
    bcast: &crate::proxy::events::EventsBroadcaster,
    capture: &crate::proxy::capture::CaptureRing,
    ev: EventInput,
    cid: Option<&str>,
) {
    if let Some((json, is_new)) = log.record_detailed(ev, cid, capture::now_ms()) {
        if is_new {
            if let Some(cid) = cid {
                capture.push_detail(cid, &json);
            }
        }
        bcast.send(EventFrame::Update(json));
    }
}

/// 流式回调里的「事件写入器」（三个 Arc 句柄的轻量拷贝）。
#[derive(Clone)]
struct EventSink {
    log: Arc<crate::proxy::events::EventLog>,
    bcast: crate::proxy::events::EventsBroadcaster,
    capture: Arc<crate::proxy::capture::CaptureRing>,
}

impl EventSink {
    fn record(&self, ev: EventInput, cid: Option<&str>) {
        events_sink_record(&self.log, &self.bcast, &self.capture, ev, cid);
    }
}

/// 把 `phase` 按 agent 表**读时**补进一条 `_captureSummary`。
///
/// Node 的 `_captureSummary(e)` 自己就握着模块级 `agents`，所以能在算 summary 时现读
/// `agents.get(e.agentId)?.stream?.lastDeltaType`。Rust 的 `CaptureEntry` 不认识 agent 表，
/// 于是把这个跨模块的一步放在**同时持有两者**的 router 里。
///
/// 依赖 `summary` 里已有 `agentId` / `ended` 两个键（`capture.rs` 的键集测试钉住了）。
fn apply_phase(agents: &AgentRegistry, summary: &mut Value) {
    let agent_id = summary.get("agentId").and_then(|v| v.as_str());
    let ended = summary
        .get("ended")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let phase = agents.phase_for(agent_id, ended);
    if let Value::Object(m) = summary {
        m.insert("phase".to_string(), json!(phase));
    }
}

/// `apply_phase` 的取值版本（构造 SSE 积压列表时用）。
fn with_phase(agents: &AgentRegistry, mut summary: Value) -> Value {
    apply_phase(agents, &mut summary);
    summary
}

/// 取原始请求目标里的查询参数（Node: `new URL(req.url,'http://localhost').searchParams.get(k)`）。
/// 返回**第一个**匹配值并做百分号解码（`url::form_urlencoded` 与 URLSearchParams 同义，
/// 包括 `+` → 空格）。
fn query_param(target: &str, key: &str) -> Option<String> {
    let query = target.split_once('?')?.1;
    url::form_urlencoded::parse(query.as_bytes()).find_map(|(k, v)| {
        if k == key {
            Some(v.into_owned())
        } else {
            None
        }
    })
}

/// JS `Number(x)` 的近似（`/config/idle` 用它把 body 里的 `main` 归一化）。
/// `None` 对应 JS 的 `NaN`（即 `!Number.isFinite(main)` 那一支）。
fn js_number(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                Some(0.0) // JS: Number('') === 0
            } else {
                t.parse::<f64>().ok()
            }
        }
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0), // JS: Number(null) === 0
        // 对象/数组的 Number() 语义（`[5]`→5、`[]`→0、`{}`→NaN）与真实配置无关，
        // 一律当 NaN 拒绝（宁可 400，不猜）。
        _ => None,
    }
}

/// 读当前 `IDLE_CLEANUP_MS_MAIN`。
fn current_idle_cleanup_ms_main(state: &AppState) -> f64 {
    *state
        .idle_cleanup_ms_main
        .lock()
        .expect("idle config poisoned")
}

/// `POST /config/idle`（`proxy.js:1505`）：校验 → 夹上限 → 存内存 + 落盘 → 回显。
fn handle_config_idle_post(state: &AppState, body: &[u8]) -> Response {
    let text = if body.is_empty() {
        "{}".to_string()
    } else {
        String::from_utf8_lossy(body).into_owned()
    };
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "ok": false, "error": e.to_string() }),
            )
        }
    };
    let main = js_number(parsed.get("main"));
    // Node: `if (!Number.isFinite(main) || main < 0) throw new Error('main must be a non-negative number')`
    let Some(main) = main.filter(|m| m.is_finite() && *m >= 0.0) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "ok": false, "error": "main must be a non-negative number" }),
        );
    };
    // Node: `Math.min(main, _IDLE_CLEANUP_MS_MAX)`
    let clamped = main.min(state::IDLE_CLEANUP_MS_MAX);
    *state
        .idle_cleanup_ms_main
        .lock()
        .expect("idle config poisoned") = clamped;
    let mut patch = Map::new();
    patch.insert(
        "idleCleanupMsMain".to_string(),
        state::js_number_value(clamped),
    );
    state::save_monitor_state(&state.env, patch);
    json_response(
        StatusCode::OK,
        &json!({ "ok": true, "main": state::js_number_value(clamped) }),
    )
}

/// `GET /cleanup/debug`（`proxy.js:1529`）：立刻跑一轮 idle cleanup + 把 candidates/saved
/// 全打回来。响应体**缩进 2 空格**（Node 用 `JSON.stringify(x, null, 2)`），所以走
/// `json_response_pretty` 而不是普通 `json_response`（后者是紧凑格式）。
///
/// 与 Node 的差异（**仅此一处**，不影响载荷）：Node 还会 `_logExpired(...)` 打一份控制台
/// 明细（`[cleanup] debug scanned=… candidates=…`）。那是纯 stdout 旁路，本实现不迁 ——
/// 结构化载荷（唯一有消费者的部分）逐字对齐。**不**顺带 `recordEvent`：Node 这里发的
/// 事件为 0（`runCleanupPass` 与 `_logExpired` 都不碰事件环），凭空加一条是发明行为。
///
/// 另一处已在 `agents.rs` 记录的等价差异：`candidates[].name` 在 Node 里恒为 `undefined`
/// （`a.name` 从未赋值）→ `JSON.stringify` 省略该键；本实现同样不写该键，故载荷逐字节等价。
fn handle_cleanup_debug(state: &AppState) -> Response {
    let now = capture::now_ms();
    let idle = current_idle_cleanup_ms_main(state);
    let (_report, payload) = state.agents.cleanup_debug_payload(now, idle as i64);
    // 载荷已是对象（`agents.rs::cleanup_debug_payload` 用 Map 构造）；补一个 `ok: true` 即可。
    // 键序是字典序（serde_json 无 preserve_order），与 `/cleanup/debug` 的 Node 字面量顺序不同，
    // 但键集合与取值一致 —— 与 `events.rs` 的键序说明同一处境。
    let mut out = match payload {
        Value::Object(m) => m,
        other => {
            let mut m = Map::new();
            m.insert("payload".to_string(), other);
            m
        }
    };
    out.insert("ok".to_string(), json!(true));
    json_response_pretty(StatusCode::OK, &Value::Object(out))
}

/// 与 `json_response` 同款，只是载荷按 `JSON.stringify(x, null, 2)` 的样式缩进。
/// 目前只有 `/cleanup/debug` 用（Node 里也只有它带 `null, 2`）。
fn json_response_pretty(status: StatusCode, value: &Value) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()),
        ))
        .expect("json response")
}

/// `POST /agent/kill`（`proxy.js:1550`）：销毁该 agent 的全部活跃 SSE 流，
/// 让 cc 看到连接重置并自动重试。响应体 `{ ok: true, killed: <bool>, streams: <n> }`。
fn handle_agent_kill(state: &AppState, body: &[u8]) -> Response {
    let text = if body.is_empty() {
        "{}".to_string()
    } else {
        String::from_utf8_lossy(body).into_owned()
    };
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        // Node 的 catch 分支：`{ ok: false, error: <JSON.parse 的 message> }`（400）。
        Err(e) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "ok": false, "error": e.to_string() }),
            )
        }
    };
    // Node: `if (!agentId || typeof agentId !== 'string') throw new Error('missing agentId')`
    let agent_id = parsed.get("agentId").and_then(|v| v.as_str());
    let Some(agent_id) = agent_id.filter(|s| !s.is_empty()) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "ok": false, "error": "missing agentId" }),
        );
    };
    let killed = state.agents.kill_streams(agent_id);
    json_response(
        StatusCode::OK,
        &json!({ "ok": true, "killed": killed > 0, "streams": killed }),
    )
}

/// L2 HTTP 错误码监控（`proxy.js` 的 5xx/4xx 分流）。**2xx 不进事件流** —— 它们属于
/// 捕获环（"流请求"tab），事件流只放异常，所以这里 `status < 400` 直接返回。
///
/// 类型与严重级逐条对齐：`429` → `upstream-429`/warn、`401|403` → `upstream-401`/error、
/// `>=500` → `upstream-5xx`/error、其余 → `upstream-<code>`/error。
/// `agentId` 用 `getAgentId(req, body)` 的解析结果（未识别时是字符串 `'unknown'`，
/// 与 Node 一致 —— Node 的 `ev.agentId || null` 里 `'unknown'` 是真值，会原样入库）。
fn emit_http_status_event(
    state: &AppState,
    cid: &str,
    agent_id: &str,
    method: &str,
    url: &str,
    status: u16,
    status_message: Option<&str>,
    retry_after: Option<&str>,
) {
    if status < 400 {
        return;
    }
    let (event_type, severity) = match status {
        429 => ("upstream-429".to_string(), "warn"),
        401 | 403 => ("upstream-401".to_string(), "error"),
        s if s >= 500 => ("upstream-5xx".to_string(), "error"),
        s => (format!("upstream-{s}"), "error"),
    };
    // Node: `上游返回 ${statusCode}${statusMessage ? ' ' + statusMessage : ''}`
    let message = match status_message.filter(|m| !m.is_empty()) {
        Some(m) => format!("上游返回 {status} {m}"),
        None => format!("上游返回 {status}"),
    };
    let mut detail = serde_json::Map::new();
    detail.insert("statusCode".to_string(), json!(status));
    // Node 里 `statusMessage` 是 `proxyRes.statusMessage`：undefined 时 JSON.stringify **省略该键**，
    // 所以这里也用「有才插」，不写成 null。
    if let Some(m) = status_message {
        detail.insert("statusMessage".to_string(), json!(m));
    }
    // Node: `proxyRes.headers['retry-after'] || null` —— 恒存在，缺失时为 null。
    detail.insert(
        "retryAfter".to_string(),
        retry_after.map(|v| json!(v)).unwrap_or(Value::Null),
    );
    detail.insert("method".to_string(), json!(method));
    detail.insert("url".to_string(), json!(url));
    record_event(
        state,
        EventInput {
            severity: severity.to_string(),
            event_type,
            agent_id: Some(agent_id.to_string()),
            message,
            detail: Value::Object(detail),
        },
        Some(cid),
    );
}

fn handle_config_baseurl(state: &AppState, body: &[u8]) -> Response {
    let text = if body.is_empty() {
        "{}".to_string()
    } else {
        String::from_utf8_lossy(body).into_owned()
    };
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "ok": false, "error": e.to_string() }),
            )
        }
    };
    let action = parsed.get("action").and_then(|a| a.as_str()).unwrap_or("");
    let result = match action {
        "enable" => settings::enable_monitoring(&state.env),
        "disable" => settings::disable_monitoring(&state.env),
        _ => Err("invalid action (enable|disable)".to_string()),
    };
    match result {
        Ok(status) => {
            // Node: `{ ok: true, ...result }`
            let mut out = serde_json::Map::new();
            out.insert("ok".to_string(), Value::Bool(true));
            if let Value::Object(m) = status {
                for (k, v) in m {
                    out.insert(k, v);
                }
            }
            json_response(StatusCode::OK, &Value::Object(out))
        }
        Err(error) => json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "ok": false, "error": error }),
        ),
    }
}

fn handle_tokencount(state: &AppState, body: &[u8]) -> Response {
    let text = String::from_utf8_lossy(body).into_owned();
    let parsed: Value = serde_json::from_str(if text.trim().is_empty() { "{}" } else { &text })
        .unwrap_or_else(|_| json!({}));
    let input = parsed.get("text").and_then(|t| t.as_str()).unwrap_or("");
    let tokens = state.bpe.encode_ordinary(input).len();
    json_response(StatusCode::OK, &json!({ "tokens": tokens }))
}

fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name,
        "transfer-encoding" | "connection" | "keep-alive" | "upgrade" | "te" | "trailer"
    ) || name.starts_with("proxy-")
}

async fn proxy(
    state: &AppState,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let target = uri
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| uri.path().to_string());
    // API_PATH_PREFIX + req.url (query preserved).
    let path = format!("{}{}", state.upstream.path_prefix, target);
    let url_str = format!(
        "{}://{}{}",
        state.upstream.scheme, state.upstream.authority, path
    );
    let url = match url::Url::parse(&url_str) {
        Ok(u) => u,
        Err(e) => return error_502(&format!("invalid upstream URL {url_str:?}: {e}")),
    };

    // 捕获需要在 method/body 被 move 之前把信息取出来
    let method_str = method.as_str().to_string();
    // `/event/detail` 的 `req.headers` 快照（Node 在注册捕获条目时就写 `req.headers`）。
    let req_headers = header_pairs(&headers);
    // `req.body` 原样留一份（Bytes 的 clone 是引用计数，不复制字节）。
    let req_body_bytes = body.clone();

    // ── agent 身份解析（Node 的 `getAgentId(req, body)`，在 `req.on('end')` 里调）──
    // body 已整体缓冲，所以这里等价于 Node「收完 body 再解析」。解析结果同时用于：
    // ① 捕获条目的 `agentId`；② `/agent/prompts` 归属；③ 事件里的 `agentId`；
    // ④ 每流 `lastDeltaType`（phase）与活跃流注册。
    //
    // 注意 Node 的 body 解析是**带缓存**的（`parseJsonBodyCached`）；这里只解析一次，
    // 供身份解析与 prompt 存储复用，天然没有重复解析。
    let parsed_body: Option<Value> = serde_json::from_slice(&body).ok();
    let agent_id = state
        .agents
        .get_agent_id(&method_str, &target, &headers, parsed_body.as_ref());
    if agent_id != agents::UNKNOWN_AGENT {
        // Node: 已识别 agent 才 `requestCount++` / 存 prompt / 估算输入 token /
        // 整体重置本流状态。必须先于 send()：`record_delta`（在响应流里）要看到已重置的
        // lastDeltaType。
        // `estimateInputTokens` 对"能解析的 body"至少给 1（`Math.max(1, ...)`），
        // 解析失败则是 0（不估算）。
        let est_in = parsed_body
            .as_ref()
            .map(agents::estimate_input_tokens)
            .unwrap_or(0);
        state
            .agents
            .begin_request(&agent_id, parsed_body, est_in, capture::now_ms());
    }

    let mut builder = state.client.request(method, url);
    for (name, value) in headers.iter() {
        // All client headers verbatim except `host`, which is rewritten below.
        // `content-length` in particular is passed through untouched.
        if name == header::HOST {
            continue;
        }
        builder = builder.header(name, value);
    }
    builder = builder.header(header::HOST, state.upstream.host_header.as_str());

    // cid 在 `send()` **之前**分配：连接失败那条 `upstream-tcp-error` 事件要带 correlationId
    // （Node 的 cid 更是早在建 capture entry 时就分配好了）。条目本身仍在 send() 成功后才注册，
    // 所以连接失败没有可查的捕获详情 —— 这是已记录的独立结构性偏差（见文档 §8bis 已知差异 (b)）。
    let cid = capture::new_cid();
    let upstream_response = match builder.body(body).send().await {
        Ok(r) => r,
        Err(e) => {
            // Node `proxyReq.on('error')`（真 TCP / TLS / DNS 失败，非 cc 主动打断）：
            // 报 `upstream-tcp-error` + 502。`code: null` 是因为 reqwest 不暴露 Node 的
            // `err.code`（ECONNREFUSED 之类），不伪造一个值。
            let msg = e.to_string();
            record_event(
                state,
                EventInput {
                    severity: "error".to_string(),
                    event_type: "upstream-tcp-error".to_string(),
                    agent_id: Some(agent_id.clone()),
                    message: format!("上游连接失败: {msg}"),
                    detail: json!({ "err": msg, "code": Value::Null }),
                },
                Some(&cid),
            );
            return error_502(&msg);
        }
    };

    // ── 捕获：注册条目 + 记录响应头时刻 ──
    // `is_sse` 由 content-type 判定（与 Node 同源）。SSE 的"首字"要用第一个**内容 delta**，
    // 由 `forward_response` 里的分帧器判定（见 sse.rs）。
    let status_u16 = upstream_response.status().as_u16();
    let is_sse = upstream_response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_ascii_lowercase().contains("text/event-stream"))
        .unwrap_or(false);
    let now = capture::now_ms();
    state.capture.begin(&cid, &method_str, &target, now);
    // `reqHeaders` / `reqBody`：Node 在注册条目时就写 headers、在 `req.on('end')` 里写 body。
    // 本实现 body 是先整体缓冲的，所以两者都在这里一次写全（`set_req_body` 同时落 size）。
    state.capture.set_req_headers(&cid, req_headers);
    state.capture.set_req_body(&cid, req_body_bytes.to_vec());
    // agentId 归属：与 Node 一样恒为字符串（未识别 = `"unknown"`）。
    state.capture.set_agent_id(&cid, &agent_id);
    state
        .capture
        .on_response_headers(&cid, status_u16, is_sse, now);
    // L7 资源：SSE 流但 agentId 解析失败（header 配置异常）→ 提示用户。
    // Node 在 `isSSE` 分支里做，且事件的 `agentId` 显式为 null。
    if is_sse && agent_id == agents::UNKNOWN_AGENT {
        record_event(
            state,
            EventInput {
                severity: "notice".to_string(),
                event_type: "agent-unknown".to_string(),
                agent_id: None,
                message: "未知 agent (header 解析失败)".to_string(),
                detail: json!({}),
            },
            Some(&cid),
        );
    }
    // 异常事件流：上游 4xx/5xx 分流记录（对齐 `proxy.js` 的 L2 HTTP 错误码监控）。
    // 判据、类型、severity 与 detail 形状见 `emit_http_status_event`。
    let status_message = upstream_response.status().canonical_reason();
    let retry_after = upstream_response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());
    emit_http_status_event(
        state,
        &cid,
        &agent_id,
        &method_str,
        &target,
        status_u16,
        status_message,
        retry_after.as_deref(),
    );
    // 广播"该请求已出现 + 响应头已到"。本实现里 `begin` 只可能发生在 `send()` 拿到响应之后，
    // 所以注册与响应头是同一帧；dashboard 由此拿到 statusCode/isSSE 并开始渲染该行。
    broadcast_summary(state, &cid);

    forward_response(state, upstream_response, cid, is_sse, agent_id).await
}

/// 把环里某条的最新 summary 广播给 `/requests/stream` 订阅者。
/// 条目已被 LRU 淘汰（或不存在）时静默跳过 —— 广播是观测层，绝不因它影响主路径。
fn broadcast_summary(state: &AppState, cid: &str) {
    if let Some(summary) = state.capture.summary_of(cid, capture::now_ms()) {
        state
            .requests
            .send(RequestEvent::Update(with_phase(&state.agents, summary)));
    }
}

/// 流结束时把 `end_at` 落定 + 收尾全部观测面。
///
/// 为什么用 **Drop guard** 而不是在流里找"最后一个 chunk"（那不可能知道）：
/// 守卫被 `inspect` 的闭包持有 → 闭包与流同生命周期 → 流正常结束**或被丢弃**（客户端断开）时
/// 守卫随之 drop，于是两种情况都能记到结束时刻，不需要任何轮询或额外任务。
/// 这也是这里唯一需要的"并发安全"手段：`CaptureRing` 内部已有锁。
///
/// 同一份 drop 负责（按 Node 的收尾路径）：
/// - agent 侧：注销活跃流（`end_stream`，含 `endTs` 与真实平均 tps 收口）、清
///   `_lastStopReason`、非 SSE 时把 `stream.reqTs` 归零（Node 在非 SSE `proxyRes.on('end')`）；
/// - 捕获侧：非 SSE 写回 `respBody`、SSE 标记 `sseTruncated=false`、写 `respHeaders`、落 `endAt`；
/// - `_streamEnded` + `/event/detail/stream` 的 `{done:true}`：判据见
///   `stream_ended_for_teardown` —— 只覆盖 Node 会调 `_finalizeRequestCapture` 的路径；
///   **非 SSE 正常结束不置位**（Node 的 `proxyRes.on('end')` 只写 endAt + 广播 summary），
///   于是"已完成的非 SSE 请求"其详情流订阅者会一直等（只有心跳）—— 这是 Node 的真实
///   quirk，照抄；
/// - 广播最终 summary（否则 dashboard 那行永远停在"进行中"）。
struct CaptureEndGuard {
    ring: Arc<crate::proxy::capture::CaptureRing>,
    cid: String,
    requests: broadcast::RequestBroadcaster,
    detail: crate::proxy::detail::DetailBroadcaster,
    agents: Arc<AgentRegistry>,
    agent_id: String,
    is_sse: bool,
    /// 上游字节流是否正常走完（`Ready(None)`）；客户端中途断开 / 流被丢弃时为 false。
    completed: Arc<std::sync::atomic::AtomicBool>,
    /// 上游流是否报过错（`inspect` 收到 `Err`）。
    saw_error: Arc<std::sync::atomic::AtomicBool>,
    /// 非 SSE 的响应体镜像（Node 的 `_respChunks` → `respBody`）。
    resp_body: Option<Arc<std::sync::Mutex<Vec<u8>>>>,
    /// 非 SSE 上游流中断时的错误文本（Node `proxyRes.on('error')` 的 `e.message`）——
    /// 用来把 `respBody` 改写成 `proxy stream error: <msg>`，见 `Drop` 里的注释。
    error_text: Option<Arc<std::sync::Mutex<String>>>,
    /// 上游响应头（Node 在流**结束**时才写进条目，不是收到响应头时）。
    resp_headers: Vec<(String, String)>,
    stream: Option<(String, u64)>,
    clear_stop_reason_for: Option<String>,
    /// 收尾事件 / 字节损坏取证的事件写入器（`inspect` 闭包是 `'static` 的，只能带句柄）。
    sink: EventSink,
    /// 「客户端或 `/agent/kill` 主动中断」标记（Node 的 `stream.clientAborted` /
    /// 非 SSE 的 `_clientAborted`）：抑制 destroy 连锁出来的 error 上报，
    /// 也让 `/agent/kill` 不被误报成 `client-disconnect`。
    client_aborted: Arc<std::sync::atomic::AtomicBool>,
    /// SSE 原始字节全量（Node 的 `rawAll`）：流末扫非法 UTF-8 用。非 SSE 为 `None`。
    raw_all: Option<Arc<std::sync::Mutex<Vec<u8>>>>,
    /// SSE 分帧后未消费的尾巴长度（Node `proxyRes.on('end')` 时读的 `buf.length`，
    /// 进 `no-delta-*` 的 `bufLen`）。
    sse_tail_len: Arc<std::sync::atomic::AtomicUsize>,
    /// `upstream-timeout` 看门狗是否仍有效：首字到达 / 流收尾即解除（Node 的 `_clearWd`）。
    watchdog_armed: Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for CaptureEndGuard {
    fn drop(&mut self) {
        use std::sync::atomic::Ordering;
        let now = capture::now_ms();
        // ── 收尾事件（Node 的 `proxyRes.on('error')` / `res.on('close')` / `proxyRes.on('end')`）──
        // 看门狗随流收尾一并解除（Node 的 `_clearWd` 在 end/error/close 三处都调）。
        self.watchdog_armed.store(false, Ordering::SeqCst);
        if self.is_sse {
            let saw_error = self.saw_error.load(Ordering::SeqCst);
            let completed = self.completed.load(Ordering::SeqCst);
            let aborted = self.client_aborted.load(Ordering::SeqCst);
            // Node 只在「SSE 且非已知 agent 的流」上不报 client-disconnect（`stream` 为 null）；
            // upstream-stream-error 则对 unknown 也报（`proxyRes.on('error')` 不看 agentId）。
            let stream_registered = self.agent_id != agents::UNKNOWN_AGENT;
            match sse_teardown_event(saw_error, completed, aborted, stream_registered) {
                Some(TeardownEvent::UpstreamStreamError) => {
                    let err = self
                        .error_text
                        .as_ref()
                        .and_then(|t| t.lock().ok().map(|t| t.clone()))
                        .unwrap_or_default();
                    self.sink.record(
                        EventInput {
                            severity: "error".to_string(),
                            event_type: "upstream-stream-error".to_string(),
                            agent_id: Some(self.agent_id.clone()),
                            message: "上游流中断".to_string(),
                            detail: json!({ "err": err }),
                        },
                        Some(&self.cid),
                    );
                }
                Some(TeardownEvent::ClientDisconnect) => {
                    self.sink.record(
                        EventInput {
                            severity: "warn".to_string(),
                            event_type: "client-disconnect".to_string(),
                            agent_id: Some(self.agent_id.clone()),
                            message: "cc 断开 (流未完成)".to_string(),
                            detail: json!({}),
                        },
                        Some(&self.cid),
                    );
                }
                None => {
                    // Node 的 `proxyRes.on('end')`：先字节损坏取证，再做流末「无 delta」分流。
                    if completed && !saw_error {
                        if let Some(raw) = &self.raw_all {
                            let bytes = raw.lock().map(|b| b.clone()).unwrap_or_default();
                            if let Some(rep) = sse::scan_corruption(&bytes) {
                                self.sink.record(
                                    EventInput {
                                        severity: "warn".to_string(),
                                        event_type: "upstream-byte-corruption".to_string(),
                                        agent_id: Some(self.agent_id.clone()),
                                        message: format!(
                                            "检测到上游字节损坏 ({} 处, 共 {} 个非法字节)",
                                            rep.clusters, rep.total_bad_bytes
                                        ),
                                        detail: json!({
                                            "clusters": rep.clusters,
                                            "totalBadBytes": rep.total_bad_bytes,
                                            "samples": rep.samples,
                                            "sseBytesLen": rep.bytes_len,
                                        }),
                                    },
                                    Some(&self.cid),
                                );
                            }
                        }
                        let tail = self.sse_tail_len.load(Ordering::SeqCst);
                        if let Some(ev) =
                            self.agents
                                .stream_end_diagnostic(&self.agent_id, tail, now)
                        {
                            self.sink.record(ev, Some(&self.cid));
                        }
                    }
                }
            }
        }
        if let Some((agent, id)) = &self.stream {
            self.agents.end_stream(agent, *id, now);
        }
        if let Some(agent) = &self.clear_stop_reason_for {
            self.agents.clear_stop_reason(agent);
        }
        if !self.is_sse && self.agent_id != agents::UNKNOWN_AGENT {
            // Node: 非 SSE end/error 后 `ensureAgent(agentId).stream.reqTs = 0`。
            self.agents.clear_req_ts(&self.agent_id);
        }
        if let Some(buf) = &self.resp_body {
            // 非 SSE 上游流中断：Node 的 `proxyRes.on('error')` 会把**已收到的 partial 字节
            // 丢掉**，改写成 `Buffer.from('proxy stream error: ' + e.message)` 并同步
            // `respBodySize`（`ent.respBody = ent.respBody || Buffer.from(...)` —— 非 SSE 的
            // `respBody` 只在 `on('end')` 里写过，错误路径上还是 null，所以必然命中这一支）。
            // 这直接影响 `/requests` 行的 `respBodySize` 与 `/event/detail` 的 `respBody`，
            // 所以要照抄。客户端侧响应体不受影响（那条路径走的是 hyper 的流错误 → 连接被截断）。
            let body = match (self.saw_error.load(Ordering::SeqCst), &self.error_text) {
                (true, Some(text)) => {
                    let text = text.lock().map(|t| t.clone()).unwrap_or_default();
                    format!("proxy stream error: {text}").into_bytes()
                }
                _ => buf.lock().map(|b| b.clone()).unwrap_or_default(),
            };
            self.ring.set_resp_body(&self.cid, body);
        }
        if !self.resp_headers.is_empty() {
            self.ring
                .set_resp_headers(&self.cid, self.resp_headers.clone());
        }
        if self.is_sse {
            self.ring.set_sse_truncated(&self.cid, false);
        }
        self.ring.set_end(&self.cid, now);

        // `_finalizeRequestCapture` 的 `_streamEnded` + `_broadcastDetail(done)`，覆盖面见结构体注释。
        if stream_ended_for_teardown(
            self.is_sse,
            self.saw_error.load(Ordering::SeqCst),
            self.completed.load(Ordering::SeqCst),
        ) {
            self.ring.set_stream_ended(&self.cid, true);
            self.detail.send(crate::proxy::detail::DetailUpdate {
                cid: self.cid.clone(),
                payload: crate::proxy::detail::done_payload(),
            });
        }

        if let Some(summary) = self.ring.summary_of(&self.cid, now) {
            self.requests
                .send(RequestEvent::Update(with_phase(&self.agents, summary)));
        }
    }
}

/// SSE 收尾事件的分流结果（Node 的三条 `recordEvent` 路径）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TeardownEvent {
    /// `proxyRes.on('error')` 且非 `clientAborted` → `upstream-stream-error`（error）
    UpstreamStreamError,
    /// `res.on('close')` 且流未完成 → `client-disconnect`（warn）
    ClientDisconnect,
}

/// SSE 收尾事件的判据 —— 对齐 Node 的三条 `recordEvent` 路径：
/// 1. `proxyRes.on('error')`：`if (stream?.clientAborted) return;` 之后报 `upstream-stream-error`；
/// 2. `res.on('close')` 且 `stream && !stream.closed`：报 `client-disconnect`；
/// 3. `proxyRes.on('end')`：不报这两条（走 `no-delta-*` / 字节损坏分流）。
///
/// 三个输入来自 `CaptureEndGuard` 的事实来源：
/// - `saw_error`：上游字节流报错（`inspect` 收到 `Err`）；
/// - `completed`：上游流正常走完（`Ready(None)` 或收满 `content-length`）；
/// - `client_aborted`：`/agent/kill` 的取消信号已触发（Node 的 `stream.clientAborted`）；
/// - `stream_registered`：该 SSE 流属于已识别 agent（Node 只在此时建了 `stream` 对象，
///   否则 `res.on('close')` 的 `if (stream && ...)` 恒假）。
fn sse_teardown_event(
    saw_error: bool,
    completed: bool,
    client_aborted: bool,
    stream_registered: bool,
) -> Option<TeardownEvent> {
    if client_aborted {
        // cc 主动打断 / kill：destroy 上游必然引出 EPIPE/ECONNRESET，是副作用不是真故障。
        return None;
    }
    if saw_error {
        return Some(TeardownEvent::UpstreamStreamError);
    }
    if !completed && stream_registered {
        return Some(TeardownEvent::ClientDisconnect);
    }
    None
}

/// `_streamEnded` 的判据 —— 对齐 Node `_finalizeRequestCapture` 的**调用路径集合**。
///
/// Node 里 `_streamEnded = true` 只由 `_finalizeRequestCapture(cid)` 设置，而它被这几条
/// 路径调用（`proxy.js`）：
///   1. SSE 正常结束 —— `proxyRes.on('end')`（SSE 分支末尾）；
///   2. SSE 上游流中断 —— `proxyRes.on('error')`（未命中 `clientAborted` 早退时）；
///   3. SSE 客户端断开 —— `res.on('close')` 且流未完成；
///   4. SSE 上游连接失败 —— `proxyReq.on('error')`；
///   5. 非 SSE 上游流中断 —— `proxyRes.on('error')`（非 SSE 分支）；
///   6. 非 SSE 客户端断开 —— `res.on('close')` 且 `_ended` 仍为 false。
///
/// **唯一的反例是非 SSE 正常结束**（`proxyRes.on('end')`）：它只写 `endAt` + 广播 summary，
/// 从不调 `_finalizeRequestCapture` —— 于是"已完成的非 SSE 请求"的详情流订阅者会一直
/// 收不到 `{done:true}`（只有心跳）。这是 Node 的真实 quirk，必须照抄。
///
/// 三个输入正是上面六条路径的判别式：
/// - `is_sse`：SSE 的**全部**收尾（1/2/3/4）都会 finalize；`proxyRes.on('error')` 与
///   `res.on('close')` 在 SSE 分支里无例外，所以 `is_sse` 直接覆盖 1–4；
/// - `saw_error`：上游字节流报错 → 覆盖 2 与 5；
/// - `!completed`：流没走完（被丢弃 = 客户端断开或 `/agent/kill`）→ 覆盖 3 与 6。
///
/// 三者的并集 = {1..6}，并集之外只剩"非 SSE 正常结束" → `false`。**这就是精确判据**，
/// 不是"用 completed/saw_error 近似"—— 每个输入都直接对应一条 Node 分支。
///
/// 已知的结构性差异（**不属于本判据**，见文档 §8bis 的「已知差异 (b)」）：上游**连接失败**
/// 时 Node 的 capture entry 早已注册（`captureRing.set` 在 `proxyReq` 之前），故那条 502
/// 的 `/requests` 行会被 finalize；本实现的 capture entry 在 `send()` 成功后才注册，
/// 所以连接失败**根本没有那条行**可言。要补齐得把注册提前到热路径 `send()` 之前 ——
/// 那是已记录的独立偏差，本轮不动。
fn stream_ended_for_teardown(is_sse: bool, saw_error: bool, completed: bool) -> bool {
    is_sse || saw_error || !completed
}

/// "上游已收满声明的 `content-length`" —— Node `proxyRes.on('end')` 的判据之一。
///
/// 为什么需要这一支：上游带 `content-length` 时该头会被原样转发给客户端，hyper 收满即
/// 结束、不再 poll 内层流拿 `None`，于是 `MarkComplete` 的 `completed` 永远不置位。
/// 与 `Ready(None)`（无长度 / chunked 上游）两支合并才等价于 Node 的 `on('end')`。
fn declared_len_reached(seen: u64, declared: Option<u64>) -> bool {
    matches!(declared, Some(want) if seen >= want)
}

/// 记录底层上游字节流是否正常走完（`Ready(None)`）—— 见 `CaptureEndGuard::completed`。
/// `StreamExt::inspect` 看不到 `None`，所以用这层薄包装补上。
struct MarkComplete<S> {
    inner: Pin<Box<S>>,
    completed: Arc<std::sync::atomic::AtomicBool>,
}

impl<S: Stream> Stream for MarkComplete<S> {
    type Item = S::Item;
    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let me = self.get_mut();
        match me.inner.as_mut().poll_next(cx) {
            Poll::Ready(None) => {
                me.completed
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                Poll::Ready(None)
            }
            other => other,
        }
    }
}

/// 可被 `/agent/kill` 中断的响应体流。
///
/// 为什么不能只清内部状态：Node 的 `killAgentStreams` 对两端 `destroy()`，注释写明
/// 「被截断的 SSE 必须让 cc 看到**连接重置**，走 SDK 自动重试；若用 `end`，cc 会把半截
/// 回复当成流正常结束而接受」。所以这里在收到取消信号时**产出错误**（hyper 于是无法补完
/// 分块编码 → 连接被截断），而不是干净地 `None` 结束。
///
/// 正常路径的行为与不包这一层完全一致：`inner` 怎么结束就怎么结束，取消分支只在信号到达时
/// 才介入（`oneshot` 发送端若先被丢弃 —— 即流已自然收尾 —— 视为"不取消"）。
struct CancellableBody<S> {
    inner: Pin<Box<S>>,
    cancel: Option<oneshot::Receiver<()>>,
    done: bool,
    /// `/agent/kill` 的取消信号已到达 → 置位（Node 的 `stream.clientAborted`）。
    /// 收尾守卫据此抑制 `client-disconnect` / `upstream-stream-error`（kill 不是客户端断开，
    /// 也不是真上游故障）。
    client_aborted: Arc<std::sync::atomic::AtomicBool>,
}

impl<S> Stream for CancellableBody<S>
where
    S: Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
{
    type Item = Result<Bytes, Box<dyn std::error::Error + Send + Sync>>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let me = self.get_mut();
        if me.done {
            return Poll::Ready(None);
        }
        if let Some(rx) = me.cancel.as_mut() {
            match Pin::new(rx).poll(cx) {
                Poll::Ready(Ok(())) => {
                    me.done = true;
                    me.cancel = None;
                    me.client_aborted
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    return Poll::Ready(Some(Err(Box::new(std::io::Error::new(
                        std::io::ErrorKind::ConnectionAborted,
                        "agent stream killed",
                    )))));
                }
                // 发送端已 drop（流已收尾/agent 记录被清）→ 不再有取消可言。
                Poll::Ready(Err(_)) => me.cancel = None,
                Poll::Pending => {}
            }
        }
        match me.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(b))) => Poll::Ready(Some(Ok(b))),
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(Box::new(e)))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

async fn forward_response(
    state: &AppState,
    resp: reqwest::Response,
    cid: String,
    is_sse: bool,
    agent_id: String,
) -> Response {
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut builder = Response::builder().status(status);
    for (name, value) in resp.headers().iter() {
        if is_hop_by_hop(name.as_str()) {
            continue;
        }
        builder = builder.header(name.clone(), value.clone());
    }
    // Incremental streaming — never buffer the whole body. A mid-stream upstream
    // error surfaces as a stream error, which tears the client response down
    // instead of hanging.
    // 逐块累计响应字节；`inspect` 的闭包持有结束守卫（见 CaptureEndGuard 的说明）。
    let ring = state.capture.clone();
    let agents = state.agents.clone();
    let bpe = state.bpe.clone();
    let detail = state.detail.clone();
    let sink = EventSink {
        log: state.events_log.clone(),
        bcast: state.events.clone(),
        capture: state.capture.clone(),
    };
    let cid_for_stream = cid.clone();
    let agent_id_for_stream = agent_id.clone();
    // Node 在流**结束**时才把 `proxyRes.headers` 写进捕获条目（不是收到响应头时）。
    let resp_headers = header_pairs(resp.headers());
    // 上游声明的 `content-length`（有则用于判定"上游流已走完"，见下方 `seen_bytes`）。
    // **为什么不能只靠 `MarkComplete` 的 `Ready(None)`**：这个 content-length 会被原样
    // 转发给客户端（它不是 hop-by-hop，契约要求逐头透传），于是 hyper 知道客户端响应体
    // 有多长 —— 收满即结束，**不必再 poll 一次拿 `None`**，`MarkComplete` 就永远等不到
    // `Ready(None)`，`completed` 会错误地停在 false。差分实测（content-length=26 的
    // 非 SSE 正常流）：Node 不置 `_streamEnded`、本实现置 → `/event/detail/stream` 多推了
    // 一个 `{done:true}`。补上"字节收满"这一支即与 Node 的 `proxyRes.on('end')` 同义。
    let declared_len: Option<u64> = resp
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());

    // 流开始：清掉 stopReason 去重锚点。Node 的 `_lastStopReason.delete(agentId)`
    // 在 `isSSE` 分支里，**不看** agentId 是否已知（不对称 quirk：流末那次只看已识别 agent）。
    if is_sse {
        agents.clear_stop_reason(&agent_id);
    }
    // 只有「已识别 agent 的 SSE 流」才登记为可 kill 的活跃流（Node 同）。
    let stream_reg = if is_sse && agent_id != agents::UNKNOWN_AGENT {
        Some(agents.begin_stream(&agent_id))
    } else {
        None
    };
    if stream_reg.is_some() {
        // Node 在 SSE 响应头分支里 `a.stream.reqTs = 0`（req→响应头窗口结束）。
        agents.clear_req_ts(&agent_id);
    }
    let clear_stop_reason_for = if is_sse && agent_id != agents::UNKNOWN_AGENT {
        Some(agent_id.clone())
    } else {
        None
    };

    // ── `_streamEnded` 的两个事实来源 ──
    // `completed`：底层上游字节流是否正常走完（`Ready(None)`）；
    // `saw_error`：上游字节流是否报过错（`inspect` 收到 `Err`）。
    // 两者 + `is_sse` 合成 `_streamEnded` 的判据，见 `stream_ended_for_teardown`。
    let completed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let saw_error = Arc::new(std::sync::atomic::AtomicBool::new(false));
    // 非 SSE：镜像响应体（Node `_respChunks`），流结束时写回捕获条目。
    let resp_body_buf: Option<Arc<std::sync::Mutex<Vec<u8>>>> = if is_sse {
        None
    } else {
        Some(Arc::new(std::sync::Mutex::new(Vec::new())))
    };
    // 上游流中断的错误文本（见 `CaptureEndGuard::error_text`）。**SSE 与非 SSE 都要**：
    // 非 SSE 的收尾用它改写 `respBody`；SSE 的 `upstream-stream-error` 事件的 `detail.err`
    // 也用它（Node 的 `proxyRes.on('error')` 两个分支都拿 `e.message`）。
    let error_text: Option<Arc<std::sync::Mutex<String>>> =
        Some(Arc::new(std::sync::Mutex::new(String::new())));
    // 「客户端 / `/agent/kill` 主动中断」标记：`CancellableBody` 在收到取消信号时置位。
    let client_aborted = Arc::new(std::sync::atomic::AtomicBool::new(false));
    // SSE 原始字节全量（Node 的 `rawAll`）：只在 SSE 上留一份，流末扫非法 UTF-8。
    let raw_all: Option<Arc<std::sync::Mutex<Vec<u8>>>> = if is_sse {
        Some(Arc::new(std::sync::Mutex::new(Vec::new())))
    } else {
        None
    };
    // SSE 分帧后未消费尾巴的长度（Node 流末读的 `buf.length`，进 `no-delta-*` 的 `bufLen`）。
    let sse_tail_len = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    // `upstream-timeout` 看门狗：只在「SSE + 已识别 agent」上存在 —— Node 的 `stream` 对象
    // 只有已识别 agent 才建，看门狗体里的 `if (stream && !stream.closed)` 因此恒假。
    let watchdog_armed = Arc::new(std::sync::atomic::AtomicBool::new(
        is_sse && agent_id != agents::UNKNOWN_AGENT,
    ));
    // 流式进度广播的节流锚点（Node 的 `_lastReqBcastTs`，初值 0 = 首个 chunk 必广播）。
    let requests_bcast = state.requests.clone();

    let guard = CaptureEndGuard {
        ring: ring.clone(),
        cid: cid.clone(),
        requests: state.requests.clone(),
        detail: detail.clone(),
        agents: agents.clone(),
        agent_id: agent_id.clone(),
        is_sse,
        completed: completed.clone(),
        saw_error: saw_error.clone(),
        resp_body: resp_body_buf.clone(),
        error_text: error_text.clone(),
        resp_headers,
        stream: stream_reg.as_ref().map(|(id, _)| (agent_id.clone(), *id)),
        clear_stop_reason_for,
        sink: sink.clone(),
        client_aborted: client_aborted.clone(),
        raw_all: raw_all.clone(),
        sse_tail_len: sse_tail_len.clone(),
        watchdog_armed: watchdog_armed.clone(),
    };

    // `upstream-timeout` 看门狗（Node 的 `setTimeout(..., SSE_WATCHDOG_MS)`）：到点若流还活着
    // 且没收到首字就报事件。**必须用独立任务**：流卡住时 `inspect` 一次都不会被调用
    // （没有 chunk 可 inspect），流内计时器无从触发。
    if is_sse && agent_id != agents::UNKNOWN_AGENT {
        let armed = watchdog_armed.clone();
        let sink_wd = sink.clone();
        let agent_wd = agent_id.clone();
        let cid_wd = cid.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(sse::SSE_WATCHDOG_MS)).await;
            if armed.load(std::sync::atomic::Ordering::SeqCst) {
                sink_wd.record(
                    EventInput {
                        severity: "warn".to_string(),
                        event_type: "upstream-timeout".to_string(),
                        agent_id: Some(agent_wd),
                        message: format!(
                            "上游无响应 (>{}s 未收到首字)",
                            sse::SSE_WATCHDOG_MS / 1000
                        ),
                        detail: json!({ "stuckMs": sse::SSE_WATCHDOG_MS }),
                    },
                    Some(&cid_wd),
                );
            }
        });
    }

    // SSE 旁路解析（**不动字节**：chunk 原样进 `Body`，这里只是额外读一遍）：
    // - 首字：第一个带文本的 `content_block_delta`（`sse::analyze_event` 的 `first_char`）；
    // - `lastDeltaType` + chars/tokens：驱动 `/status` 的 state / tps（`record_delta`）；
    // - 真实 token：`message_start.usage` / `message_delta.usage` → `record_tokens`；
    // - 详情实时流：每个完整 part 里的 think/text delta → `/event/detail/stream`；
    // - 事件来源：event-field / parse-fail / event-error-payload / unknown-type / stop-reason-*。
    //
    // 缓冲只留"未完成的那一个事件"（`split_sse_events` 返回的 tail），所以不会无限增长。
    // 与 Node 的差别（已记录）：Node 为找首字与做分流各解析一遍，这里只解析一遍。
    let mut sse_buf: Vec<u8> = Vec::new();
    // `sseBytes` 的重建（Node `sseCapturedParts.join('\n\n')` + 分隔符 + 尾巴）：
    // `sse_joined` 增量维护 parts 的 `\n\n` 拼接（等价于 join，避免每 chunk 全量 join）。
    let mut sse_joined: Vec<u8> = Vec::new();
    let mut sse_blocks: Vec<i64> = Vec::new();
    let mut sse_size: usize = 0;
    let mut got_first_char = false;
    // 已从上游收到的字节数 —— 与 `declared_len` 比对来判"上游流走完"（见 `declared_len` 注释）。
    let mut seen_bytes: u64 = 0;
    // SSE 流式进度广播的节流锚点（Node 的 `_lastReqBcastTs`，闭包内可变）。
    let mut last_req_bcast_ts: i64 = 0;
    let completed_for_stream = completed.clone();
    let stream = resp.bytes_stream().inspect(move |item| {
        let _guard_alive = &guard; // 由闭包持有 → 与流同生命周期
        let chunk = match item {
            Ok(c) => c,
            Err(e) => {
                // 上游字节流报错（真上游自断，或客户端断开后 `proxyRes.destroy()` 的连锁
                // EPIPE/ECONNRESET）。Node 在 `proxyRes.on('error')` 里调
                // `_finalizeRequestCapture` —— 即 **SSE 与非 SSE 都要** `_streamEnded`。
                // 「真上游 vs 客户端连锁」的区分（Node 的 `stream.clientAborted` /
                // `_clientAborted` 抑制上报）现已实现：`CancellableBody` 在取消信号到达时
                // 置 `client_aborted`，守卫据此跳过 `upstream-stream-error`
                // （`_streamEnded` 不受影响 —— 两条路径 Node 都会 finalize）。
                // 错误文本留给守卫：非 SSE 的收尾要用它改写 `respBody`，SSE 的
                // `upstream-stream-error` 事件也要用它当 `detail.err`（Node 同）。
                if let Some(slot) = &error_text {
                    if let Ok(mut t) = slot.lock() {
                        *t = e.to_string();
                    }
                }
                saw_error.store(true, std::sync::atomic::Ordering::SeqCst);
                return;
            }
        };
        seen_bytes += chunk.len() as u64;
        if declared_len_reached(seen_bytes, declared_len) {
            // = Node 的 `proxyRes.on('end')`：声明的字节已收满，上游流正常走完。
            completed_for_stream.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        ring.add_resp_bytes(&cid_for_stream, chunk.len(), is_sse);
        if !is_sse {
            if let Some(buf) = &resp_body_buf {
                if let Ok(mut b) = buf.lock() {
                    b.extend_from_slice(chunk);
                }
            }
            return;
        }
        sse_size += chunk.len();
        // 旁路：原始字节全量（Node 的 `rawAll`），流末扫非法 UTF-8 用 —— 必须存原始字节，
        // 因为 `sseBytes` 是 utf8 重建（非法字节已变 U+FFFD，检测不到）。
        if let Some(raw) = &raw_all {
            if let Ok(mut b) = raw.lock() {
                b.extend_from_slice(chunk.as_ref());
            }
        }
        sse_buf.extend_from_slice(chunk);
        let (events, tail) = sse::split_sse_events(&sse_buf);
        sse_buf = tail;
        // 流末 `no-delta-*` 的 `bufLen` = 分帧后未消费的尾巴长度（Node 读的 `buf.length`）。
        sse_tail_len.store(sse_buf.len(), std::sync::atomic::Ordering::SeqCst);
        let cut_ts = capture::now_ms();
        for ev in &events {
            let info = sse::analyze_event(ev);
            // 详情实时流：Node 第一遍（`proxy.js:2030-2033`）对每个完整 part 立即推字。
            if let Some((kind, text)) = &info.detail_delta {
                detail.send(crate::proxy::detail::DetailUpdate {
                    cid: cid_for_stream.clone(),
                    payload: crate::proxy::detail::delta_payload(kind.as_js_str(), text, cut_ts),
                });
            }
            if !got_first_char && info.first_char {
                ring.on_first_content_delta(&cid_for_stream, cut_ts);
                got_first_char = true;
                // 首字到 → 看门狗退场（Node 的 `_clearWd()`）。中段无活动归 SSE_STUCK / sse-stuck 管。
                watchdog_armed.store(false, std::sync::atomic::Ordering::SeqCst);
            }
            // capture 的 sseBytes 增量累积：parts.join('\n\n')。
            if !sse_joined.is_empty() {
                sse_joined.extend_from_slice(b"\n\n");
            }
            sse_joined.extend_from_slice(ev);
            sse_blocks.push(cut_ts);

            // ── Node 第二遍：没有 data 行 → event-field（ping 心跳除外），然后 continue ──
            if info.data.is_none() {
                if let Some(name) = info.event_name.as_deref() {
                    if name != "ping" {
                        sink.record(
                            EventInput {
                                severity: "notice".to_string(),
                                event_type: "event-field".to_string(),
                                agent_id: Some(agent_id_for_stream.clone()),
                                message: format!("非 data 事件: {name}"),
                                detail: json!({ "eventName": name }),
                            },
                            Some(&cid_for_stream),
                        );
                    }
                }
                continue;
            }
            let data = info.data.as_deref().unwrap_or_default();
            if info.parse_failed {
                // `err` 用真实解析错误（Node 用 `e.message`；两侧文案本就不同，键与语义一致）。
                let err = serde_json::from_str::<Value>(data)
                    .err()
                    .map(|e| e.to_string())
                    .unwrap_or_default();
                sink.record(
                    EventInput {
                        severity: "error".to_string(),
                        event_type: "parse-fail".to_string(),
                        agent_id: Some(agent_id_for_stream.clone()),
                        message: "SSE data 解析失败".to_string(),
                        detail: json!({
                            // Node: `data.slice(0, 200)`
                            "rawPreview": data.chars().take(200).collect::<String>(),
                            "err": err,
                        }),
                    },
                    Some(&cid_for_stream),
                );
                continue;
            }
            let Some(obj) = info.json.as_ref() else {
                continue;
            };
            let obj_type = obj.get("type").and_then(|t| t.as_str()).unwrap_or("");
            // 协议级 error 事件（Node: `if (obj.type === 'error')`）
            if obj_type == "error" {
                sink.record(
                    EventInput {
                        severity: "error".to_string(),
                        event_type: "event-error-payload".to_string(),
                        agent_id: Some(agent_id_for_stream.clone()),
                        message: "Anthropic error 事件".to_string(),
                        // Node: `obj.error || obj`
                        detail: json!({
                            "error": obj.get("error").cloned().unwrap_or_else(|| obj.clone()),
                        }),
                    },
                    Some(&cid_for_stream),
                );
                continue;
            }
            // 白名单外的 type（Node: `KNOWN_SSE_TYPES`）
            if !sse::is_known_sse_type(obj_type) {
                sink.record(
                    EventInput {
                        severity: "notice".to_string(),
                        event_type: "unknown-type".to_string(),
                        agent_id: Some(agent_id_for_stream.clone()),
                        // Node: `未知 SSE 类型: ${obj.type || '(undefined)'}`
                        message: format!(
                            "未知 SSE 类型: {}",
                            if obj_type.is_empty() {
                                "(undefined)"
                            } else {
                                obj_type
                            }
                        ),
                        detail: json!({
                            "type": if obj_type.is_empty() { Value::Null } else { json!(obj_type) },
                        }),
                    },
                    Some(&cid_for_stream),
                );
                continue;
            }
            // 本流收到过哪些 type（Node 只对已识别且已建表的 agent 写这三个标志）。
            agents.note_sse_type(&agent_id_for_stream, obj_type);
            // `recordDelta` 的 type 归类 + text → 每流 lastDeltaType（phase）与 chars/tokens（/status）。
            if let (Some(kind), Some(text)) = (info.delta_kind, info.delta_text.as_deref()) {
                let tokens = bpe.encode_ordinary(text).len() as i64;
                agents.record_delta(&agent_id_for_stream, kind, text, tokens, capture::now_ms());
            }
            // 真实 token（`message_start` 输入侧 / `message_delta` 输出侧）。
            if info.usage_input_tokens > 0 {
                agents.record_tokens(
                    &agent_id_for_stream,
                    0,
                    info.usage_input_tokens,
                    capture::now_ms(),
                );
            }
            if info.usage_output_tokens > 0 {
                agents.record_tokens(
                    &agent_id_for_stream,
                    info.usage_output_tokens,
                    0,
                    capture::now_ms(),
                );
            }
            // stop_reason 语义分流（同 agent 同 stopReason 流内去重）。
            if let Some(sr) = info.stop_reason.as_deref() {
                if agents.note_stop_reason(&agent_id_for_stream, sr, capture::now_ms()) {
                    if let Some((severity, event_type, message)) = stop_reason_event(sr) {
                        sink.record(
                            EventInput {
                                severity: severity.to_string(),
                                event_type: event_type.to_string(),
                                agent_id: Some(agent_id_for_stream.clone()),
                                message: message.to_string(),
                                detail: json!({ "stopReason": sr }),
                            },
                            Some(&cid_for_stream),
                        );
                    }
                }
            }
        }
        // 每 chunk 同步写 capture 的 SSE 快照（Node data 回调里那段）：
        // `sseBytes = parts.join('\n\n') [+ '\n\n' + tail]`、`sseBlocks`、`sseBytesSize`。
        let mut bytes = sse_joined.clone();
        if !sse_joined.is_empty() && !sse_buf.is_empty() {
            bytes.extend_from_slice(b"\n\n");
        }
        bytes.extend_from_slice(&sse_buf);
        ring.set_sse_progress(&cid_for_stream, bytes, sse_blocks.clone(), sse_size);
        // Node 的流式进度广播节流（`REQUEST_BROADCAST_THROTTLE_MS`）：长流的 `sseBytesSize`
        // 不必等到结束才更新（SSE 的 `respBodySize` 按 Node 恒为 0）。结束时的最终帧仍由
        // `CaptureEndGuard` 强制广播。
        // 非 SSE 分支 Node 不在 data 回调里广播（只有 `on('end')`），这里也不广播。
        let bcast_now = capture::now_ms();
        if bcast_now - last_req_bcast_ts >= REQUEST_BROADCAST_THROTTLE_MS {
            last_req_bcast_ts = bcast_now;
            if let Some(summary) = ring.summary_of(&cid_for_stream, bcast_now) {
                requests_bcast.send(RequestEvent::Update(with_phase(&agents, summary)));
            }
        }
    });
    let tracked = MarkComplete {
        inner: Box::pin(stream),
        completed: completed.clone(),
    };
    let body = match stream_reg {
        Some((_, rx)) => Body::from_stream(CancellableBody {
            inner: Box::pin(tracked),
            cancel: Some(rx),
            done: false,
            client_aborted: client_aborted.clone(),
        }),
        None => Body::from_stream(tracked),
    };
    builder
        .body(body)
        .unwrap_or_else(|e| error_502(&format!("failed to build response: {e}")))
}

/// `stop_reason` 语义分流表（`proxy.js:2138` 的 `srMap`）。表外的 stop_reason
/// （`end_turn` / `stop_sequence` / `tool_use`）**不报**，与 Node 一致。
fn stop_reason_event(sr: &str) -> Option<(&'static str, &'static str, &'static str)> {
    match sr {
        "refusal" => Some(("error", "stop-reason-refusal", "模型拒答 (refusal)")),
        "overload" => Some(("error", "stop-reason-overload", "上游过载 (overload)")),
        "max_tokens" => Some(("warn", "stop-reason-max-tokens", "输出被截断 (max_tokens)")),
        "pause_turn" => Some(("warn", "stop-reason-pause-turn", "长任务暂停 (pause_turn)")),
        _ => None,
    }
}

/// Upstream connect failure: 502 with the Node-shaped JSON error body.
fn error_502(message: &str) -> Response {
    json_response(
        StatusCode::BAD_GATEWAY,
        &json!({ "error": "proxy_error", "message": message }),
    )
}

/// Exposed for tests: the exact upstream URL a given raw request target maps to.
#[cfg(test)]
pub fn upstream_url_for(upstream: &Upstream, raw_target: &str) -> String {
    format!(
        "{}://{}{}{}",
        upstream.scheme, upstream.authority, upstream.path_prefix, raw_target
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// cid 校验必须与 Node 的 `/^[a-f0-9-]{8,64}$/i` 同义（`is_valid_cid` 是
    /// `/event/detail*` 的 400 判据）。
    #[test]
    fn cid_validation_matches_the_node_regex() {
        // 本实现生成的 cid 形态（`{:x}-{:x}`）
        assert!(is_valid_cid(&crate::proxy::capture::new_cid()));
        assert!(is_valid_cid("12345678"));
        assert!(is_valid_cid("ABCDEF12-3456")); // 带 i → 大写合法
        assert!(is_valid_cid(&"a".repeat(64)));
        // 太短 / 太长 / 非法字符
        assert!(!is_valid_cid("1234567"));
        assert!(!is_valid_cid(&"a".repeat(65)));
        assert!(!is_valid_cid("12345678g"));
        assert!(!is_valid_cid("12345678_"));
        assert!(!is_valid_cid(""));
        assert!(!is_valid_cid("not-a-uuid-at-all!"));
    }

    /// 头快照：键小写、同名多值按 Node 的 `, ` 拼。
    #[test]
    fn header_pairs_lowercase_and_join_duplicates() {
        let mut h = HeaderMap::new();
        h.append("accept", "text/plain".parse().unwrap());
        h.append("accept", "application/json".parse().unwrap());
        h.insert("host", "api.anthropic.com".parse().unwrap());
        let pairs = header_pairs(&h);
        let get = |k: &str| {
            pairs
                .iter()
                .find(|(name, _)| name == k)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(get("host").as_deref(), Some("api.anthropic.com"));
        assert_eq!(
            get("accept").as_deref(),
            Some("text/plain, application/json")
        );
    }

    #[test]
    fn path_prefix_strips_one_trailing_slash_only() {
        let u = Upstream::parse("http://127.0.0.1:1234").unwrap();
        assert_eq!(u.path_prefix, "");
        assert_eq!(u.host_header, "127.0.0.1");
        assert_eq!(u.authority, "127.0.0.1:1234");

        let u = Upstream::parse("http://127.0.0.1:1234/").unwrap();
        assert_eq!(u.path_prefix, "");
        assert_eq!(u.authority, "127.0.0.1:1234");

        let u = Upstream::parse("http://127.0.0.1:1234/api").unwrap();
        assert_eq!(u.path_prefix, "/api");

        let u = Upstream::parse("http://127.0.0.1:1234/api/").unwrap();
        assert_eq!(u.path_prefix, "/api");

        // `replace(/\/$/,'')` removes exactly one slash.
        let u = Upstream::parse("http://127.0.0.1:1234/api//").unwrap();
        assert_eq!(u.path_prefix, "/api/");
    }

    #[test]
    fn default_port_is_omitted_like_node() {
        let u = Upstream::parse("http://example.com/v1").unwrap();
        assert_eq!(u.authority, "example.com");
        let u = Upstream::parse("https://example.com:8443").unwrap();
        assert_eq!(u.authority, "example.com:8443");
        assert_eq!(u.scheme, "https");
    }

    #[test]
    fn ipv6_host_keeps_brackets_in_host_header() {
        let u = Upstream::parse("http://[::1]:1234").unwrap();
        assert_eq!(u.host_header, "[::1]");
        assert_eq!(u.authority, "[::1]:1234");
        assert!(u.is_loopback());
    }

    #[test]
    fn upstream_url_concatenation_preserves_query() {
        let u = Upstream::parse("http://127.0.0.1:1234/api").unwrap();
        assert_eq!(
            upstream_url_for(&u, "/v1/messages?beta=1"),
            "http://127.0.0.1:1234/api/v1/messages?beta=1"
        );
        let u = Upstream::parse("http://127.0.0.1:1234").unwrap();
        assert_eq!(
            upstream_url_for(&u, "/v1/messages"),
            "http://127.0.0.1:1234/v1/messages"
        );
    }

    #[test]
    fn hop_by_hop_detection() {
        for h in [
            "transfer-encoding",
            "connection",
            "keep-alive",
            "upgrade",
            "proxy-authenticate",
            "proxy-authorization",
        ] {
            assert!(is_hop_by_hop(h), "{h}");
        }
        for h in ["content-type", "x-upstream", "retry-after", "content-length"] {
            assert!(!is_hop_by_hop(h), "{h}");
        }
    }

    // ── Agent 状态机接线（下一步 3）的纯函数部分 ──

    /// 查询参数与 Node 的 `URLSearchParams.get` 同义：取第一个、做百分号解码、`+` 变空格。
    #[test]
    fn query_param_matches_url_search_params() {
        assert_eq!(query_param("/agent/prompts?id=cc%3A1234", "id").as_deref(), Some("cc:1234"));
        assert_eq!(query_param("/agent/prompts?id=a&id=b", "id").as_deref(), Some("a"), "取第一个");
        assert_eq!(query_param("/session?id=x+y", "id").as_deref(), Some("x y"), "+ 解码为空格");
        assert_eq!(query_param("/session?id=", "id").as_deref(), Some(""));
        assert_eq!(query_param("/agent/prompts?other=1", "id"), None);
        assert_eq!(query_param("/agent/prompts", "id"), None, "无 query 串");
    }

    /// `/config/idle` 的 `Number(body.main)` 归一化（含空串/布尔/null 的 JS 语义）。
    #[test]
    fn js_number_matches_the_number_constructor_cases_we_accept() {
        assert_eq!(js_number(Some(&json!(5000))), Some(5000.0));
        assert_eq!(js_number(Some(&json!(1.5))), Some(1.5));
        assert_eq!(js_number(Some(&json!("5000"))), Some(5000.0), "字符串数字可接受");
        assert_eq!(js_number(Some(&json!(" 5000 "))), Some(5000.0));
        assert_eq!(js_number(Some(&json!(""))), Some(0.0), "JS: Number('') === 0");
        assert_eq!(js_number(Some(&Value::Null)), Some(0.0), "JS: Number(null) === 0");
        assert_eq!(js_number(Some(&json!(true))), Some(1.0));
        assert_eq!(js_number(Some(&json!(false))), Some(0.0));
        assert_eq!(js_number(None), None, "缺 main → NaN → 拒绝");
        assert_eq!(js_number(Some(&json!("abc"))), None, "非数字字符串 → NaN → 拒绝");
        assert_eq!(js_number(Some(&json!({}))), None);
        // "Infinity" 能被 Rust 解析成 inf，但调用点会用 is_finite 挡掉（与 Node 的 !isFinite 一致）
        assert!(!js_number(Some(&json!("Infinity"))).unwrap().is_finite());
    }

    /// phase 补写依赖 summary 里的 `agentId` / `ended`；结束后强制 null。
    #[test]
    fn apply_phase_reads_agent_state_and_respects_ended() {
        let agents = AgentRegistry::new();
        agents.record_delta("cc:abcdefgh", sse::DeltaKind::Thinking, "hmm", 1, 1000);
        let mut pending = json!({"agentId": "cc:abcdefgh", "ended": false, "phase": Value::Null});
        apply_phase(&agents, &mut pending);
        assert_eq!(pending["phase"], "think", "未结束 + 已知 agent → 用 lastDeltaType");

        let mut ended = json!({"agentId": "cc:abcdefgh", "ended": true});
        apply_phase(&agents, &mut ended);
        assert_eq!(ended["phase"], Value::Null, "已结束一律 null");

        let mut unknown = json!({"agentId": "unknown", "ended": false});
        apply_phase(&agents, &mut unknown);
        assert_eq!(unknown["phase"], Value::Null);

        let mut missing = json!({"agentId": Value::Null, "ended": false});
        apply_phase(&agents, &mut missing);
        assert_eq!(missing["phase"], Value::Null);
    }

    /// stop_reason 分流表：表内四条 + 表外不报（Node 的 `srMap`）。
    #[test]
    fn stop_reason_table_matches_node() {
        assert_eq!(
            stop_reason_event("refusal"),
            Some(("error", "stop-reason-refusal", "模型拒答 (refusal)"))
        );
        assert_eq!(
            stop_reason_event("max_tokens"),
            Some(("warn", "stop-reason-max-tokens", "输出被截断 (max_tokens)"))
        );
        assert!(stop_reason_event("end_turn").is_none(), "正常结束不报");
        assert!(stop_reason_event("tool_use").is_none());
        assert!(stop_reason_event("stop_sequence").is_none());
    }

    /// `_streamEnded` 判据的全组合（`stream_ended_for_teardown`）。
    ///
    /// 逐条对应 Node 的 `_finalizeRequestCapture` 调用路径；**唯一 `false` 的组合是
    /// "非 SSE + 正常走完 + 没报错"** —— Node 的非 SSE `proxyRes.on('end')` 不调
    /// `_finalizeRequestCapture`（真实 quirk：详情流订阅者只收心跳）。
    #[test]
    fn stream_ended_covers_every_node_finalize_path() {
        // (is_sse, saw_error, completed) -> ended ?
        let cases: &[(bool, bool, bool, bool, &str)] = &[
            // SSE：全部收尾都 finalize（正常 end / error / 客户端断开 / 连接失败）
            (true, false, true, true, "SSE 正常结束"),
            (true, false, false, true, "SSE 客户端断开/被 kill"),
            (true, true, true, true, "SSE 上游流中断"),
            (true, true, false, true, "SSE 上游流中断 + 未走完"),
            // 非 SSE：error / 断开才 finalize
            (false, false, false, true, "非 SSE 客户端断开"),
            (false, true, false, true, "非 SSE 上游流中断"),
            (false, true, true, true, "非 SSE 上游报错但流已走完"),
            // 唯一 false：非 SSE 正常结束（Node quirk）
            (false, false, true, false, "非 SSE 正常结束 —— 不置位"),
        ];
        for (is_sse, saw_error, completed, want, why) in cases {
            assert_eq!(
                stream_ended_for_teardown(*is_sse, *saw_error, *completed),
                *want,
                "{why}"
            );
        }
    }

    /// 上游"收满 content-length"判据：这是 Node `proxyRes.on('end')` 在带长度上游上的等价物。
    /// 差分实测过它的必要性：content-length 被转发给客户端后 hyper 不再 poll `None`，
    /// 只靠 `MarkComplete` 会把正常结束误判成客户端断开（`_streamEnded` 被多置一次）。
    #[test]
    fn declared_len_reached_matches_upstream_end() {
        assert!(!declared_len_reached(0, None), "无长度上游不能靠这一支判完成");
        assert!(!declared_len_reached(10, None));
        assert!(!declared_len_reached(0, Some(26)));
        assert!(!declared_len_reached(25, Some(26)), "还差 1 字节不算走完");
        assert!(declared_len_reached(26, Some(26)), "收满即完成");
        assert!(declared_len_reached(27, Some(26)), "超过也算（防御性）");
    }

    /// `CaptureEndGuard` 的两条非 SSE 收尾逐条对齐 Node：    /// - **上游流中断**：`respBody` 被改写成 `proxy stream error: <msg>`（partial 字节丢弃）、
    ///   `respBodySize` 跟着变成该串长度、`_streamEnded = true`；
    /// - **正常结束**：保留镜像到的完整 body、**不**置 `_streamEnded`（Node 的 quirk）。
    #[test]
    fn capture_end_guard_matches_node_non_sse_teardown() {
        use std::sync::atomic::AtomicBool;
        let ring = Arc::new(capture::CaptureRing::new());
        let agents = Arc::new(AgentRegistry::new());
        let mk_guard = |cid: &str, saw_error: bool, completed: bool, body: &[u8], err: &str| {
            let guard = CaptureEndGuard {
                ring: ring.clone(),
                cid: cid.to_string(),
                requests: broadcast::RequestBroadcaster::new(),
                detail: crate::proxy::detail::DetailBroadcaster::new(),
                agents: agents.clone(),
                agent_id: agents::UNKNOWN_AGENT.to_string(),
                is_sse: false,
                completed: Arc::new(AtomicBool::new(completed)),
                saw_error: Arc::new(AtomicBool::new(saw_error)),
                resp_body: Some(Arc::new(std::sync::Mutex::new(body.to_vec()))),
                error_text: Some(Arc::new(std::sync::Mutex::new(err.to_string()))),
                resp_headers: Vec::new(),
                stream: None,
                clear_stop_reason_for: None,
                sink: EventSink {
                    log: Arc::new(crate::proxy::events::EventLog::new()),
                    bcast: crate::proxy::events::EventsBroadcaster::new(),
                    capture: ring.clone(),
                },
                client_aborted: Arc::new(AtomicBool::new(false)),
                raw_all: None,
                sse_tail_len: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                watchdog_armed: Arc::new(AtomicBool::new(false)),
            };
            drop(guard);
        };

        // ① 上游流中断
        let cid = "aaaaaaaa-1111";
        ring.begin(cid, "POST", "/v1/messages", 1_000);
        ring.on_response_headers(cid, 200, false, 1_010);
        mk_guard(cid, true, false, b"partial-bytes", "boom");
        let d = ring.detail_of(cid, false).expect("detail");
        assert_eq!(d["resp"]["body"], "proxy stream error: boom");
        assert_eq!(
            d["resp"]["bodySize"],
            "proxy stream error: boom".len() as i64
        );
        assert!(
            ring.stream_snapshot(cid).unwrap().0,
            "上游流中断必须置 _streamEnded"
        );

        // ② 正常结束
        let cid2 = "bbbbbbbb-2222";
        ring.begin(cid2, "POST", "/v1/messages", 2_000);
        ring.on_response_headers(cid2, 200, false, 2_010);
        mk_guard(cid2, false, true, b"{\"ok\":true}", "");
        let d2 = ring.detail_of(cid2, false).expect("detail");
        assert_eq!(d2["resp"]["body"], "{\"ok\":true}", "正常结束保留镜像 body");
        assert_eq!(d2["resp"]["bodySize"], 11);
        assert!(
            !ring.stream_snapshot(cid2).unwrap().0,
            "非 SSE 正常结束不置 _streamEnded（Node quirk）"
        );
    }

    /// SSE 收尾事件的分流 —— 逐条对齐 Node 的三条 `recordEvent` 路径。
    #[test]
    fn sse_teardown_event_covers_node_paths() {
        // 1. 正常走完：`proxyRes.on('end')`，两条都不报（走 no-delta / 字节损坏分流）
        assert_eq!(sse_teardown_event(false, true, false, true), None);
        // 2. 上游流错且非 clientAborted → `upstream-stream-error`
        assert_eq!(
            sse_teardown_event(true, false, false, true),
            Some(TeardownEvent::UpstreamStreamError)
        );
        // 3. 客户端断开（未走完、非报错、流已注册）→ `client-disconnect`
        assert_eq!(
            sse_teardown_event(false, false, false, true),
            Some(TeardownEvent::ClientDisconnect)
        );
        // 4. unknown agent 的 SSE 断开：Node 的 `if (stream && !stream.closed)` 恒假 → 不报
        assert_eq!(sse_teardown_event(false, false, false, false), None);
        // 5. `/agent/kill`（clientAborted）→ 两条都抑制（destroy 上游的连锁 error 不是真故障）
        assert_eq!(sse_teardown_event(true, false, true, true), None);
        assert_eq!(sse_teardown_event(false, false, true, true), None);
        // 6. 报错但流也走完了 → 仍按 upstream-stream-error（Node 的 error 路径优先）
        assert_eq!(
            sse_teardown_event(true, true, false, true),
            Some(TeardownEvent::UpstreamStreamError)
        );
    }

    /// SSE 守卫真的把收尾事件写进事件环，且形状对上（差分只证明"Node 也发"，
    /// 这里钉住"本实现发的是这个形状"）。
    #[test]
    fn capture_end_guard_emits_sse_teardown_events() {
        use std::sync::atomic::{AtomicBool, AtomicUsize};
        let ring = Arc::new(capture::CaptureRing::new());
        let log = Arc::new(crate::proxy::events::EventLog::new());
        let agents = Arc::new(AgentRegistry::new());

        #[allow(clippy::too_many_arguments)]
        let run = |cid: &str,
                   saw_error: bool,
                   completed: bool,
                   aborted: bool,
                   agent: &str,
                   raw: Option<Vec<u8>>,
                   tail: usize| {
            ring.begin(cid, "POST", "/v1/messages", 1_000);
            ring.on_response_headers(cid, 200, true, 1_010);
            let guard = CaptureEndGuard {
                ring: ring.clone(),
                cid: cid.to_string(),
                requests: broadcast::RequestBroadcaster::new(),
                detail: crate::proxy::detail::DetailBroadcaster::new(),
                agents: agents.clone(),
                agent_id: agent.to_string(),
                is_sse: true,
                completed: Arc::new(AtomicBool::new(completed)),
                saw_error: Arc::new(AtomicBool::new(saw_error)),
                resp_body: None,
                error_text: Some(Arc::new(std::sync::Mutex::new("boom".to_string()))),
                resp_headers: Vec::new(),
                stream: None,
                clear_stop_reason_for: None,
                sink: EventSink {
                    log: log.clone(),
                    bcast: crate::proxy::events::EventsBroadcaster::new(),
                    capture: ring.clone(),
                },
                client_aborted: Arc::new(AtomicBool::new(aborted)),
                raw_all: raw.map(|b| Arc::new(std::sync::Mutex::new(b))),
                sse_tail_len: Arc::new(AtomicUsize::new(tail)),
                watchdog_armed: Arc::new(AtomicBool::new(false)),
            };
            drop(guard);
        };

        // ① 客户端断开（未走完）
        agents.begin_request("cc:cd", None, 0, capture::now_ms() - 5_000);
        run("cdcdcdcd-0001", false, false, false, "cc:cd", None, 0);
        // ② 上游流错
        agents.begin_request("cc:se", None, 0, capture::now_ms() - 5_000);
        run("sesesese-0002", true, false, false, "cc:se", None, 0);
        // ③ 正常结束但整流无 delta（>1s）→ no-delta-on-close
        agents.begin_request("cc:nd", None, 0, capture::now_ms() - 5_000);
        run("ndndndnd-0003", false, true, false, "cc:nd", None, 7);
        // ④ 正常结束 + 原始字节损坏 → upstream-byte-corruption
        agents.begin_request("cc:bc", None, 0, capture::now_ms() - 5_000);
        run(
            "bcbcbcbc-0004",
            false,
            true,
            false,
            "cc:bc",
            Some(vec![0xff, 0x41, 0x41, 0x41, 0xff]),
            3,
        );

        let list = log.list();
        let find = |t: &str, agent: &str| {
            list["events"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["type"] == t && e["agentId"] == agent)
                .cloned()
                .unwrap_or_else(|| panic!("缺事件 {t} / {agent}"))
        };
        let cd = find("client-disconnect", "cc:cd");
        assert_eq!(cd["severity"], "warn");
        assert_eq!(cd["message"], "cc 断开 (流未完成)");
        assert_eq!(cd["detail"]["correlationId"], "cdcdcdcd-0001");

        let se = find("upstream-stream-error", "cc:se");
        assert_eq!(se["severity"], "error");
        assert_eq!(se["message"], "上游流中断");
        assert_eq!(se["detail"]["err"], "boom");

        let nd = find("no-delta-on-close", "cc:nd");
        assert_eq!(nd["severity"], "warn");
        assert_eq!(nd["detail"]["bufLen"], 7);

        let bc = find("upstream-byte-corruption", "cc:bc");
        assert_eq!(bc["severity"], "warn");
        assert_eq!(bc["detail"]["clusters"], 2);
        assert_eq!(bc["detail"]["totalBadBytes"], 2);
        assert_eq!(bc["detail"]["sseBytesLen"], 5);
    }
}
