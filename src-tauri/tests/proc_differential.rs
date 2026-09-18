//! `claude` / `terminal`（`ProcBridge` 的 Rust 侧）↔ Node 参考实现的**差分核验** —— Rust 侧半个探针。
//!
//! 为什么需要它：`src-tauri/src/claude.rs` 顶部的「与 迁移前 Electron 壳的 `claudeCli.ts`（已删除） 的 `runProcess`
//! 等价」和「用户可见的错误文案逐字保持不变」都是**读 Node 源码推理出来的**，它的 9 条单测也是照着
//! 这份推理写的（断言的是自己的期望，不是 Node 的真实输出）。本探针把同一批命令同时喂给两个实现，
//! 逐项比**完整结果**（有序 stdout 行序列 + `{ok,error,stderr}` + 超时行为），用来把那条推理换成
//! 独立信息源。形态与 `tests/fs_ops_differential.rs` 完全一致。
//!
//! 形态：**默认忽略**（`#[ignore]`），必须由 `test/tools/proc-differential.mjs` 驱动 ——
//! 那个脚本负责建语料、跑 Node 侧、再把这个测试跑起来并读回 `rust.json`。这样 `cargo test`
//! 基线既不依赖语料目录、也不会因为探针而变慢或被跳过时假装通过（`#[ignore]` 是诚实的「未跑」）。
//!
//! 协议（与 Node 侧共用）：
//!   - 入参：环境变量 `CCSA_PROC_DIFF_DIR` 指向语料目录，其中有 `manifest.json`：
//!     `{ "cases": [ { "id", "func", ... } ] }`，`func` ∈ `run_lines` / `exec_text` /
//!     `spawn_detached` / `default_cwd`
//!   - `path` / `args` / `cwd` / `marker` 里的 `{SIDE}` 由两侧各自替换（`rust` / `node`），
//!     用于「必须分侧落盘/落标记」的用例（写文件、spawn_detached 的 marker）
//!   - 出参：写 `<dir>/rust.json`：`{ "caseCount", "results": [ { "id", "result" } ] }`
//!   - `result`：`run_lines` → `{ok,lines,error,stderr,elapsedMs,probeTimedOut}`；
//!     `exec_text` → `{ok,out,error,invokeError}`；`spawn_detached` → `{ok,error,markerSeen}`；
//!     `default_cwd` → `{ok,value}`
//!
//! **两条必须写下来的探针自身约定**（否则读数会被误读）：
//!   1. `run_lines` 的每个用例在探针侧再套一层 `outer_bound_ms` 硬上限（默认 `timeout_ms + 3000`）。
//!      为什么需要：`run_lines_with` 的**超时只覆盖 stdout 读取**，`stdin.write_all` 在它之前；
//!      若子进程在读完 stdin 前就写满 stdout 管道，双方会互相阻塞 —— 探针必须能**观察到「它没
//!      返回」而不是被它挂死**（`probeTimedOut:true`）。这一层不改变被测函数，只是给观察者一个上限。
//!   2. `label` 缺省时用 `cmd`。这个缺省逻辑在 `#[tauri::command] run_lines` 里
//!      （`label.unwrap_or(cmd)`），本探针按同形复刻 —— 因此**缺省 label 这条不在比较范围内**，
//!      真正被比较的是显式传入的 label（见进度文档的「未覆盖」清单）。

use app_lib::claude::{exec_text, run_lines_with};
use app_lib::fs_ops::home_dir;
use app_lib::terminal::spawn_detached;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const SIDE: &str = "rust";

fn subst(s: &str) -> String {
    s.replace("{SIDE}", SIDE)
}

#[derive(Deserialize)]
struct Manifest {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    id: String,
    func: String,
    #[serde(default)]
    cmd: Option<String>,
    #[serde(default)]
    args: Option<Vec<String>>,
    #[serde(default)]
    stdin_text: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    outer_bound_ms: Option<u64>,
    #[serde(default)]
    exe: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    marker: Option<String>,
    #[serde(default)]
    marker_wait_ms: Option<u64>,
}

async fn wait_marker(path: &Path, ms: u64) -> bool {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        if path.exists() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    path.exists()
}

async fn run_case(c: &Case) -> Value {
    match c.func.as_str() {
        "run_lines" => {
            let cmd = c.cmd.clone().expect("run_lines 需要 cmd");
            let args: Vec<String> = c.args.clone().unwrap_or_default().iter().map(|a| subst(a)).collect();
            let stdin_text = c.stdin_text.clone().unwrap_or_default();
            // 缺省 label 复刻 `#[tauri::command] run_lines` 的 `label.unwrap_or(cmd)`（见文件头约定 2）
            let label = c.label.clone().unwrap_or_else(|| cmd.clone());
            let timeout_ms = c
                .timeout_ms
                .expect("run_lines 需要显式 timeout_ms（默认 180000 会让差分挂 3 分钟，无法在探针里覆盖）");
            let bound = Duration::from_millis(c.outer_bound_ms.unwrap_or(timeout_ms + 3000));

            let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let sink = lines.clone();
            let started = Instant::now();
            let fut = run_lines_with(&cmd, &args, &stdin_text, timeout_ms, &label, move |l| {
                sink.lock().unwrap().push(l)
            });
            let outcome = tokio::time::timeout(bound, fut).await;
            let elapsed_ms = started.elapsed().as_millis() as u64;
            // 可选 marker：超时杀进程用的信号能不能被捕获（SIGTERM 可捕获 / SIGKILL 不能）
            let marker = c.marker.as_ref().map(|m| subst(m));
            let marker_seen = match &marker {
                Some(m) => wait_marker(Path::new(m), c.marker_wait_ms.unwrap_or(0)).await,
                None => false,
            };
            match outcome {
                Ok(out) => json!({
                    "ok": out.ok,
                    "lines": *lines.lock().unwrap(),
                    "error": out.error,
                    "stderr": out.stderr,
                    "elapsedMs": elapsed_ms,
                    "probeTimedOut": false,
                    "markerSeen": marker_seen,
                }),
                Err(_) => json!({
                    "ok": Value::Null,
                    "lines": *lines.lock().unwrap(),
                    "error": Value::Null,
                    "stderr": Value::Null,
                    "elapsedMs": elapsed_ms,
                    "probeTimedOut": true,
                    "markerSeen": marker_seen,
                }),
            }
        }
        "exec_text" => {
            let cmd = c.cmd.clone().expect("exec_text 需要 cmd");
            let args: Vec<String> = c.args.clone().unwrap_or_default().iter().map(|a| subst(a)).collect();
            match exec_text(cmd, args).await {
                Ok(o) => json!({
                    "ok": o.ok,
                    "out": o.out,
                    "error": o.error,
                    "invokeError": Value::Null,
                }),
                // Rust 命令的失败路径是 `Err(String)` → 真实链路上是 invoke **reject**，
                // 而 Node 的 `execText` 永远 resolve `{ok:false,out:'',error}`。这个形状差异必须显形。
                Err(e) => json!({
                    "ok": Value::Null,
                    "out": Value::Null,
                    "error": Value::Null,
                    "invokeError": e,
                }),
            }
        }
        "spawn_detached" => {
            let exe = subst(&c.exe.clone().expect("spawn_detached 需要 exe"));
            let args: Vec<String> = c.args.clone().unwrap_or_default().iter().map(|a| subst(a)).collect();
            let cwd = subst(&c.cwd.clone().expect("spawn_detached 需要 cwd"));
            let marker = c.marker.clone().map(|m| subst(&m));
            let r = spawn_detached(exe, args, cwd).await;
            let marker_seen = match &marker {
                Some(m) => wait_marker(Path::new(m), 2_000).await,
                None => false,
            };
            match r {
                Ok(()) => json!({ "ok": true, "error": Value::Null, "markerSeen": marker_seen }),
                Err(e) => json!({ "ok": false, "error": e, "markerSeen": marker_seen }),
            }
        }
        // `defaultCwd()` 在 Tauri 侧映射到 `home_dir`（见 src/api/procBridgeTauri.ts），
        // 不是 proc 命令；这里记录 Rust 的取值供上层比。
        "default_cwd" => match home_dir() {
            Ok(v) => json!({ "ok": true, "value": v }),
            Err(e) => json!({ "ok": false, "raw": e }),
        },
        other => panic!("manifest 里出现未知 func: {other:?}（不允许静默跳过）"),
    }
}

#[tokio::test]
#[ignore = "差分探针：需 CCSA_PROC_DIFF_DIR 指向语料目录，由 test/tools/proc-differential.mjs 驱动"]
async fn dump_cases() {
    let dir = std::env::var("CCSA_PROC_DIFF_DIR")
        .expect("必须设置 CCSA_PROC_DIFF_DIR 指向含 manifest.json 的语料目录");
    let dir = PathBuf::from(dir);
    let manifest_text = std::fs::read_to_string(dir.join("manifest.json"))
        .expect("读不到 manifest.json —— 请用 test/tools/proc-differential.mjs 驱动本测试");
    let manifest: Manifest = serde_json::from_str(&manifest_text).expect("manifest.json 解析失败");

    let mut results = Vec::with_capacity(manifest.cases.len());
    for c in &manifest.cases {
        results.push(json!({ "id": c.id, "result": run_case(c).await }));
    }

    let dump = json!({ "caseCount": results.len(), "results": results });
    std::fs::write(
        dir.join("rust.json"),
        serde_json::to_string(&dump).expect("序列化 rust.json"),
    )
    .expect("写 rust.json 失败");
    println!(
        "proc_differential: 写出 {} 条用例结果 → {}",
        manifest.cases.len(),
        dir.join("rust.json").display()
    );
}
