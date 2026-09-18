//! Upstream base-URL resolution, ported from proxy.js:
//! `isProxySelf()`, `resolveExplicitApiUrl()`, `upstreamSourceReport()`,
//! `monitorUnavailableReason()`.
//!
//! Priority (high -> low), CONTRACT §4:
//!   1. `CC_MONITOR_TARGET`
//!   2. `$HOME/.claude/settings.json` `env.ANTHROPIC_BASE_URL`
//!   3. `$HOME/.claude/cc-monitor-state.json` `previousBaseUrl`
//!   4. `ANTHROPIC_BASE_URL`
//!
//! A source that is a loopback-same-port self reference (`localhost` /
//! `127.0.0.1` / `::1` with an explicit port equal to `CC_MONITOR_PORT`) or an
//! unparseable URL is SKIPPED — not fatal — and resolution continues to the next
//! source. If every source is skipped, `direct_url` falls back to
//! `https://api.anthropic.com` and `available` is false with a non-empty,
//! source-distinguishing `availableReason`.

use url::Url;

use crate::proxy::env::Env;
use crate::proxy::settings::get_settings_base_url;
use crate::proxy::state::load_monitor_state;

pub const FALLBACK_DIRECT_URL: &str = "https://api.anthropic.com";

#[derive(Debug, Clone)]
pub struct SourceRow {
    pub name: String,
    pub raw: String,
    /// Non-empty => this source was set but rejected, and here is why.
    pub why: String,
}

/// Loopback + same port as this proxy. Precise to the port: a local LLM on
/// `localhost:11434` is NOT us and must not be skipped.
///
/// Like Node's `new URL(x).port`, an absent port is the empty string, so
/// `http://localhost/v1` without an explicit port is not treated as self.
pub fn is_proxy_self(u: &Url, port: u16) -> bool {
    let host = u.host_str().unwrap_or("");
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1";
    loopback && u.port() == Some(port)
}

fn settings_row_name(env: &Env) -> String {
    let home = env.home.to_string_lossy();
    let path = env.settings_path.to_string_lossy().replace(home.as_ref(), "~");
    format!("settings.json ({path})")
}

/// Per-source diagnostic: raw value plus the rejection reason, if any.
pub fn upstream_source_report(env: &Env) -> Vec<SourceRow> {
    let rows: Vec<(String, String)> = vec![
        (
            "CC_MONITOR_TARGET".to_string(),
            env.target.clone().unwrap_or_default(),
        ),
        (
            settings_row_name(env),
            get_settings_base_url(env).unwrap_or_default(),
        ),
        (
            "monitor-state 缓存".to_string(),
            load_monitor_state(env)
                .previous_base_url
                .unwrap_or_default(),
        ),
        (
            "ANTHROPIC_BASE_URL 环境变量".to_string(),
            env.anthropic_base_url.clone().unwrap_or_default(),
        ),
    ];

    rows.into_iter()
        .map(|(name, raw)| {
            if raw.is_empty() {
                return SourceRow {
                    name,
                    raw,
                    why: String::new(),
                };
            }
            match Url::parse(&raw) {
                Ok(u) => {
                    let why = if is_proxy_self(&u, env.port) {
                        "指向本代理自己 (转发给自己 = 死循环), 已跳过".to_string()
                    } else {
                        String::new()
                    };
                    SourceRow { name, raw, why }
                }
                Err(_) => SourceRow {
                    name,
                    raw,
                    why: "URL 格式非法, 无法解析".to_string(),
                },
            }
        })
        .collect()
}

/// First source that is set AND accepted. `None` means no usable upstream.
pub fn resolve_explicit_api_url(env: &Env) -> Option<String> {
    let sources: [Option<String>; 4] = [
        env.target.clone(),
        get_settings_base_url(env),
        load_monitor_state(env).previous_base_url,
        env.anthropic_base_url.clone(),
    ];
    for candidate in sources.into_iter().flatten() {
        if candidate.is_empty() {
            continue;
        }
        if let Ok(u) = Url::parse(&candidate) {
            if !is_proxy_self(&u, env.port) {
                return Some(candidate);
            }
        }
        // invalid URL or self-reference: fall through to the next source
    }
    None
}

/// Where cc points when monitoring is off. `disableMonitoring()` writes this
/// back into settings.json, so it must use the same single priority ladder.
pub fn direct_base_url(env: &Env) -> String {
    resolve_explicit_api_url(env).unwrap_or_else(|| FALLBACK_DIRECT_URL.to_string())
}

/// `None` => monitoring may be enabled. `Some(reason)` => HTTP 400 error text.
/// Distinguishes "nothing configured at all" from "configured but rejected".
pub fn monitor_unavailable_reason(env: &Env) -> Option<String> {
    let report = upstream_source_report(env);
    if report
        .iter()
        .any(|r| !r.raw.is_empty() && r.why.is_empty())
    {
        return None;
    }
    let rejected: Vec<&SourceRow> = report.iter().filter(|r| !r.raw.is_empty()).collect();
    if !rejected.is_empty() {
        let parts: Vec<String> = rejected
            .iter()
            .map(|r| format!("{} {}", r.name, r.why))
            .collect();
        return Some(format!(
            "已配置的上游地址均不可用：{}。请修正该地址后再开启监控。",
            parts.join("；")
        ));
    }
    Some(
        "未配置上游 API 地址（settings.json 的 env.ANTHROPIC_BASE_URL、CC_MONITOR_TARGET、\
         ANTHROPIC_BASE_URL 环境变量均未设置）。请任选其一配置后再开启监控。"
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn unique_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "spike-upstream-{}-{}-{}",
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

    fn env_at(dir: &std::path::Path, port: u16) -> Env {
        Env {
            port,
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

    fn write_settings(env: &Env, value: &str) {
        std::fs::write(
            &env.settings_path,
            format!(r#"{{ "env": {{ "ANTHROPIC_BASE_URL": "{value}" }} }}"#),
        )
        .unwrap();
    }

    fn write_state(env: &Env, value: &str) {
        std::fs::write(
            &env.state_path,
            format!(r#"{{ "previousBaseUrl": "{value}" }}"#),
        )
        .unwrap();
    }

    #[test]
    fn c12a_env_only() {
        let d = unique_dir("c12a");
        let mut env = env_at(&d, 8080);
        env.anthropic_base_url = Some("http://A.example".into());
        assert_eq!(direct_base_url(&env), "http://A.example");
        assert!(monitor_unavailable_reason(&env).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn c12b_target_beats_everything() {
        let d = unique_dir("c12b");
        let mut env = env_at(&d, 8080);
        env.target = Some("http://B.example".into());
        assert_eq!(direct_base_url(&env), "http://B.example");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn c12c_target_beats_env() {
        let d = unique_dir("c12c");
        let mut env = env_at(&d, 8080);
        env.target = Some("http://B.example".into());
        env.anthropic_base_url = Some("http://A.example".into());
        assert_eq!(direct_base_url(&env), "http://B.example");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn c12d_settings_beats_env() {
        let d = unique_dir("c12d");
        let mut env = env_at(&d, 8080);
        env.anthropic_base_url = Some("http://A.example".into());
        write_settings(&env, "http://C.example");
        assert_eq!(direct_base_url(&env), "http://C.example");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn c12e_state_previous_base_url() {
        let d = unique_dir("c12e");
        let env = env_at(&d, 8080);
        write_state(&env, "http://D.example");
        assert_eq!(direct_base_url(&env), "http://D.example");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn c12f_self_reference_is_skipped_and_resolution_continues() {
        let d = unique_dir("c12f");
        let mut env = env_at(&d, 45999);
        env.anthropic_base_url = Some("http://A.example".into());
        write_settings(&env, "http://localhost:45999");
        assert_eq!(direct_base_url(&env), "http://A.example");
        assert!(monitor_unavailable_reason(&env).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn c12g_nothing_configured_falls_back_and_reports_unavailable() {
        let d = unique_dir("c12g");
        let env = env_at(&d, 8080);
        assert_eq!(direct_base_url(&env), FALLBACK_DIRECT_URL);
        let reason = monitor_unavailable_reason(&env).expect("must be unavailable");
        assert!(!reason.is_empty());
        assert!(reason.contains("未配置上游 API 地址"), "got: {reason}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn invalid_url_is_skipped_and_resolution_continues() {
        let d = unique_dir("invalid");
        let mut env = env_at(&d, 8080);
        env.anthropic_base_url = Some("http://A.example".into());
        write_settings(&env, "not a url");
        assert_eq!(direct_base_url(&env), "http://A.example");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn all_configured_but_rejected_reports_the_other_message() {
        let d = unique_dir("rejected");
        let mut env = env_at(&d, 45999);
        env.anthropic_base_url = Some("not a url".into());
        write_settings(&env, "http://localhost:45999");
        let reason = monitor_unavailable_reason(&env).expect("must be unavailable");
        assert!(reason.contains("已配置的上游地址均不可用"), "got: {reason}");
        assert!(reason.contains("CC_MONITOR_TARGET") || reason.contains("ANTHROPIC_BASE_URL"));
        assert_eq!(direct_base_url(&env), FALLBACK_DIRECT_URL);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn loopback_other_port_is_not_self() {
        let d = unique_dir("otherport");
        let mut env = env_at(&d, 8080);
        env.target = Some("http://127.0.0.1:11434".into());
        assert_eq!(direct_base_url(&env), "http://127.0.0.1:11434");
        let u = Url::parse("http://127.0.0.1:11434").unwrap();
        assert!(!is_proxy_self(&u, 8080));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn portless_loopback_is_not_self() {
        // Node `new URL("http://localhost/x").port === ""` -> not equal to "8080".
        let u = Url::parse("http://localhost/v1").unwrap();
        assert!(!is_proxy_self(&u, 8080));
    }
}
