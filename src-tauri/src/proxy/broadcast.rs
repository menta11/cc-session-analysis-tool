//! `/requests/stream` 与 `/events/stream` 共用的广播器与 SSE 帧格式化 —— 逐字对齐 `proxy.js` 的
//! `_broadcastRequest` / `_broadcastRequestClear` / `_broadcastEvent` / `_broadcastClear`
//! 与两个 stream handler。
//!
//! 报文格式（**逐字**，不要"顺手优化"）：
//! - 单条请求：`data: <summary JSON>\n\n` —— 推的是**单条 summary**，不是数组；
//! - 清空：`event: clear\ndata: {}\n\n` —— 带 **`event: clear`** 事件名，不是普通 data；
//! - 心跳：`: ping\n\n` —— SSE 注释行，每 `SSE_HEARTBEAT_MS`，避免连接空闲被中间层断掉。
//!
//! 为什么用 `tokio::sync::broadcast` 而不是自己维护一个订阅者集合：Node 是单事件循环里的
//! `Set<res>` + 同步 `write`；Rust handler 是并发任务，这里需要的是「一个发送端 → 多个接收端」
//! 的多播语义，`broadcast` 正好提供，而且**接收端 Drop 即自动退订**（不会泄漏订阅者）。
//! 慢订阅者被追上时 `recv()` 返回 `Lagged`：跳过丢失的中间帧继续推，**绝不终止连接** ——
//! 与 Node「写失败才删订阅者」同效，但不会误伤只是慢一点的健康连接。

use std::convert::Infallible;
use std::time::Duration;

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use serde_json::Value;
use tokio::sync::broadcast;
use tokio::time::MissedTickBehavior;

/// 新订阅者回放最近 N 条（对齐 `proxy.js` 的 `SSE_EVENT_BACKLOG`），避免连上瞬间空白。
pub const SSE_EVENT_BACKLOG: usize = 50;
/// 心跳间隔（对齐 `proxy.js` 的 `SSE_HEARTBEAT_MS`）。
pub const SSE_HEARTBEAT_MS: u64 = 15_000;
/// 广播频道容量。Node 侧没有缓冲（同一个事件循环里同步 write），这里给一个够大的环形缓冲：
/// 慢订阅者只会收到 `Lagged` 丢掉中间态、后续仍能续上。太小会频繁丢帧，太大则白占内存
/// （单条 summary 约 200B，256 条上限约 50KB，可忽略）。
pub const SSE_BROADCAST_CAPACITY: usize = 256;

/// 广播的一帧。
#[derive(Debug, Clone, PartialEq)]
pub enum RequestEvent {
    /// 单条 `_captureSummary` 形状的 summary（请求注册 / 响应头 / 结束都会推）。
    Update(Value),
    /// 通知订阅者清空本地视图（`POST /requests/clear` 触发）。
    Clear,
}

/// 能映射成 SSE 帧的广播项。请求流（`RequestEvent`）与事件流（`events::EventFrame`）
/// 的**帧格式完全一致**（`data: <json>\n\n` / `event: clear\ndata: {}\n\n`），
/// 差别只在载荷类型，所以回放/实时/心跳/`Lagged` 那套状态机只写一份，由本 trait 泛化。
pub trait SseFrame: Clone + Send + 'static {
    fn to_frame(&self) -> Bytes;
}

/// 通用广播器：`AppState` 持有发送端，每条 SSE 连接订阅一个接收端。
///
/// 请求流与事件流各用一个实例（`RequestBroadcaster` / `events::EventsBroadcaster`）——
/// Node 里是 `requestClients` 与 `eventClients` 两个独立 `Set`，不能混用，否则
/// `/requests/clear` 会连带清掉事件视图。
#[derive(Clone)]
pub struct Broadcaster<F> {
    tx: broadcast::Sender<F>,
}

impl<F: Clone + Send + 'static> Default for Broadcaster<F> {
    fn default() -> Self {
        Self::new()
    }
}

impl<F: Clone + Send + 'static> Broadcaster<F> {
    pub fn new() -> Self {
        // 初始接收端立即丢弃：只保留发送端（`send` 在无订阅者时返回 Err，属正常情况）。
        let (tx, _initial_rx) = broadcast::channel(SSE_BROADCAST_CAPACITY);
        Self { tx }
    }

    /// 广播一帧。**没有订阅者时 `send` 返回 `Err`** —— 这是正常情况，忽略即可；
    /// 绝不能 unwrap（Node 对空 Set 循环同样什么都不做）。
    pub fn send(&self, ev: F) {
        let _ = self.tx.send(ev);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<F> {
        self.tx.subscribe()
    }

    /// 当前活跃订阅者数（测试与诊断用）。
    pub fn receiver_count(&self) -> usize {
        self.tx.receiver_count()
    }
}

/// `/requests/stream` 的广播器类型别名（保持原有名字与用法）。
pub type RequestBroadcaster = Broadcaster<RequestEvent>;

impl SseFrame for RequestEvent {
    fn to_frame(&self) -> Bytes {
        match self {
            RequestEvent::Update(v) => frame_data(v),
            RequestEvent::Clear => frame_clear(),
        }
    }
}

/// `data: <json>\n\n` —— 单条 summary。
pub fn frame_data(v: &Value) -> Bytes {
    Bytes::from(format!("data: {v}\n\n"))
}

/// `event: clear\ndata: {}\n\n` —— 控制帧，订阅端识别后只清本地视图。
pub fn frame_clear() -> Bytes {
    Bytes::from_static(b"event: clear\ndata: {}\n\n")
}

/// `: ping\n\n` —— SSE 注释行心跳。
pub fn frame_heartbeat() -> Bytes {
    Bytes::from_static(b": ping\n\n")
}

/// 把一个订阅者变成 SSE 响应体流：**先**逐条回放 `backlog`（调用方已按 `ts` 升序
/// 取末尾 `SSE_EVENT_BACKLOG` 条），**再**推实时帧与心跳。
///
/// 顺序是刻意的：回放旧→新，dashboard push 到列表末尾 —— 列表"旧在上、新在下"，
/// 与实时新请求的 append 方向一致。降序回放会让历史倒序、与实时追加矛盾（Node 侧修过的 bug）。
/// 调用方在取快照**之后**才 `subscribe()`，所以订阅后到达的实时帧一定排在积压之后，
/// 不会插队到回放中间。
///
/// item 用 `Infallible`：帧格式化不可能失败（`Body::from_stream` 也因此永不产生流错误）。
pub fn sse_body_stream<F: SseFrame>(
    backlog: Vec<Value>,
    rx: broadcast::Receiver<F>,
    heartbeat: Duration,
) -> impl Stream<Item = Result<Bytes, Infallible>> + Send + 'static {
    let replay = futures_util::stream::iter(
        backlog
            .into_iter()
            .map(|v| Ok::<Bytes, Infallible>(frame_data(&v))),
    );

    // 首个 tick 落在 heartbeat 之后（Node 用 setInterval，不是立刻）。Delay 策略保证
    // 即使推送密集把 tick 饿住，也不会攒出一串补发的心跳。
    let mut hb = tokio::time::interval_at(tokio::time::Instant::now() + heartbeat, heartbeat);
    hb.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let live = futures_util::stream::unfold((rx, hb), |(mut rx, mut hb)| async move {
        loop {
            tokio::select! {
                received = rx.recv() => match received {
                    Ok(ev) => return Some((Ok(ev.to_frame()), (rx, hb))),
                    // 慢订阅者被追上：跳过丢掉的中间帧继续推，连接不终止。
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    // 所有发送端都 Drop（进程收尾）→ 结束流（客户端连接随之关闭）。
                    Err(broadcast::error::RecvError::Closed) => return None,
                },
                _ = hb.tick() => return Some((Ok(frame_heartbeat()), (rx, hb))),
            }
        }
    });

    replay.chain(live)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn summary(cid: &str, ts: i64) -> Value {
        json!({ "cid": cid, "ts": ts })
    }

    /// 三种帧必须与 Node 的字符串逐字节一致（dashboard 直接按 SSE 规范解析）。
    #[test]
    fn frames_match_node_byte_for_byte() {
        let v = json!({ "cid": "c1", "ts": 1 });
        assert_eq!(&frame_data(&v)[..], b"data: {\"cid\":\"c1\",\"ts\":1}\n\n");
        assert_eq!(&frame_clear()[..], b"event: clear\ndata: {}\n\n");
        assert_eq!(&frame_heartbeat()[..], b": ping\n\n");
    }

    /// 没有订阅者时广播是 no-op，绝不 panic。
    #[test]
    fn send_without_subscribers_is_a_noop() {
        let b = RequestBroadcaster::new();
        assert_eq!(b.receiver_count(), 0);
        b.send(RequestEvent::Update(summary("x", 1)));
        b.send(RequestEvent::Clear);
    }

    /// 接收端 Drop 即自动退订 —— 断连不会泄漏订阅者（对应 Node 的 `requestClients.delete`）。
    #[test]
    fn receivers_are_removed_on_drop() {
        let b = RequestBroadcaster::new();
        let r1 = b.subscribe();
        let r2 = b.subscribe();
        assert_eq!(b.receiver_count(), 2);
        drop(r1);
        assert_eq!(b.receiver_count(), 1);
        drop(r2);
        assert_eq!(b.receiver_count(), 0);
    }

    /// 关键顺序：即使实时帧在订阅后立刻就绪，也必须**先**回放积压，再推实时，最后才是心跳。
    #[tokio::test]
    async fn replay_comes_before_live_and_live_before_heartbeat() {
        let b = RequestBroadcaster::new();
        let rx = b.subscribe();
        // 订阅之后、建流之前就发送 → 保证实时帧已在接收端缓冲里，用来验证回放插在它前面。
        b.send(RequestEvent::Update(summary("live", 2)));

        let stream = sse_body_stream(vec![summary("old", 1)], rx, Duration::from_millis(20));
        futures_util::pin_mut!(stream);

        let f1 = stream.next().await.unwrap().unwrap();
        assert_eq!(
            &f1[..],
            b"data: {\"cid\":\"old\",\"ts\":1}\n\n",
            "积压必须排第一"
        );
        let f2 = stream.next().await.unwrap().unwrap();
        assert_eq!(
            &f2[..],
            b"data: {\"cid\":\"live\",\"ts\":2}\n\n",
            "实时帧必须排在积压之后"
        );
        let f3 = stream.next().await.unwrap().unwrap();
        assert_eq!(&f3[..], b": ping\n\n", "空闲后应收到心跳注释行");
    }

    /// 清空广播推的是 `event: clear`，不是普通 data。
    #[tokio::test]
    async fn clear_event_is_broadcast_with_the_event_name() {
        let b = RequestBroadcaster::new();
        let rx = b.subscribe();
        b.send(RequestEvent::Clear);
        let stream = sse_body_stream(vec![], rx, Duration::from_millis(5_000));
        futures_util::pin_mut!(stream);
        let f = stream.next().await.unwrap().unwrap();
        assert_eq!(&f[..], b"event: clear\ndata: {}\n\n");
    }

    /// 慢订阅者收到 `Lagged` 时必须跳过并继续，而不是终止连接。
    #[tokio::test]
    async fn lagged_subscriber_skips_instead_of_terminating() {
        // 容量 2、发送 5 条 → 第一次 recv 必定 Lagged(3)
        let (tx, rx) = broadcast::channel::<RequestEvent>(2);
        for i in 0..5 {
            tx.send(RequestEvent::Update(summary(&format!("c{i}"), i)))
                .unwrap();
        }
        let stream = sse_body_stream(vec![], rx, Duration::from_millis(5_000));
        futures_util::pin_mut!(stream);
        let f = stream.next().await.expect("Lagged 之后仍应有帧").unwrap();
        let text = String::from_utf8_lossy(&f);
        assert!(text.starts_with("data: "), "应继续推后续帧，实际: {text:?}");
    }

    /// 发送端全部 Drop → 流结束（Body 结束，连接正常关闭）。
    #[tokio::test]
    async fn stream_ends_when_all_senders_drop() {
        let (tx, rx) = broadcast::channel::<RequestEvent>(4);
        drop(tx);
        let stream = sse_body_stream(vec![], rx, Duration::from_millis(5_000));
        futures_util::pin_mut!(stream);
        assert!(stream.next().await.is_none());
    }
}
