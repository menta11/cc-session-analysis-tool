//! 独立进程入口 —— **只给契约测试用**（`test/proxy-contract/` 会 spawn 它，再用 HTTP 驱动）。
//!
//! 为什么要单独留一个 bin：契约测试的设计是「spawn 一个进程 + 轮询 `/status` 做就绪探测」，
//! 嵌在 Tauri 应用里就没法这样驱动。这也是它不叫 `main` 的原因 —— 应用的 `main` 是 Tauri 窗口。
//!
//! 关键点：它和 `lib.rs` 里应用内启动走的是**同一份实现**
//! （`proxy::run_standalone` 与 `proxy::start_background` 都经 `build_state` + `router`），
//! 所以「契约测试全绿」证明的是**应用真正跑的那份代理代码**，而不是一个平行实现。
//!
//! 进程契约（CONTRACT §1）由 `proxy::run_standalone` 保证：端口被占用即非 0 退出、
//! 绝不偷偷换端口、就绪后 `/status` 可访问。

#[tokio::main]
async fn main() {
    if let Err(e) = app_lib::proxy::run_standalone().await {
        eprintln!("[proxy] FATAL: {e}");
        std::process::exit(1);
    }
}
