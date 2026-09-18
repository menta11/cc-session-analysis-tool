//! `~/.claude/settings.json` ANTHROPIC_BASE_URL management, ported from proxy.js
//! plus `getBaseUrlStatus()` / `enableMonitoring()` / `disableMonitoring()` /
//! `restoreBaseUrlIfStale()`.
//!
//! The rewrite is a **targeted string replacement of the JSON string value**:
//! everything else in the file (indentation, key order, raw text) is preserved
//! byte-for-byte. The JSON is never re-serialized. The value is located with the
//! Node-equivalent regex `/("ANTHROPIC_BASE_URL"\s*:\s*")([^"]*)(")/`, the key's
//! presence is validated first, and only the first match is replaced. `\` and `"`
//! in the new value are escaped before substitution.

use std::fs;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::proxy::env::Env;
use crate::proxy::safe_write::with_safe_settings_write;
use crate::proxy::state::{load_monitor_state, save_monitor_state};
use crate::proxy::upstream::{direct_base_url, monitor_unavailable_reason};

fn baseurl_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"("ANTHROPIC_BASE_URL"\s*:\s*")([^"]*)(")"#).expect("BASEURL_RE")
    })
}

/// Current value of `env.ANTHROPIC_BASE_URL` in settings.json, or `None` when the
/// file is missing/unreadable or the key is absent. Never panics.
pub fn get_settings_base_url(env: &Env) -> Option<String> {
    let text = fs::read_to_string(&env.settings_path).ok()?;
    let caps = baseurl_re().captures(&text)?;
    caps.get(2).map(|m| m.as_str().to_string())
}

/// Rewrite only the ANTHROPIC_BASE_URL string value through the four gates.
pub fn set_settings_base_url(env: &Env, new_value: &str) -> Result<(), String> {
    // Escape backslash then quote, exactly like the Node reference.
    let safe = new_value.replace('\\', "\\\\").replace('"', "\\\"");
    let re = baseurl_re();
    // Contract C13d requires the HTTP 400 error text to contain
    // `ANTHROPIC_BASE_URL`. Node surfaces a raw ENOENT when the file is missing
    // (only the key-absent case names the key); we normalise an unreadable file to
    // the same key-naming shape so the assertion holds under either reading.
    if let Err(e) = fs::metadata(&env.settings_path) {
        return Err(format!(
            "ANTHROPIC_BASE_URL key not found in settings.json ({}: {e})",
            env.settings_path.display()
        ));
    }
    with_safe_settings_write(
        &env.settings_path,
        move |text: &str| {
            if !re.is_match(text) {
                return Err("ANTHROPIC_BASE_URL key not found in settings.json".to_string());
            }
            // Non-global replacement: only the first occurrence (JS String.replace).
            Ok(re
                .replace(text, |caps: &regex::Captures| {
                    format!("{}{}{}", &caps[1], safe, &caps[3])
                })
                .into_owned())
        },
        None,
    )
}

/// CONTRACT §2 `GET /config/baseurl` payload — identical key names and types.
pub fn get_base_url_status(env: &Env) -> Value {
    let current = get_settings_base_url(env);
    let state = load_monitor_state(env);
    let reason = monitor_unavailable_reason(env);
    let proxy_base = env.proxy_base_url();
    let direct = direct_base_url(env);

    // cc's original base url: the pre-enable value, but never the proxy itself
    // (a crash-residue settings.json still pointing at the proxy must not be
    // advertised as "cc's original URL").
    let original_url = match &state.previous_base_url {
        Some(p) => p.clone(),
        None => match &current {
            Some(c) if *c != proxy_base => c.clone(),
            _ => direct.clone(),
        },
    };

    json!({
        "monitoring": current.as_deref() == Some(proxy_base.as_str()),
        "current": current,
        "previous": state.previous_base_url,
        "originalUrl": original_url,
        "proxyUrl": proxy_base,
        "directUrl": direct,
        "settingsPath": env.settings_path.to_string_lossy(),
        "settingsKey": "env.ANTHROPIC_BASE_URL",
        "available": reason.is_none(),
        "availableReason": reason,
    })
}

/// Enable monitoring: point settings.json at the proxy, remembering the prior
/// value in state.json. Idempotent when already enabled.
pub fn enable_monitoring(env: &Env) -> Result<Value, String> {
    if let Some(reason) = monitor_unavailable_reason(env) {
        return Err(reason);
    }
    let current = get_settings_base_url(env);
    let proxy_base = env.proxy_base_url();

    let mut patch = Map::new();
    patch.insert("userDisabled".to_string(), Value::Bool(false));
    if current.as_deref() != Some(proxy_base.as_str()) {
        // Remember the pre-enable value (may legitimately be null = key absent).
        patch.insert(
            "previousBaseUrl".to_string(),
            current.clone().map(Value::String).unwrap_or(Value::Null),
        );
        // Throws when the key is absent -> HTTP 400 with ANTHROPIC_BASE_URL in it.
        set_settings_base_url(env, &proxy_base)?;
    }
    save_monitor_state(env, patch);
    Ok(get_base_url_status(env))
}

/// Disable monitoring: restore previousBaseUrl (or the direct URL) and clear it.
pub fn disable_monitoring(env: &Env) -> Result<Value, String> {
    let target = load_monitor_state(env)
        .previous_base_url
        .unwrap_or_else(|| direct_base_url(env));
    set_settings_base_url(env, &target)?;

    let mut patch = Map::new();
    patch.insert("previousBaseUrl".to_string(), Value::Null);
    patch.insert("userDisabled".to_string(), Value::Bool(true));
    save_monitor_state(env, patch);
    Ok(get_base_url_status(env))
}

/// Startup/exit self-heal: only when settings.json currently points at this proxy
/// AND state.json remembers a prior value. Returns the restored value.
///
/// NOTE: `proxy.js` does not call this at module load — `monitorHost.ts` calls it
/// on startup and on exit. This spike exposes and tests it but does not invoke it
/// at startup, so it cannot perturb the contract fixtures.
#[allow(dead_code)]
pub fn restore_base_url_if_stale(env: &Env) -> Result<Option<String>, String> {
    let current = get_settings_base_url(env);
    let state = load_monitor_state(env);
    let proxy_base = env.proxy_base_url();
    if current.as_deref() == Some(proxy_base.as_str()) {
        if let Some(previous) = state.previous_base_url {
            set_settings_base_url(env, &previous)?;
            let mut patch = Map::new();
            patch.insert("previousBaseUrl".to_string(), Value::Null);
            save_monitor_state(env, patch);
            return Ok(Some(previous));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn unique_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "spike-settings-{}-{}-{}",
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
            target: Some("http://upstream.example".into()),
            anthropic_base_url: None,
            loop_bypass: true,
            home: dir.to_path_buf(),
            settings_path: dir.join("settings.json"),
            state_path: dir.join("cc-monitor-state.json"),
            debug: false,
            log_dir: None,
        }
    }

    /// A realistic settings.json: indentation, other keys, trailing newline.
    const REALISTIC: &str = "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \"https://relay.example.com/api\",\n    \"ANTHROPIC_AUTH_TOKEN\": \"sk-keep-me\"\n  },\n  \"permissions\": {\n    \"allow\": [\"Bash\"]\n  }\n}\n";

    #[test]
    fn get_settings_base_url_extracts_value() {
        let d = unique_dir("get");
        let env = env_at(&d, 1234);
        fs::write(&env.settings_path, REALISTIC).unwrap();
        assert_eq!(
            get_settings_base_url(&env).as_deref(),
            Some("https://relay.example.com/api")
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_key_is_none() {
        let d = unique_dir("nokey");
        let env = env_at(&d, 1234);
        fs::write(&env.settings_path, r#"{ "env": { "OTHER": "1" } }"#).unwrap();
        assert_eq!(get_settings_base_url(&env), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// C13a byte-level: only the value span changes; a .bak appears with the
    /// pre-change text; the token and indentation are untouched.
    #[test]
    fn set_settings_base_url_changes_only_the_value_bytes() {
        let d = unique_dir("rewrite");
        let env = env_at(&d, 1234);
        fs::write(&env.settings_path, REALISTIC).unwrap();

        set_settings_base_url(&env, "http://localhost:1234").unwrap();

        let after = fs::read_to_string(&env.settings_path).unwrap();
        assert_eq!(
            after,
            "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \"http://localhost:1234\",\n    \"ANTHROPIC_AUTH_TOKEN\": \"sk-keep-me\"\n  },\n  \"permissions\": {\n    \"allow\": [\"Bash\"]\n  }\n}\n"
        );
        assert_eq!(
            fs::read_to_string(format!("{}.bak", env.settings_path.display())).unwrap(),
            REALISTIC
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_key_errors_with_key_name_and_writes_nothing() {
        let d = unique_dir("missingkey");
        let env = env_at(&d, 1234);
        fs::write(&env.settings_path, r#"{ "env": { "OTHER": "1" } }"#).unwrap();
        let err = set_settings_base_url(&env, "http://localhost:1234").unwrap_err();
        assert!(err.contains("ANTHROPIC_BASE_URL"), "got: {err}");
        assert_eq!(
            fs::read_to_string(&env.settings_path).unwrap(),
            r#"{ "env": { "OTHER": "1" } }"#
        );
        assert!(!PathBuf::from(format!("{}.bak", env.settings_path.display())).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Enable stores previousBaseUrl and flips monitoring; disable restores it.
    #[test]
    fn enable_then_disable_round_trips() {
        let d = unique_dir("toggle");
        let env = env_at(&d, 1234);
        fs::write(&env.settings_path, REALISTIC).unwrap();

        let st = enable_monitoring(&env).unwrap();
        assert_eq!(st.get("monitoring").unwrap().as_bool(), Some(true));
        assert_eq!(
            st.get("current").unwrap().as_str(),
            Some("http://localhost:1234")
        );
        assert_eq!(
            st.get("previous").unwrap().as_str(),
            Some("https://relay.example.com/api")
        );
        assert_eq!(st.get("directUrl").unwrap().as_str(), Some("http://upstream.example"));
        assert_eq!(st.get("available").unwrap().as_bool(), Some(true));
        assert!(st.get("availableReason").unwrap().is_null());

        // C13b: repeat enable is idempotent, .bak unchanged.
        let bak = format!("{}.bak", env.settings_path.display());
        let bak_before = fs::read_to_string(&bak).unwrap();
        enable_monitoring(&env).unwrap();
        assert_eq!(fs::read_to_string(&bak).unwrap(), bak_before);
        assert!(fs::read_to_string(&env.settings_path)
            .unwrap()
            .contains("\"ANTHROPIC_BASE_URL\": \"http://localhost:1234\""));

        let st = disable_monitoring(&env).unwrap();
        assert_eq!(st.get("monitoring").unwrap().as_bool(), Some(false));
        assert_eq!(
            st.get("current").unwrap().as_str(),
            Some("https://relay.example.com/api")
        );
        assert!(st.get("previous").unwrap().is_null());
        assert_eq!(fs::read_to_string(&bak).unwrap(), bak_before, "C14: .bak never overwritten");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// C13d: no key -> enable returns an error mentioning ANTHROPIC_BASE_URL.
    #[test]
    fn enable_without_key_is_an_error() {
        let d = unique_dir("enable-nokey");
        let env = env_at(&d, 1234);
        fs::write(&env.settings_path, r#"{ "env": { "OTHER": "1" } }"#).unwrap();
        let err = enable_monitoring(&env).unwrap_err();
        assert!(err.contains("ANTHROPIC_BASE_URL"), "got: {err}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// C13d robustness: even a completely missing settings.json must produce a
    /// 400-able error that names ANTHROPIC_BASE_URL, and must not create files.
    #[test]
    fn enable_with_missing_settings_file_names_the_key() {
        let d = unique_dir("enable-nofile");
        let env = env_at(&d, 1234);
        assert!(!env.settings_path.exists());
        let err = enable_monitoring(&env).unwrap_err();
        assert!(err.contains("ANTHROPIC_BASE_URL"), "got: {err}");
        assert!(!env.settings_path.exists(), "must not create settings.json");
        assert!(!PathBuf::from(format!("{}.bak", env.settings_path.display())).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// C12g + §2: nothing configured -> available=false with a non-empty reason.
    #[test]
    fn status_unavailable_when_no_upstream() {
        let d = unique_dir("status-unavail");
        let mut env = env_at(&d, 1234);
        env.target = None;
        // A settings.json that exists but carries no ANTHROPIC_BASE_URL key.
        fs::write(&env.settings_path, r#"{ "env": { "OTHER": "1" } }"#).unwrap();
        let st = get_base_url_status(&env);
        assert_eq!(st.get("available").unwrap().as_bool(), Some(false));
        assert!(st.get("availableReason").unwrap().as_str().unwrap().len() > 0);
        assert_eq!(
            st.get("directUrl").unwrap().as_str(),
            Some("https://api.anthropic.com")
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    /// `originalUrl` must not surface the proxy address as "cc's original URL".
    #[test]
    fn original_url_excludes_proxy_address_on_crash_residue() {
        let d = unique_dir("original");
        let env = env_at(&d, 1234);
        fs::write(&env.settings_path, REALISTIC).unwrap();
        fs::write(
            &env.settings_path,
            REALISTIC.replace("https://relay.example.com/api", "http://localhost:1234"),
        )
        .unwrap();
        let st = get_base_url_status(&env);
        assert_eq!(st.get("monitoring").unwrap().as_bool(), Some(true));
        assert_eq!(
            st.get("originalUrl").unwrap().as_str(),
            Some("http://upstream.example")
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn stale_restore_only_when_pointing_at_proxy_with_previous() {
        let d = unique_dir("stale");
        let env = env_at(&d, 1234);
        fs::write(&env.settings_path, REALISTIC).unwrap();
        // Not pointing at the proxy -> no-op.
        assert_eq!(restore_base_url_if_stale(&env).unwrap(), None);
        assert!(fs::read_to_string(&env.settings_path).unwrap().contains("relay.example.com"));

        // Point at proxy + previousBaseUrl set -> restore.
        fs::write(
            &env.settings_path,
            REALISTIC.replace("https://relay.example.com/api", "http://localhost:1234"),
        )
        .unwrap();
        let mut patch = Map::new();
        patch.insert("previousBaseUrl".to_string(), Value::String("https://relay.example.com/api".into()));
        save_monitor_state(&env, patch);
        assert_eq!(
            restore_base_url_if_stale(&env).unwrap().as_deref(),
            Some("https://relay.example.com/api")
        );
        assert!(fs::read_to_string(&env.settings_path).unwrap().contains("relay.example.com"));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Values containing `"` or `\` must be escaped so the file stays valid JSON.
    #[test]
    fn value_is_escaped_before_substitution() {
        let d = unique_dir("escape");
        let env = env_at(&d, 1234);
        fs::write(&env.settings_path, REALISTIC).unwrap();
        set_settings_base_url(&env, "http://x/\"quoted\"\\path").unwrap();
        let after = fs::read_to_string(&env.settings_path).unwrap();
        let parsed: Value = serde_json::from_str(&after).unwrap();
        assert_eq!(
            parsed["env"]["ANTHROPIC_BASE_URL"].as_str(),
            Some("http://x/\"quoted\"\\path")
        );
        assert!(after.contains(r#"http://x/\"quoted\"\\path"#));
        let _ = std::fs::remove_dir_all(&d);
    }
}
