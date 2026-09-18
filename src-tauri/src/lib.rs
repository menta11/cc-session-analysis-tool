//! Tauri v2 应用入口。
//!
//! 职责划分：
//! - Rust：syscall 层（fs 原语）、子进程（claude CLI）、终端、对话框、托盘/菜单/窗口、内嵌 proxy
//! - 渲染层：全部业务逻辑（core/ 原样复用 + 既有 React UI）
//!
//! 这样做的核心理由：`core/` 的测试资产留在 TypeScript 侧，把它重写成 Rust 既丢掉这些资产，
//! 又引入算法语义漂移风险；而体积收益来自「换掉 Electron 内核」，与 core/ 用什么语言无关。

pub mod proxy;

// `claude` / `terminal` 开给集成测试（`tests/proc_differential.rs`）：那个测试要拿同一批命令同时驱动
// Rust 的 `run_lines_with` / `exec_text` / `spawn_detached` 与 Node 参考实现（`core/procBridgeNode.ts`）
// 做同输入差分 —— 与 `fs_ops` 开给 `tests/fs_ops_differential.rs` 完全同一个理由与写法。
#[doc(hidden)]
pub mod claude;
// 悬浮窗 `ccMonitor` 桥：做成 inlined plugin，见模块头与 `build.rs` 的说明。
mod float_window;
// `fs_ops` 开给集成测试（`tests/fs_ops_differential.rs`）：那个测试要拿同一批语料同时驱动
// Rust 原语与 Node 参考实现（`core/fsBridgeNode.ts`）做差分。`pub` 只为让它可被 `app_lib::fs_ops`
// 引用，不是对外 API —— 同 `shell` 的 `#[doc(hidden)]` 先例。
#[doc(hidden)]
pub mod fs_ops;
mod shell;
// 同上：`spawnDetached` 是 `ProcBridge` 的一个方法，差分探针要驱动它。
#[doc(hidden)]
pub mod terminal;

// 菜单构造器只对集成测试可见（`tests/menu_structure.rs`）。之所以要开这个口子：
// muda 在 macOS 上硬性要求菜单只在**主线程**创建，所以那个测试只能用 `harness = false`
// 的独立测试二进制（它的 `main` 才是主线程），而集成测试只能摸到 crate 的公开项。
// `#[doc(hidden)]` 标记它不是对外 API。
#[doc(hidden)]
pub use shell::{build_app_menu, build_tray_menu};

use std::sync::atomic::{AtomicU16, Ordering};

use tauri::Manager;

/// 代理实际监听的端口。**0 = 尚未就绪或启动失败**（渲染层把 0 当作"未就绪"，与迁移前的
/// `getMonitorPort()` 语义一致）。
///
/// `pub(crate)`：托盘「重启代理」与监控状态轮询（`shell.rs`）要读写它。
pub(crate) static MONITOR_PORT: AtomicU16 = AtomicU16::new(0);

#[tauri::command]
fn monitor_port() -> u16 {
    MONITOR_PORT.load(Ordering::Relaxed)
}

/// 应用数据目录，给渲染层放元数据缓存（`core/discovery/metaCache.ts`）。
///
/// 与 `setup` 里注入给代理日志的目录是同一个：`app_data_dir()` 是 Tauri 侧与 Electron `userData`
/// 对应的那个位置（macOS `~/Library/Application Support/<identifier>`、Linux `$XDG_DATA_HOME/<identifier>`、
/// Windows `%APPDATA%\<identifier>`）。那次是 Rust 内部用，这次要暴露给渲染层，故开成命令。
///
/// **顺带保证目录存在**：`write_text` 的语义与 Node 的 `fs.writeFile` 一致（父目录不存在就报错），
/// 而首次运行时这个目录可能还没被创建（`logs/` 是代理自己建的，不能当作前提）。
#[tauri::command]
fn app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 {} 失败：{e}", dir.display()))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// 代理存活探测。**必须放在 Rust 侧**：渲染页与代理不同源，直连会被 CORS 拦掉；
/// Electron 版也是把探测下沉到主进程的 Node `fetch`，这里是同一个理由。
#[tauri::command]
async fn monitor_ping() -> bool {
    let port = MONITOR_PORT.load(Ordering::Relaxed);
    if port == 0 {
        return false;
    }
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    else {
        return false;
    };
    // 用 127.0.0.1 而不是 localhost：避免 IPv6 解析差异带来的假阴性
    matches!(
        client.get(format!("http://127.0.0.1:{port}/status")).send().await,
        Ok(r) if r.status().is_success()
    )
}

pub fn run() {
    // 把进程 cwd 固定到**家目录**。
    //
    // 为什么必须固定：`claude` 按 cwd 决定会话落盘位置（~/.claude/projects/<sanitize(cwd)>/），
    // 而「打开终端继续对话」要求 resume 与分析调用**同 cwd**。Electron 版用的是 process.cwd()，
    // 它随启动方式漂移（dev 下是项目根，打包后从 Finder 启动是 `/`）；Tauri 这边固定成 home，
    // 既确定又让终端停在合理位置。两侧一致性由「analyze 的 claude 继承此 cwd」+「open_terminal
    // 显式用 home」共同保证。
    let home_key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    if let Ok(home) = std::env::var(home_key) {
        let _ = std::env::set_current_dir(&home);
    }

    tauri::Builder::default()
        // ⚠️ 单实例**必须是第一个注册的插件**（官方要求）：它要在 setup 阶段就判断
        // 「是否已有实例在跑」，第二个进程会在这里 `exit(0)`，把 argv 交给第一个进程。
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            shell::on_second_instance(app, argv, cwd);
        }))
        .plugin(tauri_plugin_dialog::init())
        // 悬浮窗桥（`plugin:float|*`）。放在单实例插件之后 —— 只有它必须在第一位。
        .plugin(float_window::plugin())
        .setup(|app| {
            // 请求日志目录注入（Node 侧对应物：`monitorHost.ts:17-19` 把 `CC_MONITOR_LOG_DIR`
            // 指向 `app.getPath('userData')/logs`，dev 为 `<cwd>/logs`）。
            //
            // Tauri 的 userData 对应物是 `app_data_dir()`：macOS 是
            // `~/Library/Application Support/<identifier>`、Linux 是 `$XDG_DATA_HOME/<identifier>`、
            // Windows 是 `%APPDATA%\<identifier>`。
            //
            // **必须在这里注入**：上面刚把 cwd 固定成了家目录，若留空让代理按 Node 语义回落
            // `cwd/logs`，日志就会散进家目录（本文件第 64 行那个刻意的 cwd 决策带来的副作用）。
            // 已经显式设过（且非空）的环境变量优先保留，便于沙箱化运行与排查；空串按未设处理，
            // 与 `proxy/log.rs` 的 JS `||` 语义一致。
            if std::env::var("CC_MONITOR_LOG_DIR").map_or(true, |v| v.is_empty()) {
                match app.path().app_data_dir() {
                    Ok(dir) => {
                        let logs = dir.join("logs");
                        std::env::set_var("CC_MONITOR_LOG_DIR", &logs);
                        println!("[monitor] 请求日志目录: {}", logs.display());
                    }
                    Err(e) => eprintln!(
                        "[monitor] WARN: app_data_dir 解析失败（{e}）；请求日志将按 Node 语义回落到 cwd/logs"
                    ),
                }
            }
            // 代理**后台启动**，失败只告警不阻塞：会话分析不依赖代理
            // （Electron 版也是同样的降级策略 —— proxy 起不来时监控页提示、其余功能照用）。
            tauri::async_runtime::spawn(async move {
                match proxy::start_background(Some(proxy::config_port())).await {
                    Ok(port) => {
                        MONITOR_PORT.store(port, Ordering::Relaxed);
                        println!("[monitor] proxy ready on :{port}");
                    }
                    Err(e) => {
                        eprintln!("[monitor] 代理启动失败：{e}");
                        eprintln!("[monitor] 实时监控不可用；会话分析不受影响。");
                    }
                }
            });
            // 应用菜单 + 托盘 + 监控状态刷新（2.4 壳层，见 shell.rs）。
            shell::setup(app)?;
            // 悬浮窗平时只能靠点 dashboard 的按钮出现；这个钩子（仅 debug、需环境变量）
            // 让「远程 origin 的 IPC 是否真被 ACL 放行」可以自动化验证 —— 见 float_window.rs。
            float_window::spawn_smoke_if_requested(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fs_ops::home_dir,
            fs_ops::read_dir,
            fs_ops::stat,
            fs_ops::read_text,
            fs_ops::read_head,
            fs_ops::write_text,
            claude::run_lines,
            claude::exec_text,
            terminal::spawn_detached,
            monitor_port,
            monitor_ping,
            app_data_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
