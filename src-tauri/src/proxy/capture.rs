//! 请求捕获环（capture ring）—— `/requests/recent`、`/requests/clear`、`/events*`、`/event/detail*` 的数据源。
//!
//! 语义逐条对齐 `proxy.js`：
//! - `CAPTURE_MAX = 200`，插入后若超限，按 **`last_access_ts` 升序 LRU 淘汰**（不是按 `ts`）；
//! - `/requests/recent` 按 `ts` 排序取**最后 50 条**（`RECENT_LIMIT`），每条形如 `_captureSummary(e)`；
//! - `/requests/clear` 清空并回报清掉的条数；
//! - `firstByteMs`：**SSE 用 `first_char_at`（第一个内容 delta，"真首字"），非 SSE 用 `first_byte_at`（响应头）**，
//!   两者都未到则 `null`；
//! - `totalMs`：`end_at - ts`，流进行中则 `now - ts`（所以是持续增长的估算值）；
//! - `ended`：`end_at` 是否落定 —— dashboard 靠它而不是 `statusCode` 区分"进行中/已完成"
//!   （SSE 响应头一到就是 200，字节还在持续输出）。
//!
//! ## `phase` 为什么在这里仍是 `null`
//! Node 版取「该流所属 agent 的 `stream.lastDeltaType`」来把进行中的行染成 think(紫)/text(橙)。
//! 那个值住在 **agent 表**（`agents.rs`）里，而不在捕获条目上 —— 所以本模块（只认识自己的
//! 条目）算不出来。`CaptureEntry::summary` 因此保留 `phase: null`，由调用方在拿到 summary 后
//! 用 `AgentRegistry::phase_for` 补上（见 `router.rs::with_phase`）。
//!
//! 这样做同时保住了 Node 的语义：`phase` 是「**读时**按 agent 的当前状态算」的，不是捕获时
//! 快照 —— 同一 cid 的两次 summary 之间若有新 delta 到达，phase 会跟着变。把 phase 存进
//! 条目反而会让它变成过期快照。Node 里 `_captureSummary` 也是每次现读 `agents.get(...)`。
//!
//! 取值规则见 `AgentRegistry::phase_for`：未结束 + agentId 已知（非空且非 `'unknown'`）+
//! `lastDeltaType` 命中，三者缺一即 `null`（dashboard 退回默认橙）。

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{json, Map, Value};

/// 环容量上限（对齐 Node 的 `CAPTURE_MAX`）。
pub const CAPTURE_MAX: usize = 200;
/// `/requests/recent` 返回的最大条数（对齐 Node 的 `.slice(-50)`）。
pub const RECENT_LIMIT: usize = 50;

/// 一次被捕获的请求/响应。字段对应 Node captureRing 的 entry。
#[derive(Debug, Clone, Default)]
pub struct CaptureEntry {
    pub cid: String,
    /// 请求**开始**时刻（不是 body 收完时刻 —— Node 有专门注释解释这个坑）
    pub ts: i64,
    /// 最近一次被访问时刻，LRU 淘汰按它排
    pub last_access_ts: i64,
    pub agent_id: Option<String>,
    pub method: String,
    pub url: String,
    /// 未拿到响应头时为 0（Node 是 `e.statusCode || 0`）
    pub status_code: u16,
    pub is_sse: bool,
    /// SSE 专用：第一个**内容 delta** 到达时刻
    pub first_char_at: Option<i64>,
    /// 非 SSE 专用：响应头到达时刻
    pub first_byte_at: Option<i64>,
    /// 流真正结束时刻；`None` = 进行中
    pub end_at: Option<i64>,
    pub req_body_size: usize,
    pub resp_body_size: usize,
    pub sse_bytes_size: usize,
    // ── `/event/detail` 需要的原始快照（Node entry 的同名字段）──
    /// `reqHeaders`（原始请求头，含原始 `host`，键小写、多值按 Node 的 `, ` 拼）
    pub req_headers: Vec<(String, String)>,
    /// `reqBody`（全量，不截断 —— Node 注释：copy-as-curl / SSE 详情需要完整数据）
    pub req_body: Vec<u8>,
    /// `reqBodyTruncated`（本实现与 Node 一致恒为 false，保留字段以对齐形状）
    pub req_body_truncated: bool,
    /// `respHeaders`（上游响应头；Node 在流**结束**时才写）
    pub resp_headers: Vec<(String, String)>,
    /// `respBody`（非 SSE 才有；SSE 为 null → 输出时留空）
    pub resp_body: Vec<u8>,
    pub resp_body_truncated: bool,
    /// `sseBytes`（字节级：已切出的完整 event 用 `\n\n` 拼 + 分隔符 + 未完成尾巴）
    pub sse_bytes: Vec<u8>,
    /// `sseBlocks`（每个完整 part 的切出时刻，dashboard 用它算 block 间隔）
    pub sse_blocks: Vec<i64>,
    /// `sseTruncated`：`None` = 流还没结束（Node 里该键此时是 `undefined`，
    /// `JSON.stringify` 会**省略**它），`Some(false)` = 正常结束。
    pub sse_truncated: Option<bool>,
    /// `details`：该 cid 内全部 `recordEvent` 诊断快照（顺序 = 调用顺序）。
    pub details: Vec<Value>,
    /// Node 的 `e._streamEnded`：`/event/detail/stream` 的新订阅者据此立即收到 `done`
    /// 并关闭连接（只有 Node 会置 true 的收尾路径才置位，见 `set_stream_ended`）。
    pub stream_ended: bool,
}

impl CaptureEntry {
    /// 生成 `_captureSummary(e)` 的等价对象。
    pub fn summary(&self, now: i64) -> Value {
        let fb = if self.is_sse {
            self.first_char_at
        } else {
            self.first_byte_at
        };
        json!({
            "cid": self.cid,
            "ts": self.ts,
            // Node 用 `e.agentId`（undefined 时 JSON.stringify 会**省略该键**）；这里给 null。
            // dashboard 侧是 `e.agentId || 'unknown'` 这类写法，两种都落到同一分支，故等价。
            "agentId": self.agent_id,
            "method": self.method,
            "url": self.url,
            "statusCode": self.status_code,
            "isSSE": self.is_sse,
            "ended": self.end_at.is_some(),
            // 恒为 null：真正的 phase 由调用方按 agent 表**读时**补（见模块头）。
            "phase": Value::Null,
            "reqBodySize": self.req_body_size,
            "respBodySize": self.resp_body_size,
            "sseBytesSize": self.sse_bytes_size,
            "firstByteMs": fb.map(|v| v - self.ts),
            "totalMs": self.end_at.unwrap_or(now) - self.ts,
        })
    }
}

/// 线程安全的定容捕获环（Tauri 的 axum handler 会并发访问，所以内部加锁）。
#[derive(Default)]
pub struct CaptureRing {
    inner: Mutex<HashMap<String, CaptureEntry>>,
}

impl CaptureRing {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().expect("capture ring poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 插入并做 LRU 淘汰。返回是否插入成功（同 cid 视为覆盖）。
    pub fn insert(&self, entry: CaptureEntry) {
        let mut map = self.inner.lock().expect("capture ring poisoned");
        map.insert(entry.cid.clone(), entry);
        if map.len() <= CAPTURE_MAX {
            return;
        }
        // 按 last_access_ts 升序，丢掉超出容量的那批（最少被访问的）
        let mut order: Vec<(String, i64)> = map
            .values()
            .map(|e| (e.cid.clone(), e.last_access_ts))
            .collect();
        order.sort_by_key(|(_, t)| *t);
        let excess = map.len() - CAPTURE_MAX;
        for (cid, _) in order.into_iter().take(excess) {
            map.remove(&cid);
        }
    }

    /// 环里是否有该 cid。注意与 `recent()` 的区别：`recent` 只回**最后 50 条**，
    /// 所以"不在 recent 里"不等于"被淘汰了"。
    pub fn contains(&self, cid: &str) -> bool {
        self.inner
            .lock()
            .expect("capture ring poisoned")
            .contains_key(cid)
    }

    /// 记录一次访问（供 LRU 使用）。不存在的 cid 静默忽略 —— Node 侧同样是防御性写法。
    pub fn touch(&self, cid: &str, now: i64) {
        let mut map = self.inner.lock().expect("capture ring poisoned");
        if let Some(e) = map.get_mut(cid) {
            e.last_access_ts = now;
        }
    }

    /// 更新某个已捕获条目的响应侧字段（拿到响应头/首字/结束时调用）。
    pub fn update<F: FnOnce(&mut CaptureEntry)>(&self, cid: &str, f: F) {
        let mut map = self.inner.lock().expect("capture ring poisoned");
        if let Some(e) = map.get_mut(cid) {
            f(e);
            e.last_access_ts = now_ms();
        }
    }

    /// 清空，返回清掉的条数（`/requests/clear` 的 `cleared`）。
    pub fn clear(&self) -> usize {
        let mut map = self.inner.lock().expect("capture ring poisoned");
        let n = map.len();
        map.clear();
        n
    }

    // ── 一次捕获的生命周期 ──
    //
    // 这几个方法就是 passthrough 将来要驱动的**状态机**。之所以先单独做出来：
    // `forward_response` 是 `Body::from_stream`（刻意不缓冲，中途上游出错要让客户端断开而不是挂住），
    // 所以"结束/首字/字节数"只能在流的包装里取得 —— 那部分接线有并发风险，
    // 而它要调用的判断逻辑可以先在这里定好并测透，届时只是机械地接上。

    /// 一次捕获的开始：注册条目。此时还没有响应信息（`statusCode=0`、`ended=false`）。
    pub fn begin(&self, cid: &str, method: &str, url: &str, ts: i64) {
        self.insert(CaptureEntry {
            cid: cid.to_string(),
            ts,
            last_access_ts: ts,
            method: method.to_string(),
            url: url.to_string(),
            ..Default::default()
        });
    }

    /// 上游响应头到达。`is_sse` 由 content-type 判定。
    /// 注意：这里记的是 **`first_byte_at`（响应头时刻）**，而 `summary()` 对 SSE 取的是
    /// `first_char_at` —— 所以 SSE 在首字到达前 `firstByteMs` 仍是 `null`（契约如此，不是 bug）。
    pub fn on_response_headers(&self, cid: &str, status: u16, is_sse: bool, at: i64) {
        self.update(cid, |e| {
            e.status_code = status;
            e.is_sse = is_sse;
            e.first_byte_at = Some(at);
        });
    }

    /// SSE 第一个**内容 delta** 到达（Node 里才是"真首字"）。
    /// 只记首次：后续 delta 不能把首字时刻推后，否则 `firstByteMs` 会一直变大。
    pub fn on_first_content_delta(&self, cid: &str, at: i64) {
        self.update(cid, |e| {
            if e.first_char_at.is_none() {
                e.first_char_at = Some(at);
            }
        });
    }

    /// 累加响应字节。**SSE 只累 `sse_bytes_size`，不动 `resp_body_size`** ——
    /// 这是 Node 的真实不对称：SSE 的 `data` 回调只写 `sseBytesSize`（`proxy.js:2170`），
    /// `respBodySize` 保持建条目时的 0，而 `_captureSummary` 直接读 `e.respBodySize`
    /// （`proxy.js:529`）。差分实测：同一 SSE 请求，Node 的 `/requests/recent` 里
    /// `respBodySize=0` / `sseBytesSize=N`，本实现此前两者都等于 N（`/requests/stream`
    /// 的帧因此也不一致）。dashboard 读 `sseBytesSize || respBodySize`，故显示无差别。
    pub fn add_resp_bytes(&self, cid: &str, n: usize, sse: bool) {
        self.update(cid, |e| {
            if sse {
                e.sse_bytes_size += n;
            } else {
                e.resp_body_size += n;
            }
        });
    }

    /// 请求体大小（body 收完后才知道）。
    pub fn set_req_body_size(&self, cid: &str, n: usize) {
        self.update(cid, |e| e.req_body_size = n);
    }

    /// agent 归属（`_cap.agentId = agentId`）。
    ///
    /// Node 在注册时就写 `agentId: 'unknown'`，收到 body 后再改成解析结果；本实现因为
    /// body 是先整体缓冲的，所以在 `begin` 之后立刻写入**解析好的**值（少一次
    /// `unknown → 真值` 的重广播，属已记录的差异：本实现没有 pending 帧）。
    /// 无论是否识别成功，这里写入的都是字符串（未识别 = `"unknown"`），与 Node 一致。
    pub fn set_agent_id(&self, cid: &str, agent_id: &str) {
        self.update(cid, |e| e.agent_id = Some(agent_id.to_string()));
    }

    /// 流真正结束 → `ended=true`，`totalMs` 从此固定（不再随 `now` 增长）。
    pub fn set_end(&self, cid: &str, at: i64) {
        self.update(cid, |e| e.end_at = Some(at));
    }

    /// `e.reqHeaders = req.headers`。
    pub fn set_req_headers(&self, cid: &str, headers: Vec<(String, String)>) {
        self.update(cid, |e| e.req_headers = headers);
    }

    /// `e.reqBody = bodyBuf; e.reqBodySize = bodyBuf.length; e.reqBodyTruncated = false`。
    pub fn set_req_body(&self, cid: &str, body: Vec<u8>) {
        self.update(cid, |e| {
            e.req_body_size = body.len();
            e.req_body = body;
            e.req_body_truncated = false;
        });
    }

    /// `e.respHeaders = proxyRes.headers`（Node 在流结束时写）。
    pub fn set_resp_headers(&self, cid: &str, headers: Vec<(String, String)>) {
        self.update(cid, |e| e.resp_headers = headers);
    }

    /// 非 SSE 的 `e.respBody`（Node 在 `proxyRes.on('end')` 写全量并置 truncated=false）。
    pub fn set_resp_body(&self, cid: &str, body: Vec<u8>) {
        self.update(cid, |e| {
            e.resp_body_size = body.len();
            e.resp_body = body;
            e.resp_body_truncated = false;
        });
    }

    /// SSE 流中的实时快照（每个 chunk 后调用，对应 Node data 回调里那段
    /// `_e.sseBytes = ...; _e.sseBlocks = ...; _e.sseBytesSize = ...`）。
    pub fn set_sse_progress(&self, cid: &str, bytes: Vec<u8>, blocks: Vec<i64>, size: usize) {
        self.update(cid, |e| {
            e.sse_bytes = bytes;
            e.sse_blocks = blocks;
            e.sse_bytes_size = size;
        });
    }

    /// 流正常结束时 `e.sseTruncated = false`。
    pub fn set_sse_truncated(&self, cid: &str, truncated: bool) {
        self.update(cid, |e| e.sse_truncated = Some(truncated));
    }

    /// `recordEvent` 往捕获条目追加一条诊断快照（Node：`ent.details.push({ts,type,severity,message,detail})`，
    /// 且 `detail` 里剔除 `correlationId` —— 那是实现细节，前端用 cid 拉详情不需要回显）。
    /// 只有**新事件**（未命中去重合并）才 push，与 Node 一致。
    pub fn push_detail(&self, cid: &str, event_json: &Value) {
        let Some(obj) = event_json.as_object() else {
            return;
        };
        let mut clean = Map::new();
        if let Some(Value::Object(d)) = obj.get("detail") {
            for (k, v) in d {
                if k == "correlationId" {
                    continue;
                }
                clean.insert(k.clone(), v.clone());
            }
        }
        let snapshot = json!({
            "ts": obj.get("ts").cloned().unwrap_or(Value::Null),
            "type": obj.get("type").cloned().unwrap_or(Value::Null),
            "severity": obj.get("severity").cloned().unwrap_or(Value::Null),
            "message": obj.get("message").cloned().unwrap_or(Value::Null),
            "detail": Value::Object(clean),
        });
        self.update(cid, |e| e.details.push(snapshot));
    }

    /// `e._streamEnded` —— 只有 Node 会置 true 的收尾路径才置位（见 `router.rs` 的守卫）。
    pub fn set_stream_ended(&self, cid: &str, ended: bool) {
        self.update(cid, |e| e.stream_ended = ended);
    }

    /// `/event/detail?cid=` 的载荷快照（同时按 Node 语义 touch LRU）。
    /// 不存在返回 `None`（端点据此回 404）。`hex` 对应 `?hex=1`（附原始字节 hex）。
    pub fn detail_of(&self, cid: &str, hex: bool) -> Option<Value> {
        let now = now_ms();
        let mut map = self.inner.lock().expect("capture ring poisoned");
        let e = map.get_mut(cid)?;
        e.last_access_ts = now; // LRU read touch
        Some(e.detail_payload(hex))
    }

    /// `/event/detail/stream?cid=` 需要的三样：是否已结束、当前 SSE 字节、完整事件块的切出时刻。
    /// 不 touch LRU 的调用方（浏览器点开详情时会先打 `/event/detail` 再开流，touch 已发生）。
    pub fn stream_snapshot(&self, cid: &str) -> Option<(bool, Vec<u8>, Vec<i64>)> {
        let mut map = self.inner.lock().expect("capture ring poisoned");
        let e = map.get_mut(cid)?;
        e.last_access_ts = now_ms();
        Some((e.stream_ended, e.sse_bytes.clone(), e.sse_blocks.clone()))
    }

    /// 单条 summary（广播用）。条目不存在（已被 LRU 淘汰）返回 `None` —— 调用方静默跳过，
    /// 不做"补一条空 summary"之类的猜测。
    pub fn summary_of(&self, cid: &str, now: i64) -> Option<Value> {
        let map = self.inner.lock().expect("capture ring poisoned");
        map.get(cid).map(|e| e.summary(now))
    }

    /// 按 `ts` **升序**取最后 `limit` 条 summary。
    ///
    /// `/requests/recent`（limit=`RECENT_LIMIT`）与 `/requests/stream` 的订阅回放
    /// （limit=`SSE_EVENT_BACKLOG`）共用这一份语义：**升序取末尾 N 条 = 旧→新**。
    /// 顺序很讲究 —— dashboard push 到列表末尾，回放旧在新之前，列表才是"旧在上、新在下"，
    /// 与实时 append 方向一致；降序回放会让历史倒序（Node 侧修过的 bug）。
    pub fn summaries_sorted(&self, limit: usize, now: i64) -> Vec<Value> {
        let map = self.inner.lock().expect("capture ring poisoned");
        let mut all: Vec<&CaptureEntry> = map.values().collect();
        all.sort_by_key(|e| e.ts);
        let start = all.len().saturating_sub(limit);
        all[start..].iter().map(|e| e.summary(now)).collect()
    }

    /// `/requests/recent` 的载荷：按 `ts` 升序取最后 `RECENT_LIMIT` 条。
    pub fn recent(&self, now: i64) -> Value {
        json!({ "requests": self.summaries_sorted(RECENT_LIMIT, now) })
    }
}

impl CaptureEntry {
    /// `/event/detail` 的响应体。逐字对齐 `proxy.js:1635-1664`。
    pub fn detail_payload(&self, hex: bool) -> Value {
        let header_obj = |pairs: &[(String, String)]| -> Value {
            let mut m = Map::new();
            for (k, v) in pairs {
                m.insert(k.clone(), json!(v));
            }
            Value::Object(m)
        };
        // SSE 时也回 resp：statusCode/headers 来自上游，body=null（字节在 sse 字段）。
        let mut resp = Map::new();
        resp.insert(
            "statusCode".to_string(),
            if self.status_code == 0 {
                Value::Null
            } else {
                json!(self.status_code)
            },
        );
        resp.insert("headers".to_string(), header_obj(&self.resp_headers));
        resp.insert(
            "body".to_string(),
            if self.is_sse {
                Value::Null
            } else {
                json!(String::from_utf8_lossy(&self.resp_body))
            },
        );
        resp.insert(
            "bodyTruncated".to_string(),
            if self.is_sse {
                Value::Bool(false)
            } else {
                json!(self.resp_body_truncated)
            },
        );
        resp.insert(
            "bodySize".to_string(),
            if self.is_sse {
                json!(0)
            } else {
                json!(self.resp_body_size)
            },
        );
        resp.insert("isSSE".to_string(), json!(self.is_sse));

        let sse = if self.is_sse {
            let mut s = Map::new();
            s.insert(
                "bytes".to_string(),
                json!(String::from_utf8_lossy(&self.sse_bytes)),
            );
            // Node：`...(hexQ && e.sseBytes ? { bytesHex: ... } : {})` —— 空字节流不附 hex。
            if hex && !self.sse_bytes.is_empty() {
                s.insert("bytesHex".to_string(), json!(hex_encode(&self.sse_bytes)));
            }
            // Node：`bytesTruncated: e.sseTruncated` —— 流未结束时该值是 undefined，键被省略。
            if let Some(t) = self.sse_truncated {
                s.insert("bytesTruncated".to_string(), json!(t));
            }
            s.insert("bytesSize".to_string(), json!(self.sse_bytes_size));
            s.insert(
                "blocks".to_string(),
                Value::Array(self.sse_blocks.iter().map(|ts| json!({ "ts": ts })).collect()),
            );
            Value::Object(s)
        } else {
            Value::Null
        };

        let mut req = Map::new();
        req.insert("headers".to_string(), header_obj(&self.req_headers));
        req.insert(
            "body".to_string(),
            json!(String::from_utf8_lossy(&self.req_body)),
        );
        req.insert("bodyTruncated".to_string(), json!(self.req_body_truncated));
        req.insert("bodySize".to_string(), json!(self.req_body_size));

        let mut out = Map::new();
        out.insert("cid".to_string(), json!(self.cid));
        out.insert(
            "agentId".to_string(),
            self.agent_id
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        out.insert("method".to_string(), json!(self.method));
        out.insert("url".to_string(), json!(self.url));
        out.insert("ts".to_string(), json!(self.ts));
        out.insert("req".to_string(), Value::Object(req));
        out.insert("resp".to_string(), Value::Object(resp));
        out.insert("sse".to_string(), sse);
        out.insert("details".to_string(), Value::Array(self.details.clone()));
        Value::Object(out)
    }
}

/// 小写 hex（Node `Buffer.toString('hex')`）。
fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

/// 生成捕获 id。Node 用 `crypto.randomUUID()`；这里用「时间戳 + 进程内自增」——
/// cid 对 dashboard 只是**不透明主键**（用于 `/event/detail?cid=` 回查），没有格式契约，
/// 所以不必为它引一个 uuid 依赖。同一毫秒内靠自增保证唯一。
pub fn new_cid() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    format!("{:x}-{:x}", now_ms(), SEQ.fetch_add(1, Ordering::Relaxed))
}

/// 当前毫秒时间戳（对齐 Node 的 `Date.now()`）。
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(cid: &str, ts: i64, last_access: i64) -> CaptureEntry {
        CaptureEntry {
            cid: cid.to_string(),
            ts,
            last_access_ts: last_access,
            method: "POST".into(),
            url: "/v1/messages".into(),
            ..Default::default()
        }
    }

    #[test]
    fn insert_and_len() {
        let r = CaptureRing::new();
        assert!(r.is_empty());
        r.insert(entry("a", 1, 1));
        assert_eq!(r.len(), 1);
    }

    /// 容量上限：插到 CAPTURE_MAX+1 时淘汰掉最久未访问的那一条
    #[test]
    fn evicts_by_last_access_not_by_ts() {
        let r = CaptureRing::new();
        for i in 0..CAPTURE_MAX {
            // ts 递增，但让最早插入的那条拥有**最大的** last_access（最近被访问过）
            r.insert(entry(&format!("c{i}"), i as i64, i as i64));
        }
        // 把 c0 标成"刚刚访问过"——它 ts 最小却最不该被淘汰
        r.touch("c0", 10_000);
        r.insert(entry("new", 9_999, 9_999));

        assert_eq!(r.len(), CAPTURE_MAX);
        // 必须用 contains 判存活：recent() 只回"最后 50 条（按 ts）"，
        // 而 c0 的 ts 是最小的 —— 它压根不会出现在 recent 里，但那不代表它被淘汰了。
        assert!(r.contains("c0"), "最近访问过的 c0 不该被淘汰（ts 最小但 last_access 最大）");
        assert!(!r.contains("c1"), "最久未访问的 c1 应被淘汰（last_access 最小）");
        assert!(r.contains("new"), "新插入的应留下");
    }

    #[test]
    fn recent_sorted_by_ts_and_capped_at_50() {
        let r = CaptureRing::new();
        for i in 0..80 {
            r.insert(entry(&format!("c{i}"), i as i64, i as i64));
        }
        let got = r.recent(1000);
        let arr = got["requests"].as_array().unwrap();
        assert_eq!(arr.len(), RECENT_LIMIT, "最多 50 条");
        // 取的是**最后** 50 条（c30..c79），且按 ts 升序
        assert_eq!(arr[0]["cid"], "c30");
        assert_eq!(arr[49]["cid"], "c79");
        let ts: Vec<i64> = arr.iter().map(|v| v["ts"].as_i64().unwrap()).collect();
        let mut sorted = ts.clone();
        sorted.sort_unstable();
        assert_eq!(ts, sorted, "必须按 ts 升序");
    }

    /// SSE 与普通请求的"首字耗时"来源不同 —— 这是 Node 里被专门注释过的语义
    #[test]
    fn first_byte_ms_uses_first_char_for_sse_and_header_for_others() {
        let mut sse = entry("s", 1000, 1000);
        sse.is_sse = true;
        sse.first_char_at = Some(1500); // 真首字
        sse.first_byte_at = Some(1100); // 响应头更早，但 SSE 不看它
        assert_eq!(sse.summary(2000)["firstByteMs"], 500);
        assert_eq!(sse.summary(2000)["isSSE"], true);

        let mut plain = entry("p", 1000, 1000);
        plain.first_byte_at = Some(1200);
        plain.first_char_at = Some(1999); // 非 SSE 不看它
        assert_eq!(plain.summary(2000)["firstByteMs"], 200);
    }

    #[test]
    fn total_ms_grows_while_running_and_freezes_when_ended() {
        let mut e = entry("x", 1000, 1000);
        // 进行中：用 now - ts
        assert_eq!(e.summary(3000)["totalMs"], 2000);
        assert_eq!(e.summary(5000)["totalMs"], 4000);
        assert_eq!(e.summary(5000)["ended"], false);
        // 结束后：固定为 end_at - ts
        e.end_at = Some(2500);
        assert_eq!(e.summary(9000)["totalMs"], 1500);
        assert_eq!(e.summary(9000)["ended"], true);
    }

    #[test]
    fn summary_has_exactly_the_dashboard_keys() {
        let e = entry("k", 1, 1);
        let s = e.summary(2);
        let obj = s.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "agentId",
                "cid",
                "ended",
                "firstByteMs",
                "isSSE",
                "method",
                "phase",
                "reqBodySize",
                "respBodySize",
                "sseBytesSize",
                "statusCode",
                "totalMs",
                "ts",
                "url",
            ],
            "_captureSummary 的键集必须与 Node 版一致（dashboard 直接读这些键）"
        );
        assert_eq!(obj["statusCode"], 0, "未拿到响应头时是 0（Node: e.statusCode || 0）");
        assert_eq!(obj["phase"], Value::Null);
        assert_eq!(obj["firstByteMs"], Value::Null, "两个时刻都没有 → null");
    }

    /// 完整生命周期：必须与 Node 的字段更新时机一致
    #[test]
    fn lifecycle_matches_node() {
        let r = CaptureRing::new();
        let cid = new_cid();
        r.begin(&cid, "POST", "/v1/messages", 1000);
        assert!(r.contains(&cid));

        // 响应头到达：statusCode 落定，但**还不算结束**（SSE 字节还在流）
        r.on_response_headers(&cid, 200, true, 1100);
        let s = r.recent(1200)["requests"][0].clone();
        assert_eq!(s["statusCode"], 200);
        assert_eq!(s["isSSE"], true);
        assert_eq!(s["ended"], false, "响应头到了不等于流结束（SSE 靠 ended 而非 statusCode 判断）");
        assert_eq!(
            s["firstByteMs"],
            Value::Null,
            "SSE 的首字还没到 → 即使响应头已到，firstByteMs 仍是 null"
        );

        // 首字（内容 delta）到达：SSE 的 firstByteMs 从这里算
        r.on_first_content_delta(&cid, 1500);
        assert_eq!(r.recent(1600)["requests"][0]["firstByteMs"], 500);

        // 后续 delta 不能把首字推后
        r.on_first_content_delta(&cid, 1900);
        assert_eq!(r.recent(2000)["requests"][0]["firstByteMs"], 500);

        // 字节累计 + 请求体大小。**SSE 的 `respBodySize` 恒为 0** —— Node 的 SSE 回调只累
        // `sseBytesSize`（`proxy.js:2170`），而 `_captureSummary` 直接读 `e.respBodySize`
        // （`proxy.js:529`）；差分实测 Node 的 `/requests/recent` 正是 `respBodySize=0`。
        r.add_resp_bytes(&cid, 10, true);
        r.add_resp_bytes(&cid, 5, true);
        r.set_req_body_size(&cid, 42);
        let s = r.recent(2100)["requests"][0].clone();
        assert_eq!(
            s["respBodySize"], 0,
            "SSE 的 respBodySize 保持 0（与 Node 逐项相等的差分判据）"
        );
        assert_eq!(s["sseBytesSize"], 15);
        assert_eq!(s["reqBodySize"], 42);

        // 结束：totalMs 固定
        r.set_end(&cid, 2500);
        let s = r.recent(9000)["requests"][0].clone();
        assert_eq!(s["ended"], true);
        assert_eq!(s["totalMs"], 1500, "结束后不再随 now 增长");
    }

    /// 非 SSE：首字用**响应头**时刻，且不累加 sseBytesSize
    #[test]
    fn non_sse_first_byte_ms_comes_from_the_response_header() {
        let r = CaptureRing::new();
        r.begin("c", "GET", "/v1/models", 1000);
        r.on_response_headers("c", 200, false, 1300);
        r.add_resp_bytes("c", 7, false);
        r.set_end("c", 1400);
        let s = r.recent(2000)["requests"][0].clone();
        assert_eq!(s["firstByteMs"], 300);
        assert_eq!(s["totalMs"], 400);
        assert_eq!(s["sseBytesSize"], 0, "非 SSE 不该记 SSE 字节");
        assert_eq!(s["respBodySize"], 7);
    }

    #[test]
    fn cids_are_unique_even_within_the_same_millisecond() {
        let a = new_cid();
        let b = new_cid();
        assert_ne!(a, b);
    }

    /// 广播回放用的读接口：升序 + 末尾 limit 条，与 `recent` 同源。
    #[test]
    fn summaries_sorted_ascending_and_capped() {
        let r = CaptureRing::new();
        for i in 0..80 {
            r.insert(entry(&format!("c{i}"), i as i64, i as i64));
        }
        let got = r.summaries_sorted(50, 1000);
        assert_eq!(got.len(), 50, "最多 limit 条");
        assert_eq!(got[0]["cid"], "c30");
        assert_eq!(got[49]["cid"], "c79");
        let ts: Vec<i64> = got.iter().map(|v| v["ts"].as_i64().unwrap()).collect();
        let mut sorted = ts.clone();
        sorted.sort_unstable();
        assert_eq!(ts, sorted, "必须按 ts 升序（旧→新）");
        // 小 limit 也成立：取的是末尾
        let got = r.summaries_sorted(3, 1000);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0]["cid"], "c77");
        assert_eq!(got[2]["cid"], "c79");
    }

    #[test]
    fn summary_of_returns_entry_or_none() {
        let r = CaptureRing::new();
        r.begin("c", "POST", "/v1/messages", 1000);
        let s = r.summary_of("c", 1200).expect("存在的 cid 应有 summary");
        assert_eq!(s["cid"], "c");
        assert_eq!(s["totalMs"], 200);
        assert!(
            r.summary_of("missing", 1200).is_none(),
            "不存在的 cid 返回 None，不 panic"
        );
    }

    #[test]
    fn clear_reports_count_and_empties() {
        let r = CaptureRing::new();
        r.insert(entry("a", 1, 1));
        r.insert(entry("b", 2, 2));
        assert_eq!(r.clear(), 2);
        assert!(r.is_empty());
        assert_eq!(r.clear(), 0);
        assert_eq!(r.recent(1)["requests"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn touch_and_update_on_missing_cid_are_noops() {
        let r = CaptureRing::new();
        r.touch("nope", 5); // 不该 panic
        r.update("nope", |e| e.status_code = 500);
        assert!(r.is_empty());
    }

    // ── `/event/detail` 载荷（dashboard 详情抽屉的契约）──

    #[test]
    fn detail_payload_matches_node_shape_for_sse() {
        let r = CaptureRing::new();
        r.begin("c", "POST", "/v1/messages", 1000);
        r.set_req_headers("c", vec![("host".into(), "api.anthropic.com".into())]);
        r.set_req_body("c", b"{\"model\":\"x\"}".to_vec());
        r.set_agent_id("c", "cc:aaaaaaaa");
        r.on_response_headers("c", 200, true, 1100);
        r.set_sse_progress("c", b"data: {\"a\":1}".to_vec(), vec![1100], 15);
        r.set_sse_truncated("c", false);
        r.push_detail(
            "c",
            &json!({
                "ts": 1200, "type": "parse-fail", "severity": "error", "message": "m",
                "detail": {"correlationId": "c", "err": "x"},
            }),
        );
        r.set_resp_headers(
            "c",
            vec![("content-type".into(), "text/event-stream".into())],
        );
        r.set_end("c", 1300);

        let d = r.detail_of("c", false).unwrap();
        assert_eq!(d["cid"], "c");
        assert_eq!(d["agentId"], "cc:aaaaaaaa");
        assert_eq!(d["method"], "POST");
        assert_eq!(d["url"], "/v1/messages");
        assert_eq!(d["ts"], 1000);
        assert_eq!(d["req"]["body"], "{\"model\":\"x\"}");
        assert_eq!(d["req"]["bodyTruncated"], false);
        assert_eq!(d["req"]["bodySize"], 13);
        assert_eq!(d["req"]["headers"]["host"], "api.anthropic.com");
        assert_eq!(d["resp"]["statusCode"], 200);
        assert_eq!(d["resp"]["isSSE"], true);
        assert_eq!(d["resp"]["body"], Value::Null, "SSE 的 resp.body=null");
        assert_eq!(d["resp"]["bodySize"], 0);
        assert_eq!(d["resp"]["bodyTruncated"], false);
        assert_eq!(
            d["resp"]["headers"]["content-type"],
            "text/event-stream"
        );
        assert_eq!(d["sse"]["bytes"], "data: {\"a\":1}");
        assert_eq!(d["sse"]["bytesSize"], 15);
        assert_eq!(d["sse"]["bytesTruncated"], false);
        assert_eq!(d["sse"]["blocks"][0]["ts"], 1100);
        assert!(d["sse"].get("bytesHex").is_none(), "默认不带 hex");
        // details：顺序保留，且 correlationId 被剔除（Node 的 cleanDetail）
        assert_eq!(d["details"][0]["type"], "parse-fail");
        assert_eq!(d["details"][0]["ts"], 1200);
        assert_eq!(d["details"][0]["detail"]["err"], "x");
        assert!(d["details"][0]["detail"].get("correlationId").is_none());

        // ?hex=1 → 原始字节 hex
        let h = r.detail_of("c", true).unwrap();
        assert_eq!(h["sse"]["bytesHex"], hex_encode(b"data: {\"a\":1}"));
        // LRU read touch
        assert!(r.detail_of("missing", false).is_none());
    }

    #[test]
    fn detail_payload_non_sse_has_null_sse_and_utf8_body() {
        let r = CaptureRing::new();
        r.begin("p", "GET", "/v1/models", 1000);
        r.set_resp_body("p", "{\"ok\":真}".as_bytes().to_vec());
        r.set_end("p", 1200);
        let d = r.detail_of("p", false).unwrap();
        assert_eq!(d["sse"], Value::Null, "非 SSE → sse=null");
        assert_eq!(d["resp"]["body"], "{\"ok\":真}");
        assert_eq!(d["resp"]["isSSE"], false);
        assert_eq!(d["resp"]["bodySize"], 10, "字节数(10)而非字符数(8)");
        assert_eq!(d["resp"]["statusCode"], Value::Null, "statusCode=0 → null");
        assert!(r.detail_of("nope", false).is_none());
    }

    /// 流未结束时 `sseTruncated` 是 `None` → 键被**省略**（Node 此时是 `undefined`，
    /// `JSON.stringify` 同样省略）；流结束置 `Some(false)` 后才出现。
    #[test]
    fn sse_truncated_key_is_omitted_until_the_stream_ends() {
        let r = CaptureRing::new();
        r.begin("c", "POST", "/v1/messages", 1000);
        r.on_response_headers("c", 200, true, 1100);
        let before = r.detail_of("c", false).unwrap();
        assert!(
            before["sse"].get("bytesTruncated").is_none(),
            "流未结束 → 与 Node 的 undefined 一致省略该键"
        );
        r.set_sse_truncated("c", false);
        let after = r.detail_of("c", false).unwrap();
        assert_eq!(after["sse"]["bytesTruncated"], false);
    }

    /// 空 SSE 字节流不附 `bytesHex`（Node: `hexQ && e.sseBytes ? ... : {}`）。
    #[test]
    fn empty_sse_bytes_never_get_a_hex_dump() {
        let r = CaptureRing::new();
        r.begin("c", "POST", "/v1/messages", 1000);
        r.on_response_headers("c", 200, true, 1100);
        let d = r.detail_of("c", true).unwrap();
        assert!(d["sse"].get("bytesHex").is_none());
        assert_eq!(d["sse"]["bytes"], "");
        assert_eq!(d["sse"]["blocks"].as_array().unwrap().len(), 0);
    }
}
