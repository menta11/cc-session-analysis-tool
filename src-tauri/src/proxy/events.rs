//! 异常事件环（events ring）—— `/events`、`/events/stream`、`/events/clear` 的数据源。
//!
//! **这是与 `capture.rs` 的捕获环完全独立的第二个定容结构**，不是同一份数据的两个视图。
//! 依据是 `proxy.js`：`/events/stream` 回放的是 `events.slice(-SSE_EVENT_BACKLOG)`
//! （见 `proxy.js:1401`），而 `/requests/stream` 回放的是 `captureRing.values()`；
//! 两者是不同的数组、不同的容量、不同的淘汰方式。搞混会让 dashboard 的事件流带显示成
//! 请求列表（或反过来），所以这里逐条对齐 Node 的语义：
//!
//! - `MAX_EVENTS = 200`，追加后超限时 `shift()` 掉**最旧**的一条（先进先出，**不是** LRU ——
//!   对比捕获环按 `last_access_ts` 淘汰，两者刻意不同）；
//! - `EVENT_DEDUPE_MS = 60_000`：同 `type` + 同 `agentId` 的**最近一条**，若距其 `ts` 不足
//!   60s 则**合并**（`count += 1`、`lastTs = now`、原 `ts` 不变），否则追加新条目；
//! - `/events` 载荷：`{ count: events.length, events: events.slice(-100) }` —— `count` 是
//!   **环长**（最多 200），不是切片长度（最多 100）；
//! - `/events/stream` 订阅回放：插入序的**最后 50 条**（旧→新），与实时帧 append 方向一致；
//! - `/events/clear`：清空环（顺带让 60s 去重窗口自然重置），并广播 `event: clear` 控制帧。
//!
//! ## 事件形状（逐字对齐 `recordEvent`）
//!
//! 新条目：`{ severity, type, agentId, message, detail, ts, count }`；
//! 命中去重合并后才会多出 `lastTs`。`agentId` 恒存在（无归属时为 `null`）；
//! 传了请求 cid 时 `detail.correlationId` 会被补上（已有则不覆盖）。
//! `recordEvent` 开头的守卫（缺 `type` 或 `severity` 直接丢弃）也照抄。
//!
//! ## 事件来源（2026-09-15 起为全量）
//!
//! - **L2 HTTP 错误码**（`router.rs::emit_http_status_event`，信息在响应头到达时已完整）；
//! - **agent 身份归属**（`router.rs` 把 `getAgentId` 的结果带给每条事件）——
//!   未识别时是字符串 `'unknown'`（Node 的 `ev.agentId || null` 里它是真值），所以 60s
//!   去重现在是按 type + agent 分组，与 Node 一致；
//! - **`agent-unknown`**（SSE 流但 header 解析不出 agent，`agentId: null`）；
//! - **SSE 内容类**（都在 `router.rs::forward_response` 的那一遍解析里，见 `sse.rs::analyze_event`）：
//!   `event-field` / `parse-fail` / `event-error-payload` / `unknown-type` /
//!   `stop-reason-refusal|overload|max-tokens|pause-turn`；
//! - **agent 状态机转换**（`agents.rs::select_transition` + `mod.rs::spawn_cleanup_loop`）：
//!   `sse-stuck` / `sse-resumed` / `first-delta` / `tool-started` / `end-turn` / `work-done` /
//!   `work-followup` / `sse-slow-response` / `agent-killed` / `cc-retry`；
//! - **流末「无 delta」分流**（`agents.rs::stream_end_diagnostic`，由 `CaptureEndGuard` 在
//!   上游正常结束时调）：`no-delta-tool-only` / `upstream-empty-stream` / `no-delta-on-close`；
//! - **上游字节损坏取证**（`sse.rs::scan_corruption` + `CaptureEndGuard`）：
//!   `upstream-byte-corruption`（扫 Node 的 `rawAll` 等价物，即 `CaptureEndGuard::raw_all`）；
//! - **`upstream-timeout`**（`forward_response` 里起的 60s 看门狗，首字到达 / 流收尾即解除）；
//! - **收尾类**（`CaptureEndGuard::drop`）：`client-disconnect` / `upstream-stream-error`；
//! - **`upstream-tcp-error`**（`proxy()` 的 `send()` 失败分支，TCP/TLS/DNS 连接失败）。
//!
//! 已知的**运行时文案差异**（非形状差异）：`upstream-tcp-error` 的 `message` 后缀与
//! `detail.code` 来自各自运行时的 socket 错误（Node `ECONNREFUSED` vs reqwest 无等价 code，
//! 故本实现取 `null`）；`upstream-stream-error` 的 `detail.err` 同理。键集与语义一致。

//! `recordEvent` 往 `captureRing.get(cid).details` 追加事件快照**已实现**（供
//! `/event/detail` 的"诊断详情"tab 回查）：`record_detailed` 返回"是不是新事件"，
//! 只有追加分支才写 `details`（命中 60s 去重合并不写，Node 如此）。

use std::sync::Mutex;

use serde_json::{json, Map, Value};

use crate::proxy::broadcast::{frame_clear, frame_data, Broadcaster, SseFrame};
use crate::proxy::capture::now_ms;

/// 环容量上限（对齐 Node 的 `MAX_EVENTS`）。溢出丢**最旧**的（`events.shift()`）。
pub const MAX_EVENTS: usize = 200;
/// 同 `type` + 同 `agentId` 在此窗口内合并为一条（对齐 `EVENT_DEDUPE_MS`）。
pub const EVENT_DEDUPE_MS: i64 = 60_000;
/// `/events` 返回的最大条数（对齐 Node 的 `.slice(-100)`）。
pub const EVENTS_LIST_LIMIT: usize = 100;

/// `recordEvent` 的入参：调用方只填这五项，`ts`/`count`/`lastTs` 由 `record` 注入。
#[derive(Debug, Clone, PartialEq)]
pub struct EventInput {
    pub severity: String,
    /// JSON 里的 `type` 键（`type` 是 Rust 关键字，故字段叫 `event_type`）。
    pub event_type: String,
    pub agent_id: Option<String>,
    pub message: String,
    pub detail: Value,
}

/// 环里的一条事件。字段与 Node events 元素一一对应。
#[derive(Debug, Clone, PartialEq)]
pub struct EventEntry {
    pub severity: String,
    pub event_type: String,
    pub agent_id: Option<String>,
    pub message: String,
    pub detail: Value,
    /// 首次出现时刻（合并**不**更新它 —— 去重窗口从首次算起，Node 如此）
    pub ts: i64,
    pub count: u64,
    /// 最近一次合并时刻；只有被合并过才存在（Node 到那个分支才写 `lastTs`）
    pub last_ts: Option<i64>,
}

impl EventEntry {
    /// 对齐 `JSON.stringify(ev)`。键顺序因 serde_json 默认 `Map` 为有序映射而按字典序，
    /// 与 Node 的对象字面量顺序不同 —— 键**集合**与取值语义一致，dashboard 按名读取。
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("ts".to_string(), json!(self.ts));
        m.insert("count".to_string(), json!(self.count));
        if let Some(last) = self.last_ts {
            m.insert("lastTs".to_string(), json!(last));
        }
        m.insert("severity".to_string(), json!(self.severity));
        m.insert("type".to_string(), json!(self.event_type));
        m.insert(
            "agentId".to_string(),
            self.agent_id
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        m.insert("message".to_string(), json!(self.message));
        m.insert("detail".to_string(), self.detail.clone());
        Value::Object(m)
    }
}

/// 线程安全的定容事件环（axum handler 并发访问，内部加锁 —— 与 `CaptureRing` 同款）。
#[derive(Default)]
pub struct EventLog {
    inner: Mutex<Vec<EventEntry>>,
}

impl EventLog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().expect("events ring poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 对齐 `recordEvent(ev, reqCid)`：去重合并或追加，然后返回**最终**对象的 JSON
    /// （调用方拿它广播）。被守卫拦掉（缺 `type`/`severity`）返回 `None`。
    pub fn record(&self, ev: EventInput, req_cid: Option<&str>) -> Option<Value> {
        self.record_detailed(ev, req_cid, now_ms()).map(|(v, _)| v)
    }

    /// `record` 的可注入时钟版本（去重窗口是时间相关的，测试必须能控时）。
    pub fn record_at(&self, ev: EventInput, req_cid: Option<&str>, now: i64) -> Option<Value> {
        self.record_detailed(ev, req_cid, now).map(|(v, _)| v)
    }

    /// `record` 的完整版本：除最终 JSON 外还告诉调用方**这是不是新事件**
    /// （`false` = 命中了 60s 去重合并）。
    ///
    /// 为什么需要这个布尔：Node 只在**追加分支**才把事件快照写进捕获条目的
    /// `details`（`proxy.js:460-479`，去重分支提前 `return`），所以
    /// `recordEvent` 的两个消费者（事件环 / `/event/detail` 的 details）对
    /// "是否合并"的判断必须一致。
    pub fn record_detailed(
        &self,
        ev: EventInput,
        req_cid: Option<&str>,
        now: i64,
    ) -> Option<(Value, bool)> {
        // Node: `if (!ev || !ev.type || !ev.severity) return;`
        if ev.event_type.is_empty() || ev.severity.is_empty() {
            return None;
        }
        // Node: `const agentId = ev.agentId || null;`（空串同样落到 null）
        let agent_id = ev.agent_id.filter(|a| !a.is_empty());

        // Node: 传了 cid 才补 correlationId，且**不覆盖**已有值。
        let mut detail = ev.detail;
        if let Some(cid) = req_cid {
            if !detail.is_object() {
                detail = json!({});
            }
            if let Value::Object(ref mut m) = detail {
                if !m.contains_key("correlationId") {
                    m.insert("correlationId".to_string(), json!(cid));
                }
            }
        }

        let mut events = self.inner.lock().expect("events ring poisoned");

        // 从后往前找同 type + 同 agentId 的最近一条（Node 的 `_lastIdxOfEvent`）。
        let last_idx = events
            .iter()
            .rposition(|e| e.event_type == ev.event_type && e.agent_id == agent_id);

        if let Some(idx) = last_idx {
            if now - events[idx].ts < EVENT_DEDUPE_MS {
                // 合并：只动 count / lastTs，ts 保持不变。
                let e = &mut events[idx];
                e.count += 1;
                e.last_ts = Some(now);
                return Some((e.to_json(), false));
            }
        }

        events.push(EventEntry {
            severity: ev.severity,
            event_type: ev.event_type,
            agent_id,
            message: ev.message,
            detail,
            ts: now,
            count: 1,
            last_ts: None,
        });
        if events.len() > MAX_EVENTS {
            events.remove(0); // Node: `events.shift()`
        }
        Some((events.last().expect("just pushed").to_json(), true))
    }

    /// 清空环（`/events/clear`）。去重窗口随之自然重置。
    pub fn clear(&self) {
        self.inner.lock().expect("events ring poisoned").clear();
    }

    /// `/events/stream` 订阅回放：插入序的最后 `limit` 条（旧→新）。
    /// 与 `/requests/stream` 同款「升序取末尾」语义 —— 回放必须与实时 append 同向。
    pub fn backlog(&self, limit: usize) -> Vec<Value> {
        let events = self.inner.lock().expect("events ring poisoned");
        let start = events.len().saturating_sub(limit);
        events[start..].iter().map(|e| e.to_json()).collect()
    }

    /// `/events` 载荷：`{ count: 环长, events: 最后 EVENTS_LIST_LIMIT 条 }`。
    pub fn list(&self) -> Value {
        let events = self.inner.lock().expect("events ring poisoned");
        let start = events.len().saturating_sub(EVENTS_LIST_LIMIT);
        json!({
            "count": events.len(),
            "events": events[start..].iter().map(|e| e.to_json()).collect::<Vec<_>>(),
        })
    }
}

/// `/events/stream` 推的一帧。与请求流逐字同款两帧（`data: <ev>` / `event: clear`），
/// 只是载荷是事件对象而不是请求 summary。
#[derive(Debug, Clone, PartialEq)]
pub enum EventFrame {
    Update(Value),
    Clear,
}

impl SseFrame for EventFrame {
    fn to_frame(&self) -> axum::body::Bytes {
        match self {
            EventFrame::Update(v) => frame_data(v),
            EventFrame::Clear => frame_clear(),
        }
    }
}

/// `/events/stream` 的广播器（发送端挂在 `AppState` 上，每条连接订阅一个接收端）。
pub type EventsBroadcaster = Broadcaster<EventFrame>;

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(event_type: &str, agent: Option<&str>) -> EventInput {
        EventInput {
            severity: "warn".to_string(),
            event_type: event_type.to_string(),
            agent_id: agent.map(|a| a.to_string()),
            message: "上游返回 429".to_string(),
            detail: json!({ "statusCode": 429 }),
        }
    }

    fn keys(v: &Value) -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort_unstable();
        k
    }

    /// 新条目的形状：七把键，`lastTs` 只有在合并后才有。
    #[test]
    fn fresh_event_has_the_node_shape_without_last_ts() {
        let log = EventLog::new();
        let v = log
            .record_at(ev("upstream-429", None), Some("cid-1"), 1000)
            .unwrap();
        assert_eq!(
            keys(&v),
            vec!["agentId", "count", "detail", "message", "severity", "ts", "type"]
        );
        assert_eq!(v["ts"], 1000);
        assert_eq!(v["count"], 1);
        assert_eq!(v["severity"], "warn");
        assert_eq!(v["type"], "upstream-429");
        assert_eq!(
            v["agentId"],
            Value::Null,
            "无 agent 归属时为 null（不是省略）"
        );
        assert_eq!(v["message"], "上游返回 429");
        assert_eq!(v["detail"]["statusCode"], 429);
        assert_eq!(v["detail"]["correlationId"], "cid-1");
        assert!(v.get("lastTs").is_none(), "未被合并过就不该有 lastTs");
    }

    /// 60s 窗口内同 type + 同 agent 合并：count 累加、lastTs 落定、ts 不变、环不增长。
    #[test]
    fn dedupe_merges_within_window_and_keeps_original_ts() {
        let log = EventLog::new();
        log.record_at(ev("upstream-429", Some("a1")), None, 1000)
            .unwrap();
        let merged = log
            .record_at(
                ev("upstream-429", Some("a1")),
                None,
                1000 + EVENT_DEDUPE_MS - 1,
            )
            .unwrap();
        assert_eq!(log.len(), 1, "窗口内必须是合并而不是新增");
        assert_eq!(merged["count"], 2);
        assert_eq!(merged["ts"], 1000, "合并保持首次 ts（去重窗口从首次算起）");
        assert_eq!(merged["lastTs"], 1000 + EVENT_DEDUPE_MS - 1);
    }

    /// 恰好 60s 是**过期**（Node 用严格小于）；窗口外追加新条目。
    #[test]
    fn dedupe_expires_at_exactly_the_window() {
        let log = EventLog::new();
        log.record_at(ev("upstream-429", Some("a1")), None, 1000)
            .unwrap();
        log.record_at(ev("upstream-429", Some("a1")), None, 1000 + EVENT_DEDUPE_MS)
            .unwrap();
        assert_eq!(log.len(), 2, "now - ts == 60_000 不满足 `< 60_000`，应新增");
        let list = log.list();
        assert_eq!(list["count"], 2);
        assert_eq!(list["events"][1]["count"], 1);
    }

    /// 合并只在 type 与 agentId 都相同时发生；不同 agent/type 各自成条。
    #[test]
    fn dedupe_is_scoped_to_type_and_agent() {
        let log = EventLog::new();
        log.record_at(ev("upstream-429", Some("a1")), None, 1000)
            .unwrap();
        log.record_at(ev("upstream-429", Some("a2")), None, 1001)
            .unwrap();
        log.record_at(ev("upstream-5xx", Some("a1")), None, 1002)
            .unwrap();
        log.record_at(ev("upstream-429", None), None, 1003).unwrap();
        assert_eq!(log.len(), 4, "四种组合互不合并");
    }

    /// 合并命中「最近的」那条，而不是最早的那条。
    #[test]
    fn dedupe_merges_the_most_recent_match() {
        let log = EventLog::new();
        log.record_at(ev("upstream-429", None), None, 0).unwrap();
        log.record_at(ev("upstream-429", None), None, 100_000)
            .unwrap(); // 窗口外 → 新条目
        let merged = log
            .record_at(ev("upstream-429", None), None, 100_001)
            .unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(merged["count"], 2);
        assert_eq!(merged["ts"], 100_000, "命中的应是后一条");
        assert_eq!(log.list()["events"][0]["count"], 1, "早期那条不该被合并");
    }

    /// 容量 200：第 201 条挤掉**最旧**的一条（FIFO，不是 LRU）。
    #[test]
    fn evicts_oldest_when_over_max_events() {
        let log = EventLog::new();
        for i in 0..MAX_EVENTS {
            log.record_at(ev(&format!("t{i}"), None), None, i as i64)
                .unwrap();
        }
        assert_eq!(log.len(), MAX_EVENTS);
        log.record_at(ev("overflow", None), None, 99_999).unwrap();
        assert_eq!(log.len(), MAX_EVENTS);
        let list = log.list();
        assert_eq!(list["count"], MAX_EVENTS, "count 是环长，可以超过 100");
        let types: Vec<&str> = list["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["type"].as_str().unwrap())
            .collect();
        assert!(!types.contains(&"t0"), "t0 是最旧的一条，应先被挤掉");
        assert!(types.contains(&"overflow"));
        // /events 只回最后 100 条，而环里有 200 条
        assert_eq!(list["events"].as_array().unwrap().len(), EVENTS_LIST_LIMIT);
    }

    /// 回放取插入序的最后 N 条（旧→新），与实时 append 同向。
    #[test]
    fn backlog_takes_the_tail_in_insertion_order() {
        let log = EventLog::new();
        for i in 0..60 {
            log.record_at(ev(&format!("t{i}"), None), None, i as i64)
                .unwrap();
        }
        let got = log.backlog(50);
        assert_eq!(got.len(), 50);
        assert_eq!(got[0]["type"], "t10");
        assert_eq!(got[49]["type"], "t59");
        let ts: Vec<i64> = got.iter().map(|v| v["ts"].as_i64().unwrap()).collect();
        let mut sorted = ts.clone();
        sorted.sort_unstable();
        assert_eq!(ts, sorted, "回放必须旧→新");
    }

    /// 清空后环为空、count 归零，且 60s 去重窗口随之重置（同 type 会作为新条目出现）。
    #[test]
    fn clear_empties_and_resets_dedupe() {
        let log = EventLog::new();
        log.record_at(ev("upstream-429", None), None, 1000).unwrap();
        log.record_at(ev("upstream-429", None), None, 1001).unwrap();
        assert_eq!(log.len(), 1);
        log.clear();
        assert!(log.is_empty());
        assert_eq!(log.list()["count"], 0);
        assert!(log.backlog(50).is_empty());
        let fresh = log.record_at(ev("upstream-429", None), None, 1002).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(fresh["count"], 1, "清空后不继承合并计数");
    }

    /// correlationId 只在传了 cid 时补，且不覆盖调用方已有的值。
    #[test]
    fn correlation_id_is_injected_only_when_absent() {
        let log = EventLog::new();
        // 三种情形用不同 type，避免被 60s 去重合并成同一条（否则断言的是第一次的 detail）。
        let with_cid = log.record_at(ev("ta", None), Some("c9"), 1).unwrap();
        assert_eq!(with_cid["detail"]["correlationId"], "c9");

        let mut ev2 = ev("tb", None);
        ev2.detail = json!({ "correlationId": "mine" });
        let kept = log.record_at(ev2, Some("c9"), 2).unwrap();
        assert_eq!(kept["detail"]["correlationId"], "mine", "已有值不被覆盖");

        let mut ev3 = ev("tc", None);
        ev3.detail = json!({});
        let without = log.record_at(ev3, None, 3).unwrap();
        assert!(
            without["detail"].get("correlationId").is_none(),
            "没 cid 就不补"
        );
    }

    /// `recordEvent` 的守卫：缺 type 或 severity 直接丢。
    #[test]
    fn events_without_type_or_severity_are_dropped() {
        let log = EventLog::new();
        let mut no_type = ev("", None);
        no_type.event_type = String::new();
        assert!(log.record_at(no_type, None, 1).is_none());
        let mut no_sev = ev("t", None);
        no_sev.severity = String::new();
        assert!(log.record_at(no_sev, None, 2).is_none());
        assert!(log.is_empty());
    }

    /// 广播帧与请求流逐字同款（同一实现），事件载荷走 `data:`。
    #[test]
    fn event_frames_match_the_shared_framing() {
        let v = json!({ "type": "upstream-429", "count": 1 });
        assert_eq!(
            &EventFrame::Update(v.clone()).to_frame()[..],
            b"data: {\"count\":1,\"type\":\"upstream-429\"}\n\n"
        );
        assert_eq!(
            &EventFrame::Clear.to_frame()[..],
            b"event: clear\ndata: {}\n\n"
        );
    }

    /// `record_detailed` 的 `is_new` 是"要不要写进捕获条目 `details`"的唯一判据：
    /// 只有**追加分支**才 true，60s 去重合并返回 false（Node 的去重分支提前 return，
    /// 不往 `ent.details` push）。
    #[test]
    fn record_detailed_reports_whether_the_event_was_appended() {
        let log = EventLog::new();
        let (v, is_new) = log
            .record_detailed(ev("parse-fail", Some("a1")), Some("cid-1"), 1000)
            .expect("首条事件");
        assert!(is_new, "新事件 → 应写入 details");
        assert_eq!(v["count"], 1);

        let (v, is_new) = log
            .record_detailed(ev("parse-fail", Some("a1")), Some("cid-1"), 1500)
            .expect("合并事件");
        assert!(!is_new, "命中去重合并 → 不重复写 details");
        assert_eq!(v["count"], 2);
        assert_eq!(v["lastTs"], 1500);

        let (_, is_new) = log
            .record_detailed(ev("parse-fail", Some("a1")), Some("cid-1"), 1000 + EVENT_DEDUPE_MS)
            .expect("窗口外的同 type 事件");
        assert!(is_new, "超出 60s 窗口 → 新条目");
    }
}
