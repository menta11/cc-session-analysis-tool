//! 请求日志落盘 —— `proxy.js` 第 31–51 行 `logLine` 的移植。
//!
//! ## Node 侧的事实（逐行核对 `vendor/cc-monitor/proxy.js`，不靠猜）
//!
//! - `LOG_DIR = process.env.CC_MONITOR_LOG_DIR || path.join(process.cwd(), 'logs')`
//!   （第 35 行，模块加载时求值一次）；
//! - `LOG_FILE = path.join(LOG_DIR, 'proxy.log')`（第 36 行）；
//! - `logLine(msg)`（第 38–51 行）：行格式 `` `[${new Date().toISOString()}] ${msg}` ``，
//!   **先 `console.log(line)` 再** `fs.mkdirSync(LOG_DIR, { recursive: true })` +
//!   `fs.appendFileSync(LOG_FILE, line + '\n')`；
//! - 唯一调用点（第 1385 行，`http.createServer` 回调第一行）：
//!   `if (isLLMRequest(req)) logLine('get到一条请求')` —— 即**只有** POST 且 url 含
//!   `/v1/messages` / `/chat/completions` / `/completions` 的请求才落盘，每请求一行。
//!   （`_log(tag, msg, cid)` 是另一个函数，只 `console.log`、**不落盘**，不要接错。）
//! - **没有任何轮转 / 截断**：全文只有这一处写 `LOG_FILE`，且只有 `appendFileSync`，
//!   从不 rename / truncate / unlink。所以「按大小轮转」在 Node 里**不存在**，本实现也不做 ——
//!   加轮转反而会让文件内容与 Electron 版不可比。
//! - **没有「关闭日志」的开关**：`CC_MONITOR_LOG_DIR` 未设置时**依然写**，只是目录回落
//!   `cwd/logs`。所以「未设置 = 不写盘」是错的（用一条单测把这个语义钉住）。
//! - 写盘失败只警告**一次**（Node 的 `logWriteWarned`），且**绝不打断**请求转发。
//!
//! ## 目录由宿主注入，不自己判断打包状态
//!
//! Node 的宿主（`monitorHost.ts:17-19`）把 `CC_MONITOR_LOG_DIR` 指向
//! `app.getPath('userData')/logs`（dev 为 `<cwd>/logs`）。Rust 侧同样：应用入口（`lib.rs`）
//! 注入 `app_data_dir()/logs`（`app_data_dir()` 就是 Tauri/OS 侧与 Electron userData 对应的
//! 每用户应用数据目录：macOS `~/Library/Application Support/<identifier>`、
//! Linux `$XDG_DATA_HOME/<identifier>`、Windows `%APPDATA%\<identifier>`）；
//! 独立进程入口（`proxy-standalone`，契约测试驱动）不注入，于是走 Node 的 `cwd/logs` 回落。
//!
//! ## 为什么是「可注入的实例」而不是全局单例
//!
//! 代理是并发的（tokio），但本项目一贯的做法是把这种边界做成**显式注入**的结构
//! （`fsBridge` / `procBridge` 同理）：`ProxyLog` 挂在 `AppState` 上，路径与写入器都能在
//! 单测里指向临时目录，不碰进程级全局；内部用一个 `Mutex` 串行化「打开→追加→关闭」，
//! 保证并发请求的行不会交叉。时间戳与行格式抽成纯函数，可脱离文件系统单测。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// 唯一会落盘的消息 —— `proxy.js:1385` 的字面量，照抄不译。
pub const LLM_REQUEST_MESSAGE: &str = "get到一条请求";

/// 固定文件名（`proxy.js:36`）。
const LOG_FILE_NAME: &str = "proxy.log";

/// `process.env.CC_MONITOR_LOG_DIR || path.join(process.cwd(), 'logs')`。
///
/// 严格按 JS `||` 的语义：**只有空串**是 falsy，显式给空串时同样回落到 `cwd/logs`。
/// （`"   "` 在 JS 里是 truthy，会原样当目录名用；这里也照抄 —— 只判 `is_empty`，不 trim。）
pub fn resolve_log_dir(explicit: Option<&str>, cwd: &Path) -> PathBuf {
    match explicit {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => cwd.join("logs"),
    }
}

/// `new Date().toISOString()` 的等价物：UTC、毫秒固定 3 位零填充、总长 24 字符。
///
/// Node 的 `toISOString()` 输出形如 `2026-09-11T13:25:50.687Z`（仓库 `logs/proxy.log`
/// 的实际两行即此格式）。用 Howard Hinnant 的 civil-from-days 算法，不引时间库。
pub fn iso8601_utc_millis(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let (hh, mm, ss) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

/// days since 1970-01-01 → (year, month, day)，全部为 UTC。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    // 把纪元平移到 0000-03-01，让闰日落在年末，从而消掉逐月判断。
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]，0 = March
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `logLine(msg)` 的整行文本（不含换行）：`[{iso}] {msg}`。
pub fn format_line(ms: i64, msg: &str) -> String {
    format!("[{}] {}", iso8601_utc_millis(ms), msg)
}

/// 请求日志写入器：目录 + `proxy.log` + 「只警告一次」标志 + 串行化锁。
pub struct ProxyLog {
    dir: PathBuf,
    file: PathBuf,
    /// Node 的 `logWriteWarned`：写盘失败只提示一次（全静默会让人以为日志功能没生效）。
    warned: AtomicBool,
    /// 串行化「打开 → 追加 → 关闭」。Node 是单线程 `appendFileSync` 所以天然串行；
    /// tokio 下多个请求可能同时到达，此处显式串行以免行与行交叉。
    lock: Mutex<()>,
}

impl ProxyLog {
    /// 用显式目录构造（`cwd/logs` 的回落已完成）。
    pub fn new(dir: PathBuf) -> ProxyLog {
        let file = dir.join(LOG_FILE_NAME);
        ProxyLog {
            dir,
            file,
            warned: AtomicBool::new(false),
            lock: Mutex::new(()),
        }
    }

    /// 按 `CC_MONITOR_LOG_DIR` + 进程 cwd 解析目录（与 Node 的模块级求值同义）。
    pub fn from_env(explicit: Option<&str>) -> ProxyLog {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        ProxyLog::new(resolve_log_dir(explicit, &cwd))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    /// 是否已经因为写盘失败警告过（Node 的 `logWriteWarned`，供测试断言）。
    pub fn warned(&self) -> bool {
        self.warned.load(Ordering::SeqCst)
    }

    /// `mkdirSync(recursive) + appendFileSync(line + '\n')`。失败原样返回错误，不打印。
    pub fn append_line(&self, line: &str) -> Result<(), String> {
        // 锁中毒也照样继续：写一行日志不值得让整个进程 panic。
        let _guard = match self.lock.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        // 目录**惰性创建**（Node 也是每次写之前 mkdirSync(recursive:true)，不是启动时建）。
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let mut payload = String::with_capacity(line.len() + 1);
        payload.push_str(line);
        payload.push('\n');
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file)
            .map_err(|e| e.to_string())?;
        f.write_all(payload.as_bytes()).map_err(|e| e.to_string())
    }

    /// `logLine(msg)`：终端 + 落盘；落盘失败只警告一次，绝不向外传播错误。
    pub fn line(&self, msg: &str) {
        let line = format_line(crate::proxy::capture::now_ms(), msg);
        // Node 是先 console.log 再 append：终端输出不受写盘失败影响。
        println!("{line}");
        if let Err(e) = self.append_line(&line) {
            if !self.warned.swap(true, Ordering::SeqCst) {
                eprintln!(
                    "[log] 落盘失败, 仅终端输出: {} — {e}",
                    self.file.display()
                );
            }
        }
    }

    /// `if (isLLMRequest(req)) logLine('get到一条请求')` —— 唯一落盘的消息。
    pub fn llm_request(&self) {
        self.line(LLM_REQUEST_MESSAGE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "spike-proxy-log-{}-{}-{}",
            std::process::id(),
            tag,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    // ── 目录解析（纯函数） ────────────────────────────────────────────────

    /// 显式设置了就用它，文件名固定为 `proxy.log`。
    #[test]
    fn explicit_dir_is_used_verbatim() {
        let log = ProxyLog::new(resolve_log_dir(Some("/tmp/x/logs"), Path::new("/somewhere")));
        assert_eq!(log.dir(), Path::new("/tmp/x/logs"));
        assert_eq!(log.file(), Path::new("/tmp/x/logs/proxy.log"));
    }

    /// ⚠️ 这条是 Node 语义的关键：**未设置时不是"不写"，而是回落到 cwd/logs**。
    #[test]
    fn unset_dir_falls_back_to_cwd_logs() {
        let log = ProxyLog::new(resolve_log_dir(None, Path::new("/work/app")));
        assert_eq!(log.file(), Path::new("/work/app/logs/proxy.log"));
    }

    /// JS 的 `||` 只把**空串**当 falsy；显式空串同样回落（Node 里 `'' || x` === `x`）。
    #[test]
    fn empty_string_dir_falls_back_like_js_or() {
        assert_eq!(
            resolve_log_dir(Some(""), Path::new("/work/app")),
            Path::new("/work/app/logs")
        );
        // 空白串在 JS 里是 truthy，原样当目录名（不 trim）—— 这里同样照抄。
        assert_eq!(
            resolve_log_dir(Some("   "), Path::new("/work/app")),
            Path::new("   ")
        );
    }

    // ── 时间戳 / 行格式（纯函数） ────────────────────────────────────────

    /// 与 `new Date(...).toISOString()` 逐字符对齐，含仓库 `logs/proxy.log` 里那行 2026-09-11 的真实值。
    #[test]
    fn iso8601_matches_js_toisostring() {
        assert_eq!(iso8601_utc_millis(0), "1970-01-01T00:00:00.000Z");
        // 仓库 logs/proxy.log 第一行的时间戳（2026-09-11T13:25:50.687Z）—— 现场算出的 epoch。
        assert_eq!(iso8601_utc_millis(1_789_133_150_687), "2026-09-11T13:25:50.687Z");
        assert_eq!(iso8601_utc_millis(1_798_761_599_999), "2026-12-31T23:59:59.999Z");
        // 毫秒必须零填充到 3 位（Node 的 toISOString 永远 3 位）。
        assert_eq!(iso8601_utc_millis(1_000), "1970-01-01T00:00:01.000Z");
        assert_eq!(iso8601_utc_millis(1_007), "1970-01-01T00:00:01.007Z");
        // 闰年 2 月 29 日 —— civil-from-days 的经典边界。
        assert_eq!(iso8601_utc_millis(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
    }

    /// 行格式 = `[iso] msg`，`msg` 为 Node 的字面量。
    #[test]
    fn line_format_is_bracketed_iso_then_message() {
        assert_eq!(
            format_line(0, LLM_REQUEST_MESSAGE),
            "[1970-01-01T00:00:00.000Z] get到一条请求"
        );
        assert_eq!(LLM_REQUEST_MESSAGE, "get到一条请求");
    }

    // ── 写入行为（真文件系统，临时目录） ────────────────────────────────

    /// 目录**惰性创建**（不是构造时建），写一行后文件里恰好是格式化后的那一行 + `\n`。
    #[test]
    fn creates_dir_lazily_and_appends_one_line() {
        let d = unique_dir("lazy");
        let dir = d.join("nested").join("logs");
        assert!(!dir.exists(), "构造前不应有目录");
        let log = ProxyLog::new(dir.clone());
        assert!(!dir.exists(), "构造 ProxyLog 本身不应建目录（Node 是写之前才 mkdirSync）");

        log.append_line(&format_line(0, LLM_REQUEST_MESSAGE)).unwrap();
        assert!(dir.exists(), "写入时才创建目录");
        assert_eq!(
            std::fs::read_to_string(log.file()).unwrap(),
            "[1970-01-01T00:00:00.000Z] get到一条请求\n"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    /// **追加而非截断**：预置一行老内容，写新行后老内容原样保留（Node 的 appendFileSync）。
    #[test]
    fn appends_and_never_truncates() {
        let d = unique_dir("append");
        let log = ProxyLog::new(d.join("logs"));
        // 目录是惰性创建的，预置老内容前先手动建（模拟 Electron 迁移前留下的那个文件）。
        std::fs::create_dir_all(log.dir()).unwrap();
        std::fs::write(log.file(), "[2026-09-11T13:25:50.687Z] get到一条请求\n").unwrap();

        log.append_line(&format_line(1_000, LLM_REQUEST_MESSAGE)).unwrap();
        log.append_line(&format_line(2_000, LLM_REQUEST_MESSAGE)).unwrap();

        let text = std::fs::read_to_string(log.file()).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3, "老行必须保留（追加语义）: {text:?}");
        assert_eq!(lines[0], "[2026-09-11T13:25:50.687Z] get到一条请求");
        assert_eq!(lines[1], "[1970-01-01T00:00:01.000Z] get到一条请求");
        assert_eq!(lines[2], "[1970-01-01T00:00:02.000Z] get到一条请求");
        assert!(text.ends_with('\n'), "每行以 \\n 收尾");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// `llm_request()` 走完整路径（含 `println!` 终端输出），落盘内容与 Node 同形。
    /// 用正则而不是固定时间戳断言，因为时间戳来自真实时钟。
    #[test]
    fn llm_request_writes_a_js_shaped_line() {
        let d = unique_dir("llm");
        let log = ProxyLog::new(d.join("logs"));
        log.llm_request();
        log.llm_request();

        let text = std::fs::read_to_string(log.file()).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        let re = regex::Regex::new(
            r"^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] get到一条请求$",
        )
        .unwrap();
        for l in &lines {
            assert!(re.is_match(l), "行格式必须与 Node 一致: {l:?}");
        }
        assert!(!log.warned(), "正常写入不应触发警告");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 写盘失败**不 panic**、返回 Err，并把「只警告一次」的标志翻起来（Node 的 `logWriteWarned`）。
    /// 制造失败的手法：让日志目录的父路径是一个**普通文件**，`create_dir_all` 必然失败。
    #[test]
    fn write_failure_is_reported_not_fatal_and_warns_once() {
        let d = unique_dir("fail");
        let blocker = d.join("blocker");
        std::fs::write(&blocker, "not a directory").unwrap();

        let log = ProxyLog::new(blocker.join("logs"));
        let err = log.append_line("[x] y").unwrap_err();
        assert!(!err.is_empty(), "失败要带回原因");
        assert!(!log.warned(), "只有 line() 才负责警告"); 

        // 走完整的 line()：不 panic，且只置位一次。
        log.line(LLM_REQUEST_MESSAGE);
        assert!(log.warned(), "写盘失败后必须置位 warned（Node 的 logWriteWarned）");
        log.line(LLM_REQUEST_MESSAGE);
        assert!(log.warned(), "第二次仍然只是 true（不重复警告）");
        // 文件没有被创建，也没有把拦截用的普通文件破坏掉。
        assert_eq!(std::fs::read_to_string(&blocker).unwrap(), "not a directory");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 并发写入：多线程各写多行，行数必须精确等于写入次数，且每行都是完整的一行
    /// （没有交叉、没有半行 —— 靠的是内部 Mutex 串行化）。
    #[test]
    fn concurrent_writes_do_not_interleave() {
        let d = unique_dir("concurrent");
        let log = std::sync::Arc::new(ProxyLog::new(d.join("logs")));
        let threads = 8;
        let per_thread = 50;

        let mut handles = Vec::new();
        for t in 0..threads {
            let log = std::sync::Arc::clone(&log);
            handles.push(std::thread::spawn(move || {
                for i in 0..per_thread {
                    log.append_line(&format_line((t * 1000 + i) as i64, LLM_REQUEST_MESSAGE))
                        .unwrap();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        let text = std::fs::read_to_string(log.file()).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), threads * per_thread);
        let re = regex::Regex::new(
            r"^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] get到一条请求$",
        )
        .unwrap();
        assert!(lines.iter().all(|l| re.is_match(l)), "存在被写坏/交叉的行");
        assert!(!log.warned());
        let _ = std::fs::remove_dir_all(&d);
    }
}
