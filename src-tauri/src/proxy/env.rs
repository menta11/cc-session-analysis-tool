//! Process environment -> typed config, mirroring
//! `vendor/cc-monitor/shared/config.js` (env override) plus proxy.js's
//! `~/.claude` path constants.

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Env {
    /// `CC_MONITOR_PORT` (config.js default 8080 when unset).
    pub port: u16,
    /// `CC_MONITOR_TARGET` — highest priority upstream escape hatch.
    pub target: Option<String>,
    /// `ANTHROPIC_BASE_URL` — lowest priority upstream source.
    pub anthropic_base_url: Option<String>,
    /// `CC_MONITOR_LOOP_BYPASS=1` allows a loopback upstream (test mode).
    pub loop_bypass: bool,
    /// `HOME` — honoured explicitly (never a passwd lookup) so tests sandbox it.
    pub home: PathBuf,
    pub settings_path: PathBuf,
    pub state_path: PathBuf,
    /// `CC_MONITOR_DEBUG=0` disables debug dumps (advisory only in this spike).
    pub debug: bool,
    /// `CC_MONITOR_LOG_DIR` —— 请求日志目录（`proxy.js:35` 的 `LOG_DIR`）。
    ///
    /// **已不是 advisory**：`proxy/log.rs` 真的按它落盘 `proxy.log`。
    /// 应用入口（`lib.rs`）注入 `app_data_dir()/logs`（= Electron 的 userData/logs）；
    /// 独立进程入口不注入，于是按 Node 的 `||` 语义回落到 `cwd/logs`（**不是**不写盘）。
    /// 解析用 JS 语义：**只有空串**是 falsy，空白串照 Node 原样保留当目录名。
    pub log_dir: Option<String>,
}

impl Env {
    pub fn from_process() -> Result<Env, String> {
        Env::from_process_with_default(None)
    }

    /// `default_port`：`CC_MONITOR_PORT` **未设置**时的兜底。
    /// - 独立 bin（契约测试驱动）传 `None` → 8080，与 spike 行为一致；
    /// - Tauri 应用传 `config_port()`（读自与 Electron 共用的 config.json）→ 两侧同值。
    /// 环境变量始终优先，所以契约测试的沙箱不受影响。
    pub fn from_process_with_default(default_port: Option<u16>) -> Result<Env, String> {
        let port = match non_empty(std::env::var("CC_MONITOR_PORT").ok()) {
            Some(raw) => raw
                .trim()
                .parse::<u16>()
                .map_err(|e| format!("invalid CC_MONITOR_PORT={raw:?}: {e}"))?,
            None => default_port.unwrap_or(8080),
        };
        let home = non_empty(std::env::var("HOME").ok())
            .or_else(|| non_empty(std::env::var("USERPROFILE").ok()))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"));
        let settings_path = home.join(".claude").join("settings.json");
        let state_path = home.join(".claude").join("cc-monitor-state.json");
        Ok(Env {
            port,
            target: non_empty(std::env::var("CC_MONITOR_TARGET").ok()),
            anthropic_base_url: non_empty(std::env::var("ANTHROPIC_BASE_URL").ok()),
            loop_bypass: std::env::var("CC_MONITOR_LOOP_BYPASS").ok().as_deref() == Some("1"),
            home,
            settings_path,
            state_path,
            debug: std::env::var("CC_MONITOR_DEBUG").ok().as_deref() != Some("0"),
            // 刻意不用 `non_empty`：JS 的 `||` 只把**空串**当 falsy，而 `non_empty` 会把
            // 空白串也丢掉 —— 那样 `CC_MONITOR_LOG_DIR="   "` 会从「Node 创建一个名为
            // 三个空格的目录」变成「回落到 cwd/logs」，是可观测的语义漂移。
            log_dir: parse_log_dir(std::env::var("CC_MONITOR_LOG_DIR").ok()),
        })
    }

    /// `http://localhost:<port>` — the value written into settings.json while
    /// monitoring is on, and the self-reference we must never forward to.
    pub fn proxy_base_url(&self) -> String {
        format!("http://localhost:{}", self.port)
    }
}

fn non_empty(v: Option<String>) -> Option<String> {
    match v {
        Some(s) if !s.trim().is_empty() => Some(s),
        _ => None,
    }
}

/// `CC_MONITOR_LOG_DIR` 的 JS `||` 语义（`proxy.js:35`）：**只有空串**算 falsy，
/// 于是 `None` 或空串都由调用方回落到 `cwd/logs`；空白串是 truthy，原样保留。
/// 抽成纯函数以便单测 —— 直接改进程环境变量会在并行测试间互相干扰。
fn parse_log_dir(raw: Option<String>) -> Option<String> {
    raw.filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 未设置 / 空串 = 未设置（会被 `proxy/log.rs` 回落到 `cwd/logs`）。
    #[test]
    fn log_dir_unset_or_empty_is_none() {
        assert_eq!(parse_log_dir(None), None);
        assert_eq!(parse_log_dir(Some(String::new())), None);
    }

    /// 空白串在 JS 里是 **truthy**（`'   ' || x` === `'   '`），必须原样保留 ——
    /// 若用 `non_empty` 就会被吞掉，是可观测的语义漂移。
    #[test]
    fn log_dir_whitespace_is_preserved_like_js() {
        assert_eq!(parse_log_dir(Some("   ".to_string())), Some("   ".to_string()));
        assert_eq!(
            parse_log_dir(Some(" /tmp/x ".to_string())),
            Some(" /tmp/x ".to_string())
        );
    }
}
