//! `/event/detail/stream` 专用通道 —— `proxy.js` 的 `_broadcastDetail` / `detailClients` /
//! 详情流 handler（`proxy.js:1668-1735`）的移植。
//!
//! 与 `/requests/stream`、`/events/stream` 的**帧格式相同**（`data: <json>\n\n` /
//! `: ping\n\n`），但载荷与订阅粒度不同：
//! - 载荷是**逐字 delta**：`{kind:'thinking'|'text', text, ts}` 或收尾的 `{done:true}`；
//! - 订阅粒度是 **cid**（Node 是 `detailClients: Map<cid, Set<res>>`），所以广播帧带 cid，
//!   订阅流的闭包按 cid 过滤 —— 见 `detail_body_stream`。
//!
//! 订阅时的**回放**：Node 把已收到的 `sseBytes`（utf8）按 `\r?\n\r?\n` 切开，逐块解析出
//! `content_block_delta` 推给新订阅者（`ts` 固定为 **0**，不是块切出时刻）。这样"中途点开
//! 详情"也能立刻看到已流过的字。本模块的 `replay_deltas` 用 `sse::split_sse_events`
//! （完整事件 + 尾巴）逐块 `analyze_event`，判据与 Node 逐条同源。
//!
//! 流已结束（`e._streamEnded`）时：回放完历史 delta 再推一个 `{done:true}` 然后**关连接**。
//! 流进行中时：注册订阅者，之后每来一帧推一帧；**收到 `done` 不主动关连接** ——
//! Node 也不关（它只写一帧 `done`，由 dashboard 的 EventSource 自己 `close()`），
//! 服务端连接靠客户端断开回收。这是 Node 的真实行为，照抄。

use std::convert::Infallible;
use std::time::Duration;

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio::time::MissedTickBehavior;

use crate::proxy::broadcast::{frame_data, frame_heartbeat, Broadcaster, SseFrame};
use crate::proxy::sse;

/// 一帧详情广播。`cid` 只用于订阅侧过滤（Node 的 `detailClients` 是按 cid 分桶的）。
#[derive(Debug, Clone, PartialEq)]
pub struct DetailUpdate {
    pub cid: String,
    pub payload: Value,
}

impl SseFrame for DetailUpdate {
    fn to_frame(&self) -> Bytes {
        frame_data(&self.payload)
    }
}

/// 详情通道的广播器（挂 `AppState`；每条订阅连接订阅一个接收端）。
pub type DetailBroadcaster = Broadcaster<DetailUpdate>;

/// 逐字 delta 载荷（live 路径用 `ts = 块切出时刻`，回放路径按 Node 固定 `0`）。
pub fn delta_payload(kind: &str, text: &str, ts: i64) -> Value {
    json!({ "kind": kind, "text": text, "ts": ts })
}

/// 收尾载荷 `{done:true}`。
pub fn done_payload() -> Value {
    json!({ "done": true })
}

/// 把已收到的 SSE 字节流切成"回放用"的逐字 delta 列表（`ts` 固定 0）。
///
/// Node：`past.split(/\r?\n\r?\n/).filter(Boolean)` 后逐块解析；`split_sse_events`
/// 返回的正是"完整事件 + 未完成尾巴"，两块合起来等价于按分隔符切分（尾巴单独成块，
/// 若它恰好是完整 JSON 则与 Node 一样会被解析出来）。
pub fn replay_deltas(sse_bytes: &[u8]) -> Vec<Value> {
    if sse_bytes.is_empty() {
        return Vec::new();
    }
    let (events, tail) = sse::split_sse_events(sse_bytes);
    let mut out = Vec::new();
    for block in events.iter().chain(std::iter::once(&tail)) {
        if block.is_empty() {
            continue;
        }
        if let Some((kind, text)) = sse::analyze_event(block).detail_delta {
            out.push(delta_payload(kind.as_js_str(), &text, 0));
        }
    }
    out
}

/// `/event/detail/stream` 的响应体流：**先**回放 `replay`，**若已结束**再推一帧 done 并结束；
/// **否则**进入实时循环（按 cid 过滤 + 心跳）。
///
/// 心跳间隔与另外两条 SSE 一致（`SSE_HEARTBEAT_MS` = 15s，Node 复用同一个 `setInterval`）。
pub fn detail_body_stream(
    cid: String,
    replay: Vec<Value>,
    ended: bool,
    rx: broadcast::Receiver<DetailUpdate>,
    heartbeat: Duration,
) -> impl Stream<Item = Result<Bytes, Infallible>> + Send + 'static {
    let head = futures_util::stream::iter(
        replay
            .into_iter()
            .map(|v| Ok::<Bytes, Infallible>(frame_data(&v))),
    );

    let mut hb = tokio::time::interval_at(tokio::time::Instant::now() + heartbeat, heartbeat);
    hb.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let live = futures_util::stream::unfold((rx, hb), move |(mut rx, mut hb)| {
        let cid = cid.clone();
        async move {
            loop {
                tokio::select! {
                    received = rx.recv() => match received {
                        Ok(update) => {
                            // 只推本 cid 的帧（Node 是 Map<cid, Set<res>>，天然隔离）。
                            if update.cid != cid {
                                continue;
                            }
                            return Some((Ok(update.to_frame()), (rx, hb)));
                        }
                        // 慢订阅者被追上：跳过丢掉的中间帧继续推，连接不终止。
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => return None,
                    },
                    _ = hb.tick() => return Some((Ok(frame_heartbeat()), (rx, hb))),
                }
            }
        }
    });

    if ended {
        // 已结束：回放 + `{done:true}` 然后干净收尾（对应 Node 的 `res.write(done); res.end();`）。
        head.chain(futures_util::stream::once(async {
            Ok::<Bytes, Infallible>(frame_data(&done_payload()))
        }))
        .boxed()
    } else {
        head.chain(live).boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_text(b: &Bytes) -> String {
        String::from_utf8_lossy(b).into_owned()
    }

    #[test]
    fn delta_and_done_payloads_match_node_stringify() {
        // Node: JSON.stringify({ kind:'text', text:'Hi', ts:0 })
        assert_eq!(
            serde_json::to_string(&delta_payload("text", "Hi", 0)).unwrap(),
            r#"{"kind":"text","text":"Hi","ts":0}"#
        );
        assert_eq!(
            serde_json::to_string(&done_payload()).unwrap(),
            r#"{"done":true}"#
        );
        let upd = DetailUpdate {
            cid: "c1".into(),
            payload: done_payload(),
        };
        assert_eq!(&upd.to_frame()[..], b"data: {\"done\":true}\n\n");
    }

    #[test]
    fn replay_extracts_only_text_deltas_with_ts_zero() {
        let sse = concat!(
            "event: message_start\ndata: {\"type\":\"message_start\"}\n\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hmm\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n",
            "data: {\"type\":\"content_block_start\"}\n\n",
        );
        let got = replay_deltas(sse.as_bytes());
        assert_eq!(got.len(), 2);
        assert_eq!(got[0]["kind"], "thinking");
        assert_eq!(got[0]["text"], "hmm");
        assert_eq!(got[0]["ts"], 0, "回放的 ts 固定 0（Node 硬编码）");
        assert_eq!(got[1]["kind"], "text");
    }

    /// 未完成尾巴若恰好是完整 JSON 事件，Node 的 `split(/\r?\n\r?\n/)` 也会把它当一个块
    /// 解析出来 —— 这里必须同义（`split_sse_events` 把它放在 tail）。
    #[test]
    fn replay_also_parses_a_complete_json_tail() {
        let sse = b"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}";
        let got = replay_deltas(sse);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["text"], "Hi");
        // 真·半截尾巴（JSON 不完整）不会产出 delta
        assert!(replay_deltas(b"data: {\"type\":\"content_bl").is_empty());
    }

    #[tokio::test]
    async fn ended_stream_replays_then_emits_done_and_finishes() {
        let (_tx, rx) = broadcast::channel::<DetailUpdate>(4);
        let stream = detail_body_stream(
            "c1".into(),
            vec![delta_payload("text", "Hi", 0)],
            true,
            rx,
            Duration::from_millis(5_000),
        );
        futures_util::pin_mut!(stream);
        let f1 = frame_text(&stream.next().await.unwrap().unwrap());
        assert_eq!(f1, "data: {\"kind\":\"text\",\"text\":\"Hi\",\"ts\":0}\n\n");
        let f2 = frame_text(&stream.next().await.unwrap().unwrap());
        assert_eq!(f2, "data: {\"done\":true}\n\n");
        assert!(
            stream.next().await.is_none(),
            "已结束的流推完 done 必须关连接"
        );
    }

    #[tokio::test]
    async fn running_stream_filters_by_cid_and_does_not_end_on_done() {
        let (tx, rx) = broadcast::channel::<DetailUpdate>(8);
        let stream = detail_body_stream(
            "c1".into(),
            vec![],
            false,
            rx,
            Duration::from_millis(5_000),
        );
        futures_util::pin_mut!(stream);
        // 别的 cid 的帧必须被丢掉
        tx.send(DetailUpdate {
            cid: "other".into(),
            payload: delta_payload("text", "nope", 1),
        })
        .unwrap();
        tx.send(DetailUpdate {
            cid: "c1".into(),
            payload: delta_payload("thinking", "hmm", 42),
        })
        .unwrap();
        let f = frame_text(&stream.next().await.unwrap().unwrap());
        assert_eq!(f, "data: {\"kind\":\"thinking\",\"text\":\"hmm\",\"ts\":42}\n\n");
        // done 帧照推，但流**不结束**（Node 不 res.end；等客户端自己 close）
        tx.send(DetailUpdate {
            cid: "c1".into(),
            payload: done_payload(),
        })
        .unwrap();
        let f = frame_text(&stream.next().await.unwrap().unwrap());
        assert_eq!(f, "data: {\"done\":true}\n\n");
    }

    #[tokio::test]
    async fn running_stream_emits_heartbeat_when_idle() {
        let (_tx, rx) = broadcast::channel::<DetailUpdate>(4);
        let stream = detail_body_stream(
            "c1".into(),
            vec![],
            false,
            rx,
            Duration::from_millis(20),
        );
        futures_util::pin_mut!(stream);
        let f = frame_text(&stream.next().await.unwrap().unwrap());
        assert_eq!(f, ": ping\n\n");
    }

    #[tokio::test]
    async fn stream_ends_when_all_senders_drop() {
        let (tx, rx) = broadcast::channel::<DetailUpdate>(4);
        drop(tx);
        let stream = detail_body_stream(
            "c1".into(),
            vec![],
            false,
            rx,
            Duration::from_millis(5_000),
        );
        futures_util::pin_mut!(stream);
        assert!(stream.next().await.is_none());
    }
}
