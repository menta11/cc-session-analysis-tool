//! Byte-level SSE event framing, a faithful port of proxy.js `splitSseEvents()`.
//!
//! The reference builds a `latin1` string (a lossless 1 byte -> 1 char map) purely
//! to locate `\r?\n\r?\n` boundaries, then decodes each complete event slice as
//! UTF-8 independently. It NEVER converts the accumulated buffer to UTF-8, because
//! a multibyte character split across two TCP chunks would be lossily decoded to
//! U+FFFD and those bytes are gone forever.
//!
//! This port works on `&[u8]` throughout and returns `(Vec<Vec<u8>>, Vec<u8>)`:
//! the complete event slices and the unconsumed tail. Decoding a slice to text is
//! a separate, explicitly-lossy step (`decode_event`), exactly like Node.
//!
//! Separator matching mirrors the JS regex `/\r?\n\r?\n/` precisely: leftmost
//! match, with each `\r?` greedy (prefers `\r\n` over `\n`). For the buffer shapes
//! that appear in SSE the greedy choice is always the only viable one, but the
//! matcher below keeps the exact attempt order anyway.

/// If `\r?\n\r?\n` matches starting at `i`, return the exclusive end offset.
fn match_separator(b: &[u8], i: usize) -> Option<usize> {
    let len = b.len();
    let mut j = i;

    // first \r?\n
    if j < len && b[j] == b'\r' {
        if j + 1 < len && b[j + 1] == b'\n' {
            j += 2;
        } else {
            // `\r?` backtracked to empty would need `\n` at j, which is `\r`.
            return None;
        }
    } else if j < len && b[j] == b'\n' {
        j += 1;
    } else {
        return None;
    }

    // second \r?\n
    if j < len && b[j] == b'\r' {
        if j + 1 < len && b[j + 1] == b'\n' {
            j += 2;
        } else {
            return None;
        }
    } else if j < len && b[j] == b'\n' {
        j += 1;
    } else {
        return None;
    }

    Some(j)
}

/// Split `buf` into complete SSE event byte-slices plus the incomplete tail.
///
/// `events` are the raw bytes of each complete event (the separator itself is
/// consumed, matching `String.split`). The tail is what a subsequent chunk must
/// be concatenated onto.
pub fn split_sse_events(buf: &[u8]) -> (Vec<Vec<u8>>, Vec<u8>) {
    let mut events: Vec<Vec<u8>> = Vec::new();
    let mut prev = 0usize;
    let mut i = 0usize;
    while i < buf.len() {
        if let Some(end) = match_separator(buf, i) {
            events.push(buf[prev..i].to_vec());
            i = end;
            prev = end;
        } else {
            i += 1;
        }
    }
    (events, buf[prev..].to_vec())
}

/// Lossy UTF-8 decode of one complete event — identical to Node's
/// `Buffer.from(p, 'latin1').toString('utf8')` for the dashboard/capture path.
/// The passthrough path never calls this; it forwards raw bytes.
pub fn decode_event(event: &[u8]) -> String {
    String::from_utf8_lossy(event).into_owned()
}

/// `content_block_delta` 的两种语义（Node 的 `lastDeltaType` 取值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeltaKind {
    Thinking,
    Text,
}

impl DeltaKind {
    /// Node 里 `stream.lastDeltaType` 的字面量取值。
    pub fn as_js_str(&self) -> &'static str {
        match self {
            DeltaKind::Thinking => "thinking",
            DeltaKind::Text => "text",
        }
    }
}

/// Node `KNOWN_SSE_TYPES`（`proxy.js:1968`）：白名单外的 `type` 会记一条 `unknown-type`
/// 事件，**不再静默吞**。
pub fn is_known_sse_type(t: &str) -> bool {
    matches!(
        t,
        "content_block_delta"
            | "content_block_start"
            | "content_block_stop"
            | "message_start"
            | "message_delta"
            | "message_stop"
            | "ping"
            | "error"
    )
}

/// 一条完整 SSE 事件一次解析出来的全部信息。
///
/// 为什么要「一次解析出全部」：Node 对每个 event 解析了**两遍**（第一遍只找首字，
/// `proxy.js:2014-2039`；第二遍做事件来源分流 + `recordDelta`，`2041-2158`）。
/// 两遍的判据并不完全相同（第二遍在白名单/`error` 上会 `continue`），所以这里把两遍
/// 需要的东西一次性算出来并分别标注来源，避免在热路径上解析两次。
#[derive(Debug, Default)]
pub struct SseEventInfo {
    /// `event:` 字段（trim 后）。无该字段时为 `None`。
    pub event_name: Option<String>,
    /// 多行 `data:` 用 `\n` 拼接后的原文；无 data 行或为 `[DONE]` 时 `None`
    /// （对应 Node 的两个 `continue`）。
    pub data: Option<String>,
    /// `data` 存在、非 `[DONE]` 且 `JSON.parse` 失败。
    pub parse_failed: bool,
    /// `JSON.parse` 成功后的对象（`type` 白名单判定留给调用方）。
    pub json: Option<serde_json::Value>,
    /// 第一遍（`_hasText`）的结论：`type === 'content_block_delta'` 且
    /// `delta.thinking` / `delta.text` 在 JS 里为真值。
    pub first_char: bool,
    /// 第二遍 `recordDelta` 的 `type` 归类（`'thinking' | 'text'`）。
    pub delta_kind: Option<DeltaKind>,
    /// 第二遍 `recordDelta(agentId, text, type)` 的 **text** —— 即 Node 传进去的
    /// `d.thinking` / `d.text`（`proxy.js:2106-2113`）。`chars` 累计、tokenizer 估算与
    /// `deltas[]` 都吃这个值，所以必须与 `delta_kind` 来自同一分支。
    pub delta_text: Option<String>,
    /// 实时详情流的单条 delta（`proxy.js:2030-2033` 的四分支）—— **与 `delta_kind`
    /// 不是同一套判据**（那个带 `??` 兜底、这个带 `else if` 顺序）。两者各自照抄。
    pub detail_delta: Option<(DeltaKind, String)>,
    /// `message_start` 的输入侧 token：`usage.input_tokens || usage.prompt_tokens ||
    /// usage.inputTokens || 0` 加上 `cache_read_input_tokens || cache_read_tokens || 0`。
    /// 0 = 没有可记的（Node 只在 `> 0` 时调 `recordTokens`）。
    pub usage_input_tokens: i64,
    /// `message_delta` 的 `usage.output_tokens`（Node 只在真值时记录）。0 = 无。
    pub usage_output_tokens: i64,
    /// `message_delta.delta.stop_reason`。
    pub stop_reason: Option<String>,
}

/// JS `if (x)` 的真值语义（`''` / `0` / `NaN` / `null` / `false` / `undefined` 为假）。
/// Node 的首字判据用的是裸 truthiness（`if (_dd.thinking)`），不是「非空字符串」，
/// 所以这里按 JS 语义来，而不是 `as_str().is_empty()`。
pub fn js_truthy(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        serde_json::Value::String(s) => !s.is_empty(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => true,
    }
}

/// 解析一条完整 SSE 事件（行拆分 + 多行 `data` 拼接 + JSON 解析 + 两遍判据）。
pub fn analyze_event(event: &[u8]) -> SseEventInfo {
    let text = decode_event(event);
    let mut event_name: Option<String> = None;
    let mut data_lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        // 分帧已消费分隔符，但事件体内部仍可能带 CRLF。
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = line.strip_prefix("event:") {
            event_name = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim().to_string());
        }
    }
    let mut info = SseEventInfo {
        event_name,
        ..Default::default()
    };
    // Node: `if (dataLines.length === 0) { ...event-field...; continue }`
    if data_lines.is_empty() {
        return info;
    }
    let data = data_lines.join("\n");
    // Node: `if (data === '[DONE]') continue;`
    if data == "[DONE]" {
        return info;
    }
    info.data = Some(data.clone());
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else {
        info.parse_failed = true;
        return info;
    };

    // 第一遍：首字（不看 type 白名单，也不看 error —— `error` 本身不会是
    // content_block_delta，所以两条判据在这里自然一致）。
    let obj_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if obj_type == "content_block_delta" {
        let delta = v.get("delta");
        let truthy = |k: &str| -> bool {
            delta
                .and_then(|d| d.get(k))
                .map(js_truthy)
                .unwrap_or(false)
        };
        info.first_char = truthy("thinking") || truthy("text");
        // 第二遍：`recordDelta` 的 type 归类 + 同一分支的 text（含 Node 的 `??` 兜底分支）。
        if let Some((kind, text)) = content_delta_kind_and_text(delta) {
            info.delta_kind = Some(kind);
            info.delta_text = Some(text);
        }
        // 详情流的四分支（判据与上面刻意不同，见字段注释）。
        info.detail_delta = detail_delta(delta);
    }
    if obj_type == "message_delta" {
        info.stop_reason = v
            .get("delta")
            .and_then(|d| d.get("stop_reason"))
            .and_then(|s| s.as_str())
            .map(|s| s.to_string());
        // Node: `if (obj.usage?.output_tokens) recordTokens(agentId, outT, 0)`
        if let Some(out) = v
            .get("usage")
            .and_then(|u| u.get("output_tokens"))
            .filter(|t| js_truthy(t))
            .and_then(|t| t.as_i64())
        {
            info.usage_output_tokens = out;
        }
    }
    if obj_type == "message_start" {
        // Node: `const u = obj.message?.usage || obj.usage;`
        // `u.input_tokens || u.prompt_tokens || u.inputTokens || 0`（`||` 链：0/缺失继续往下）
        let usage = v
            .get("message")
            .and_then(|m| m.get("usage"))
            .filter(|u| js_truthy(u))
            .or_else(|| v.get("usage").filter(|u| js_truthy(u)));
        if let Some(u) = usage {
            let in_t = first_truthy_i64(u, &["input_tokens", "prompt_tokens", "inputTokens"]);
            let cache_t = first_truthy_i64(u, &["cache_read_input_tokens", "cache_read_tokens"]);
            info.usage_input_tokens = in_t + cache_t;
        }
    }
    info.json = Some(v);
    info
}

/// JS `u.a || u.b || 0` 的数字链：返回第一个真值字段的整数（无命中 → 0）。
fn first_truthy_i64(u: &serde_json::Value, keys: &[&str]) -> i64 {
    for k in keys {
        if let Some(v) = u.get(k) {
            if js_truthy(v) {
                return v.as_i64().unwrap_or(0);
            }
        }
    }
    0
}

/// 实时详情流的单条 delta —— 逐字对齐 `proxy.js:2030-2033` 的 `else if` 顺序：
///
/// ```js
/// if (_dd.type === 'thinking_delta' && _dd.thinking) ...
/// else if (_dd.type === 'text_delta' && _dd.text) ...
/// else if (_dd.thinking) ...
/// else if (_dd.text) ...
/// ```
fn detail_delta(delta: Option<&serde_json::Value>) -> Option<(DeltaKind, String)> {
    let dtype = delta.and_then(|d| d.get("type")).and_then(|t| t.as_str());
    let thinking = delta.and_then(|d| d.get("thinking"));
    let text = delta.and_then(|d| d.get("text"));
    if dtype == Some("thinking_delta") && thinking.map(js_truthy).unwrap_or(false) {
        return Some((DeltaKind::Thinking, js_to_string(thinking.unwrap())));
    }
    if dtype == Some("text_delta") && text.map(js_truthy).unwrap_or(false) {
        return Some((DeltaKind::Text, js_to_string(text.unwrap())));
    }
    if thinking.map(js_truthy).unwrap_or(false) {
        return Some((DeltaKind::Thinking, js_to_string(thinking.unwrap())));
    }
    if text.map(js_truthy).unwrap_or(false) {
        return Some((DeltaKind::Text, js_to_string(text.unwrap())));
    }
    None
}

/// JS `String(v)` 的近似：字符串原样、数字/布尔按 JS 形态、其余（对象/数组/null）
/// 在真实 Anthropic delta 里不会出现，返回空串（调用方只在 JS 真值时才会用）。
fn js_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

/// 第二遍里 `recordDelta(agentId, text, type)` 的 `(type, text)` —— 逐字对齐
/// `proxy.js:2104-2114`：
///
/// ```js
/// if (d?.type === 'thinking_delta' && d.thinking) recordDelta(..., d.thinking, 'thinking');
/// else if (d?.type === 'text_delta' && d.text)  recordDelta(..., d.text, 'text');
/// else { const t = d?.text ?? d?.thinking; if (t) recordDelta(..., t, d?.thinking ? 'thinking' : 'text'); }
/// ```
///
/// 注意兜底分支用的是 **`??`（nullish）** 而不是 `||`：`text` 为 `''` 时会选 `''`（假值 →
/// 不记录），而不是退回 `thinking`。这是 Node 的真实 quirk，照抄。
fn content_delta_kind_and_text(delta: Option<&serde_json::Value>) -> Option<(DeltaKind, String)> {
    let dtype = delta.and_then(|d| d.get("type")).and_then(|t| t.as_str());
    let thinking = delta.and_then(|d| d.get("thinking"));
    let text = delta.and_then(|d| d.get("text"));
    let truthy = |v: Option<&serde_json::Value>| v.map(js_truthy).unwrap_or(false);
    if dtype == Some("thinking_delta") && truthy(thinking) {
        return Some((DeltaKind::Thinking, js_to_string(thinking.unwrap())));
    }
    if dtype == Some("text_delta") && truthy(text) {
        return Some((DeltaKind::Text, js_to_string(text.unwrap())));
    }
    // `t = d?.text ?? d?.thinking`：只有 text 缺失或为 JSON null 时才看 thinking。
    let chosen = match text {
        None | Some(serde_json::Value::Null) => thinking,
        other => other,
    };
    if !truthy(chosen) {
        return None;
    }
    if truthy(thinking) {
        Some((DeltaKind::Thinking, js_to_string(thinking.unwrap())))
    } else {
        Some((DeltaKind::Text, js_to_string(chosen.unwrap())))
    }
}

/// 判断一条完整 SSE 事件是不是"首字"事件 —— 即**第一个带实际文本的 `content_block_delta`**。
///
/// 语义逐条对齐 `proxy.js`（2025–2036 行）：
/// - 只看 `data:` 字段；多行 `data:` 用 `\n` 拼接（与 Node 的 `_dl.join('\n')` 一致）；
/// - `[DONE]` 跳过；
/// - `JSON.parse` 失败、或 `type !== "content_block_delta"` → 不算；
/// - **`delta` 里的 `thinking` / `text` 必须为 JS 真值**才算 —— `content_block_start`、
///   `input_json_delta`、空 delta 都"没有字"，不算首字（原注释："都没'字' → 不算首字"）；
/// - **不校验 `delta.type`**：Node 的最后两个 `else if` 分支表明，只要 `thinking`/`text` 非空即可。
///
/// 这个判据是 `firstByteMs` 对 SSE 的全部依据，所以它必须与 Node 逐字同义 —— 用测试钉住。
/// 实现委托给 `analyze_event`（热路径只解析一次，两遍共用同一份结果）。
pub fn is_first_char_event(event: &[u8]) -> bool {
    analyze_event(event).first_char
}

/// `SSE_WATCHDOG_MS`（`proxy.js:387`）：SSE 流开始后这么久还没收到**首字** →
/// `upstream-timeout` 事件。中段卡顿不归它管（那是 `SSE_STUCK` / `sse-stuck`）。
pub const SSE_WATCHDOG_MS: u64 = 60_000;

/// 字节级 UTF-8 校验器 —— 逐字移植 `proxy.js:146-171` 的 `_scanUtf8Errors(buf)`。
///
/// 返回所有**非法起始字节**与**不完整/被截断序列**的首字节偏移。判据刻意与 Node 一致
/// （只按 `10xxxxxx` 掩码认续字节，不查过长编码 / 代理项 / 码点范围）—— 它不是严格
/// UTF-8 校验器，而是"Node 会怎样把这段字节解码坏"的取证器。
pub fn scan_utf8_errors(buf: &[u8]) -> Vec<usize> {
    let is_cont = |b: u8| (b & 0xC0) == 0x80;
    let mut errors = Vec::new();
    let mut i = 0usize;
    while i < buf.len() {
        let b = buf[i];
        let seqlen: usize = if b <= 0x7F {
            1 // 0xxxxxxx ASCII
        } else if (b & 0xE0) == 0xC0 {
            2 // 110xxxxx
        } else if (b & 0xF0) == 0xE0 {
            3 // 1110xxxx (中文)
        } else if (b & 0xF8) == 0xF0 {
            4 // 11110xxx (emoji)
        } else {
            // 非法起始字节（孤立续字节 / 过长）
            errors.push(i);
            i += 1;
            continue;
        };
        let mut valid = true;
        for j in 1..seqlen {
            if i + j >= buf.len() || !is_cont(buf[i + j]) {
                valid = false;
                break;
            }
        }
        if valid {
            i += seqlen;
        } else {
            // 序列不完整（截断/被截）
            errors.push(i);
            // 跳过紧跟的续字节（属于本失败序列，不重复计 —— 贴近真实 decoder 的 1 U+FFFD）
            let mut j = i + 1;
            while j < buf.len() && is_cont(buf[j]) {
                j += 1;
            }
            i = j;
        }
    }
    errors
}

/// `upstream-byte-corruption` 事件的载荷 —— `proxy.js:176-200` 的 `_scanAndReportCorruption`。
/// `None` = 没有非法字节（不报事件）。
#[derive(Debug, Clone, PartialEq)]
pub struct CorruptionReport {
    /// 合并相邻错误后的**簇**数（Node 的 `clusters.length`）
    pub clusters: usize,
    /// 非法字节总数（Node 的 `offsets.length`）
    pub total_bad_bytes: usize,
    /// 最多 6 条取证样本，每条 `{byteOffset,badBytes,contextHex,contextText}`
    pub samples: Vec<serde_json::Value>,
    /// 被扫描的原始字节长度（Node 的 `sseBytesLen`）
    pub bytes_len: usize,
}

/// 小写无分隔 hex（Node 的 `Buffer.toString('hex')`）。
fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// 扫一段**原始上游字节**（Node 的 `rawAll`）里的非法 UTF-8，合并相邻错误并取最多 6 条上下文样本。
/// 纯函数，不碰主路径；`None` 表示没有损坏（与 Node 的 `offsets.length === 0` 同义）。
pub fn scan_corruption(buf: &[u8]) -> Option<CorruptionReport> {
    let offsets = scan_utf8_errors(buf);
    if offsets.is_empty() {
        return None;
    }
    // 合并相邻错误（一个中文 3 字节坏 → 1 簇），避免重复 dump。
    // Node: `if (last && off - last.end <= 2) last.end = off + 1; else push({start: off, end: off + 1})`
    let mut clusters: Vec<(usize, usize)> = Vec::new();
    for off in &offsets {
        let off = *off;
        match clusters.last_mut() {
            Some(last) if off as i64 - last.1 as i64 <= 2 => last.1 = off + 1,
            _ => clusters.push((off, off + 1)),
        }
    }
    let samples = clusters
        .iter()
        .take(6)
        .map(|(start, end)| {
            let a = start.saturating_sub(12);
            let b = (*end + 12).min(buf.len());
            let ctx = &buf[a..b];
            serde_json::json!({
                "byteOffset": start,
                "badBytes": to_hex(&buf[*start..*end]),
                "contextHex": to_hex(ctx),
                // Node: `toString('utf8').replace(/\uFFFD/g, '·')` —— 正则里那个字符是 U+FFFD，
                // 这里用转义写法，免得本文件自身带一个替换字符（乱码扫描会误报）。
                "contextText": String::from_utf8_lossy(ctx).replace('\u{FFFD}', "·"),
            })
        })
        .collect();
    Some(CorruptionReport {
        clusters: clusters.len(),
        total_bad_bytes: offsets.len(),
        samples,
        bytes_len: buf.len(),
    })
}

#[cfg(test)]
mod tests {
    // ── is_first_char_event：firstByteMs 对 SSE 的全部依据 ──

    #[test]
    fn text_delta_with_text_is_first_char() {
        let ev = b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}";
        assert!(is_first_char_event(ev));
    }

    #[test]
    fn thinking_delta_with_thinking_is_first_char() {
        let ev = b"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hmm\"}}";
        assert!(is_first_char_event(ev));
    }

    /// 非空文本即可，**不看 delta.type**（Node 最后两个 else-if 分支的语义）
    #[test]
    fn text_without_explicit_delta_type_still_counts() {
        let ev = b"data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"x\"}}";
        assert!(is_first_char_event(ev));
    }

    /// 这些"没有字"的事件**都不算**首字 —— 算错会让 firstByteMs 系统性偏小
    #[test]
    fn events_without_actual_text_are_not_first_char() {
        for ev in [
            &b"data: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"text\"}}"[..],
            &b"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{}\"}}"[..],
            &b"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"\"}}"[..],
            &b"data: {\"type\":\"content_block_stop\"}"[..],
            &b"data: {\"type\":\"message_start\"}"[..],
            &b"data: [DONE]"[..],
            &b"data: not-json"[..],
            &b"event: ping"[..],
            &b""[..],
        ] {
            assert!(
                !is_first_char_event(ev),
                "不该被当成首字: {:?}",
                String::from_utf8_lossy(ev)
            );
        }
    }

    /// 多行 data 要按 \n 拼接后再解析（与 Node 的 _dl.join('\n') 一致）
    #[test]
    fn multiline_data_is_joined() {
        let ev = b"data: {\"type\":\"content_block_delta\",\ndata: \"delta\":{\"text\":\"ok\"}}";
        assert!(is_first_char_event(ev));
    }

    use super::*;

    /// Feed `payload` through the splitter in the given chunk sizes, accumulating
    /// complete events, and assert the events are byte-identical to `expected`.
    fn feed(payload: &[u8], chunk_sizes: &[usize]) -> Vec<Vec<u8>> {
        let mut buf: Vec<u8> = Vec::new();
        let mut got: Vec<Vec<u8>> = Vec::new();
        let mut idx = 0usize;
        let mut k = 0usize;
        while idx < payload.len() {
            let n = chunk_sizes[k % chunk_sizes.len()].max(1);
            k += 1;
            let end = (idx + n).min(payload.len());
            buf.extend_from_slice(&payload[idx..end]);
            idx = end;
            let (events, rest) = split_sse_events(&buf);
            for e in events {
                got.push(e);
            }
            buf = rest;
        }
        got
    }

    /// The contract's C7 payload: 3 complete events, CRLF in one, LF in another,
    /// Chinese + emoji inside JSON, terminated by `data: [DONE]`.
    fn c7_payload() -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"event: message_start\r\n");
        v.extend_from_slice("data: {\"type\":\"message_start\",\"text\":\"你好，世界🌏\"}\r\n".as_bytes());
        v.extend_from_slice(b"\r\n"); // CRLF-CRLF separator
        v.extend_from_slice(b"event: content_block_delta\n");
        v.extend_from_slice(
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"🚀ok\"}}\n".as_bytes(),
        );
        v.extend_from_slice(b"\n"); // LF-LF separator
        v.extend_from_slice(b"event: message_stop\n");
        v.extend_from_slice(b"data: [DONE]\n");
        v.extend_from_slice(b"\n");
        v
    }

    #[test]
    fn c7_payload_expected_events_are_byte_exact() {
        let payload = c7_payload();
        let (events, rest) = split_sse_events(&payload);
        assert_eq!(rest.len(), 0, "fully terminated payload leaves no tail");
        assert_eq!(events.len(), 3);
        // NOTE the trailing newline is GONE: for `data: X\r\n\r\n` the regex
        // `\r?\n\r?\n` matches the 4-byte `\r\n\r\n`, i.e. the data line's own CRLF
        // is the first half of the separator. Node's `String.split` behaves the
        // same way, so the event body never carries its terminating newline.
        assert_eq!(
            events[0],
            "event: message_start\r\ndata: {\"type\":\"message_start\",\"text\":\"你好，世界🌏\"}".as_bytes()
        );
        assert_eq!(
            events[1],
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"🚀ok\"}}".as_bytes()
        );
        assert_eq!(events[2], b"event: message_stop\ndata: [DONE]".as_slice());
    }

    /// The headline requirement: split one byte at a time, i.e. through EVERY
    /// mid-multibyte and mid-CRLF boundary, and every complete event must still
    /// round-trip byte-exactly (no U+FFFD, no lost bytes).
    #[test]
    fn one_byte_at_a_time_preserves_every_byte() {
        let payload = c7_payload();
        let expected = split_sse_events(&payload).0;
        let got = feed(&payload, &[1]);

        assert_eq!(got.len(), expected.len());
        assert_eq!(got, expected, "byte-at-a-time chunking must not alter events");

        // No event may contain a replacement character, and each must be valid UTF-8.
        for e in &got {
            let s = std::str::from_utf8(e).expect("event must be valid UTF-8");
            assert!(!s.contains('\u{FFFD}'), "lost bytes: {s:?}");
        }
        // The literal emoji bytes must survive intact.
        assert!(got[0].windows(4).any(|w| w == "🌏".as_bytes()));
        assert!(got[1].windows(4).any(|w| w == "🚀".as_bytes()));
    }

    /// Explicit adversarial offsets: split exactly between `\r` and `\n`, between
    /// the two `\n`s of a separator, and inside a 3-byte Chinese char / 4-byte emoji.
    #[test]
    fn adversarial_offsets_preserve_bytes() {
        let payload = c7_payload();
        let expected = split_sse_events(&payload).0;

        // A path that deliberately stops at every interesting boundary.
        let boundary_plan: &[usize] = &[1, 1, 1, 1, 2, 1, 1, 3, 1, 1, 2, 1, 1, 4, 1, 2, 1, 1, 1, 3, 1];
        let got = feed(&payload, boundary_plan);
        assert_eq!(got, expected, "adversarial chunking altered event bytes");

        // Chunk sizes that land exactly between the `\r` and the `\n` of the CRLF
        // separator (offset of the separator's \r is 17 + data length).
        let cr = payload.windows(2).position(|w| w == b"\r\n").unwrap();
        let got = feed(&payload, &[cr + 1, 1, 1, 1, 1, 1, 1, 1]);
        assert_eq!(got, expected, "mid-CRLF split altered event bytes");
    }

    #[test]
    fn tail_is_preserved_until_terminator_arrives() {
        let mut buf = b"event: x\ndata: par".to_vec();
        let (events, rest) = split_sse_events(&buf);
        assert!(events.is_empty());
        assert_eq!(rest, b"event: x\ndata: par");

        buf.extend_from_slice(b"tial\n\n");
        let (events, rest) = split_sse_events(&buf);
        assert_eq!(events, vec![b"event: x\ndata: partial".to_vec()]);
        assert!(rest.is_empty());
    }

    #[test]
    fn empty_and_unterminated_buffers() {
        let (events, rest) = split_sse_events(b"");
        assert!(events.is_empty());
        assert!(rest.is_empty());

        let (events, rest) = split_sse_events(b"abc");
        assert!(events.is_empty());
        assert_eq!(rest, b"abc");
    }

    /// JS `"a\n\nb".split(/\r?\n\r?\n/)` === ["a","b"]; tail is "b".
    #[test]
    fn matches_js_split_semantics() {
        let (events, rest) = split_sse_events(b"a\n\nb");
        assert_eq!(events, vec![b"a".to_vec()]);
        assert_eq!(rest, b"b");

        // "\n\n" -> ["", ""] -> one empty event, empty tail.
        let (events, rest) = split_sse_events(b"\n\n");
        assert_eq!(events, vec![Vec::<u8>::new()]);
        assert!(rest.is_empty());

        // Mixed separators.
        let (events, rest) = split_sse_events(b"a\r\n\r\nb\n\nc\r\n\nd");
        assert_eq!(
            events,
            vec![b"a".to_vec(), b"b".to_vec(), b"c".to_vec()]
        );
        assert_eq!(rest, b"d");

        // `\r\n\n` and `\n\r\n` are single separators (4-char class).
        let (events, _) = split_sse_events(b"a\r\n\nb\n\r\nc");
        assert_eq!(events, vec![b"a".to_vec(), b"b".to_vec()]);
    }

    /// An isolated `\r` not followed by `\n` must never split.
    #[test]
    fn lone_carriage_return_never_splits() {
        let (events, rest) = split_sse_events(b"a\rb\r\r\nc\n\nd");
        assert_eq!(events, vec![b"a\rb\r\r\nc".to_vec()]);
        assert_eq!(rest, b"d");
    }

    /// The node pipeline: complete bytes -> lossily decoded text, matching
    /// `Buffer.from(p,'latin1').toString('utf8')`.
    #[test]
    fn decode_event_is_lossy_like_node() {
        assert_eq!(decode_event("你好🌏".as_bytes()), "你好🌏");
        // Invalid UTF-8 becomes U+FFFD — same as Node, and only on this side path.
        assert_eq!(decode_event(&[0xff, 0xfe]), "\u{FFFD}\u{FFFD}");
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// DIFFERENTIAL GOLDEN TEST.
    ///
    /// The expected hex strings below were produced by running the REAL Node
    /// `splitSseEvents()` (copied verbatim from proxy.js) over byte-identical
    /// buffers. Node's `events` are `Buffer.from(slice,'latin1').toString('utf8')`,
    /// so we compare the UTF-8 re-encoding of `decode_event(slice)` — which
    /// exercises both the raw byte slicing and the lossy decode.
    #[test]
    fn matches_node_golden_output() {
        let cases: Vec<(&str, Vec<u8>, Vec<&str>, &str)> = vec![
            (
                "c7",
                c7_payload(),
                vec![
                    "6576656e743a206d6573736167655f73746172740d0a646174613a207b2274797065223a226d6573736167655f7374617274222c2274657874223a22e4bda0e5a5bdefbc8ce4b896e7958cf09f8c8f227d",
                    "6576656e743a20636f6e74656e745f626c6f636b5f64656c74610a646174613a207b2274797065223a22636f6e74656e745f626c6f636b5f64656c7461222c2264656c7461223a7b2274657874223a22f09f9a806f6b227d7d",
                    "6576656e743a206d6573736167655f73746f700a646174613a205b444f4e455d",
                ],
                "",
            ),
            ("mixed", b"a\r\n\r\nb\n\nc\r\n\nd".to_vec(), vec!["61", "62", "63"], "64"),
            ("lonecr", b"a\rb\r\r\nc\n\nd".to_vec(), vec!["610d620d0d0a63"], "64"),
            (
                "badutf8",
                vec![0xffu8, 0xfe, 0x0a, 0x0a, 0x41, 0x0a, 0x0a],
                vec!["efbfbdefbfbd", "41"],
                "",
            ),
            (
                "tail",
                b"event: x\ndata: partial".to_vec(),
                vec![],
                "6576656e743a20780a646174613a207061727469616c",
            ),
            ("empty", vec![], vec![], ""),
            ("onlysep", b"\n\n".to_vec(), vec![""], ""),
        ];

        for (name, buf, want_events, want_rest) in cases {
            let (events, rest) = split_sse_events(&buf);
            let got: Vec<String> = events
                .iter()
                .map(|e| hex(decode_event(e).as_bytes()))
                .collect();
            assert_eq!(got, want_events, "case {name}: events differ from Node");
            assert_eq!(hex(&rest), want_rest, "case {name}: rest differs from Node");
        }
    }

    fn hex_decode(s: &str) -> Vec<u8> {
        assert!(s.len() % 2 == 0, "hex 长度必须是偶数");
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("非法 hex"))
            .collect()
    }

    /// 差分 golden fuzz：160 个对抗性输入逐例比对**真实 Node `splitSseEvents`** 的输出。
    ///
    /// golden 由 `test/proxy-contract/tools/gen-sse-golden.mjs` 生成（该脚本从 proxy.js 正则抠出
    /// 真实实现原文来跑，不是手抄的期望值）。编译期 `include_str!` 嵌入，不依赖运行期路径。
    ///
    /// 为什么必须单独有这条：spike 的字节保真靠「原样转发上游 chunk」实现，分帧器**不在透传热路径**上，
    /// 端到端用例 C7 测不到它 —— 一个分帧器写坏的实现照样能让 C7 全绿。分帧器一旦在 Stage 2 上热路径
    /// （dashboard / capture），就是最高风险组件，必须有跨实现的逐例证据。
    #[test]
    fn matches_node_golden_fuzz() {
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            input: String,
            events_raw: Vec<String>,
            events_decoded: Vec<String>,
            rest_raw: String,
        }
        #[derive(serde::Deserialize)]
        struct Golden {
            cases: Vec<Case>,
        }

        let raw = include_str!("../../../test/proxy-contract/fixtures/sse-framing-golden.json");
        let golden: Golden = serde_json::from_str(raw).expect("golden json 解析失败");
        assert!(golden.cases.len() >= 120, "golden 用例太少，证据不足");

        let mut framing_mismatch = Vec::new();
        let mut decode_mismatch = Vec::new();
        for c in &golden.cases {
            let input = hex_decode(&c.input);
            let (events, rest) = split_sse_events(&input);

            let got_raw: Vec<String> = events.iter().map(|e| hex(e)).collect();
            if got_raw != c.events_raw || hex(&rest) != c.rest_raw {
                framing_mismatch.push(c.name.clone());
                continue;
            }
            let got_dec: Vec<String> = events
                .iter()
                .map(|e| hex(decode_event(e).as_bytes()))
                .collect();
            if got_dec != c.events_decoded {
                decode_mismatch.push(c.name.clone());
            }
        }

        assert!(
            framing_mismatch.is_empty(),
            "分帧（原始字节）与真实 Node 不一致: {:?}",
            framing_mismatch
        );
        // 有损解码的差异只影响 dashboard 显示文案，不影响契约的字节通路 —— 真出现也要如实报出来。
        assert!(
            decode_mismatch.is_empty(),
            "有损 UTF-8 解码与真实 Node 不一致（会影响 dashboard 显示）: {:?}",
            decode_mismatch
        );
    }

    // ── analyze_event：首字 + lastDeltaType + 事件来源所需字段，一次解析 ──

    fn analyze(s: &str) -> SseEventInfo {
        analyze_event(s.as_bytes())
    }

    #[test]
    fn analyze_extracts_event_name_multiline_data_and_json() {
        let i = analyze("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\ndata: \"delta\":{\"text\":\"ok\"}}");
        assert_eq!(i.event_name.as_deref(), Some("content_block_delta"));
        assert_eq!(
            i.data.as_deref(),
            Some("{\"type\":\"content_block_delta\",\n\"delta\":{\"text\":\"ok\"}}"),
            "多行 data 必须按 \\n 拼接"
        );
        assert!(!i.parse_failed);
        assert!(i.json.is_some());
        assert!(i.first_char);
        assert_eq!(i.delta_kind, Some(DeltaKind::Text));
    }

    /// `event:` 名与 `data:` 值都 `.trim()`（Node 是 `slice(n).trim()`）。
    #[test]
    fn analyze_trims_event_name_and_data() {
        let i = analyze("event:  ping \ndata:   {\"type\":\"ping\"}   ");
        assert_eq!(i.event_name.as_deref(), Some("ping"));
        assert_eq!(i.data.as_deref(), Some("{\"type\":\"ping\"}"));
        assert_eq!(
            i.json.as_ref().unwrap()["type"],
            "ping",
            "trim 后必须仍是合法 JSON"
        );
    }

    #[test]
    fn analyze_reports_event_field_only_when_there_is_no_data_line() {
        let i = analyze("event: error");
        assert_eq!(i.event_name.as_deref(), Some("error"));
        assert!(i.data.is_none(), "没有 data 行 → data=None（event-field 判据）");
        assert!(!i.parse_failed);
        assert!(i.json.is_none());

        let i = analyze("event: message_stop\ndata: [DONE]");
        assert!(i.data.is_none(), "[DONE] 也走 continue，不算 data");
        assert!(!i.parse_failed, "[DONE] 不是解析失败");
    }

    #[test]
    fn analyze_marks_parse_failure_and_keeps_the_raw_data() {
        let i = analyze("data: not-json");
        assert!(i.parse_failed);
        assert_eq!(i.data.as_deref(), Some("not-json"), "parse-fail 的 rawPreview 用它");
        assert!(i.json.is_none());
        assert!(!i.first_char);
        assert_eq!(i.delta_kind, None);
    }

    /// 第二遍的 `recordDelta` 归类：三分支逐条对齐 Node（含 `??` 兜底 quirk）。
    #[test]
    fn delta_kind_follows_the_node_record_delta_branches() {
        assert_eq!(
            analyze("data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hmm\"}}").delta_kind,
            Some(DeltaKind::Thinking)
        );
        assert_eq!(
            analyze("data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}").delta_kind,
            Some(DeltaKind::Text)
        );
        // 兜底：无 delta.type，靠字段归类；thinking 为真 → thinking
        assert_eq!(
            analyze("data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"x\",\"thinking\":\"y\"}}").delta_kind,
            Some(DeltaKind::Thinking),
            "Node 兜底用 `d?.thinking ? 'thinking' : 'text'`"
        );
        assert_eq!(
            analyze("data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"x\"}}").delta_kind,
            Some(DeltaKind::Text)
        );
        // `??` quirk：text === '' 时选 ''（假值 → 不记录），不退回 thinking
        assert_eq!(
            analyze("data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"\",\"thinking\":\"zzz\"}}").delta_kind,
            None,
            "text 为空串时第一支不成立；兜底 t='' 为假 → 不记录（Node quirk）"
        );
        assert_eq!(
            analyze("data: {\"type\":\"content_block_delta\"}").delta_kind,
            None
        );
        assert_eq!(
            analyze("data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{}\"}}").delta_kind,
            None
        );
    }

    /// 首字判据用 JS truthiness（`if (_dd.thinking)`），不是「非空字符串」。
    #[test]
    fn first_char_uses_js_truthiness() {
        assert!(analyze("data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":5}}").first_char);
        assert!(!analyze("data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":0}}").first_char);
        assert!(!js_truthy(&serde_json::json!(0)));
        assert!(js_truthy(&serde_json::json!(5)));
        assert!(js_truthy(&serde_json::json!([1])));
    }

    #[test]
    fn analyze_extracts_stop_reason_from_message_delta() {
        let i = analyze("data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"}}");
        assert_eq!(i.stop_reason.as_deref(), Some("max_tokens"));
        assert!(is_known_sse_type("message_delta"));
        let i = analyze("data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":3}}");
        assert_eq!(i.stop_reason, None);
    }

    /// 白名单与 Node 的 `KNOWN_SSE_TYPES` 逐项一致（多一个少一个都会改变事件流内容）。
    #[test]
    fn known_sse_types_match_node_whitelist() {
        for t in [
            "content_block_delta",
            "content_block_start",
            "content_block_stop",
            "message_start",
            "message_delta",
            "message_stop",
            "ping",
            "error",
        ] {
            assert!(is_known_sse_type(t), "{t} 应在白名单内");
        }
        for t in ["", "message", "tool_use", "content_block", "PING"] {
            assert!(!is_known_sse_type(t), "{t} 不该在白名单内");
        }
    }

    // ── upstream-byte-corruption：字节级 UTF-8 取证（`_scanUtf8Errors` / `_scanAndReportCorruption`）──

    /// 合法 UTF-8 一律无错；非法起始字节与不完整序列各报**首字节偏移**。
    #[test]
    fn scan_utf8_errors_matches_node_offsets() {
        assert!(scan_utf8_errors(b"").is_empty());
        assert!(scan_utf8_errors(b"hello").is_empty());
        assert!(scan_utf8_errors("你好，世界🌏".as_bytes()).is_empty());

        // 两个孤立起始字节（0xff/0xfe 既非 ASCII 也不是任何合法前缀）各报一次
        assert_eq!(scan_utf8_errors(&[0xff, 0xfe]), vec![0, 1], "两个非法起始字节");
        // 孤立续字节
        assert_eq!(scan_utf8_errors(&[0x41, 0x80]), vec![1]);
        // 被截断的 3 字节序列：只报首字节，紧跟的续字节不重复计
        assert_eq!(scan_utf8_errors(&[0xE4, 0xB8]), vec![0], "截断序列只报首字节");
        // 序列中间被非续字节打断
        assert_eq!(scan_utf8_errors(&[0xE4, 0x41]), vec![0]);
        // 合法的 3 字节中文 / 4 字节 emoji
        assert!(scan_utf8_errors("中".as_bytes()).is_empty());
        assert!(scan_utf8_errors(&[0xF0, 0x9F, 0x8C, 0x8F]).is_empty());
        // Node 的 quirk：只看续字节掩码，不查过长编码 —— 0xC0 0x80 被判为"合法"
        assert!(
            scan_utf8_errors(&[0xC0, 0x80]).is_empty(),
            "Node 不查过长编码，照抄"
        );
    }

    /// 没有非法字节 → 不报事件（`None`）。
    #[test]
    fn scan_corruption_is_none_for_clean_bytes() {
        assert!(scan_corruption(b"").is_none());
        assert!(scan_corruption("data: {\"text\":\"你好\"}".as_bytes()).is_none());
    }

    /// 相邻（距离 ≤ 2）的错误合并成一簇：`0xff 0xfe` 是 1 簇 / 2 个非法字节。
    #[test]
    fn scan_corruption_merges_adjacent_errors_and_counts_bytes() {
        let rep = scan_corruption(&[0xff, 0xfe]).expect("应报损坏");
        assert_eq!(rep.clusters, 1, "0xff 0xfe 相邻，合并为 1 簇");
        assert_eq!(rep.total_bad_bytes, 2, "totalBadBytes 是 offsets.length");
        assert_eq!(rep.bytes_len, 2);
        assert_eq!(rep.samples.len(), 1);
        let s = &rep.samples[0];
        assert_eq!(s["byteOffset"], 0);
        assert_eq!(s["badBytes"], "fffe");
        assert_eq!(s["contextHex"], "fffe");
        assert_eq!(
            s["contextText"], "··",
            "U+FFFD 被替换成 ·（Node 的 replace(/\\uFFFD/g,'·')）"
        );
    }

    /// 距离 > 2 的错误各成一簇；样本上限 6 条（Node 的 `clusters.slice(0, 6)`）。
    #[test]
    fn scan_corruption_splits_distant_errors_and_caps_samples_at_six() {
        // 每个坏字节之间隔 3 个 ASCII 字节（off - last.end == 3 > 2）→ 各自成簇
        let mut buf = Vec::new();
        for _ in 0..10 {
            buf.push(0xff);
            buf.extend_from_slice(b"AAA");
        }
        let rep = scan_corruption(&buf).expect("应报损坏");
        assert_eq!(rep.total_bad_bytes, 10);
        assert_eq!(rep.clusters, 10, "间隔 3 > 2，不合并");
        assert_eq!(rep.samples.len(), 6, "样本最多 6 条");
        assert_eq!(rep.samples[0]["byteOffset"], 0);
        assert_eq!(rep.samples[1]["byteOffset"], 4);

        // 间隔恰好 2 → 合并（`off - last.end <= 2`）
        let rep2 = scan_corruption(&[0xff, 0x41, 0xff]).expect("应报损坏");
        assert_eq!(rep2.clusters, 1, "off - last.end == 1，合并");
        // 间隔恰好 3 → 不合并（边界）
        let rep3 = scan_corruption(&[0xff, 0x41, 0x41, 0xff]).expect("应报损坏");
        assert_eq!(rep3.clusters, 1, "off - last.end == 2，仍合并");
        let rep4 = scan_corruption(&[0xff, 0x41, 0x41, 0x41, 0xff]).expect("应报损坏");
        assert_eq!(rep4.clusters, 2, "off - last.end == 3，不合并");
    }

    /// 上下文窗口是 `[start-12, end+12)` 且被缓冲边界夹住；hex/文本取的是同一段。
    #[test]
    fn scan_corruption_context_window_is_clamped() {
        // 坏字节在偏移 1，前面只有 1 字节 → a = max(0, 1-12) = 0
        let rep = scan_corruption(&[0x41, 0xff, 0x42]).expect("应报损坏");
        let s = &rep.samples[0];
        assert_eq!(s["byteOffset"], 1);
        assert_eq!(s["badBytes"], "ff");
        assert_eq!(s["contextHex"], "41ff42", "a=0（被下界夹住）、b=min(3, 1+1+12)=3");
        assert_eq!(s["contextText"], "A·B");
    }
}
