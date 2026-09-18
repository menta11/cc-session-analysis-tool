//! `/session?id=<sessionId>` —— cc 会话时间线（`proxy.js:1215` 的 `loadSessionTimeline`）。
//!
//! cc 把会话落盘在 `~/.claude/projects/<项目目录>/<sessionId>.jsonl`（JSONL，每行一事件）。
//! 本模块把这个读取 + 提取逻辑逐条对齐 Node：
//!
//! - 在 `projects/` 下**按目录名顺序**找第一个存在 `<sessionId>.jsonl` 的目录（Node 就是
//!   `readdirSync` 顺序 + 首个命中，没有别的排序）；
//! - 逐行 `trim` → 空行跳过 → `JSON.parse` 失败跳过（**不报错**，坏行不影响其它）；
//! - 只保留 `user` 的文本输入、`assistant` 的 `thinking` / `text` / `tool_use` 块；
//!   工具结果（`tool_result`）刻意不进时间线；
//! - 每处理完一行检查 `entries.length >= MAX_ENTRIES` 就停 —— 注意这是**行级**检查，
//!   所以一条 assistant 消息若含多个块，`entries` 可以略微超过 2000（Node 如此，照抄）。
//!
//! 返回 `{ sessionId, count, entries }`；读不到目录 / 找不到文件 / 读文件失败 → `None`
//! （端点据此回 404）。

use std::path::Path;

use serde_json::{json, Map, Value};

/// Node 的 `const MAX = 2000`（防超大 session 撑爆前端）。
pub const MAX_ENTRIES: usize = 2000;

/// 读一个 session 的对话时间线。`home` 是 `~`（可注入，便于测试）。
pub fn load_session_timeline(home: &Path, session_id: &str) -> Option<Value> {
    let projects_dir = home.join(".claude").join("projects");
    let file_name = format!("{session_id}.jsonl");
    // Node: 遍历 readdirSync(projectsDir)，首个存在 <sid>.jsonl 的目录胜出。
    let dir = std::fs::read_dir(&projects_dir).ok()?;
    let mut found: Option<std::path::PathBuf> = None;
    for entry in dir.flatten() {
        let candidate = entry.path().join(&file_name);
        if candidate.exists() {
            found = Some(candidate);
            break;
        }
    }
    let file = found?;

    // Node 用 `readFileSync(file,'utf8')`：非法 UTF-8 会被替换成 U+FFFD 而不是失败，
    // 所以这里 `from_utf8_lossy` 而不是 `read_to_string`（后者会整体返回 Err）。
    let raw = std::fs::read(&file).ok()?;
    let text = String::from_utf8_lossy(&raw);

    let mut entries: Vec<Value> = Vec::new();
    for line in text.split('\n') {
        let s = line.trim();
        if s.is_empty() {
            continue;
        }
        let Ok(o) = serde_json::from_str::<Value>(s) else {
            continue; // Node: catch → continue
        };
        // Node: `const msg = o.message; if (!msg || typeof msg !== 'object') continue;`
        // 数组在 JS 里 `typeof` 也是 'object'，故数组同样通过。
        let msg = match o.get("message") {
            Some(Value::Object(_)) | Some(Value::Array(_)) => o.get("message").unwrap(),
            _ => continue,
        };
        // Node: `const ts = o.timestamp || null;`（空串 / 0 / null 都落 null）
        let ts = o
            .get("timestamp")
            .filter(|v| crate::proxy::sse::js_truthy(v))
            .cloned()
            .unwrap_or(Value::Null);

        let o_type = o.get("type").and_then(|t| t.as_str());
        let role = msg.get("role").and_then(|r| r.as_str());
        let content = msg.get("content");

        if o_type == Some("user") && role == Some("user") {
            match content {
                Some(Value::String(c)) => {
                    entries.push(json!({ "role": "user", "text": c, "ts": ts }));
                }
                Some(Value::Array(blocks)) => {
                    // 用户文本块（粘贴/command）；tool_result 刻意跳过。
                    for b in blocks {
                        if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                                entries.push(json!({ "role": "user", "text": t, "ts": ts }));
                            }
                        }
                    }
                }
                _ => {}
            }
        } else if o_type == Some("assistant")
            && role == Some("assistant")
            && matches!(content, Some(Value::Array(_)))
        {
            for b in content.and_then(|c| c.as_array()).map(|v| v.as_slice()).unwrap_or(&[]) {
                let b_type = b.get("type").and_then(|t| t.as_str());
                match b_type {
                    Some("thinking") => {
                        if let Some(t) = b.get("thinking").and_then(|t| t.as_str()) {
                            entries.push(json!({ "role": "thinking", "text": t, "ts": ts }));
                        }
                    }
                    Some("text") => {
                        if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                            entries.push(json!({ "role": "text", "text": t, "ts": ts }));
                        }
                    }
                    Some("tool_use") => {
                        // cc 真实发出的工具调用（Read/Bash/Edit/Skill…）+ 参数。
                        let name = b
                            .get("name")
                            .and_then(|n| n.as_str())
                            .filter(|n| !n.is_empty())
                            .unwrap_or("?");
                        let mut entry = Map::new();
                        entry.insert("role".to_string(), json!("tool_use"));
                        entry.insert("name".to_string(), json!(name));
                        // `JSON.stringify(b.input, null, 2)`：input 缺失（undefined）时
                        // JS 得到 undefined → 键被省略；这里同样省略，不写成 "null"。
                        if let Some(input) = b.get("input") {
                            let text = serde_json::to_string_pretty(input)
                                .unwrap_or_else(|_| "null".to_string());
                            entry.insert("text".to_string(), json!(text));
                        }
                        entry.insert("ts".to_string(), ts.clone());
                        entries.push(Value::Object(entry));
                    }
                    _ => {}
                }
            }
        }
        // Node 的行级上限检查（一条消息多块时可略微超过 MAX）。
        if entries.len() >= MAX_ENTRIES {
            break;
        }
    }

    Some(json!({
        "sessionId": session_id,
        "count": entries.len(),
        "entries": entries,
    }))
}

/// `/session` 的 sessionId 形状守卫（Node: `/^[a-f0-9-]+$/i`）。不合法 → 400。
/// 注意 `(?i)`：Node 的正则带 `i` 标志，大写十六进制同样合法（不是笔误）。
pub fn is_valid_session_id(sid: &str) -> bool {
    use std::sync::OnceLock;
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"(?i)^[a-f0-9-]+$").expect("session id regex")
    });
    re.is_match(sid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_home(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "spike-session-{}-{}-{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(d.join(".claude/projects/proj-a")).unwrap();
        d
    }

    fn write_session(home: &Path, proj: &str, sid: &str, body: &str) {
        let dir = home.join(".claude/projects").join(proj);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{sid}.jsonl")), body).unwrap();
    }

    #[test]
    fn session_id_shape_guard_matches_node_regex() {
        assert!(is_valid_session_id("abc123"));
        assert!(is_valid_session_id("A1B2-C3D4"));
        assert!(is_valid_session_id("----"));
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("has space"), "空格不合法");
        assert!(!is_valid_session_id("../../etc/passwd"), "路径穿越不合法");
        assert!(!is_valid_session_id("g"), "'g' 不在 [a-f0-9-] 内");
    }

    #[test]
    fn missing_projects_dir_or_file_yields_none() {
        let home = tmp_home("missing");
        assert!(load_session_timeline(&home, "abc").is_none());
        assert!(load_session_timeline(&std::path::Path::new("/nonexistent-xyz"), "abc").is_none());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn extracts_user_thinking_text_and_tool_use_but_not_tool_result() {
        let home = tmp_home("extract");
        write_session(
            &home,
            "proj-a",
            "sess-1",
            concat!(
                r#"{"type":"user","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello"}}"#,
                "\n",
                r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ignored"},{"type":"text","text":"pasted"}]}}"#,
                "\n",
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"answer"},{"type":"tool_use","name":"Read","input":{"file_path":"/x"}}]}}"#,
                "\n",
                "not json at all",
                "\n",
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","input":{"a":1}}]}}"#,
                "\n",
            ),
        );
        let v = load_session_timeline(&home, "sess-1").unwrap();
        assert_eq!(v["sessionId"], "sess-1");
        let entries = v["entries"].as_array().unwrap();
        assert_eq!(v["count"], entries.len());
        let roles: Vec<&str> = entries.iter().map(|e| e["role"].as_str().unwrap()).collect();
        assert_eq!(
            roles,
            vec!["user", "user", "thinking", "text", "tool_use", "tool_use"],
            "tool_result 不进时间线；坏行跳过"
        );
        assert_eq!(entries[0]["text"], "hello");
        assert_eq!(entries[0]["ts"], "2026-01-01T00:00:01.000Z");
        // 无 timestamp 的行 → ts 为 null
        assert!(entries[1]["ts"].is_null());
        // tool_use: name + pretty JSON input
        assert_eq!(entries[4]["name"], "Read");
        assert_eq!(entries[4]["text"], "{\n  \"file_path\": \"/x\"\n}");
        // name 缺失 → '?'
        assert_eq!(entries[5]["name"], "?");
        std::fs::remove_dir_all(&home).unwrap();
    }

    /// `input` 缺失时 Node 的 `text: undefined` 会被 JSON.stringify 省略 —— 这里同样省略键。
    #[test]
    fn tool_use_without_input_omits_the_text_key() {
        let home = tmp_home("noinput");
        write_session(
            &home,
            "proj-a",
            "sess-2",
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash"}]}}"#,
        );
        let v = load_session_timeline(&home, "sess-2").unwrap();
        let e = &v["entries"][0];
        assert_eq!(e["role"], "tool_use");
        assert_eq!(e["name"], "Bash");
        assert!(e.get("text").is_none(), "input 缺失 → 不写 text 键");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn finds_the_session_in_whichever_project_dir_has_it() {
        let home = tmp_home("search");
        write_session(&home, "proj-b", "findme", r#"{"type":"user","message":{"role":"user","content":"x"}}"#);
        let v = load_session_timeline(&home, "findme").unwrap();
        assert_eq!(v["count"], 1);
        std::fs::remove_dir_all(&home).unwrap();
    }

    /// 行级上限：一条消息里多个块可以让 entries 略超 2000，但绝不会跑到 4000。
    #[test]
    fn stops_after_the_line_that_reaches_the_cap() {
        let home = tmp_home("cap");
        let mut body = String::new();
        let mut i = 0;
        while i < MAX_ENTRIES + 20 {
            body.push_str(r#"{"type":"user","message":{"role":"user","content":"line"}}"#);
            body.push('\n');
            i += 1;
        }
        write_session(&home, "proj-a", "cap", &body);
        let v = load_session_timeline(&home, "cap").unwrap();
        assert_eq!(v["count"], MAX_ENTRIES, "到上限即停，不多读一行");
        std::fs::remove_dir_all(&home).unwrap();
    }

    /// 一条 assistant 消息含多块：突破上限时也只在**行末**停（Node 的行级检查）。
    /// 所以「把 entries 从 1999 推到 2002」的那一行会整行留下 → 2002 条。
    #[test]
    fn the_cap_is_checked_per_line_so_one_message_can_overshoot() {
        let home = tmp_home("overshoot");
        let mut body = String::new();
        for _ in 0..MAX_ENTRIES - 1 {
            body.push_str(r#"{"type":"user","message":{"role":"user","content":"l"}}"#);
            body.push('\n');
        }
        // 这一行含 3 个 text 块：1999 → 2002，行末才发现已超上限。
        body.push_str(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"a"},{"type":"text","text":"b"},{"type":"text","text":"c"}]}}"#,
        );
        body.push('\n');
        write_session(&home, "proj-a", "over", &body);
        let v = load_session_timeline(&home, "over").unwrap();
        assert_eq!(v["count"], MAX_ENTRIES + 2, "行级检查 → 一行可整体超过上限");
        std::fs::remove_dir_all(&home).unwrap();
    }
}
