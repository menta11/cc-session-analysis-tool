//! Agent 身份解析 + 每流状态 + 显示状态机 —— `proxy.js` 的 `getAgentId` / `ensureAgent` /
//! `freshStreamState` / `recordDelta` / `recordTokens` / `calcAgentStatus` / `buildStatus` /
//! `killAgentStreams` 的移植。
//!
//! 这是捕获环之外的**第二个诊断层结构**（第一个是 `capture.rs` 的请求环、第二个是
//! `events.rs` 的事件环，加上本模块的 agent 表）。三者独立：Node 里分别是
//! `captureRing` / `events` / `agents` 三个 Map，不要合并语义。
//!
//! ## 本轮（P0-2 / P0-3）补齐了什么
//!
//! dashboard 轮询 `/status` 并读 `data.agents[]`，所以 `buildStatus()` 那台状态机
//! （`calcAgentStatus`）**有了真实消费者**，本轮整台迁移：
//! - 累计量 `chars` / `deltas`（上限 60）/ `requestCount` / `totalTokens` / `inputTokens` /
//!   `lastInputTokens` / `estOutTokens`；
//! - 每流状态 `StreamState`（`freshStreamState` 的**整体重置**语义，字段集中一处，
//!   不散落手列）；
//! - `recordDelta`（tokenizer 数真实 token + JS `String.length` 的 UTF-16 计数）；
//! - `recordTokens`（`message_start` 的输入侧 / `message_delta` 的 `output_tokens`）；
//! - `calcAgentStatus(a, now, isSubagent)`（IDLE / STREAM(think|text) / SSE_STUCK / WORK /
//!   WAITING / DISCONNECTED）与 `/status` 的完整载荷（`ts` / `agents` / `idleCleanupMsMain`）；
//! - `agentMeta`（name → `{sessionId, isSubagent}`），`/status` 的 `sessionId` / `isSubagent`
//!   与 dashboard 的按 session 分组都吃它。
//!
//! `agentFingerprints`（fingerprint key → name）仍然**故意不建表**：名字是 key 的纯函数
//! （`cc:<8>` / `sub:<8>` / `hermes…` / `<uaKey>[#userId]`），缓存不改变任何可观测行为。
//!
//! ## 本轮（P0-5）补齐了什么
//!
//! - **idle cleanup**：`isAgentActive` / `sessionHasActiveSub` / `sessionMainsAllIdle` 三个
//!   判定 + `runCleanupPass` 的四个 pass（孤儿 sub 强制入列、阈值筛选、main 被同 session
//!   活 sub 救回、真正删除）整台迁移，`CleanupReport` 携带 `/cleanup/debug` 需要的全部信息；
//! - **`_emitStateTransition` 的十个转换事件**：转换白名单表 + `onlyIfMs` 门槛 + 首次建表
//!   不发事件 + `*→DISCONNECTED` 兜底，全部照抄；`_lastState` 用 `last_state` 表实现；
//! - **`_tickCleanup`**：一次 tick = 先对每个 agent 比对状态并发转换事件，再跑一轮 cleanup。
//!
//! 这三件的**事件写入**（`recordEvent`）不住在本模块：`tick()` 只返回"该发哪些事件"，
//! 由 `router.rs` 的 `EventSink` 落环 + 广播 + 写 capture 详情 —— 与 Node 的模块级
//! `recordEvent` 相比，只是把副作用移到了唯一调用方，判定逻辑一字未改。
//!
//! `_logExpired` 的**控制台输出**未迁：它只 `console.log` 候选/救回明细，不改任何 HTTP
//! 载荷或状态，属观测旁路；`/cleanup/debug` 的结构化载荷已完整迁移（那才是有消费者的部分）。
//!
//! ## 流末「无 delta」分流（2026-09-15 补齐）
//!
//! `stream_end_diagnostic` 移植 `proxyRes.on('end')` 里那段严格分流
//! （`no-delta-tool-only` / `upstream-empty-stream` / `no-delta-on-close`），
//! 由 `router.rs` 的 `CaptureEndGuard` 在上游正常结束时调用。至此本模块已无「未搬」项；
//! 事件来源的完整清单见 `events.rs` 模块头。

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use axum::http::HeaderMap;
use serde_json::{json, Map, Value};
use tokio::sync::oneshot;

use crate::proxy::sse::DeltaKind;

/// `isLLMRequest(req)`：只有真正的 LLM 调用才算 agent，其它（`GET /version`、
/// `GET /models`、ollama 探测…）一律 `'unknown'`，不进 agent 表。
/// Node 判据是 `req.method === 'POST'` **加上** `req.url.includes(p)`（含 query）。
pub fn is_llm_request(method: &str, target: &str) -> bool {
    method == "POST"
        && ["/v1/messages", "/chat/completions", "/completions"]
            .iter()
            .any(|p| target.contains(p))
}

/// Node 里 `!agentId` 落到 `'unknown'` 的哨兵值。它与 `null` 在 dashboard 里同一条分支
/// （`req.agentId && req.agentId !== 'unknown'`），但 `phase` 判据必须把它排除。
pub const UNKNOWN_AGENT: &str = "unknown";

/// `prompts` 列表上限（Node: `if (a.prompts.length > 100) a.prompts.shift()`）。
pub const MAX_PROMPTS: usize = 100;
/// `deltas` 环形上限（Node: `if (a.deltas.length > 60) a.deltas.shift()`）。
pub const MAX_DELTAS: usize = 60;

// ── `calcAgentStatus` 的阈值（逐条对齐 `proxy.js:230-248`）──
/// 无 delta 超过此时长 → `SSE_STUCK`（10s 误报率高，60s 才算真卡位）。
pub const STREAM_STUCK_MS: i64 = 60_000;
/// sub-agent `tool_use` 后 30s 不回下一流算孤儿（显示用）。
pub const WORK_FOLLOWUP_MS_SUB: i64 = 30_000;
/// main agent `tool_use` 后 5min 兜底（显示用）。
pub const WORK_DISPLAY_MS_MAIN: i64 = 300_000;
/// `end_turn` 后保持 STREAM 视觉的收尾缓冲（cc 终端渲染滞后于 SSE 接收）。
pub const STREAM_TAIL_MS: i64 = 3_000;
/// `killAgentStreams` 后 DISCONNECTED 态的存活窗口（Node 的局部常量）。
pub const DISCONNECT_TTL_MS: i64 = 60_000;
/// WORK 期间 cc 发新流 → 主动切 WAITING 的有效窗口（Node 的局部常量）。
pub const PENDING_NEXT_TTL_MS: i64 = 5_000;
/// 输入侧 token 估算的 chars/token（Node `CHARS_PER_INPUT_TOKEN`）。
pub const CHARS_PER_INPUT_TOKEN: f64 = 2.5;

// ── idle cleanup 的阈值（逐条对齐 `proxy.js:246-248` / `1051` / `1072`）──
/// `IDLE_CLEANUP_MS_SUB`：sub-agent 非正常结束（tool_use 中断 / WORK）的清理缓冲；
/// 正常 `end_turn` 的 sub 用完即清（limit=0）。
pub const IDLE_CLEANUP_MS_SUB: i64 = 60_000;
/// `CLEANUP_INTERVAL_MS`：`_tickCleanup` 的自走 timer 周期。旧实现嵌在 `buildStatus()` 里，
/// 只在 dashboard 轮询 `/status` 时才跑；标签页 hidden / 应用未打开 → 轮询停 → 2h+ 不清。
/// 独立 timer 解耦，node 与 Rust 都是 10s 一轮。
pub const CLEANUP_INTERVAL_MS: u64 = 10_000;
/// `WORK_FOLLOWUP_MS_MAIN`：main agent 的 WORK 窗口兜底（长 tool 容忍 10min）。
pub const WORK_FOLLOWUP_MS_MAIN: i64 = 600_000;
/// `SUB_ALIVE_FOR_MAIN_MS`：main 视角下"sub 还活着"的宽窗口。
///
/// 为什么与 `IDLE_CLEANUP_MS_SUB` 是两个不同的 60s/10min：父看子要**宽松**（子跑长 tool
/// 时 main 不能被清），父死判孤儿在 pass 0 用**严判**（60s）。两套阈值分场景，不冲突。
pub const SUB_ALIVE_FOR_MAIN_MS: i64 = 600_000;

/// 一条 delta 样本（Node `a.deltas.push({ ts, tokens, chars })`）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct DeltaSample {
    ts: i64,
    tokens: i64,
    chars: i64,
}

/// 每流状态 —— `freshStreamState(now, opts)` 的逐字段移植。
/// 流开始时**整体替换**（`a.stream = freshStreamState(...)`），所以加字段只改这一处。
#[derive(Debug, Clone)]
struct StreamState {
    start_ts: i64,
    last_delta_ts: i64,
    last_delta_type: Option<&'static str>,
    phase_start_ts: i64,
    tokens: i64,
    last_out_tokens: i64,
    last_real_tps: i64,
    stop_reason: Option<String>,
    stop_reason_ts: i64,
    end_ts: i64,
    req_ts: i64,
    saw_message_start: bool,
    saw_any_delta: bool,
    saw_any_block: bool,
    saw_stop_reason: bool,
    killed_at: i64,
    pending_next_request: i64,
}

impl Default for StreamState {
    fn default() -> Self {
        Self {
            start_ts: 0,
            last_delta_ts: 0,
            last_delta_type: None,
            phase_start_ts: 0,
            tokens: 0,
            last_out_tokens: 0,
            last_real_tps: 0,
            stop_reason: None,
            stop_reason_ts: 0,
            end_ts: 0,
            req_ts: 0,
            saw_message_start: false,
            saw_any_delta: false,
            saw_any_block: false,
            saw_stop_reason: false,
            killed_at: 0,
            pending_next_request: 0,
        }
    }
}

/// 一条 agent 记录（`ensureAgent` 的字段集）。
#[derive(Debug, Default)]
struct Agent {
    /// `a.chars` 跨流累计（JS `String.length`，即 UTF-16 code unit 数）。
    chars: i64,
    /// `a.deltas`，上限 60（驱动 1s 窗口的 cps / tps）。
    deltas: VecDeque<DeltaSample>,
    /// `a.requestCount`
    request_count: i64,
    /// `a.lastTs`（任意活动都刷新）
    last_ts: i64,
    /// `a.lastActivityTs`（只有真实输出活动刷新，清理用）
    last_activity_ts: i64,
    /// `a.totalTokens`（真实 `output_tokens` 跨流累计）
    total_tokens: i64,
    /// `a.inputTokens`
    input_tokens: i64,
    /// `a.lastInputTokens`（单次请求的估算输入，dashboard 的 ↑ 读数）
    last_input_tokens: i64,
    /// `a.estOutTokens`（tokenizer 估算，跨流累计）
    est_out_tokens: i64,
    /// `a.prompts`：实时请求体列表 `[{ts, seq, body}]`，跟 agent 生灭。
    prompts: VecDeque<Value>,
    /// `activeStreams.get(agentId)`：活跃 SSE 流句柄（只有已识别 agent 会进这里）。
    streams: Vec<StreamHandle>,
    /// `a.stream`：每流状态（整体替换）。
    stream: StreamState,
}

/// `agentMeta.get(name)` —— `buildStatus` 的 `sessionId` / `isSubagent` 来源，也是
/// dashboard 按 session 分组的依据（只有 P2 / P3 分支会写）。
#[derive(Debug, Clone, Default)]
struct AgentMeta {
    session_id: Option<String>,
    is_subagent: bool,
}

/// 一条活跃 SSE 流。`cancel` 是「销毁两端」的实现手段：发信号后响应体流出错中断，
/// 客户端看到连接被截断（对应 Node 的 `res.destroy()` + `proxyReq.destroy()`）。
#[derive(Debug)]
struct StreamHandle {
    id: u64,
    cancel: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct Inner {
    agents: HashMap<String, Agent>,
    /// `agentMeta`（name → `{sessionId, isSubagent}`）
    meta: HashMap<String, AgentMeta>,
    /// `_lastStopReason`：同 agent 同 `stop_reason` 的流内去重锚点。
    /// 流开始/结束时清除（Node 如此），所以它等价于「每流只报首个 stop_reason」。
    stop_reasons: HashMap<String, String>,
    /// `_lastState`：状态转换 diff 表（`_emitStateTransition` 的 `prev` 来源）。
    ///
    /// **刻意不在 cleanup 删 agent 时清** —— Node 的 `_lastState` 也从不显式删除（全文只有
    /// `get`/`set` 两处），靠 Map 条目随 agent 被删后自然无人再读。所以同 id 的 agent 被清掉
    /// 又重建时，Node 会拿"上一个同 id agent 的末状态"当 prev 比对（可能因此多发一条转换事件）。
    /// 这是 quirk，照抄；"顺手清干净"反而会与 Electron 版不可比。
    last_state: HashMap<String, String>,
    next_stream_id: u64,
}

/// 线程安全的 agent 表（axum handler 与流式回调并发访问，内部加锁）。
#[derive(Default)]
pub struct AgentRegistry {
    inner: Mutex<Inner>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// `getAgentId(req, body)` —— 四级优先级逐条对齐 `proxy.js:668`：
    ///
    /// 1. `x-agent-id` 头原样返回（**不**建 agent 记录也不建 meta，Node 如此）；
    /// 2. `x-claude-code-session-id`（+ 可选 `x-claude-code-agent-id`）→
    ///    main = `cc:<sessionId 前 8 位>`、sub = `sub:<codeAgentId 前 8 位>`，
    ///    并写 `agentMeta{ sessionId, isSubagent }`；
    /// 3. `user-agent` 嗅探（第三方 SDK）：UA 主段 + body 指纹 →
    ///    `hermes` / `hermes:sub` / `<uaKey>[#userId]`，同步写 meta；
    /// 4. body 里的 `model`；
    /// 5. fallback：`x-api-key` / `authorization` 的**末 6 位** → `key:<6位>`；
    /// 6. 全不命中 → `'unknown'`。
    ///
    /// `target` 是**原始请求目标**（含 query），因为 Node 判据是 `req.url.includes(...)`。
    pub fn get_agent_id(
        &self,
        method: &str,
        target: &str,
        headers: &HeaderMap,
        body: Option<&Value>,
    ) -> String {
        // 只对真正的 LLM 调用识别成 agent（非 LLM 请求即使有 UA 也走 fallback）。
        if !is_llm_request(method, target) {
            return UNKNOWN_AGENT.to_string();
        }

        // Priority 1: 显式 x-agent-id（原样，不注册）
        if let Some(v) = header_str(headers, "x-agent-id") {
            return v;
        }

        // Priority 2: Claude Code 的 session + agent-id 头
        if let Some(session_id) = header_str(headers, "x-claude-code-session-id") {
            let code_agent_id = header_str(headers, "x-claude-code-agent-id");
            let is_subagent = code_agent_id.is_some();
            let name = match &code_agent_id {
                // sub-agent：每个 subagent 实例稳定
                Some(aid) => format!("sub:{}", slice8(aid)),
                // 无 agent-id = 本 session 的 main agent
                None => format!("cc:{}", slice8(&session_id)),
            };
            self.set_meta(&name, Some(session_id), is_subagent);
            return name;
        }

        // Priority 3: UA 嗅探
        if let Some(ua) = header_str(headers, "user-agent") {
            if let Some(named) = ua_agent_name(&ua, body) {
                self.set_meta(&named.name, Some(named.session_id), named.is_subagent);
                return named.name;
            }
        }

        // Priority 4: body 里的 model
        if let Some(model) = body.and_then(|p| p.get("model")).and_then(js_string) {
            return model;
        }

        // Fallback: API key 末 6 位
        let key = header_str(headers, "x-api-key")
            .or_else(|| header_str(headers, "authorization"))
            .unwrap_or_default();
        if !key.is_empty() {
            return format!("key:{}", last6(&key));
        }
        UNKNOWN_AGENT.to_string()
    }

    /// `agentMeta.set(name, { sessionId, isSubagent })`。
    fn set_meta(&self, name: &str, session_id: Option<String>, is_subagent: bool) {
        let mut inner = self.inner.lock().expect("agents poisoned");
        inner.meta.insert(
            name.to_string(),
            AgentMeta {
                session_id,
                is_subagent,
            },
        );
    }

    /// `ensureAgent(agentId)`：建记录（不存在时）。
    pub fn ensure_agent(&self, agent_id: &str) {
        let mut inner = self.inner.lock().expect("agents poisoned");
        inner.agents.entry(agent_id.to_string()).or_default();
    }

    /// agent 表里是否有这个名字。`/agent/prompts` 用它区分 200 / 404。
    pub fn has_agent(&self, agent_id: &str) -> bool {
        self.inner
            .lock()
            .expect("agents poisoned")
            .agents
            .contains_key(agent_id)
    }

    /// 一次已识别 agent 的新请求：`requestCount++`、存 prompt、估算输入 token、
    /// **整体重置本流状态**（`freshStreamState`）。
    ///
    /// 「重置」是显示状态正确性的关键：Node 在 `req.on('end')` 里执行
    /// `a.stream = freshStreamState(...)`，把 `lastDeltaType` 清回 `null`。不重置的话，
    /// 上一流残留的 `'text'` 会让新流在还没收到任何 delta 时就染上错的颜色。
    ///
    /// `body` 是已解析的请求体（Node 侧 `JSON.parse` 成功才 push prompt，失败只是不存）。
    /// `est_in` 是 `estimateInputTokens` 的结果（0 = 无估算）。
    /// 返回 `seq`（= 递增后的 `requestCount`）。
    pub fn begin_request(
        &self,
        agent_id: &str,
        body: Option<Value>,
        est_in: i64,
        now: i64,
    ) -> i64 {
        let mut inner = self.inner.lock().expect("agents poisoned");
        let a = inner.agents.entry(agent_id.to_string()).or_default();
        a.request_count += 1;
        if let Some(parsed) = body {
            a.prompts.push_back(json!({
                "ts": now,
                "seq": a.request_count,
                "body": parsed,
            }));
            if a.prompts.len() > MAX_PROMPTS {
                a.prompts.pop_front();
            }
        }
        // Node: `if (estIn > 0) { a.inputTokens += estIn; a.lastInputTokens = estIn; a.lastTs = now; }`
        if est_in > 0 {
            a.input_tokens += est_in;
            a.last_input_tokens = est_in;
            a.last_ts = now;
        }
        // WORK 期间 (上一流 endTs>0 + stopReason=tool_use/非 end_turn) cc 发新流 →
        // 主动置 pendingNextRequest 推进 WORK→WAITING。
        let prev_stop = a.stream.stop_reason.clone();
        let prev_end = a.stream.end_ts;
        let is_work_followup = prev_end > 0
            && prev_stop
                .as_deref()
                .map(|s| s != "end_turn" && s != "stop_sequence")
                .unwrap_or(false);
        let mut fresh = StreamState {
            start_ts: now,
            req_ts: now,
            ..Default::default()
        };
        if is_work_followup {
            fresh.pending_next_request = now;
        }
        a.stream = fresh;
        a.request_count
    }

    /// `recordDelta(agentId, text, type)` —— 全量字段（不只 phase 那两行）：
    ///
    /// ```js
    /// const chars = text.length; const tokens = countTokens(text);
    /// a.chars += chars; a.estOutTokens += tokens;
    /// if (type) { if (s.lastDeltaType !== type) s.phaseStartTs = now; s.lastDeltaType = type; }
    /// a.lastTs = now; s.lastDeltaTs = now; a.lastActivityTs = now;
    /// s.tokens += tokens;
    /// a.deltas.push({ ts: now, tokens, chars }); if (a.deltas.length > 60) a.deltas.shift();
    /// ```
    ///
    /// 注意 Node 这里**没有** `agentId !== 'unknown'` 守卫 —— 它会对 `'unknown'` 也调
    /// `ensureAgent`，于是 agent 表里可能出现一条 `unknown` 记录。这是 Node 的真实行为，
    /// 照抄（`phase` 那边另有 `!== 'unknown'` 守卫，两者不矛盾）。
    ///
    /// `tokens` 由调用方用 o200k_base 分词器算好传入（Node 的 `countTokens`）；
    /// `chars` 用 JS `String.length` 语义（UTF-16 code unit）就地算。
    pub fn record_delta(&self, agent_id: &str, kind: DeltaKind, text: &str, tokens: i64, now: i64) {
        let chars = text.encode_utf16().count() as i64;
        let ty = kind.as_js_str();
        let mut inner = self.inner.lock().expect("agents poisoned");
        let a = inner.agents.entry(agent_id.to_string()).or_default();
        a.chars += chars;
        a.est_out_tokens += tokens;
        if a.stream.last_delta_type != Some(ty) {
            a.stream.phase_start_ts = now;
        }
        a.stream.last_delta_type = Some(ty);
        a.last_ts = now;
        a.stream.last_delta_ts = now;
        a.last_activity_ts = now;
        a.stream.tokens += tokens;
        a.deltas.push_back(DeltaSample { ts: now, tokens, chars });
        if a.deltas.len() > MAX_DELTAS {
            a.deltas.pop_front();
        }
    }

    /// `recordTokens(agentId, outputTokens, inputTokens)`：
    /// `output > 0` 记真实输出（刷新 `lastActivityTs`）；`input > 0` 只累计（**不**刷新
    /// `lastActivityTs` —— 输入 token 来自 `message_start` 请求侧，后台请求也会报，
    /// 刷新会挡住 idle 清理）；最后总是 `a.lastTs = now`。
    pub fn record_tokens(&self, agent_id: &str, output_tokens: i64, input_tokens: i64, now: i64) {
        let mut inner = self.inner.lock().expect("agents poisoned");
        let a = inner.agents.entry(agent_id.to_string()).or_default();
        if output_tokens > 0 {
            a.total_tokens += output_tokens;
            a.stream.last_out_tokens = output_tokens;
            a.last_activity_ts = now;
        }
        if input_tokens > 0 {
            a.input_tokens += input_tokens;
        }
        a.last_ts = now;
    }

    /// `sawMessageStart` / `sawAnyBlock` / `sawAnyDelta` 标记 ——
    /// Node 只对**已识别且已建表**的 agent 写（`if (agentId !== 'unknown') { const _aa = agents.get(agentId); if (_aa) ... }`）。
    pub fn note_sse_type(&self, agent_id: &str, obj_type: &str) {
        if agent_id == UNKNOWN_AGENT {
            return;
        }
        let mut inner = self.inner.lock().expect("agents poisoned");
        let Some(a) = inner.agents.get_mut(agent_id) else {
            return;
        };
        match obj_type {
            "message_start" => a.stream.saw_message_start = true,
            "content_block_start" => a.stream.saw_any_block = true,
            "content_block_delta" => a.stream.saw_any_delta = true,
            _ => {}
        }
    }

    /// `message_delta` 的 stop_reason 处理：先写流状态（`sawStopReason` / `stopReason` /
    /// `stopReasonTs`），再做 `_lastStopReason` 去重。返回是否应上报事件。
    pub fn note_stop_reason(&self, agent_id: &str, stop_reason: &str, now: i64) -> bool {
        let mut inner = self.inner.lock().expect("agents poisoned");
        let Inner {
            agents,
            stop_reasons,
            ..
        } = &mut *inner;
        let a = agents.entry(agent_id.to_string()).or_default();
        a.stream.saw_stop_reason = true;
        a.stream.stop_reason = Some(stop_reason.to_string());
        a.stream.stop_reason_ts = now;
        if stop_reasons.get(agent_id).map(String::as_str) == Some(stop_reason) {
            return false;
        }
        stop_reasons.insert(agent_id.to_string(), stop_reason.to_string());
        true
    }

    /// Node `proxyRes.on('end')` 里流末的「无 delta」分流（`proxy.js:2242-2273`）：
    /// `no-delta-tool-only` / `upstream-empty-stream` / `no-delta-on-close`。
    ///
    /// 只在**正常结束**时调用（上游 `on('end')` 的等价点），且只对已识别 agent ——
    /// Node 这段整体在 `if (agentId !== 'unknown')` 里。`buf_len` = Node 的 `buf.length`，
    /// 即分帧后**未消费的尾巴**长度（不是 `sseBytesSize`）。
    ///
    /// 严格分流（Node 注释：避免误报 tool_use / 短 cache / 拒答 之类合法无 delta 流）：
    /// - A) `sawMessageStart` 且无 block 无 stopReason → 上游真发空流；
    /// - B) 有 block 或有 stopReason → 合法无 delta 流，仅 notice（且只在 `!sawAnyDelta` 时报）；
    /// - C) 三个标志全无且流持续 > 1s → 真的卡位；
    /// - D) 流 ≤ 1s → 不报（流太快没机会送）。
    pub fn stream_end_diagnostic(
        &self,
        agent_id: &str,
        buf_len: usize,
        now: i64,
    ) -> Option<crate::proxy::events::EventInput> {
        use crate::proxy::events::EventInput;
        if agent_id == UNKNOWN_AGENT {
            return None;
        }
        let inner = self.inner.lock().expect("agents poisoned");
        let s = &inner.agents.get(agent_id)?.stream;
        // Node: `if (s.lastDeltaTs === 0 && s.startTs > 0) { const durMs = ...; if (durMs > 1000) ... }`
        if s.last_delta_ts != 0 || s.start_ts <= 0 {
            return None;
        }
        let dur_ms = now - s.start_ts;
        if dur_ms <= 1000 {
            // D) 流 ≤ 1s：静默，不报
            return None;
        }
        let agent = Some(agent_id.to_string());
        if s.saw_any_block || s.saw_stop_reason {
            // B) 合法无 delta 流（tool_use-only / 拒答 / stop_turn）
            if s.saw_any_delta {
                return None;
            }
            Some(EventInput {
                severity: "notice".to_string(),
                event_type: "no-delta-tool-only".to_string(),
                agent_id: agent,
                message: "流内无文本 delta (tool_use / 拒答 / 短流)".to_string(),
                detail: json!({
                    "durMs": dur_ms,
                    "bufLen": buf_len,
                    "sawAnyBlock": s.saw_any_block,
                    "sawStopReason": s.saw_stop_reason,
                    "stopReason": s.stop_reason,
                }),
            })
        } else if s.saw_message_start {
            // A) 上游真发空流（message_start 后无内容直接 close）
            Some(EventInput {
                severity: "warn".to_string(),
                event_type: "upstream-empty-stream".to_string(),
                agent_id: agent,
                message: "上游空流 (message_start 后无内容)".to_string(),
                detail: json!({ "durMs": dur_ms, "bufLen": buf_len }),
            })
        } else {
            // C) 啥标志都没 + 流持续 > 1s → 真的卡位
            Some(EventInput {
                severity: "warn".to_string(),
                event_type: "no-delta-on-close".to_string(),
                agent_id: agent,
                message: "整流无 delta, chunk 卡位嫌疑".to_string(),
                detail: json!({ "durMs": dur_ms, "bufLen": buf_len }),
            })
        }
    }

    /// `a.stream.reqTs = 0`（SSE 响应头到达 / 非 SSE 结束时）。不建表。
    pub fn clear_req_ts(&self, agent_id: &str) {
        let mut inner = self.inner.lock().expect("agents poisoned");
        if let Some(a) = inner.agents.get_mut(agent_id) {
            a.stream.req_ts = 0;
        }
    }

    /// 该 agent 当前流的 `lastDeltaType`（Node 的取值就是 `'thinking' | 'text'`）。
    pub fn last_delta_type(&self, agent_id: &str) -> Option<&'static str> {
        self.inner
            .lock()
            .expect("agents poisoned")
            .agents
            .get(agent_id)
            .and_then(|a| a.stream.last_delta_type)
    }

    /// `_captureSummary` 的 `phase` 规则，逐字对齐：
    ///
    /// ```js
    /// let phase = null;
    /// if (e.endAt == null && e.agentId && e.agentId !== 'unknown') {
    ///   const _dt = agents.get(e.agentId)?.stream?.lastDeltaType;
    ///   phase = _dt === 'thinking' ? 'think' : (_dt === 'text' ? 'text' : null);
    /// }
    /// ```
    /// 即：**只有请求未结束、且 agentId 已知（非空且非 `'unknown'`）** 时才取
    /// `lastDeltaType`；否则一律 `null`（dashboard 退回默认橙）。
    pub fn phase_for(&self, agent_id: Option<&str>, ended: bool) -> Option<&'static str> {
        if ended {
            return None;
        }
        let id = agent_id?;
        if id.is_empty() || id == UNKNOWN_AGENT {
            return None;
        }
        match self.last_delta_type(id) {
            Some("thinking") => Some("think"),
            Some("text") => Some("text"),
            _ => None,
        }
    }

    /// 注册一条活跃 SSE 流（Node 的 `activeStreams.get(agentId).add(stream)` +
    /// `a.openStreams++`）。返回 `(streamId, 取消接收端)`；接收端交给响应体流，
    /// 收到信号后中断。
    pub fn begin_stream(&self, agent_id: &str) -> (u64, oneshot::Receiver<()>) {
        let (tx, rx) = oneshot::channel();
        let mut inner = self.inner.lock().expect("agents poisoned");
        let id = inner.next_stream_id;
        inner.next_stream_id += 1;
        let a = inner.agents.entry(agent_id.to_string()).or_default();
        a.streams.push(StreamHandle {
            id,
            cancel: Some(tx),
        });
        (id, rx)
    }

    /// 注销一条活跃流（Node 的 `unregister()` + `openStreams--` + `s.endTs = now` +
    /// 真实平均 tps 收口）。按 id 精确移除；**已被 kill 抽走的流是 no-op** ——
    /// 这与 Node 一致：kill 之后 `stream.closed=true`，`unregister()` 与流末那段都不再跑。
    pub fn end_stream(&self, agent_id: &str, stream_id: u64, now: i64) {
        let mut inner = self.inner.lock().expect("agents poisoned");
        let Some(a) = inner.agents.get_mut(agent_id) else {
            return;
        };
        let before = a.streams.len();
        a.streams.retain(|s| s.id != stream_id);
        if a.streams.len() == before {
            return; // 没找到（已被 kill / 已注销）→ 不做流末收尾
        }
        a.stream.end_ts = now;
        // 真实平均 tps = 该流真实 output_tokens ÷ 流耗时（Node: durSec >= 0.1 才算）
        if a.stream.last_out_tokens > 0 && a.stream.start_ts > 0 {
            let dur_sec = (now - a.stream.start_ts) as f64 / 1000.0;
            if dur_sec >= 0.1 {
                a.stream.last_real_tps = (a.stream.last_out_tokens as f64 / dur_sec).round() as i64;
            }
        }
    }

    /// `killAgentStreams(agentId)`：把该 agent 全部活跃流「两端销毁」并清空集合，
    /// 返回销毁条数（Node 的返回值）。同时写 `a.stream.killedAt = Date.now()`
    /// （60s 内 `calcAgentStatus` 优先判 DISCONNECTED）。
    pub fn kill_streams(&self, agent_id: &str) -> usize {
        self.kill_streams_at(agent_id, crate::proxy::capture::now_ms())
    }

    /// `kill_streams` 的可注入时钟版本（DISCONNECTED 窗口是时间相关的，测试必须能控时）。
    pub fn kill_streams_at(&self, agent_id: &str, now: i64) -> usize {
        let mut inner = self.inner.lock().expect("agents poisoned");
        let Some(a) = inner.agents.get_mut(agent_id) else {
            return 0;
        };
        let drained: Vec<StreamHandle> = a.streams.drain(..).collect();
        let mut killed = 0;
        for mut s in drained {
            if let Some(tx) = s.cancel.take() {
                // 接收端可能已经随流结束被丢弃：send 失败是正常竞态，忽略。
                if tx.send(()).is_ok() {
                    killed += 1;
                }
            }
            // 句柄 drop → 发送端 drop；已发的信号仍会到达。
        }
        a.stream.killed_at = now;
        killed
    }

    /// 当前活跃流条数（Node 的 `a.openStreams`；诊断/测试用）。
    pub fn open_streams(&self, agent_id: &str) -> usize {
        self.inner
            .lock()
            .expect("agents poisoned")
            .agents
            .get(agent_id)
            .map(|a| a.streams.len())
            .unwrap_or(0)
    }

    /// `/agent/prompts?id=` 的载荷：`{ agentId, count, prompts }`。
    /// agent 不存在返回 `None`（端点据此回 404）。
    pub fn prompts_payload(&self, agent_id: &str) -> Option<Value> {
        let inner = self.inner.lock().expect("agents poisoned");
        let a = inner.agents.get(agent_id)?;
        let prompts: Vec<Value> = a.prompts.iter().cloned().collect();
        Some(json!({
            "agentId": agent_id,
            "count": prompts.len(),
            "prompts": prompts,
        }))
    }

    /// `_lastStopReason.delete(agentId)`。
    pub fn clear_stop_reason(&self, agent_id: &str) {
        self.inner
            .lock()
            .expect("agents poisoned")
            .stop_reasons
            .remove(agent_id);
    }

    /// `buildStatus()` —— `/status` 的完整载荷（dashboard 的唯一数据源）。
    ///
    /// `{ ts: <ISO8601>, agents: { <id>: <calcAgentStatus 结果 + sessionId/isSubagent> },
    ///    idleCleanupMsMain: <number> }`。
    pub fn status_payload(&self, now: i64, idle_cleanup_ms_main: f64) -> Value {
        let inner = self.inner.lock().expect("agents poisoned");
        let mut agents = Map::new();
        for (id, a) in inner.agents.iter() {
            let meta = inner.meta.get(id);
            let is_subagent = meta.map(|m| m.is_subagent).unwrap_or(false);
            let mut s = calc_agent_status(a, now, is_subagent);
            if let Value::Object(ref mut m) = s {
                m.insert(
                    "sessionId".to_string(),
                    meta.and_then(|m| m.session_id.clone())
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                );
                m.insert("isSubagent".to_string(), json!(is_subagent));
            }
            agents.insert(id.clone(), s);
        }
        json!({
            "ts": crate::proxy::log::iso8601_utc_millis(now),
            "agents": Value::Object(agents),
            "idleCleanupMsMain": crate::proxy::state::js_number_value(idle_cleanup_ms_main),
        })
    }
}

/// `calcAgentStatus(a, now, isSubagent)` —— 纯读函数，返回 dashboard 行渲染所需的全部字段。
///
/// 状态机（逐条对齐 `proxy.js:889-1040`）：
/// - `DISCONNECTED`：显式 kill 后 60s 内（**优先判**，早于 openStreams/endTs）；
/// - `WAITING`：WORK 期间新请求已到（`pendingNextRequest` 5s 内）／SSE 开但还没首字／
///   req 已收但响应头未回（`reqTs > 0` 且其余分支都落 IDLE）；
/// - `STREAM(think|text)`：SSE 开且 delta 在流入（或 stop_reason 为 end_turn/stop_sequence
///   的流尾，或流结束 3s 内的收尾缓冲）；
/// - `SSE_STUCK`：SSE 开但 >60s 无 delta；
/// - `WORK`：stop_reason 非 end_turn/stop_sequence（cc 在跑工具），main 5min / sub 30s；
/// - `IDLE`：其余。
fn calc_agent_status(a: &Agent, now: i64, is_subagent: bool) -> Value {
    let s = &a.stream;
    // 1s window — matches dashboard refresh rate, SSE is real-time
    const WINDOW: i64 = 1000;
    let recent_chars: i64 = a
        .deltas
        .iter()
        .filter(|d| now - d.ts < WINDOW)
        .map(|d| d.chars)
        .sum();
    let recent_tokens: i64 = a
        .deltas
        .iter()
        .filter(|d| now - d.ts < WINDOW)
        .map(|d| d.tokens)
        .sum();
    let cps = recent_chars; // chars in last 1s = cps directly
    let active = now - a.last_ts < 2000; // 2s grace for active detection

    // estimatedOut: tokenizer 累计估算（actualOut=0 即还没收到真实 output_tokens 时用）
    let estimated_out = a.est_out_tokens;
    let actual_out = a.total_tokens;
    let actual_in = a.input_tokens;
    let out_t = if actual_out > 0 {
        actual_out
    } else {
        estimated_out
    };

    // tps: STREAM 用 tokenizer 估算（过去 1s 数出的 token 数，直接即 tps）；
    // 流结束后用真实平均（output_tokens ÷ 耗时）。
    let open_streams = a.streams.len();
    let (tps, tps_estimated) = if open_streams > 0 {
        (recent_tokens, true)
    } else if s.last_real_tps > 0 {
        (s.last_real_tps, false)
    } else {
        (0, false)
    };

    let idle_ms = now - a.last_ts;

    let mut state = "IDLE";
    let mut state_ms = idle_ms;
    let mut stream_phase: Option<&'static str> = None;
    let phase_of = |dt: Option<&'static str>| -> Option<&'static str> {
        if dt == Some("thinking") {
            Some("think")
        } else {
            Some("text")
        }
    };
    if open_streams == 0 && s.killed_at > 0 && now - s.killed_at < DISCONNECT_TTL_MS {
        state = "DISCONNECTED";
        state_ms = now - s.killed_at;
    } else if open_streams == 0
        && s.pending_next_request > 0
        && now - s.pending_next_request < PENDING_NEXT_TTL_MS
    {
        state = "WAITING";
        state_ms = now - s.pending_next_request;
    } else if open_streams > 0 {
        let start = if s.start_ts != 0 { s.start_ts } else { now };
        let stream_dur = now - start;
        if s.last_delta_ts == 0 {
            // SSE open but never received delta — API is thinking
            state = "WAITING";
            state_ms = stream_dur;
        } else {
            let since_delta = now - s.last_delta_ts;
            if since_delta > STREAM_STUCK_MS {
                state = "SSE_STUCK";
                state_ms = since_delta;
            } else if let Some(sr) = s.stop_reason.as_deref() {
                // 已收到 stop_reason = 内容输出完毕，流即将关闭（proxyRes end 前的流尾）。
                let ended = sr == "end_turn" || sr == "stop_sequence";
                if ended {
                    state = "STREAM";
                    stream_phase = phase_of(s.last_delta_type);
                    state_ms = since_delta;
                } else {
                    state = "WORK";
                    state_ms = now - js_or(s.stop_reason_ts, s.last_delta_ts, now);
                }
            } else {
                state = "STREAM";
                state_ms = now - js_or(s.phase_start_ts, s.last_delta_ts, now);
                stream_phase = phase_of(s.last_delta_type);
            }
        }
    } else if s.end_ts > 0 {
        let since_end = now - s.end_ts;
        let sr = s.stop_reason.as_deref();
        if sr == Some("end_turn") || sr == Some("stop_sequence") {
            // 收尾缓冲：cc 终端可能还在渲染刚收完的字（STREAM_TAIL_MS）。
            if since_end < STREAM_TAIL_MS {
                state = "STREAM";
                stream_phase = phase_of(s.last_delta_type);
                state_ms = since_end;
            } else {
                state = "IDLE";
                state_ms = since_end;
            }
        } else if since_end < (if is_subagent {
            WORK_FOLLOWUP_MS_SUB
        } else {
            WORK_DISPLAY_MS_MAIN
        }) {
            state = "WORK";
            state_ms = now - js_or(s.stop_reason_ts, s.end_ts, now);
        } else {
            state = "IDLE";
            state_ms = since_end;
        }
    }

    // req→上游响应头窗口：reqTs>0 + 上面所有状态分支都没命中（openStreams=0, endTs=0）
    // → 默认 IDLE 是误判，升级 WAITING：用户视角"我刚发了"应见 wait，不是 idle。
    if state == "IDLE" && s.req_ts > 0 {
        state = "WAITING";
        state_ms = now - s.req_ts;
    }

    json!({
        "chars": a.chars,
        "cps": cps,
        "tokens": actual_in + out_t,
        "outputTokens": out_t,
        "inputTokens": actual_in,
        "lastInputTokens": a.last_input_tokens,
        "tps": tps,
        "tpsEstimated": tps_estimated,
        "active": active,
        "idleMs": idle_ms,
        "state": state,
        "stateMs": state_ms,
        "streamPhase": stream_phase,
        "openStreams": open_streams,
        "streamTokens": s.tokens,
        "requests": a.request_count,
    })
}

/// JS `a || b || now` 的数值链（三个候选里取第一个非 0 的值）。
fn js_or(a: i64, b: i64, fallback: i64) -> i64 {
    if a != 0 {
        a
    } else if b != 0 {
        b
    } else {
        fallback
    }
}

/// `estimateInputTokens(req, body)` —— 输入侧 token 估算（`message_start.usage`
/// 不可用时的 fallback）。逐条对齐 `proxy.js:623-644`：
/// system 文本 + 所有 message 的文本块字符数，`Math.max(1, Math.round(chars / 2.5))`。
/// 字符数用 JS `String.length` 语义（UTF-16 code unit）。
pub fn estimate_input_tokens(parsed: &Value) -> i64 {
    let mut char_count: i64 = system_text(parsed).encode_utf16().count() as i64;
    if let Some(Value::Array(msgs)) = parsed.get("messages") {
        for m in msgs {
            match m.get("content") {
                Some(Value::String(c)) => char_count += c.encode_utf16().count() as i64,
                Some(Value::Array(blocks)) => {
                    for b in blocks {
                        if let Some(Value::String(t)) = b.get("text") {
                            char_count += t.encode_utf16().count() as i64;
                        } else if let Some(Value::String(c)) = b.get("content") {
                            char_count += c.encode_utf16().count() as i64;
                        }
                    }
                }
                _ => {}
            }
        }
    }
    ((char_count as f64) / CHARS_PER_INPUT_TOKEN).round().max(1.0) as i64
}

/// 取头的第一个值（`to_str` 失败/缺省 → `None`）。Node 的 `req.headers[k]` 对多值头
/// 也只给第一个（逗号拼接），且空串是 falsy —— 这里同样把空串当缺失。
fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    let v = headers.get(name)?.to_str().ok()?.trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// JS `String.prototype.slice(0, 8)` 的等价（按字符取，UUID 场景与 UTF-16 单元一致）。
fn slice8(s: &str) -> String {
    s.chars().take(8).collect()
}

/// JS `s.slice(-6)`。
fn last6(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let start = chars.len().saturating_sub(6);
    chars[start..].iter().collect()
}

/// JS 真值判定（`if (x)`）—— `''`/`0`/`NaN`/`null`/`false` 为假，其余为真。
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JS `String(x)` 的近似（只处理标量；对象/数组的 `[object Object]` / `a,b` 形态与
/// 真实取值无关，一律当「没有指纹」处理）。
fn js_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// P3 分支的命名结果（name + `agentMeta` 的两个字段）。
struct UaAgent {
    name: String,
    session_id: String,
    is_subagent: bool,
}

/// Priority 3 的 UA 嗅探。返回 `None` = 不该由 UA 分支命名（缺 UA / 是 Claude Code 自家
/// UA / UA 主段为空），调用方继续走 P4。
///
/// 语义逐条对齐 `proxy.js:717-786`：见函数内注释。
fn ua_agent_name(ua: &str, body: Option<&Value>) -> Option<UaAgent> {
    // `ua.split(/[\/\s()]+/).filter(Boolean)`：按 `/`、空白、`(`、`)` 切并丢空段。
    let parts: Vec<&str> = ua
        .split(|c: char| c == '/' || c == '(' || c == ')' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .collect();
    let head = parts.first().copied().unwrap_or("");
    // `parts[1] && /^[a-zA-Z]/.test(parts[1]) ? '-' + parts[1] : ''`
    let sub = match parts.get(1) {
        Some(p2)
            if p2
                .chars()
                .next()
                .map(|c| c.is_ascii_alphabetic())
                .unwrap_or(false) =>
        {
            format!("-{p2}")
        }
        _ => String::new(),
    };
    let ua_key = format!("{head}{sub}").trim().to_string();

    // 白名单只挡 Claude Code 自家 UA（它们已走 P2）。**不挡** `Anthropic-*`
    // —— 那是 hermes 这类第三方 SDK 用户的真实形态，必须保留。
    const CC_UA_PREFIX: [&str; 3] = ["claude-cli", "claude-code", "claude-sdk"];
    let lower = ua_key.to_lowercase();
    let is_claude_code_ua = CC_UA_PREFIX.iter().any(|p| lower.starts_with(p));
    if ua_key.is_empty() || is_claude_code_ua {
        return None;
    }

    // body 指纹：`metadata.user_id || user_id`，以及 system 文本里的 hermes 锚点。
    let mut user_id = String::new();
    let mut hermes_kind: Option<&str> = None;
    if let Some(parsed) = body {
        let raw_uid = parsed
            .get("metadata")
            .and_then(|m| m.get("user_id"))
            .filter(|v| js_truthy(v))
            .or_else(|| parsed.get("user_id").filter(|v| js_truthy(v)));
        user_id = raw_uid.and_then(js_string).unwrap_or_default();
        let sys_text = system_text(parsed);
        if sys_text.contains("Hermes Agent Persona") || sys_text.contains("hermes-agent") {
            hermes_kind = Some("main");
        } else if sys_text.contains("focused subagent working on a specific delegated task")
            || (sys_text.contains("YOUR TASK:") && sys_text.contains("subagent"))
        {
            hermes_kind = Some("sub");
        }
    }
    // `String(userId).replace(/[^a-zA-Z0-9_.-]/g,'').slice(0, 32)`
    user_id = user_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        .take(32)
        .collect();

    let uid_or_underscore = if user_id.is_empty() {
        "_".to_string()
    } else {
        user_id.clone()
    };
    Some(match hermes_kind {
        Some("main") => UaAgent {
            name: if user_id.is_empty() {
                "hermes".to_string()
            } else {
                format!("hermes#{user_id}")
            },
            session_id: format!("hermes:{uid_or_underscore}"),
            is_subagent: false,
        },
        Some("sub") => UaAgent {
            name: if user_id.is_empty() {
                "hermes:sub".to_string()
            } else {
                format!("hermes:sub#{user_id}")
            },
            session_id: format!("hermes:sub:{uid_or_underscore}"),
            is_subagent: true,
        },
        _ => UaAgent {
            name: if user_id.is_empty() {
                ua_key.clone()
            } else {
                format!("{ua_key}#{user_id}")
            },
            session_id: format!("ua:{ua_key}:{uid_or_underscore}"),
            is_subagent: false,
        },
    })
}

/// `system` 字段的文本化：字符串原样；数组取 `type === 'text'` 的 `text` 用 `\n` 拼
/// （JS `Array.join` 把 `null`/`undefined` 变空串，这里同样跳过非标量）；其余空串。
fn system_text(parsed: &Value) -> String {
    match parsed.get("system") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(js_string))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

// ═══════════════════════════ idle cleanup（`runCleanupPass`） ═══════════════════════════
//
// 逐条对齐 `proxy.js:2465-2536`。四个 pass 的顺序与各自的判定条件都**必须**照抄，因为
// 它们互相影响（pass 0 的孤儿强制入列会被 pass 1 重算 kept、pass 2 只救 main、pass 3 才删）：
//
//   pass 0：孤儿 sub —— sub 自己还在 WORK 窗口内，但同 session 的 main 都已长期 idle
//           （父 task 死了 / cc 强制 kill sub / session 切换）。proxy 收不到任何信号，
//           只能靠"父都不在了，sub 没理由存活"推断。命中后**强制**入 candidates。
//   pass 1：其余 agent 按 `isAgentActive` 与 idle 阈值筛（sub 正常 end_turn 的 limit=0）。
//   pass 2：**main** 被同 session 的活 sub 救回（`sessionHasActiveSub`）。sub 不救（父已死）。
//   pass 3：真正删除（agents + activeStreams + agentFingerprints + agentMeta）。
//
// Rust 侧没有 `activeStreams`（活跃流句柄挂在 `Agent::streams` 里，随 Agent 一起 drop），
// 也没有 `agentFingerprints`（本模块不建那张表，见模块头），所以 pass 3 只需删
// `agents` 与 `meta` 两张表。

/// `runCleanupPass` 的候选/救回明细。字段集对应 Node 侧那个匿名对象上的全部键。
///
/// **没有 `name`**：Node 的候选对象写的是 `name: a.name`，但 `a.name` 在 `ensureAgent`
/// 里**从未被赋值**（全文搜 `name:` 只有这几处读取点，没有任何写入点），所以它恒为
/// `undefined` —— `/cleanup/debug` 的 `JSON.stringify` 会**省略该键**。既然可观测载荷里
/// 永远没有这个名字，就不建一个恒 `None` 的字段（避免给后人"它有值"的错觉）。
#[derive(Debug, Clone, PartialEq)]
pub struct CleanupCandidate {
    pub id: String,
    pub is_subagent: bool,
    /// `limit`（ms）—— 该 agent 用的清理阈值。
    pub limit: i64,
    /// 该 agent 的 idle 时长（`now - (lastActivityTs || lastTs)`）。
    pub idle_ms: i64,
    pub sub_done: bool,
    pub session_id: Option<String>,
    pub stop_reason: Option<String>,
    pub open_streams: usize,
    /// pass 0 命中时的标记（`"parent_dead"`）；只有孤儿 sub 会有。
    pub orphan_reason: Option<&'static str>,
}

/// `runCleanupPass()` 的返回值
/// `{ removed, kept, scanned, candidates, saved, keptAgents }`。
#[derive(Debug, Clone, Default)]
pub struct CleanupReport {
    /// 本轮真正删掉的条数（= pass 3 前的 candidates 长度）。
    pub removed: usize,
    /// `keptAgents.size` —— pass 1 保下来的 + pass 2 救回的 main。
    pub kept: usize,
    /// `agents.size + candidates.length`（**删除前**的条数 —— Node 删完才取 `agents.size`
    /// 再加 `candidates.length`，两者相等）。
    pub scanned: usize,
    /// 被删掉的候选（pass 3 之前的那批，`/cleanup/debug` 逐条回显）。
    pub candidates: Vec<CleanupCandidate>,
    /// pass 2 被活 sub 救回的 main。
    pub saved: Vec<CleanupCandidate>,
}

/// `isAgentActive(a, now, isSubagent)`（`proxy.js:1052`）：SSE 开 / WORK 窗口内即"还在工作"。
///
/// WORK 窗口兜底：`endTs > 0` + `stopReason` 非 `end_turn`/`stop_sequence`（= 流尾是
/// `tool_use` 之类，cc 在跑工具期间 proxy 看不到活动，但 cc 还会回来发下一流）时，
/// sub 只容忍 60s（fork 完基本很快回，超了就是孤儿），main 容忍 10min（长 tool 不能误清）。
fn is_agent_active(a: &Agent, now: i64, is_subagent: bool) -> bool {
    if !a.streams.is_empty() {
        return true;
    }
    let s = &a.stream;
    if s.end_ts > 0
        && s.stop_reason
            .as_deref()
            .map(|sr| sr != "end_turn" && sr != "stop_sequence")
            .unwrap_or(false)
    {
        let followup = if is_subagent {
            IDLE_CLEANUP_MS_SUB
        } else {
            WORK_FOLLOWUP_MS_MAIN
        };
        if now - s.end_ts < followup {
            return true;
        }
    }
    false
}

/// `isSubAliveForMain(a, now)`（`proxy.js:1073`）：main 视角下"这个 sub 还活着"的**宽判**
/// （openStreams>0 或上次活动 < 10min）。取不到时间戳当死。
fn is_sub_alive_for_main(a: &Agent, now: i64) -> bool {
    if !a.streams.is_empty() {
        return true;
    }
    let last = js_or(a.last_activity_ts, a.last_ts, 0);
    if last == 0 {
        return false;
    }
    now - last < SUB_ALIVE_FOR_MAIN_MS
}

/// `sessionHasActiveSub(sessionId, now)`（`proxy.js:1079`）。
///
/// 不按"本批待删候选"过滤 —— 那会把正在跑长 tool 的 sub 一并排除在保护外，导致 main
/// 已 idle 超 2min 时被同 batch 全清（历史 bug）。只要 sub 还活着就返回 true。
fn session_has_active_sub(
    agents: &HashMap<String, Agent>,
    meta: &HashMap<String, AgentMeta>,
    session_id: Option<&str>,
    now: i64,
) -> bool {
    for (sid, a) in agents.iter() {
        let Some(m) = meta.get(sid) else { continue };
        if !m.is_subagent {
            continue;
        }
        // JS 里 `agentMeta.get(sid).sessionId !== sessionId`：两边都可能是 undefined，
        // `undefined !== undefined` 为 false（视为同一 session），所以用 Option 直接比。
        if m.session_id.as_deref() != session_id {
            continue;
        }
        if !is_sub_alive_for_main(a, now) {
            continue;
        }
        return true;
    }
    false
}

/// `sessionMainsAllIdle(sessionId, now)`（`proxy.js:1093`）：同 session 的 main 是否都已
/// 长期 idle → sub 没理由继续存活。
///
/// **没有 main 时返回 `hasMain`（= false）**，即"不判孤儿" —— 与函数名的字面直觉相反，
/// 但这是 Node 的原文（`return hasMain`），照抄。
fn session_mains_all_idle(
    agents: &HashMap<String, Agent>,
    meta: &HashMap<String, AgentMeta>,
    session_id: Option<&str>,
    now: i64,
    idle_cleanup_ms_main: i64,
) -> bool {
    let mut has_main = false;
    for (sid, a) in agents.iter() {
        let Some(m) = meta.get(sid) else { continue };
        if m.is_subagent {
            continue;
        }
        if m.session_id.as_deref() != session_id {
            continue;
        }
        has_main = true;
        // main 还开着流 → 父 task 还活着
        if !a.streams.is_empty() {
            return false;
        }
        // main 还在 WORK 窗口 → 父 task 可能马上就回来了
        if is_agent_active(a, now, false) {
            return false;
        }
        // main idle < IDLE_CLEANUP_MS_MAIN → 父 task 可能还在等 sub 回来，不清 sub
        let idle_ms = now - js_or(a.last_activity_ts, a.last_ts, now);
        if idle_ms < idle_cleanup_ms_main {
            return false;
        }
    }
    has_main
}

/// `runCleanupPass()`（`proxy.js:2467`）的锁内实现。
///
/// `idle_cleanup_ms_main` 是当前 `IDLE_CLEANUP_MS_MAIN`（调用方从 `AppState` 读出后传入，
/// 保证 `/config/idle` 改过的值真的影响清理判定 —— Node 读的就是那个模块级变量）。
fn cleanup_pass_locked(inner: &mut Inner, now: i64, idle_cleanup_ms_main: i64) -> CleanupReport {
    if inner.agents.is_empty() {
        return CleanupReport::default();
    }
    let Inner {
        agents,
        meta,
        last_state,
        ..
    } = inner;
    // `_lastState` **刻意不随 cleanup 清理**（Node 也从不显式删它，见 `last_state` 字段注释）。
    let _ = last_state;

    // ── pass 0：孤儿 sub 识别 ──
    let mut candidates: Vec<CleanupCandidate> = Vec::new();
    for (id, a) in agents.iter() {
        if !a.streams.is_empty() {
            continue;
        }
        let Some(m) = meta.get(id) else { continue };
        if !m.is_subagent {
            continue;
        }
        if !is_agent_active(a, now, true) {
            continue;
        }
        if !session_mains_all_idle(agents, meta, m.session_id.as_deref(), now, idle_cleanup_ms_main)
        {
            continue;
        }
        candidates.push(CleanupCandidate {
            id: id.clone(),
            is_subagent: true,
            limit: IDLE_CLEANUP_MS_SUB,
            idle_ms: now - js_or(a.last_activity_ts, a.last_ts, now),
            sub_done: false,
            session_id: m.session_id.clone(),
            stop_reason: a.stream.stop_reason.clone(),
            open_streams: a.streams.len(),
            orphan_reason: Some("parent_dead"),
        });
    }
    // ── pass 1：阈值筛选 ──
    // （Node 在 pass 0 之后还有一句 `keptAgents.delete(o.id)`，见下方 `kept` 处的说明：它是死代码。）
    let mut pass1_kept: Vec<String> = Vec::new();
    for (id, a) in agents.iter() {
        if !a.streams.is_empty() {
            pass1_kept.push(id.clone());
            continue;
        }
        let m = meta.get(id);
        let is_sub = m.map(|m| m.is_subagent).unwrap_or(false);
        // pass 0 命中的孤儿在这里同样命中（`isAgentActive(_, _, true)` 为真正是它被选中的原因），
        // 于是它走这一支 `pass1_kept.push` + continue、**不会**被重复计入 candidates —— 与 Node 的
        // `keptAgents.add(id); continue;` 逐步同义，不需要额外的"孤儿 id 集合"。
        if is_agent_active(a, now, is_sub) {
            pass1_kept.push(id.clone());
            continue;
        }
        let idle_ms = now - js_or(a.last_activity_ts, a.last_ts, now);
        let sub_done = a
            .stream
            .stop_reason
            .as_deref()
            .map(|sr| sr == "end_turn" || sr == "stop_sequence")
            .unwrap_or(false);
        let limit = if is_sub {
            if sub_done {
                0
            } else {
                IDLE_CLEANUP_MS_SUB
            }
        } else {
            idle_cleanup_ms_main
        };
        if idle_ms > limit {
            candidates.push(CleanupCandidate {
                id: id.clone(),
                is_subagent: is_sub,
                limit,
                idle_ms,
                sub_done,
                session_id: m.and_then(|m| m.session_id.clone()),
                stop_reason: a.stream.stop_reason.clone(),
                open_streams: a.streams.len(),
                orphan_reason: None,
            });
        } else {
            pass1_kept.push(id.clone());
        }
    }

    // ── pass 2：main 被同 session 活 sub 救回（orphanForced 的 sub 不救 —— 父已死）──
    let mut saved: Vec<CleanupCandidate> = Vec::new();
    let mut i = candidates.len();
    while i > 0 {
        i -= 1;
        let c = &candidates[i];
        if c.is_subagent {
            continue; // 只保护 main
        }
        if c.orphan_reason.is_some() {
            continue; // 理论上 main 不会进 pass 0
        }
        if session_has_active_sub(agents, meta, c.session_id.as_deref(), now) {
            saved.push(candidates.remove(i));
        }
    }

    // ── pass 3：真正删除 ──
    let agents_total = agents.len();
    let removed = candidates.len();
    for c in candidates.iter() {
        agents.remove(&c.id);
        meta.remove(&c.id);
    }
    // `scanned = agents.size + candidates.length`，Node 是在**删除循环之后**取的 ——
    // 那时 `agents.size` 已是 `agents_total - removed`，加上 `candidates.length`（= removed）
    // 恰好还原成**删除前**的条数。所以这里直接用 `agents_total`（早先误写成
    // `agents_total + removed`，会把它算成两倍；差分与单测都能抓到）。
    let scanned = agents_total;
    // Node 的 `keptAgents.size`：pass 1 里每一次 `keptAgents.add(id)` + pass 2 对 saved 的 add。
    //
    // **pass 0 里那句 `keptAgents.delete(o.id)` 是死代码** —— 紧随其后的 pass 1 会**重新遍历到**
    // 同一个孤儿 sub，而孤儿的定义就是 `isAgentActive(a, now, true)` 为真，于是那一行必然
    // `keptAgents.add(id)` 把它加回来。所以 `kept` **包含**孤儿 sub；把它排除反而与 Node 不可比
    // （初版就是这么写的，被"孤儿 + kept"差分用例抓住后改正）。
    let kept = pass1_kept.len() + saved.len();

    CleanupReport {
        removed,
        kept,
        scanned,
        candidates,
        saved,
    }
}

impl AgentRegistry {
    /// `runCleanupPass()` 的可注入时钟入口（HTTP 端点与 `_tickCleanup` 共用）。
    pub fn cleanup_pass_at(&self, now: i64, idle_cleanup_ms_main: i64) -> CleanupReport {
        let mut inner = self.inner.lock().expect("agents poisoned");
        cleanup_pass_locked(&mut inner, now, idle_cleanup_ms_main)
    }

    /// `/cleanup/debug` 的载荷（除 `ok` 外全部字段），逐字对齐 `proxy.js:1533-1545`。
    ///
    /// 键**集合**与取值逐条对齐 Node 的 `{ removed, saved, kept, scanned, remaining, candidates }`；
    /// 每个候选是 `{ id, kind, idleMs, limit, reason, stopReason, openStreams }`。
    /// **键序是字典序**（serde_json 默认 `Map` 为 `BTreeMap`，与 `events.rs` 同一处境）——
    /// Node 的对象字面量顺序不同，但 dashboard 按名读取，键集合与取值一致。
    ///
    /// 两个"省略该键"的分支都照抄 Node 的 `JSON.stringify` 行为（`undefined` → 键消失）：
    /// `stopReason` 为 `None` 时省略；`name` 则**恒省略**（`a.name` 从未赋值，见
    /// `CleanupCandidate` 的注释）。
    /// `remaining` 是**删除后**的 `agents.size`，所以先跑 pass 再取长度。
    pub fn cleanup_debug_payload(
        &self,
        now: i64,
        idle_cleanup_ms_main: i64,
    ) -> (CleanupReport, Value) {
        let r = self.cleanup_pass_at(now, idle_cleanup_ms_main);
        let remaining = self
            .inner
            .lock()
            .expect("agents poisoned")
            .agents
            .len();
        let candidates: Vec<Value> = r
            .candidates
            .iter()
            .map(|c| {
                let mut m = Map::new();
                m.insert("id".to_string(), json!(c.id));
                // Node 候选对象里还有 `name: c.name`，但 `c.name` 来自 `a.name` —— 那个字段
                // 从未被赋值（恒 undefined），`JSON.stringify` 会**省略该键**，故这里也不写。
                m.insert(
                    "kind".to_string(),
                    json!(if c.is_subagent { "sub" } else { "main" }),
                );
                m.insert("idleMs".to_string(), json!(c.idle_ms));
                m.insert("limit".to_string(), json!(c.limit));
                m.insert(
                    "reason".to_string(),
                    json!(if c.sub_done {
                        "end_turn"
                    } else if c.is_subagent {
                        "idle_sub"
                    } else {
                        "idle_main"
                    }),
                );
                // Node: `stopReason: c.stopReason` —— undefined 同样省略。
                if let Some(sr) = &c.stop_reason {
                    m.insert("stopReason".to_string(), json!(sr));
                }
                m.insert("openStreams".to_string(), json!(c.open_streams));
                Value::Object(m)
            })
            .collect();
        let payload = json!({
            "removed": r.removed,
            "saved": r.saved.len(),
            "kept": r.kept,
            "scanned": r.scanned,
            "remaining": remaining,
            "candidates": candidates,
        });
        (r, payload)
    }
}

// ═════════════════ `_emitStateTransition` 的十个转换事件 ═════════════════

/// 一条状态转换的静态描述（Node `TRANSITIONS` 表的一行）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransitionSpec {
    pub severity: &'static str,
    pub event_type: &'static str,
    pub message: &'static str,
    /// 只有 `WAITING→IDLE` 有（60_000ms）；有值时 `stateMs < onlyIfMs` **不发**。
    pub only_if_ms: Option<i64>,
}

/// `TRANSITIONS` 白名单（`proxy.js:581-592`）。未在表内的转换不报（例 `IDLE→STREAM`
/// 状态机里不存在），避免误报；`*→DISCONNECTED` 是兜底（任意态 → DISCONNECTED 同一条事件）。
fn transition_spec(prev: &str, curr: &str) -> Option<TransitionSpec> {
    let spec = |severity, event_type, message, only_if_ms| TransitionSpec {
        severity,
        event_type,
        message,
        only_if_ms,
    };
    match (prev, curr) {
        ("STREAM", "SSE_STUCK") => Some(spec("warn", "sse-stuck", "SSE 卡住 (>10s 无 delta)", None)),
        ("SSE_STUCK", "STREAM") => Some(spec("info", "sse-resumed", "SSE 恢复", None)),
        ("WAITING", "STREAM") => Some(spec("info", "first-delta", "收到首字", None)),
        ("STREAM", "WORK") => Some(spec("info", "tool-started", "进入工具调用", None)),
        ("STREAM", "IDLE") => Some(spec("info", "end-turn", "对话结束", None)),
        ("WORK", "IDLE") => Some(spec("info", "work-done", "工具结束 (无新请求)", None)),
        ("WORK", "WAITING") => Some(spec("info", "work-followup", "工具结束, 新请求已发", None)),
        ("WAITING", "IDLE") => {
            Some(spec("warn", "sse-slow-response", "等首字超时/异常", Some(60_000)))
        }
        ("DISCONNECTED", "WAITING") => Some(spec("info", "cc-retry", "cc 重试新请求", None)),
        (_, "DISCONNECTED") => Some(spec("warn", "agent-killed", "已显式断开", None)),
        _ => None,
    }
}

/// 已判定"确实要发"的一条转换事件（`tick` 的返回值）。`message` 已带 `onlyIfMs` 后缀。
///
/// 形状与 Node 的 `recordEvent({severity, type, agentId, message, detail})` 一一对应，
/// 由调用方（`router.rs`）转成 `EventInput` 落环 —— 本模块不依赖事件层。
#[derive(Debug, Clone, PartialEq)]
pub struct StateTransitionEvent {
    pub agent_id: String,
    pub severity: &'static str,
    pub event_type: &'static str,
    pub message: String,
    pub prev: String,
    pub curr: String,
    pub state_ms: i64,
}

impl StateTransitionEvent {
    /// 转成事件层入参 —— 逐字对齐 Node 的
    /// `recordEvent({ severity, type, agentId, message, detail: { prev, curr, stateMs } })`。
    ///
    /// `detail` 的键序也照抄 Node 的对象字面量（`prev` / `curr` / `stateMs`）。
    pub fn to_event_input(&self) -> crate::proxy::events::EventInput {
        let mut detail = Map::new();
        detail.insert("prev".to_string(), json!(self.prev));
        detail.insert("curr".to_string(), json!(self.curr));
        detail.insert("stateMs".to_string(), json!(self.state_ms));
        crate::proxy::events::EventInput {
            severity: self.severity.to_string(),
            event_type: self.event_type.to_string(),
            agent_id: Some(self.agent_id.clone()),
            message: self.message.clone(),
            detail: Value::Object(detail),
        }
    }
}

/// `_emitStateTransition(prev, curr, id, st)`（`proxy.js:593`）的判定部分。
///
/// 三条守卫逐字照抄：
/// 1. `prev === curr` → 不发；
/// 2. `prev === undefined` → 不发（首次建表，不报"凭空出现"）；
/// 3. 表外转换 → 不发；有 `onlyIfMs` 时 `st.stateMs < onlyIfMs` → 不发。
/// 消息后缀：`t.message + (t.onlyIfMs ? ' (>' + t.onlyIfMs/1000 + 's)' : '')`。
pub fn select_transition(
    prev: Option<&str>,
    curr: &str,
    agent_id: &str,
    state_ms: i64,
) -> Option<StateTransitionEvent> {
    let prev = prev?; // 守卫 2
    if prev == curr {
        return None; // 守卫 1
    }
    let spec = transition_spec(prev, curr)?; // 守卫 3
    if let Some(min) = spec.only_if_ms {
        if state_ms < min {
            return None;
        }
    }
    let message = match spec.only_if_ms {
        Some(min) => format!("{} (>{}s)", spec.message, min / 1000),
        None => spec.message.to_string(),
    };
    Some(StateTransitionEvent {
        agent_id: agent_id.to_string(),
        severity: spec.severity,
        event_type: spec.event_type,
        message,
        prev: prev.to_string(),
        curr: curr.to_string(),
        state_ms,
    })
}

/// `_tickCleanup()`（`proxy.js:2538`）的返回值：按**遍历顺序**排好的转换事件 + cleanup 报告。
pub struct TickOutcome {
    pub transitions: Vec<StateTransitionEvent>,
    pub cleanup: CleanupReport,
}

impl AgentRegistry {
    /// `_tickCleanup()` 的锁内版本。
    ///
    /// 顺序与 Node 一致：`agents.size === 0` 直接返回（**不** touch `last_state`）；
    /// 否则**先**对每个 agent 做状态 diff 并发转换事件，**再**跑一轮 cleanup。
    ///
    /// 为什么状态 diff 与 cleanup 必须在同一个 tick 里：cleanup 会把 agent 从表里删掉，
    /// 而 Node 的状态循环在 cleanup **之前**读完所有 agent —— 顺序颠倒会少发一轮转换事件。
    pub fn tick_at(&self, now: i64, idle_cleanup_ms_main: i64) -> TickOutcome {
        let mut inner = self.inner.lock().expect("agents poisoned");
        let mut transitions = Vec::new();
        if !inner.agents.is_empty() {
            let Inner {
                agents,
                meta,
                last_state,
                ..
            } = &mut *inner;
            for (id, a) in agents.iter() {
                let is_sub = meta.get(id).map(|m| m.is_subagent).unwrap_or(false);
                let st = calc_agent_status(a, now, is_sub);
                let curr = st
                    .get("state")
                    .and_then(|v| v.as_str())
                    .unwrap_or("IDLE")
                    .to_string();
                let state_ms = st.get("stateMs").and_then(|v| v.as_i64()).unwrap_or(0);
                let prev = last_state.get(id).map(String::as_str);
                if let Some(ev) = select_transition(prev, &curr, id, state_ms) {
                    transitions.push(ev);
                }
                last_state.insert(id.clone(), curr);
            }
        }
        let cleanup = cleanup_pass_locked(&mut inner, now, idle_cleanup_ms_main);
        TickOutcome {
            transitions,
            cleanup,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                axum::http::HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    fn reg() -> AgentRegistry {
        AgentRegistry::new()
    }

    /// 造一个"流已结束、stop_reason 已知"的 agent（calcAgentStatus 的可控输入）。
    fn seeded(agent_id: &str, stop: &str, end_ts: i64) -> AgentRegistry {
        let r = reg();
        r.begin_request(agent_id, None, 0, 0);
        r.note_stop_reason(agent_id, stop, 10);
        let (id, _rx) = r.begin_stream(agent_id);
        r.end_stream(agent_id, id, end_ts);
        r
    }

    fn state_of(r: &AgentRegistry, id: &str, now: i64) -> Value {
        r.status_payload(now, 120_000.0)["agents"][id].clone()
    }

    // ── isLLMRequest ──

    #[test]
    fn only_post_llm_paths_are_llm_requests() {
        assert!(is_llm_request("POST", "/v1/messages"));
        assert!(is_llm_request("POST", "/v1/messages?beta=1"));
        assert!(is_llm_request("POST", "/v1/chat/completions"));
        assert!(is_llm_request("POST", "/completions"));
        assert!(!is_llm_request("GET", "/v1/messages"), "GET 不算 LLM 调用");
        assert!(!is_llm_request("POST", "/version"), "非 LLM 路径不算");
        assert!(
            !is_llm_request("POST", "/api/tags"),
            "ollama 探测即使 POST 也不算"
        );
    }

    /// 非 LLM 请求即使带 UA / model 也直接 'unknown'（Node 注释：避免噪音挤占列表）
    #[test]
    fn non_llm_requests_are_unknown_even_with_identity_headers() {
        let r = reg();
        let h = headers(&[("user-agent", "hermes/1.0"), ("x-agent-id", "")]);
        assert_eq!(r.get_agent_id("GET", "/models", &h, None), "unknown");
    }

    // ── 四级优先级 ──

    #[test]
    fn priority_1_explicit_agent_header_wins_verbatim() {
        let r = reg();
        let h = headers(&[
            ("x-agent-id", "agent-alpha"),
            ("x-claude-code-session-id", "abcdefgh-1111"),
        ]);
        assert_eq!(
            r.get_agent_id("POST", "/v1/messages", &h, None),
            "agent-alpha"
        );
    }

    #[test]
    fn priority_2_claude_code_session_headers_name_main_and_sub() {
        let r = reg();
        let main = headers(&[("x-claude-code-session-id", "12345678-90ab-cdef")]);
        assert_eq!(
            r.get_agent_id("POST", "/v1/messages", &main, None),
            "cc:12345678"
        );
        let sub = headers(&[
            ("x-claude-code-session-id", "12345678-90ab-cdef"),
            ("x-claude-code-agent-id", "deadbeefcafe"),
        ]);
        assert_eq!(
            r.get_agent_id("POST", "/v1/messages", &sub, None),
            "sub:deadbeef"
        );
    }

    #[test]
    fn priority_3_ua_sniff_names_third_party_sdk() {
        let r = reg();
        // "Anthropic/Python 0.87.0" → "Anthropic-Python"（第二段以字母开头）
        let h = headers(&[("user-agent", "Anthropic/Python 0.87.0")]);
        assert_eq!(
            r.get_agent_id("POST", "/v1/messages", &h, None),
            "Anthropic-Python"
        );
        // 单段 UA：不拼第二段
        let h = headers(&[("user-agent", "HermesAgent/1.4.2")]);
        assert_eq!(
            r.get_agent_id("POST", "/v1/messages", &h, None),
            "HermesAgent"
        );
        // 第二段不是字母开头（"1.4.2"）→ 不拼
        let h = headers(&[("user-agent", "curl/8.4.2")]);
        assert_eq!(r.get_agent_id("POST", "/v1/messages", &h, None), "curl");
    }

    #[test]
    fn claude_code_ua_is_blocklisted_so_it_falls_through_to_model() {
        let r = reg();
        let h = headers(&[("user-agent", "claude-cli/1.0.30 (external, cli)")]);
        let body = json!({ "model": "claude-sonnet-4" });
        assert_eq!(
            r.get_agent_id("POST", "/v1/messages", &h, Some(&body)),
            "claude-sonnet-4",
            "自家 UA 被白名单挡住 → 落到 P4 model"
        );
    }

    #[test]
    fn hermes_body_fingerprint_overrides_ua_key() {
        let r = reg();
        let h = headers(&[("user-agent", "Anthropic/Python 0.87.0")]);
        let main = json!({ "system": "# Hermes Agent Persona\n..." });
        assert_eq!(
            r.get_agent_id("POST", "/v1/messages", &h, Some(&main)),
            "hermes"
        );
        let sub = json!({
            "system": [{"type": "text", "text": "You are a focused subagent working on a specific delegated task."}],
            "metadata": { "user_id": "u/1 2" },
        });
        assert_eq!(
            r.get_agent_id("POST", "/v1/messages", &h, Some(&sub)),
            "hermes:sub#u12",
            "userId 先按 [^a-zA-Z0-9_.-] 过滤"
        );
        // YOUR TASK: + subagent 组合也判 sub（JS 的 || / && 优先级）
        let combo = json!({"system": "YOUR TASK: x\nsubagent"});
        assert_eq!(
            r.get_agent_id("POST", "/v1/messages", &h, Some(&combo)),
            "hermes:sub"
        );
        // 只有 YOUR TASK: 没有 subagent → 不判 sub
        let partial = json!({"system": "YOUR TASK: x"});
        assert_eq!(
            r.get_agent_id("POST", "/v1/messages", &h, Some(&partial)),
            "Anthropic-Python"
        );
    }

    /// P2 / P3 会写 `agentMeta`，`/status` 的 `sessionId` / `isSubagent` 与 dashboard
    /// 的按 session 分组都依赖它；P1 / P4 / key 分支**不写**（Node 如此）。
    #[test]
    fn agent_meta_is_written_only_by_p2_and_p3() {
        let r = reg();
        let h = headers(&[("x-claude-code-session-id", "12345678-90ab-cdef")]);
        assert_eq!(r.get_agent_id("POST", "/v1/messages", &h, None), "cc:12345678");
        r.ensure_agent("cc:12345678");
        let st = state_of(&r, "cc:12345678", 1000);
        assert_eq!(st["sessionId"], "12345678-90ab-cdef");
        assert_eq!(st["isSubagent"], false);

        let sub = headers(&[
            ("x-claude-code-session-id", "12345678-90ab-cdef"),
            ("x-claude-code-agent-id", "deadbeefcafe"),
        ]);
        r.get_agent_id("POST", "/v1/messages", &sub, None);
        r.ensure_agent("sub:deadbeef");
        assert_eq!(state_of(&r, "sub:deadbeef", 1000)["isSubagent"], true);

        // P3：hermes main / sub / 普通 UA 的 sessionId 规则
        let ua = headers(&[("user-agent", "Anthropic/Python 0.87.0")]);
        r.get_agent_id(
            "POST",
            "/v1/messages",
            &ua,
            Some(&json!({"system": "# Hermes Agent Persona"})),
        );
        r.ensure_agent("hermes");
        assert_eq!(state_of(&r, "hermes", 1000)["sessionId"], "hermes:_");
        r.get_agent_id(
            "POST",
            "/v1/messages",
            &ua,
            Some(&json!({"system": "focused subagent working on a specific delegated task", "metadata": {"user_id": "abc"}})),
        );
        r.ensure_agent("hermes:sub#abc");
        let hs = state_of(&r, "hermes:sub#abc", 1000);
        assert_eq!(hs["sessionId"], "hermes:sub:abc");
        assert_eq!(hs["isSubagent"], true);

        // P1：不写 meta → sessionId null / isSubagent false
        let p1 = headers(&[("x-agent-id", "agent-alpha")]);
        r.ensure_agent("agent-alpha");
        r.get_agent_id("POST", "/v1/messages", &p1, None);
        let st = state_of(&r, "agent-alpha", 1000);
        assert_eq!(st["sessionId"], Value::Null);
        assert_eq!(st["isSubagent"], false);
    }

    #[test]
    fn priority_4_uses_model_then_falls_back_to_key_tail() {
        let r = reg();
        let model = json!({ "model": "minimax-m3" });
        assert_eq!(
            r.get_agent_id("POST", "/v1/messages", &headers(&[]), Some(&model)),
            "minimax-m3"
        );
        // 无 model → API key 末 6 位
        let h = headers(&[("x-api-key", "sk-abcdef123456")]);
        assert_eq!(
            r.get_agent_id("POST", "/v1/messages", &h, Some(&json!({}))),
            "key:123456"
        );
        // x-api-key 为空 → 用 authorization
        let h = headers(&[("x-api-key", ""), ("authorization", "Bearer zzz999")]);
        assert_eq!(
            r.get_agent_id("POST", "/v1/messages", &h, None),
            "key:zzz999"
        );
        // 都没有 → unknown
        assert_eq!(
            r.get_agent_id("POST", "/v1/messages", &headers(&[]), None),
            "unknown"
        );
    }

    #[test]
    fn last6_handles_short_strings() {
        assert_eq!(last6("abc"), "abc");
        assert_eq!(last6("abcdef"), "abcdef");
        assert_eq!(last6("abcdefg"), "bcdefg");
    }

    // ── 每流状态 / phase ──

    /// phase 规则：未结束 + agentId 已知 + lastDeltaType 命中才给值；结束一律 null。
    #[test]
    fn phase_requires_pending_known_agent_and_a_delta() {
        let r = reg();
        r.record_delta("cc:12345678", DeltaKind::Thinking, "hi", 1, 1000);
        assert_eq!(r.phase_for(Some("cc:12345678"), false), Some("think"));
        assert_eq!(
            r.phase_for(Some("cc:12345678"), true),
            None,
            "流已结束 → phase=null（完成态按 ok/err 染色）"
        );
        assert_eq!(
            r.phase_for(Some("unknown"), false),
            None,
            "agentId='unknown' 不算已知"
        );
        assert_eq!(r.phase_for(None, false), None);
        assert_eq!(
            r.phase_for(Some("cc:12345678"), false),
            Some("think"),
            "phase 只看 agent 的 lastDeltaType，与具体 cid 无关"
        );

        r.record_delta("cc:12345678", DeltaKind::Text, "yo", 1, 1100);
        assert_eq!(r.phase_for(Some("cc:12345678"), false), Some("text"));

        // 没有 delta 的 agent → null（Node: 无 delta 时 phase=null → 退回默认橙）
        r.ensure_agent("cc:no-delta");
        assert_eq!(r.phase_for(Some("cc:no-delta"), false), None);
    }

    /// 新请求把 lastDeltaType 清回 null（对应 Node 的 `a.stream = freshStreamState()`）。
    /// 不重置的话上一流的 text 会污染新流。
    #[test]
    fn new_request_resets_last_delta_type() {
        let r = reg();
        r.record_delta("a", DeltaKind::Text, "x", 1, 900);
        assert_eq!(r.phase_for(Some("a"), false), Some("text"));
        let seq = r.begin_request("a", None, 0, 1000);
        assert_eq!(seq, 1);
        assert_eq!(
            r.phase_for(Some("a"), false),
            None,
            "新请求开始即重置本流 lastDeltaType"
        );
    }

    #[test]
    fn record_delta_also_creates_the_unknown_agent_like_node() {
        // Node 的 recordDelta 没有 agentId !== 'unknown' 守卫 → 会为 'unknown' 建记录。
        let r = reg();
        assert!(!r.has_agent("unknown"));
        r.record_delta("unknown", DeltaKind::Text, "x", 1, 1000);
        assert!(r.has_agent("unknown"), "照抄 Node：unknown 也会被建表");
        assert_eq!(r.last_delta_type("unknown"), Some("text"));
        assert_eq!(
            r.phase_for(Some("unknown"), false),
            None,
            "但 phase 有独立的 !== 'unknown' 守卫"
        );
    }

    // ── recordDelta / recordTokens 的累计量（dashboard 的 TPS 与 token 读数）──

    #[test]
    fn record_delta_accumulates_chars_tokens_and_delta_ring() {
        let r = reg();
        // JS String.length：emoji 是 2 个 UTF-16 code unit
        r.record_delta("a", DeltaKind::Text, "ab😀", 5, 1000);
        let st = state_of(&r, "a", 1000);
        assert_eq!(st["chars"], 4, "a b + 代理对(2) = 4");
        assert_eq!(st["streamTokens"], 5, "本流 tokenizer 估算");
        assert_eq!(st["outputTokens"], 5, "实际 output=0 → 用估算");
        assert_eq!(st["tokens"], 5);
        assert_eq!(r.last_delta_type("a"), Some("text"));

        // deltas 环上限 60（最旧的被挤掉）：70 条都在 1s 窗口内时，cps 只能数到 60
        for i in 0..70 {
            r.record_delta("a", DeltaKind::Text, "z", 1, 2000 + i);
        }
        let st = state_of(&r, "a", 2069);
        assert_eq!(st["cps"], 60, "deltas 环上限 60（否则会数到 70）");
    }

    #[test]
    fn record_tokens_splits_real_output_and_input_like_node() {
        let r = reg();
        r.record_tokens("a", 100, 0, 1000);
        assert_eq!(r.status_payload(1000, 120_000.0)["agents"]["a"]["outputTokens"], 100);
        r.record_tokens("a", 0, 40, 1010);
        let st = state_of(&r, "a", 1010);
        assert_eq!(st["inputTokens"], 40);
        assert_eq!(st["tokens"], 140, "tokens = inputTokens + outputTokens");
    }

    // ── calcAgentStatus 各态 ──

    #[test]
    fn stream_state_is_stuck_when_no_delta_for_60s() {
        let r = reg();
        r.begin_request("a", None, 0, 1000);
        let (_id, _rx) = r.begin_stream("a");
        r.record_delta("a", DeltaKind::Text, "x", 1, 2000);
        // 有 delta 且在 60s 内 → STREAM(text)
        assert_eq!(state_of(&r, "a", 3000)["state"], "STREAM");
        assert_eq!(state_of(&r, "a", 3000)["streamPhase"], "text");
        // 超过 60s 无 delta → SSE_STUCK
        let st = state_of(&r, "a", 2000 + STREAM_STUCK_MS + 1);
        assert_eq!(st["state"], "SSE_STUCK");
    }

    #[test]
    fn waiting_before_first_delta_and_work_after_tool_use() {
        let r = reg();
        r.begin_request("a", None, 0, 1000);
        let (id, _rx) = r.begin_stream("a");
        // SSE 响应头到达 → reqTs 归零（否则流结束后的 IDLE 会被升级成 WAITING）。
        r.clear_req_ts("a");
        // SSE 开但还没首字 → WAITING
        assert_eq!(state_of(&r, "a", 1500)["state"], "WAITING");
        r.record_delta("a", DeltaKind::Thinking, "t", 1, 1600);
        assert_eq!(state_of(&r, "a", 1700)["streamPhase"], "think");
        // stop_reason=tool_use（流还开着）→ WORK（cc 在跑工具）
        r.note_stop_reason("a", "tool_use", 1800);
        let st = state_of(&r, "a", 1900);
        assert_eq!(st["state"], "WORK");
        // end_turn 的流尾保持 STREAM（不闪 idle）
        r.note_stop_reason("a", "end_turn", 2000);
        assert_eq!(state_of(&r, "a", 2100)["state"], "STREAM");
        // 流关闭后 3s 收尾缓冲内仍 STREAM
        r.end_stream("a", id, 2200);
        assert_eq!(state_of(&r, "a", 4000)["state"], "STREAM");
        // 缓冲外 → IDLE
        assert_eq!(state_of(&r, "a", 2200 + STREAM_TAIL_MS + 1)["state"], "IDLE");
    }

    /// WORK 窗口按 isSubagent 分档：main 5min、sub 30s。
    #[test]
    fn work_window_is_main_5min_and_sub_30s() {
        let main = seeded("m", "tool_use", 1000);
        assert_eq!(state_of(&main, "m", 1000 + WORK_DISPLAY_MS_MAIN - 1)["state"], "WORK");
        assert_eq!(state_of(&main, "m", 1000 + WORK_DISPLAY_MS_MAIN + 1)["state"], "IDLE");

        let sub = reg();
        let h = headers(&[
            ("x-claude-code-session-id", "s1"),
            ("x-claude-code-agent-id", "deadbeef"),
        ]);
        sub.get_agent_id("POST", "/v1/messages", &h, None);
        sub.begin_request("sub:deadbeef", None, 0, 0);
        sub.note_stop_reason("sub:deadbeef", "tool_use", 10);
        let (id, _rx) = sub.begin_stream("sub:deadbeef");
        sub.end_stream("sub:deadbeef", id, 1000);
        assert_eq!(state_of(&sub, "sub:deadbeef", 1000 + WORK_FOLLOWUP_MS_SUB - 1)["state"], "WORK");
        assert_eq!(state_of(&sub, "sub:deadbeef", 1000 + WORK_FOLLOWUP_MS_SUB + 1)["state"], "IDLE");
    }

    #[test]
    fn disconnected_wins_over_other_states_for_60s() {
        let r = reg();
        r.begin_request("a", None, 0, 1000);
        let (_id, _rx) = r.begin_stream("a");
        // SSE 响应头到达 → `a.stream.reqTs = 0`（否则 DISCONNECTED 窗口过后会被
        // reqTs>0 那条升级成 WAITING）。
        r.clear_req_ts("a");
        assert_eq!(r.kill_streams_at("a", 1100), 1);
        let st = state_of(&r, "a", 1100);
        assert_eq!(st["state"], "DISCONNECTED");
        assert_eq!(st["openStreams"], 0);
        // 超过 60s → 回落到 IDLE（killedAt 过期）
        assert_eq!(
            state_of(&r, "a", 1100 + DISCONNECT_TTL_MS + 1)["state"],
            "IDLE"
        );
    }

    /// WORK 期间新请求（pendingNextRequest）→ WAITING，仅 5s 内有效。
    #[test]
    fn pending_next_request_promotes_work_to_waiting() {
        let r = reg();
        r.begin_request("a", None, 0, 0);
        r.note_stop_reason("a", "tool_use", 10);
        let (id, _rx) = r.begin_stream("a");
        r.end_stream("a", id, 100);
        assert_eq!(state_of(&r, "a", 200)["state"], "WORK");
        // 新流开始（body 已收）→ pendingNextRequest
        r.begin_request("a", None, 0, 300);
        assert_eq!(state_of(&r, "a", 400)["state"], "WAITING");
        assert_eq!(
            state_of(&r, "a", 300 + PENDING_NEXT_TTL_MS + 1)["state"],
            "WAITING",
            "过期后 reqTs>0 仍把它升级成 WAITING（Node 的 req→响应头窗口）"
        );
    }

    /// req 已收但响应头未回 → 默认 IDLE 被升级成 WAITING。
    #[test]
    fn req_ts_window_upgrades_idle_to_waiting() {
        let r = reg();
        r.begin_request("a", None, 0, 1000);
        let st = state_of(&r, "a", 1500);
        assert_eq!(st["state"], "WAITING");
        assert_eq!(st["stateMs"], 500);
        r.clear_req_ts("a");
        assert_eq!(state_of(&r, "a", 1500)["state"], "IDLE");
    }

    #[test]
    fn tps_uses_window_tokens_in_stream_and_real_average_after() {
        let r = reg();
        r.begin_request("a", None, 0, 1000);
        let (id, _rx) = r.begin_stream("a");
        r.record_delta("a", DeltaKind::Text, "abcd", 4, 1500);
        let st = state_of(&r, "a", 1600);
        assert_eq!(st["tps"], 4, "流中 tps = 过去 1s 的 tokenizer token 数");
        assert_eq!(st["tpsEstimated"], true);
        assert_eq!(st["cps"], 4);
        // 真实 output_tokens 到位 + 流结束 → 用真实平均
        r.record_tokens("a", 40, 0, 1700);
        r.end_stream("a", id, 2000); // 耗时 1s → 40 tps
        let st = state_of(&r, "a", 2100);
        assert_eq!(st["tps"], 40);
        assert_eq!(st["tpsEstimated"], false);
        assert_eq!(st["outputTokens"], 40);
    }

    // ── /status 载荷形状 ──

    #[test]
    fn status_payload_has_the_dashboard_keys() {
        let r = reg();
        r.begin_request("cc:aaaaaaaa", None, 0, 1000);
        // 响应头已回（reqTs=0）→ 无流无结束 → IDLE
        r.clear_req_ts("cc:aaaaaaaa");
        let p = r.status_payload(2000, 120_000.0);
        let obj = p.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["agents", "idleCleanupMsMain", "ts"]);
        assert_eq!(p["idleCleanupMsMain"], 120_000);
        assert_eq!(p["agents"]["cc:aaaaaaaa"]["state"], "IDLE");
        assert!(p["ts"].as_str().unwrap().ends_with('Z'), "ts 是 ISO8601 UTC");
        let agent_keys: Vec<&str> = p["agents"]["cc:aaaaaaaa"]
            .as_object()
            .unwrap()
            .keys()
            .map(|k| k.as_str())
            .collect();
        for k in [
            "chars",
            "cps",
            "tokens",
            "outputTokens",
            "inputTokens",
            "lastInputTokens",
            "tps",
            "tpsEstimated",
            "active",
            "idleMs",
            "state",
            "stateMs",
            "streamPhase",
            "openStreams",
            "streamTokens",
            "requests",
            "sessionId",
            "isSubagent",
        ] {
            assert!(agent_keys.contains(&k), "缺少 dashboard 读的键 {k}");
        }
    }

    // ── prompts ──

    #[test]
    fn prompts_are_capped_at_100_and_keep_seq_and_body() {
        let r = reg();
        for i in 0..105 {
            r.begin_request("a", Some(json!({ "n": i })), 0, i as i64);
        }
        let payload = r.prompts_payload("a").unwrap();
        assert_eq!(payload["agentId"], "a");
        assert_eq!(payload["count"], MAX_PROMPTS, "上限 100，挤掉最旧");
        let arr = payload["prompts"].as_array().unwrap();
        assert_eq!(arr.len(), MAX_PROMPTS);
        // 最旧的是第 6 次（seq=6），最新 seq=105
        assert_eq!(arr[0]["seq"], 6);
        assert_eq!(arr[0]["body"]["n"], 5);
        assert_eq!(arr[99]["seq"], 105);
        assert_eq!(arr[0]["ts"], 5);
    }

    #[test]
    fn prompts_payload_is_none_for_unknown_agent() {
        let r = reg();
        assert!(r.prompts_payload("nope").is_none());
        r.ensure_agent("a");
        let p = r.prompts_payload("a").unwrap();
        assert_eq!(p["count"], 0);
        assert_eq!(p["prompts"].as_array().unwrap().len(), 0);
    }

    /// begin_request 的 body=None（JSON 解析失败）仍要计数，只是不存 prompt —— Node 如此。
    #[test]
    fn request_count_increments_even_when_body_is_unparsable() {
        let r = reg();
        assert_eq!(r.begin_request("a", None, 0, 1), 1);
        assert_eq!(r.begin_request("a", Some(json!({})), 0, 2), 2);
        let p = r.prompts_payload("a").unwrap();
        assert_eq!(p["count"], 1, "只有能解析的那次进 prompts");
        assert_eq!(p["prompts"][0]["seq"], 2);
    }

    // ── estimateInputTokens ──

    #[test]
    fn estimate_input_tokens_matches_node_formula() {
        // system 串 5 字符 + messages 文本 → round(chars/2.5)，下限 1
        let body = json!({"system": "abcde", "messages": [{"content": "fghij"}]});
        assert_eq!(estimate_input_tokens(&body), 4, "10 chars / 2.5 = 4");
        // content 数组里的 text / content 两种块都算
        let body = json!({
            "system": [{"type": "text", "text": "abc"}, {"type": "image"}],
            "messages": [{"content": [{"text": "de"}, {"content": "fg"}]}],
        });
        assert_eq!(estimate_input_tokens(&body), 3, "7 chars / 2.5 = 2.8 → 3");
        // 空 body → Math.max(1, 0) = 1（Node 对能解析的 body 至少给 1）
        assert_eq!(estimate_input_tokens(&json!({})), 1);
    }

    // ── 流注册 / kill ──

    #[tokio::test]
    async fn kill_destroys_registered_streams_and_reports_count() {
        let r = reg();
        let (id1, mut rx1) = r.begin_stream("a");
        let (_id2, _rx2) = r.begin_stream("a");
        assert_eq!(r.open_streams("a"), 2);

        assert_eq!(r.kill_streams("a"), 2);
        assert_eq!(r.open_streams("a"), 0, "kill 后集合清空（openStreams=0）");
        assert!(rx1.try_recv().is_ok(), "取消信号必须真的发到接收端");
        assert_eq!(r.kill_streams("a"), 0, "再 kill 一次没有流可销毁");
        assert_eq!(r.kill_streams("nope"), 0, "不存在的 agent 返回 0");
        // 已注销的流不会重复计数（kill 后的 end_stream 是 no-op，不做流末收尾）
        r.end_stream("a", id1, 9999);
    }

    #[tokio::test]
    async fn end_stream_removes_only_its_own_handle() {
        let r = reg();
        let (id1, _rx1) = r.begin_stream("a");
        let (_id2, _rx2) = r.begin_stream("a");
        r.end_stream("a", id1, 100);
        assert_eq!(r.open_streams("a"), 1);
        r.end_stream("a", 9999, 200); // 未知 id：no-op
        assert_eq!(r.open_streams("a"), 1);
    }

    // ── stop_reason 去重锚点 ──

    #[test]
    fn stop_reason_dedupe_is_per_agent_and_resettable() {
        let r = reg();
        assert!(r.note_stop_reason("a", "max_tokens", 1));
        assert!(!r.note_stop_reason("a", "max_tokens", 2), "同流内重复不报");
        assert!(r.note_stop_reason("a", "refusal", 3), "变化要报");
        assert!(r.note_stop_reason("b", "max_tokens", 4), "别的 agent 独立");
        r.clear_stop_reason("a");
        assert!(r.note_stop_reason("a", "refusal", 5), "清掉后重新算首次");
    }

    #[test]
    fn js_string_and_truthy_match_js_for_scalars() {
        assert!(js_truthy(&json!("x")));
        assert!(!js_truthy(&json!("")));
        assert!(!js_truthy(&json!(0)));
        assert!(js_truthy(&json!(1)));
        assert!(!js_truthy(&Value::Null));
        assert!(js_truthy(&json!([])), "空数组在 JS 里是真值");
        assert_eq!(js_string(&json!(5)), Some("5".to_string()));
        assert_eq!(js_string(&json!(true)), Some("true".to_string()));
        assert_eq!(js_string(&json!({})), None);
    }

    // ═══════════════ idle cleanup（`runCleanupPass`）═══════════════

    /// 用 `getAgentId` 造出带 `agentMeta` 的 main/sub（P2 分支会写 sessionId + isSubagent）。
    fn agent_with_session(r: &AgentRegistry, session: &str, code_agent: Option<&str>) -> String {
        let mut hs = vec![("x-claude-code-session-id", session)];
        if let Some(a) = code_agent {
            hs.push(("x-claude-code-agent-id", a));
        }
        r.get_agent_id("POST", "/v1/messages", &headers(&hs), None)
    }

    /// 空表：`agents.size === 0` 直接返回全零（Node 的第一行守卫）。
    #[test]
    fn cleanup_on_empty_registry_is_a_noop() {
        let r = reg();
        let rep = r.cleanup_pass_at(999, 120_000);
        assert_eq!((rep.removed, rep.kept, rep.scanned), (0, 0, 0));
        assert!(rep.candidates.is_empty() && rep.saved.is_empty());
    }

    /// main 的清理阈值：**严格大于**才删（Node `idleMs > limit`），且 `limit` 就是传入的
    /// `IDLE_CLEANUP_MS_MAIN`（= `/config/idle` 的消费者）。
    #[test]
    fn cleanup_removes_main_only_when_idle_strictly_exceeds_threshold() {
        let r = reg();
        // 注意 ts 不能用 0：`lastActivityTs || lastTs` 里 0 是 falsy，会回落成 `now`。
        r.record_delta("cc:main0001", DeltaKind::Text, "hi", 1, 1_000);

        // idleMs == limit → 不删
        let rep = r.cleanup_pass_at(1_000 + 120_000, 120_000);
        assert_eq!(rep.removed, 0, "idleMs == limit 不满足严格大于");
        assert_eq!(rep.scanned, 1, "scanned = 删除前的条数");

        // idleMs == limit + 1 → 删
        let rep = r.cleanup_pass_at(1_001 + 120_000, 120_000);
        assert_eq!(rep.removed, 1);
        assert_eq!(rep.kept, 0);
        assert_eq!(rep.scanned, 1);
        let c = &rep.candidates[0];
        assert_eq!(c.id, "cc:main0001");
        assert!(!c.is_subagent);
        assert!(!c.sub_done);
        assert_eq!(c.limit, 120_000);
        assert_eq!(c.idle_ms, 120_001);
        assert_eq!(c.stop_reason, None);
        assert_eq!(c.open_streams, 0);
        assert_eq!(c.orphan_reason, None);
        assert!(!r.has_agent("cc:main0001"), "pass 3 真的把 agent 删了");
    }

    /// 阈值来自调用方（`/config/idle` 改过的值必须真的生效）—— 小阈值不是被忽略的常量。
    #[test]
    fn cleanup_uses_the_configured_idle_threshold() {
        let r = reg();
        r.record_delta("cc:cfg", DeltaKind::Text, "x", 1, 1_000);
        assert_eq!(r.cleanup_pass_at(1_000 + 5_000, 5_000).removed, 0);
        assert_eq!(r.cleanup_pass_at(1_001 + 5_000, 5_000).removed, 1);
    }

    /// sub 正常 `end_turn` 的 limit 是 **0**（用完即清），与 main 的 120s 无关。
    #[test]
    fn cleanup_sub_that_ended_normally_has_zero_limit() {
        let r = reg();
        let sub = agent_with_session(&r, "sess-1", Some("agent-1"));
        assert!(sub.starts_with("sub:"), "P2 的 sub 命名：{sub}");
        r.record_delta(&sub, DeltaKind::Text, "x", 1, 1_000);
        r.note_stop_reason(&sub, "end_turn", 1_000);
        // idleMs = 1 > limit = 0 → 删；且 reason 归类为 end_turn
        let rep = r.cleanup_pass_at(1_001, 120_000);
        assert_eq!(rep.removed, 1);
        let c = &rep.candidates[0];
        assert!(c.is_subagent && c.sub_done);
        assert_eq!(c.limit, 0);
        assert_eq!(c.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(c.session_id.as_deref(), Some("sess-1"));
    }

    /// sub 非正常结束（`tool_use`）用 60s 缓冲。
    #[test]
    fn cleanup_sub_with_tool_use_uses_the_60s_buffer() {
        let r = reg();
        let sub = agent_with_session(&r, "sess-2", Some("agent-2"));
        r.record_delta(&sub, DeltaKind::Text, "x", 1, 1_000);
        r.note_stop_reason(&sub, "tool_use", 1_000);
        // endTs 落在很远的过去 → 已不在 WORK 兜底窗口内，按 IDLE_CLEANUP_MS_SUB 判
        let (sid, _rx) = r.begin_stream(&sub);
        r.end_stream(&sub, sid, 1_000);
        // idleMs == 60_000 → 不删（严格大于）
        assert_eq!(r.cleanup_pass_at(61_000, 120_000).removed, 0);
        // idleMs == 60_001 → 删
        let rep = r.cleanup_pass_at(61_001, 120_000);
        assert_eq!(rep.removed, 1);
        assert_eq!(rep.candidates[0].limit, 60_000);
        assert!(!rep.candidates[0].sub_done);
    }

    /// pass 0：sub 自己还在 WORK 窗口内（endTs 距今 < 60s），但同 session 的 main 已长期
    /// idle → 判"父 task 已死"，**强制**入列（`orphan_reason = parent_dead`）；同时 main 被
    /// pass 2 用这个活 sub 救回，所以本轮只删 sub。
    #[test]
    fn cleanup_forces_orphan_sub_when_session_mains_are_all_idle() {
        let r = reg();
        let main = agent_with_session(&r, "sess-orph", None);
        let sub = agent_with_session(&r, "sess-orph", Some("agent-9"));
        assert!(main.starts_with("cc:") && sub.starts_with("sub:"), "{main} / {sub}");

        let t: i64 = 1_000_000;
        // main 的"上次活动"距今 300s > 120s → 父不在了
        r.record_delta(&main, DeltaKind::Text, "m", 1, t - 300_000);
        // sub 的 endTs 距今 50s（< 60s WORK 兜底）→ 按 isAgentActive 仍算"在工作"
        r.record_delta(&sub, DeltaKind::Text, "s", 1, t - 200_000);
        r.note_stop_reason(&sub, "tool_use", t - 50_000);
        let (sid, _rx) = r.begin_stream(&sub);
        r.end_stream(&sub, sid, t - 50_000);

        let rep = r.cleanup_pass_at(t, 120_000);
        assert_eq!(rep.removed, 1, "孤儿子 agent 应被强制清掉");
        assert_eq!(rep.candidates.len(), 1);
        let c = &rep.candidates[0];
        assert_eq!(c.id, sub);
        assert_eq!(c.orphan_reason, Some("parent_dead"));
        assert!(c.is_subagent);
        assert_eq!(c.limit, 60_000);
        assert_eq!(c.stop_reason.as_deref(), Some("tool_use"));
        assert!(r.has_agent(&main), "main 被这个活 sub 救回，不该被删");
        assert!(!r.has_agent(&sub));
        assert_eq!(rep.saved.len(), 1, "main 走 pass 2 被救回");
        assert_eq!(rep.saved[0].id, main);
    }

    /// 父还活着（main 刚活动过）时，sub 不算孤儿。
    #[test]
    fn cleanup_keeps_sub_while_its_main_is_still_active() {
        let r = reg();
        let main = agent_with_session(&r, "sess-live", None);
        let sub = agent_with_session(&r, "sess-live", Some("agent-3"));
        let t: i64 = 2_000_000;
        r.record_delta(&main, DeltaKind::Text, "m", 1, t - 5_000); // 父刚活动
        r.record_delta(&sub, DeltaKind::Text, "s", 1, t - 50_000);
        r.note_stop_reason(&sub, "tool_use", t - 45_000);
        let (sid, _rx) = r.begin_stream(&sub);
        r.end_stream(&sub, sid, t - 45_000);

        let rep = r.cleanup_pass_at(t, 120_000);
        assert_eq!(rep.removed, 0, "父还活着，sub 不该被当孤儿");
        assert!(r.has_agent(&sub) && r.has_agent(&main));
    }

    /// pass 2：main 自己已超阈值，但同 session 有活着的 sub（宽窗口 10min）→ 救回 main，
    /// 且 `kept` = pass 1 保下的 + 救回的（Node 的 `keptAgents.size`）。
    #[test]
    fn cleanup_rescues_main_when_a_same_session_sub_is_alive() {
        let r = reg();
        let main = agent_with_session(&r, "sess-a", None);
        let sub = agent_with_session(&r, "sess-a", Some("agent-2"));
        let t: i64 = 3_000_000;
        r.record_delta(&main, DeltaKind::Text, "m", 1, t - 200_000); // main 超阈值
        r.record_delta(&sub, DeltaKind::Text, "s", 1, t - 5_000); // sub 刚活动

        let rep = r.cleanup_pass_at(t, 120_000);
        assert_eq!(rep.removed, 0, "有活 sub 的 session 里 main 不能被清");
        assert_eq!(rep.saved.len(), 1);
        assert_eq!(rep.saved[0].id, main);
        assert_eq!(rep.kept, 2, "kept = pass1 保下的 sub + pass2 救回的 main");
        assert!(r.has_agent(&main) && r.has_agent(&sub));
    }

    /// `kept` **包含** pass 0 的孤儿 sub —— Node 那句 `keptAgents.delete(o.id)` 是死代码：
    /// 紧随其后的 pass 1 必然把它 `add` 回来（孤儿定义即 `isAgentActive` 为真）。救回的 main 也计入。
    #[test]
    fn cleanup_kept_includes_orphan_forced_subs() {
        let r = reg();
        let main = agent_with_session(&r, "sess-k", None);
        let sub = agent_with_session(&r, "sess-k", Some("agent-k"));
        let t: i64 = 4_000_000;
        r.record_delta(&main, DeltaKind::Text, "m", 1, t - 300_000);
        r.record_delta(&sub, DeltaKind::Text, "s", 1, t - 100_000);
        r.note_stop_reason(&sub, "tool_use", t - 30_000);
        let (sid, _rx) = r.begin_stream(&sub);
        r.end_stream(&sub, sid, t - 30_000);

        let rep = r.cleanup_pass_at(t, 120_000);
        assert_eq!(rep.removed, 1, "只清孤儿 sub");
        // kept = pass 1 里的孤儿 sub（被重新 add 回来）+ pass 2 救回的 main
        assert_eq!(rep.kept, 2, "kept 必须包含孤儿 sub 与救回的 main");
    }

    /// `/cleanup/debug` 的载荷：键集合、reason/kind 归类、省略分支。
    #[test]
    fn cleanup_debug_payload_matches_node_shape() {
        let r = reg();
        r.record_delta("cc:dbg", DeltaKind::Text, "x", 1, 1_000);
        let (_rep, payload) = r.cleanup_debug_payload(1_000 + 200_000, 120_000);

        assert_eq!(payload["removed"], 1);
        assert_eq!(payload["saved"], 0);
        assert_eq!(payload["kept"], 0);
        assert_eq!(payload["scanned"], 1);
        assert_eq!(payload["remaining"], 0, "remaining 是删除后的 agents.size");
        assert_eq!(
            payload["candidates"].as_array().unwrap().len(),
            1
        );
        let c = &payload["candidates"][0];
        // 键序是字典序（serde_json 无 preserve_order）；键**集合**与 Node 一致。
        let keys: Vec<&str> = c
            .as_object()
            .unwrap()
            .keys()
            .map(|k| k.as_str())
            .collect();
        assert_eq!(
            keys,
            vec!["id", "idleMs", "kind", "limit", "openStreams", "reason"]
        );
        assert_eq!(c["id"], "cc:dbg");
        assert_eq!(c["kind"], "main");
        assert_eq!(c["idleMs"], 200_000);
        assert_eq!(c["limit"], 120_000);
        assert_eq!(c["reason"], "idle_main");
        assert_eq!(c["openStreams"], 0);
        assert!(c.get("stopReason").is_none(), "stopReason 为 undefined → 键省略");
        assert!(c.get("name").is_none(), "a.name 恒 undefined → 键省略");
    }

    /// 候选的 `reason` 三分支：`end_turn` / `idle_sub` / `idle_main`。
    #[test]
    fn cleanup_debug_reason_classification() {
        let r = reg();
        let main = agent_with_session(&r, "s-main", None);
        let sub_done = agent_with_session(&r, "s-done", Some("a1"));
        let sub_idle = agent_with_session(&r, "s-idle", Some("a2"));
        let t: i64 = 5_000_000;
        r.record_delta(&main, DeltaKind::Text, "m", 1, t - 200_000);
        r.record_delta(&sub_done, DeltaKind::Text, "d", 1, t - 200_000);
        r.note_stop_reason(&sub_done, "stop_sequence", t - 200_000);
        r.record_delta(&sub_idle, DeltaKind::Text, "i", 1, t - 200_000);
        r.note_stop_reason(&sub_idle, "tool_use", t - 200_000);
        // 三个都超阈值、都不在 WORK 兜底窗口（endTs 由 stop_reason_ts 之外无 endTs → 只看 idle）
        let (sid, _rx) = r.begin_stream(&sub_idle);
        r.end_stream(&sub_idle, sid, t - 200_000);

        let (_rep, payload) = r.cleanup_debug_payload(t, 120_000);
        let mut by_id: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for c in payload["candidates"].as_array().unwrap() {
            by_id.insert(
                c["id"].as_str().unwrap().to_string(),
                c["reason"].as_str().unwrap().to_string(),
            );
        }
        assert_eq!(by_id.get(&main).map(String::as_str), Some("idle_main"));
        assert_eq!(
            by_id.get(&sub_done).map(String::as_str),
            Some("end_turn")
        );
        assert_eq!(by_id.get(&sub_idle).map(String::as_str), Some("idle_sub"));
    }

    /// 差分实测的 section D 场景（小阈值 800ms + 刚结束的 tool_use sub）：
    /// 孤儿子 agent 被强制清掉、main 被这个活 sub 救回、`kept` 计入两者。
    #[test]
    fn cleanup_orphan_sub_rescues_main_and_counts_both_in_kept() {
        let r = reg();
        let main = agent_with_session(&r, "sess-d", None);
        let sub = agent_with_session(&r, "sess-d", Some("agent-sub-1"));
        assert_eq!(sub, "sub:agent-su", "P2 取 agent-id 前 8 个字符");
        let t: i64 = 9_000_000;
        // main：end_turn 已结束，idle 1853ms（> 阈值 800，也不是 WORK 窗口）
        r.begin_request(&main, None, 1, t - 1_853);
        r.record_delta(&main, DeltaKind::Text, "hi", 1, t - 1_853);
        r.note_stop_reason(&main, "end_turn", t - 1_853);
        let (sid, _rx) = r.begin_stream(&main);
        r.end_stream(&main, sid, t - 1_853);
        // sub：tool_use 刚结束（endTs 距今 300ms < 60s → 仍在 WORK 兜底窗口内）
        r.begin_request(&sub, None, 1, t - 300);
        r.record_delta(&sub, DeltaKind::Text, "working", 1, t - 300);
        r.note_stop_reason(&sub, "tool_use", t - 300);
        let (sid2, _rx2) = r.begin_stream(&sub);
        r.end_stream(&sub, sid2, t - 300);

        let rep = r.cleanup_pass_at(t, 800);
        assert_eq!(rep.removed, 1, "只清孤儿子 agent");
        assert_eq!(rep.candidates.len(), 1);
        assert_eq!(rep.candidates[0].id, sub);
        assert_eq!(rep.candidates[0].orphan_reason, Some("parent_dead"));
        assert_eq!(rep.candidates[0].limit, IDLE_CLEANUP_MS_SUB);
        assert_eq!(rep.saved.len(), 1, "main 被这个活 sub 救回");
        assert_eq!(rep.saved[0].id, main);
        assert_eq!(rep.kept, 2, "kept = 孤儿 sub + 救回的 main");
        assert_eq!(rep.scanned, 2);
        assert!(r.has_agent(&main) && !r.has_agent(&sub));
    }

    /// `sessionMainsAllIdle` 的"没有 main 就返回 false（不判孤儿）"这一支：父不在了但**表里
    /// 一个 main 都没有**时，Node `return hasMain` 给出 false —— 即**不**把 sub 当孤儿。
    #[test]
    fn cleanup_does_not_orphan_a_sub_when_no_main_is_in_the_table() {
        let r = reg();
        let sub = agent_with_session(&r, "sess-nomain", Some("agent-solo"));
        let t: i64 = 1_000_000;
        r.record_delta(&sub, DeltaKind::Text, "s", 1, t - 100_000);
        r.note_stop_reason(&sub, "tool_use", t - 30_000);
        let (sid, _rx) = r.begin_stream(&sub);
        r.end_stream(&sub, sid, t - 30_000);

        let rep = r.cleanup_pass_at(t, 120_000);
        assert_eq!(rep.removed, 0, "表里没有 main → hasMain=false → 不判孤儿");
        assert!(r.has_agent(&sub));
    }

    // ═══════════════ `_emitStateTransition` 的十个转换事件 ═══════════════

    /// 十个转换逐条钉住 `type` / `severity` / `message`（含 `WAITING→IDLE` 的 `(>60s)` 后缀），
    /// 以及 `*→DISCONNECTED` 兜底。
    #[test]
    fn transition_table_has_all_ten_node_events() {
        let cases: &[(&str, &str, &str, &str, &str)] = &[
            ("STREAM", "SSE_STUCK", "warn", "sse-stuck", "SSE 卡住 (>10s 无 delta)"),
            ("SSE_STUCK", "STREAM", "info", "sse-resumed", "SSE 恢复"),
            ("WAITING", "STREAM", "info", "first-delta", "收到首字"),
            ("STREAM", "WORK", "info", "tool-started", "进入工具调用"),
            ("STREAM", "IDLE", "info", "end-turn", "对话结束"),
            ("WORK", "IDLE", "info", "work-done", "工具结束 (无新请求)"),
            ("WORK", "WAITING", "info", "work-followup", "工具结束, 新请求已发"),
            (
                "WAITING",
                "IDLE",
                "warn",
                "sse-slow-response",
                "等首字超时/异常 (>60s)",
            ),
            ("IDLE", "DISCONNECTED", "warn", "agent-killed", "已显式断开"),
            ("DISCONNECTED", "WAITING", "info", "cc-retry", "cc 重试新请求"),
        ];
        for (prev, curr, severity, event_type, message) in cases {
            let ev = select_transition(Some(prev), curr, "cc:x", 120_000)
                .unwrap_or_else(|| panic!("{prev}→{curr} 应发事件"));
            assert_eq!(ev.severity, *severity, "{prev}→{curr}");
            assert_eq!(ev.event_type, *event_type, "{prev}→{curr}");
            assert_eq!(ev.message, *message, "{prev}→{curr}");
            assert_eq!(ev.prev, *prev);
            assert_eq!(ev.curr, *curr);
            assert_eq!(ev.agent_id, "cc:x");
            assert_eq!(ev.state_ms, 120_000);
        }
    }

    /// 三条守卫：`prev === curr` / 首次建表 / 表外转换，以及 `onlyIfMs` 门槛。
    #[test]
    fn transition_guards_match_node() {
        // 1. 状态没变 → 不发
        assert!(select_transition(Some("STREAM"), "STREAM", "a", 1).is_none());
        // 2. 首次建表（prev === undefined）→ 不发"凭空出现"
        assert!(select_transition(None, "STREAM", "a", 1).is_none());
        assert!(select_transition(None, "DISCONNECTED", "a", 1).is_none());
        // 3. 表外转换 → 不发（避免误报）
        assert!(select_transition(Some("IDLE"), "STREAM", "a", 9_999).is_none());
        assert!(select_transition(Some("WAITING"), "SSE_STUCK", "a", 9_999).is_none());
        assert!(select_transition(Some("WORK"), "SSE_STUCK", "a", 9_999).is_none());
        // onlyIfMs：`WAITING→IDLE` 需 stateMs >= 60_000（严格小于才不发）
        assert!(select_transition(Some("WAITING"), "IDLE", "a", 59_999).is_none());
        let ev = select_transition(Some("WAITING"), "IDLE", "a", 60_000).expect("恰好 60s 应发");
        assert_eq!(ev.event_type, "sse-slow-response");
        assert_eq!(ev.message, "等首字超时/异常 (>60s)");
        // 其余转换没有门槛：stateMs 极小也发
        assert!(select_transition(Some("STREAM"), "IDLE", "a", 0).is_some());
    }

    /// `tick` 的完整语义：首次建表不发；状态变化发一条并更新 `last_state`；状态不变不重复发。
    #[test]
    fn tick_emits_on_state_change_then_stays_quiet() {
        let r = reg();
        r.record_delta("cc:tick", DeltaKind::Text, "x", 1, 1_000);

        // tick 1：首次建表，不发事件
        let t1 = r.tick_at(1_000, 120_000);
        assert!(t1.transitions.is_empty(), "首次建表不该发'凭空出现'");
        assert_eq!(t1.cleanup.removed, 0, "idleMs=0，清理不动它");

        // 让 agent 进入 DISCONNECTED（killedAt 距今 100ms < 60s）
        assert_eq!(r.kill_streams_at("cc:tick", 2_000), 0, "没有活跃流");

        // tick 2：IDLE → DISCONNECTED
        let t2 = r.tick_at(2_100, 120_000);
        assert_eq!(t2.transitions.len(), 1);
        let ev = &t2.transitions[0];
        assert_eq!(ev.event_type, "agent-killed");
        assert_eq!(ev.severity, "warn");
        assert_eq!(ev.message, "已显式断开");
        assert_eq!((ev.prev.as_str(), ev.curr.as_str()), ("IDLE", "DISCONNECTED"));

        // tick 3：状态未变 → 不再发
        let t3 = r.tick_at(2_200, 120_000);
        assert!(t3.transitions.is_empty(), "状态未变不重复发");
    }

    /// `StateTransitionEvent::to_event_input` 的 `detail` 形状（Node 的 `{prev, curr, stateMs}`）
    /// 与 `agentId`（恒为字符串 `'unknown'` 也照发 —— Node 的 `ev.agentId || null` 里它是真值）。
    #[test]
    fn transition_event_input_has_node_detail_shape() {
        let ev = select_transition(Some("STREAM"), "WORK", "cc:abc", 4_321).unwrap();
        let input = ev.to_event_input();
        assert_eq!(input.severity, "info");
        assert_eq!(input.event_type, "tool-started");
        assert_eq!(input.agent_id.as_deref(), Some("cc:abc"));
        assert_eq!(input.message, "进入工具调用");
        assert_eq!(input.detail["prev"], "STREAM");
        assert_eq!(input.detail["curr"], "WORK");
        assert_eq!(input.detail["stateMs"], 4_321);
    }

    // ── 流末「无 delta」分流（`no-delta-*` / `upstream-empty-stream`）──

    /// 四个分支逐条对齐 Node（含"有 delta 就不报""≤1s 不报""unknown 不报"）。
    #[test]
    fn stream_end_diagnostic_matches_node_branches() {
        // unknown 一律不报（Node 的 `if (agentId !== 'unknown')`）
        let r = AgentRegistry::new();
        assert!(r.stream_end_diagnostic(UNKNOWN_AGENT, 5, 9_999).is_none());

        // D) 流持续 ≤ 1s → 静默（startTs=1000，now=2000 → durMs=1000，不满足 `> 1000`）
        let r = AgentRegistry::new();
        r.begin_request("a", None, 0, 1_000);
        assert!(r.stream_end_diagnostic("a", 5, 2_000).is_none(), "durMs=1000 不报");

        // C) 三标志全无 + > 1s → no-delta-on-close（warn）
        let ev = r.stream_end_diagnostic("a", 5, 2_001).expect("卡位嫌疑");
        assert_eq!(ev.severity, "warn");
        assert_eq!(ev.event_type, "no-delta-on-close");
        assert_eq!(ev.message, "整流无 delta, chunk 卡位嫌疑");
        assert_eq!(ev.agent_id.as_deref(), Some("a"));
        assert_eq!(ev.detail["durMs"], 1_001);
        assert_eq!(ev.detail["bufLen"], 5);
        let mut keys: Vec<String> = ev.detail.as_object().unwrap().keys().cloned().collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["bufLen", "durMs"], "C 分支 detail 只有两把键");

        // A) 有 message_start、无 block 无 stopReason → upstream-empty-stream（warn）
        r.note_sse_type("a", "message_start");
        let ev = r.stream_end_diagnostic("a", 7, 2_500).expect("空流");
        assert_eq!(ev.severity, "warn");
        assert_eq!(ev.event_type, "upstream-empty-stream");
        assert_eq!(ev.message, "上游空流 (message_start 后无内容)");
        assert_eq!(ev.detail["bufLen"], 7);

        // B) 出现 content_block_start → no-delta-tool-only（notice）
        r.note_sse_type("a", "content_block_start");
        let ev = r.stream_end_diagnostic("a", 9, 2_600).expect("合法无 delta 流");
        assert_eq!(ev.severity, "notice");
        assert_eq!(ev.event_type, "no-delta-tool-only");
        assert_eq!(ev.message, "流内无文本 delta (tool_use / 拒答 / 短流)");
        assert_eq!(ev.detail["durMs"], 1_600);
        assert_eq!(ev.detail["bufLen"], 9);
        assert_eq!(ev.detail["sawAnyBlock"], true);
        assert_eq!(ev.detail["sawStopReason"], false);
        assert_eq!(ev.detail["stopReason"], serde_json::Value::Null);
        let mut keys: Vec<String> = ev.detail.as_object().unwrap().keys().cloned().collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["bufLen", "durMs", "sawAnyBlock", "sawStopReason", "stopReason"],
            "B 分支 detail 五把键"
        );

        // 有 delta → 不报（`lastDeltaTs !== 0`）
        r.record_delta("a", DeltaKind::Text, "hi", 1, 2_650);
        assert!(
            r.stream_end_diagnostic("a", 9, 2_700).is_none(),
            "本流收到过 delta 就不属于无 delta 分流"
        );
    }

    /// `stopReason` 会进 B 分支的 detail（Node 的 `stopReason: s.stopReason`）。
    #[test]
    fn stream_end_diagnostic_reports_stop_reason() {
        let r = AgentRegistry::new();
        r.begin_request("a", None, 0, 1_000);
        r.note_sse_type("a", "content_block_start");
        r.note_stop_reason("a", "refusal", 1_500);
        let ev = r.stream_end_diagnostic("a", 3, 2_800).expect("拒答流");
        assert_eq!(ev.event_type, "no-delta-tool-only");
        assert_eq!(ev.detail["sawStopReason"], true);
        assert_eq!(ev.detail["stopReason"], "refusal");
    }

    /// `sawAnyDelta` 为真但 `lastDeltaTs` 仍为 0 是不可能的组合（delta 必写 lastDeltaTs），
    /// 这里钉住 Node 里那个 `if (!s.sawAnyDelta)` 守卫：有 block + 有 delta 时不报。
    #[test]
    fn stream_end_diagnostic_silent_when_blocks_and_delta_seen() {
        let r = AgentRegistry::new();
        r.begin_request("a", None, 0, 1_000);
        r.note_sse_type("a", "content_block_start");
        r.record_delta("a", DeltaKind::Text, "x", 1, 1_200);
        assert!(r.stream_end_diagnostic("a", 0, 3_000).is_none());
    }
}
