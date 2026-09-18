//! `~/.claude/cc-monitor-state.json` load/save, ported from proxy.js
//! `loadMonitorState()` / `saveMonitorState()`.
//!
//! Semantics preserved:
//! - defaults first, then file overlay (unknown keys are retained verbatim);
//! - save is a patch-merge, so callers pass only the keys they change;
//! - the `~/.claude` directory is created if missing (Node would silently fail
//!   the write; we deliberately create it — see README deviations).

use crate::proxy::env::Env;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone)]
pub struct MonitorState {
    pub previous_base_url: Option<String>,
    /// Read/written for state-file fidelity with the Node reference; this spike
    /// has no idle-cleanup loop, so the bin does not consume it.
    #[allow(dead_code)]
    pub user_disabled: bool,
    #[allow(dead_code)]
    pub idle_cleanup_ms_main: Option<f64>,
}

fn read_state_map(env: &Env) -> Map<String, Value> {
    std::fs::read_to_string(&env.state_path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default()
}

pub fn load_monitor_state(env: &Env) -> MonitorState {
    let m = read_state_map(env);
    MonitorState {
        previous_base_url: m
            .get("previousBaseUrl")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        user_disabled: m
            .get("userDisabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        idle_cleanup_ms_main: m
            .get("idleCleanupMsMain")
            .and_then(|v| v.as_f64())
            .or(Some(120_000.0)),
    }
}

/// Patch-merge: `{...load(), ...patch}` written back as pretty JSON.
/// Errors are logged, never propagated (matches Node `saveMonitorState`).
pub fn save_monitor_state(env: &Env, patch: Map<String, Value>) {
    let mut merged = Map::new();
    merged.insert("previousBaseUrl".to_string(), Value::Null);
    merged.insert("userDisabled".to_string(), Value::Bool(false));
    merged.insert("idleCleanupMsMain".to_string(), json!(120_000));
    for (k, v) in read_state_map(env) {
        merged.insert(k, v);
    }
    for (k, v) in patch {
        merged.insert(k, v);
    }
    if let Some(dir) = env.state_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match serde_json::to_string_pretty(&Value::Object(merged)) {
        Ok(text) => {
            if let Err(e) = std::fs::write(&env.state_path, text) {
                eprintln!("[state] save failed: {e}");
            }
        }
        Err(e) => eprintln!("[state] save failed: {e}"),
    }
}

/// `IDLE_CLEANUP_MS_MAIN` 的模块级初值（Node: `let IDLE_CLEANUP_MS_MAIN = 120_000`）。
pub const IDLE_CLEANUP_MS_MAIN_DEFAULT: f64 = 120_000.0;
/// 上限 1h（Node `_IDLE_CLEANUP_MS_MAX`，防配错把 agent 永远留表里）。
pub const IDLE_CLEANUP_MS_MAX: f64 = 3_600_000.0;

/// 启动时的 `applyStateOverrides()`：状态文件里的 `idleCleanupMsMain` 若为**有限且非负**
/// 才生效（并夹到 `IDLE_CLEANUP_MS_MAX`），否则保留默认 120000。
///
/// 为什么单独有这个函数而不是直接用 `load_monitor_state` 的值：后者对缺失键回填默认值，
/// 但不会过滤 `-1` / `NaN` 这类脏值 —— Node 的 `Number.isFinite(...) && >= 0` 守卫必须照抄。
pub fn initial_idle_cleanup_ms_main(env: &Env) -> f64 {
    match load_monitor_state(env).idle_cleanup_ms_main {
        Some(v) if v.is_finite() && v >= 0.0 => v.min(IDLE_CLEANUP_MS_MAX),
        _ => IDLE_CLEANUP_MS_MAIN_DEFAULT,
    }
}

/// 把 JS Number 打印成 JSON 数字。
///
/// 必要性：serde_json 会把 `f64` 的整数值序列化成 `120000.0`，而 Node 的
/// `JSON.stringify(120000)` 是 `120000` —— `/config/idle` 的响应体与状态文件都会因此
/// 出现无意义的小数尾巴。整数值走 `i64`，非整数（用户真传了 `1.5`）保留 `f64`，
/// 两种都与 JS 的 Number→String 一致。
pub fn js_number_value(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn env_at(dir: &std::path::Path) -> Env {
        Env {
            port: 9999,
            target: None,
            anthropic_base_url: None,
            loop_bypass: true,
            home: dir.to_path_buf(),
            settings_path: dir.join("settings.json"),
            state_path: dir.join("cc-monitor-state.json"),
            debug: false,
            log_dir: None,
        }
    }

    fn unique_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "spike-state-{}-{}-{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn missing_state_yields_defaults() {
        let d = unique_dir("missing");
        let env = env_at(&d);
        let s = load_monitor_state(&env);
        assert_eq!(s.previous_base_url, None);
        assert!(!s.user_disabled);
        assert_eq!(s.idle_cleanup_ms_main, Some(120_000.0));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn save_is_patch_merge_and_retains_unknown_keys() {
        let d = unique_dir("merge");
        let env = env_at(&d);
        std::fs::write(
            &env.state_path,
            r#"{ "previousBaseUrl": "http://a", "custom": 42 }"#,
        )
        .unwrap();
        let mut patch = Map::new();
        patch.insert("previousBaseUrl".to_string(), Value::Null);
        patch.insert("userDisabled".to_string(), Value::Bool(true));
        save_monitor_state(&env, patch);
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&env.state_path).unwrap()).unwrap();
        assert!(v.get("previousBaseUrl").unwrap().is_null());
        assert_eq!(v.get("userDisabled").unwrap().as_bool(), Some(true));
        assert_eq!(v.get("custom").unwrap().as_i64(), Some(42));
        // default backfilled by the merge
        assert_eq!(v.get("idleCleanupMsMain").unwrap().as_i64(), Some(120_000));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 启动时的应用规则：有限且非负才生效，且夹到 1h 上限。
    #[test]
    fn initial_idle_cleanup_applies_state_with_clamp() {
        let d = unique_dir("idle");
        let env = env_at(&d);
        // 缺键 → 默认
        assert_eq!(initial_idle_cleanup_ms_main(&env), 120_000.0);
        // 正常值生效
        std::fs::write(&env.state_path, r#"{ "idleCleanupMsMain": 90000 }"#).unwrap();
        assert_eq!(initial_idle_cleanup_ms_main(&env), 90_000.0);
        // 超上限 → 夹到 1h
        std::fs::write(&env.state_path, r#"{ "idleCleanupMsMain": 99999999 }"#).unwrap();
        assert_eq!(initial_idle_cleanup_ms_main(&env), 3_600_000.0);
        // 负数 → 视为没配（Node: `>= 0` 守卫）
        std::fs::write(&env.state_path, r#"{ "idleCleanupMsMain": -1 }"#).unwrap();
        assert_eq!(initial_idle_cleanup_ms_main(&env), 120_000.0);
        // 非数字 → 默认（Node: `Number.isFinite` 守卫）
        std::fs::write(&env.state_path, r#"{ "idleCleanupMsMain": "abc" }"#).unwrap();
        assert_eq!(initial_idle_cleanup_ms_main(&env), 120_000.0);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// JS Number 的 JSON 形态：整数值不带 `.0` 尾巴，非整数保留小数。
    #[test]
    fn js_number_value_has_no_trailing_dot_zero() {
        assert_eq!(js_number_value(120_000.0).to_string(), "120000");
        assert_eq!(js_number_value(1.5).to_string(), "1.5");
        assert_eq!(js_number_value(0.0).to_string(), "0");
    }
}
