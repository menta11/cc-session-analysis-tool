//! 2.4 壳层：应用菜单（含「文件 → 导入会话」）、系统托盘、单实例接管。
//!
//! **逐条对照的 Node 参考实现**（只读未改）：
//! - 应用菜单 → 迁移前 Electron 壳的 `index.ts`（已删除） 的 `setMenu()`：macOS 首项 appMenu，
//!   然后 文件（`导入会话 (.jsonl)…` + 分隔线 + mac 关窗 / 其他平台退出）/ 编辑 / 视图；
//! - 托盘 → 迁移前 Electron 壳的 `monitorHost.ts`（已删除） 的 `createTray()` / `buildMenuTemplate()` /
//!   `showMainWindow()` / `toggleMonitor()` / 「重启代理」；
//! - 单实例 → Electron 的 `app.requestSingleInstanceLock()`，Tauri 侧用官方
//!   `tauri-plugin-single-instance`（macOS 实现是 `/tmp/<identifier>_si.sock` 这个 Unix socket，
//!   第二个进程连上、把 argv 递过去后 `exit(0)`，回调在第一个进程里跑 —— 见 lib.rs 的注册顺序）。
//!
//! **导入会话的端到端路径**（这是本模块唯一跨进程/跨语言的部分，重点说清）：
//!   菜单点击 → `on_menu_event` 里 `ID_IMPORT_SESSION` 分支 → 系统文件选择框（dialog 插件）
//!   → 选中路径 → `app.emit(EVENT_IMPORT_SESSION, path)` → 渲染层 `src/api/tauri.ts` 的
//!   `listen(EVENT_IMPORT_SESSION, …)` 收到 → `AnalyzerPage` 的 `load(path)`。
//!   事件名 `EVENT_IMPORT_SESSION` 与 TS 侧是**同一个字面量**，由本文件末尾的单测用
//!   `include_str!` 交叉断言，防止两边各改一半。

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};
use tauri_plugin_dialog::DialogExt;

use crate::proxy;

/// 渲染层订阅的「菜单导入」事件名。**必须**与 `src/api/tauri.ts` 的 `listen(...)` 一致。
pub const EVENT_IMPORT_SESSION: &str = "session:import";

// ── 应用菜单项 id ──
const ID_IMPORT_SESSION: &str = "import_session";
const ID_VIEW_RELOAD: &str = "view_reload";
const ID_VIEW_RESET_ZOOM: &str = "view_reset_zoom";
const ID_VIEW_ZOOM_IN: &str = "view_zoom_in";
const ID_VIEW_ZOOM_OUT: &str = "view_zoom_out";
/// 只有 debug 构建才有 `open_devtools()`（`#[cfg(any(debug_assertions, feature = "devtools"))]`），
/// 所以这个 id 也只在 debug 构建里存在。
#[cfg(debug_assertions)]
const ID_VIEW_DEVTOOLS: &str = "view_devtools";

// ── 托盘菜单项 id ──
const ID_TRAY_STATUS: &str = "tray_status";
const ID_TRAY_OPEN: &str = "tray_open";
const ID_TRAY_TOGGLE: &str = "tray_toggle_monitor";
const ID_TRAY_RESTART: &str = "tray_restart_proxy";
const ID_TRAY_QUIT: &str = "tray_quit";

/// macOS 菜单栏图标：**模板图**（22pt，@2x = 44px）。
///
/// 必须是 template image 才能随菜单栏深浅自动反色 —— 彩色图在深色菜单栏上会糊成一片。
/// Node 侧由 `nativeImage.setTemplateImage(true)` 达到同一效果，Tauri 侧是
/// `TrayIconBuilder::icon_as_template(true)`。
#[cfg(target_os = "macos")]
const TRAY_ICON_PNG: &[u8] = include_bytes!("../../vendor/cc-monitor/assets/trayTemplate.png");

/// Windows / Linux 系统托盘惯例用彩色 logo。
///
/// 与 Node 的已知差异：Node 把 1024px 的 `icon.png` resize 到 16px，而 Tauri 的
/// `Image` 没有 resize API，这里直接用仓库里现成的 32px 图标，由系统缩放到托盘槽位。
/// 图标本身是真的（不是空图），只是不做 16px 预缩放。
#[cfg(not(target_os = "macos"))]
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/32x32.png");

/// 监控状态轮询间隔。
///
/// Node 是「右键弹出菜单**前**刷一次状态」（`tray.on('right-click')` + `popUpContextMenu`）。
/// Tauri 的 `TrayIcon` **没有公开 `popup_menu`**（菜单由系统在右键时自动弹出，拦不到"弹出前"
/// 那一瞬），所以这里退一步改成后台轮询：状态变化最迟 3s 反映到菜单标签上。
/// 单独为它发本地 HTTP 请求很便宜（代理就在同一进程里）。
const MONITOR_POLL_MS: u64 = 3_000;

/// Chromium/Electron 的 zoom level 语义：1 级 = ×1.2，`zoomIn/zoomOut` 每步 0.5 级。
/// 存成「百分之一级」的整数，避免浮点累积。
const ZOOM_STEP_HALF_LEVEL: i32 = 50;
/// Chromium 对页面缩放的实际夹取范围。
const ZOOM_MIN: f64 = 0.25;
const ZOOM_MAX: f64 = 5.0;

/// 托盘句柄 + 监控状态的进程内缓存。
///
/// 为什么要缓存：`TrayIcon::set_menu` 要在主线程调用，而读 `/config/baseurl` 是网络请求；
/// 在菜单/托盘回调里同步发请求会卡住主线程（Node 的 `fetch` 是异步的，没这个问题）。
/// 所以状态由后台任务刷新，回调只读缓存。`TrayIcon` 有 tauri 的 `unsafe impl Send/Sync`，
/// 放进 static 是安全的。
struct TrayState {
    tray: OnceLock<TrayIcon<Wry>>,
    monitor_on: AtomicBool,
    proxy_running: AtomicBool,
    /// 当前 zoom level（百分之一级）。Tauri 的 `set_zoom` **只写不读**，相对步进必须自己记。
    zoom_level_pct: AtomicI32,
}

static TRAY: TrayState = TrayState {
    tray: OnceLock::new(),
    monitor_on: AtomicBool::new(false),
    proxy_running: AtomicBool::new(false),
    zoom_level_pct: AtomicI32::new(0),
};

/// 在 `tauri::Builder::setup` 里调用：装应用菜单、建托盘、起监控状态刷新任务。
///
/// 单实例插件**不在这里** —— 它必须是 `Builder` 上注册的第一个插件（见 lib.rs）。
pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    let handle = app.handle().clone();

    let menu = build_app_menu(&handle)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| on_menu_event(app, event.id().as_ref()));

    create_tray(&handle)?;
    spawn_monitor_watch(handle);
    Ok(())
}

/// 单实例回调：第二次启动时，插件把控制权交给已经在跑的第一个实例（也就是本进程）。
///
/// Node 的对应物是 `app.requestSingleInstanceLock()` 失败分支 + `second-instance` 事件里的
/// `showMainWindow()`；这里做同样的事。**额外打印一行日志**：单实例是本任务里少数能自动化
/// 验证的 GUI 行为之一，日志是唯一的证据来源（见方案 §8bis）。
pub fn on_second_instance(app: &AppHandle, argv: Vec<String>, cwd: String) {
    println!("[single-instance] 检测到第二次启动，唤起已有窗口：argv={argv:?} cwd={cwd}");
    show_main_window(app);
}

/// 构建应用菜单。
///
/// `pub` 是为了让 `tests/menu_structure.rs` 能断言它的结构 —— 那个测试必须跑在**主线程**
/// （muda 的 macOS 后端只在主线程建菜单），所以只能用 `harness = false` 的独立测试二进制，
/// 而集成测试只能访问 crate 的公开项。
pub fn build_app_menu<R: Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<Menu<R>> {
    let mut builder = MenuBuilder::new(manager);

    // macOS 的第一项必须是 app 子菜单（关于/服务/隐藏/退出），对应 Node 的 `{ role: 'appMenu' }`。
    // 不显式给的话系统会塞一个空的默认项。
    if cfg!(target_os = "macos") {
        let app_menu = SubmenuBuilder::new(manager, "Claude 会话工具集")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        builder = builder.item(&app_menu);
    }

    // 文件 —— Node: `导入会话 (.jsonl)…` + 分隔线 + `mac ? role:close : role:quit`
    let file = SubmenuBuilder::new(manager, "文件")
        .text(ID_IMPORT_SESSION, "导入会话 (.jsonl)…")
        .separator();
    let file = if cfg!(target_os = "macos") {
        file.close_window_with_text("关闭窗口")
    } else {
        file.quit_with_text("退出")
    }
    .build()?;

    // 编辑 —— 对应 Node 的 `{ role: 'editMenu' }`
    let edit = SubmenuBuilder::new(manager, "编辑")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // 视图 —— Node 的 `{ role: 'viewMenu' }`（reload / zoom / fullscreen）。
    //
    // 用「cfg 影子绑定」而不是 `let mut view` + `#[cfg] { view = ... }`：后者在 release
    // （debug_assertions 关）下会留下一个没被赋值的 `mut` → `unused_mut` 警告（实测有）。
    let view = SubmenuBuilder::new(manager, "视图")
        .text(ID_VIEW_RELOAD, "重新加载")
        .separator()
        .text(ID_VIEW_RESET_ZOOM, "实际大小")
        .text(ID_VIEW_ZOOM_IN, "放大")
        .text(ID_VIEW_ZOOM_OUT, "缩小")
        .separator();
    // 开发者工具项只在 debug 构建里存在 —— `open_devtools()` 本身也是这个编译条件。
    #[cfg(debug_assertions)]
    let view = view.text(ID_VIEW_DEVTOOLS, "开发者工具").separator();
    let view = view.fullscreen_with_text("全屏").build()?;

    builder.item(&file).item(&edit).item(&view).build()
}

/// 托盘菜单。`running` / `monitor_on` 是构建时的快照 —— 状态变化时整份重建再 `set_menu`。
///
/// `pub` 的原因同 `build_app_menu`（供主线程的 `tests/menu_structure.rs` 断言）。
pub fn build_tray_menu<R: Runtime, M: Manager<R>>(
    manager: &M,
    running: bool,
    monitor_on: bool,
) -> tauri::Result<Menu<R>> {
    // 标签逐字对齐 Node 的 buildMenuTemplate()：`实时监控 (Running|Stopped)`、`●监控中 / ○已停用`
    let status = if running { "Running" } else { "Stopped" };
    let toggle = if monitor_on { "●监控中" } else { "○已停用" };
    let status_item = MenuItemBuilder::with_id(ID_TRAY_STATUS, format!("实时监控 ({status})"))
        .enabled(false)
        .build(manager)?;
    MenuBuilder::new(manager)
        .item(&status_item)
        .separator()
        .text(ID_TRAY_OPEN, "打开主窗口")
        .text(ID_TRAY_TOGGLE, toggle)
        .text(ID_TRAY_RESTART, "重启代理")
        .separator()
        .text(ID_TRAY_QUIT, "退出")
        .build()
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_tray_menu(
        app,
        TRAY.proxy_running.load(Ordering::Relaxed),
        TRAY.monitor_on.load(Ordering::Relaxed),
    )?;
    let icon = tauri::image::Image::from_bytes(TRAY_ICON_PNG)?;

    let builder = TrayIconBuilder::with_id("main")
        .tooltip("Claude 会话工具集 · 实时监控")
        .icon(icon)
        .menu(&menu)
        // 左键留给「显示/隐藏主窗口」，右键出菜单 —— 对应 Node 的
        // `tray.on('click', toggle)` + `tray.on('right-click', popUpContextMenu)`。
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        });
    // 模板图只对 macOS 有意义（Windows/Linux 的托盘不做反色）。
    // 同样用 cfg 影子绑定，避免非 macOS 构建里 `let mut builder` 变成 unused_mut。
    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true);

    let tray = builder.build(app)?;
    // set 只会成功一次；重复调用（理论上不会）直接忽略，不 panic。
    let _ = TRAY.tray.set(tray);
    Ok(())
}

/// 用当前缓存状态重建并替换托盘菜单。
fn apply_tray_menu(app: &AppHandle) {
    let running = TRAY.proxy_running.load(Ordering::Relaxed);
    let monitor_on = TRAY.monitor_on.load(Ordering::Relaxed);
    match build_tray_menu(app, running, monitor_on) {
        Ok(menu) => {
            if let Some(tray) = TRAY.tray.get() {
                if let Err(e) = tray.set_menu(Some(menu)) {
                    eprintln!("[tray] 更新菜单失败：{e}");
                }
            }
        }
        Err(e) => eprintln!("[tray] 构建托盘菜单失败：{e}"),
    }
}

/// 监控状态后台刷新：`/config/baseurl` 的 `monitoring` 字段 + 代理是否可达。
fn spawn_monitor_watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            refresh_monitor_state(&app).await;
            tokio::time::sleep(Duration::from_millis(MONITOR_POLL_MS)).await;
        }
    });
}

/// 探一次真实状态，变了才重建菜单（避免每 3s 无谓重建）。
async fn refresh_monitor_state(app: &AppHandle) {
    let port = crate::MONITOR_PORT.load(Ordering::Relaxed);
    let (running, monitoring) = probe_monitor(port).await;
    if set_monitor_state(running, monitoring) {
        apply_tray_menu(app);
    }
}

/// 更新缓存，返回「是否发生变化」。
///
/// `monitoring == None` 表示「代理不可达 / 读不到开关」—— 此时保留上次的开关值
/// （Node 的 `refreshMonitorStatus()` 在 fetch 失败时也是保持上次值）。
fn set_monitor_state(running: bool, monitoring: Option<bool>) -> bool {
    let prev_running = TRAY.proxy_running.swap(running, Ordering::Relaxed);
    let prev_on = TRAY.monitor_on.load(Ordering::Relaxed);
    let on = monitoring.unwrap_or(prev_on);
    TRAY.monitor_on.store(on, Ordering::Relaxed);
    prev_running != running || prev_on != on
}

/// 返回 `(代理是否可达, 监控开关)`。
///
/// 打的是 `/config/baseurl` 而不是 `/status`：它的响应里同时有 `monitoring`（开关真值，
/// 与 dashboard 顶部开关、托盘标签共用同一份数据，单一契约）。
async fn probe_monitor(port: u16) -> (bool, Option<bool>) {
    if port == 0 {
        return (false, None);
    }
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return (false, None);
    };
    match client
        .get(format!("http://127.0.0.1:{port}/config/baseurl"))
        .send()
        .await
    {
        Ok(resp) => {
            let monitoring = if resp.status().is_success() {
                parse_json_body(resp).await.and_then(|v| {
                    v.get("monitoring").and_then(|m| m.as_bool())
                })
            } else {
                None
            };
            (true, monitoring)
        }
        Err(_) => (false, None),
    }
}

/// 读响应体并解析 JSON。
///
/// 不用 `reqwest::Response::json()`：本 crate 刻意没开 reqwest 的默认特性（它会静默解压
/// gzip/brotli、破坏代理的字节保真，见 Cargo.toml），而 `json` 也在默认特性里。
/// 所以这里手动 `bytes()` + `serde_json`，行为等价且不引入任何特性变动。
async fn parse_json_body(resp: reqwest::Response) -> Option<serde_json::Value> {
    let bytes = resp.bytes().await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// 菜单事件总入口（应用菜单与托盘菜单共用一条通道）。
fn on_menu_event(app: &AppHandle, id: &str) {
    match id {
        ID_IMPORT_SESSION => import_session(app.clone()),
        ID_VIEW_RELOAD => {
            with_main_window(app, |w| {
                let _ = w.eval("window.location.reload()");
            });
        }
        ID_VIEW_RESET_ZOOM => set_zoom(app, 0),
        ID_VIEW_ZOOM_IN => set_zoom(app, ZOOM_STEP_HALF_LEVEL),
        ID_VIEW_ZOOM_OUT => set_zoom(app, -ZOOM_STEP_HALF_LEVEL),
        #[cfg(debug_assertions)]
        ID_VIEW_DEVTOOLS => with_main_window(app, |w| w.open_devtools()),
        ID_TRAY_OPEN => show_main_window(app),
        ID_TRAY_TOGGLE => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { toggle_monitor(&app).await });
        }
        ID_TRAY_RESTART => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { restart_proxy(&app).await });
        }
        ID_TRAY_QUIT => app.exit(0),
        _ => {}
    }
}

/// 「文件 → 导入会话」：开系统文件选择框，把选中的 `.jsonl` 路径推给渲染层。
///
/// 与 Node 的对应：`dialog.showOpenDialog(win, {filters:[JSONL], properties:['openFile']})`
/// → `FileDialogBuilder::pick_file`；`win.webContents.send('session:import', p)`
/// → `app.emit(EVENT_IMPORT_SESSION, p)`。取消选择则什么都不做（Node 检查 `res.canceled`）。
fn import_session(app: AppHandle) {
    app.dialog()
        .file()
        .set_title("导入会话")
        .add_filter("JSONL", &["jsonl"])
        .pick_file(move |picked| {
            let Some(file) = picked else { return }; // 用户取消
            match file.into_path() {
                Ok(path) => {
                    let path = path.to_string_lossy().into_owned();
                    println!("[menu] 导入会话：{path}");
                    if let Err(e) = app.emit(EVENT_IMPORT_SESSION, path) {
                        eprintln!("[menu] 推送导入路径失败：{e}");
                    }
                }
                Err(e) => eprintln!("[menu] 选中的路径不可用：{e}"),
            }
        });
}

/// 显示并聚焦主窗口。`pub(crate)`：悬浮窗的 `backToDashboard`（`float_window.rs`）也要用它
/// —— Node 的 `monitor:back-to-dashboard` 就是「销毁悬浮窗 + `showMainWindow()`」。
pub(crate) fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 托盘左键：可见则隐藏、不可见则显示并聚焦（Node 的 `tray.on('click')`）。
///
/// 与 Node 的已知差异：Node 在窗口已被销毁时会 `createMainWindow()` 重建；Tauri 里
/// 窗口被关闭即退出应用（默认行为），不存在"应用还活着但没有主窗口"的中间态，
/// 因此没有可复刻的重建分支 —— 见方案 §8bis 的如实记录。
fn toggle_main_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 托盘「●监控中 / ○已停用」：与 dashboard 顶部开关复用同一个 HTTP 端点（Node 同做法）。
///
/// 先 GET 读真实态再反向操作 —— 面板可能改过状态，用缓存值判断会反着操作。
async fn toggle_monitor(app: &AppHandle) {
    let port = crate::MONITOR_PORT.load(Ordering::Relaxed);
    if port == 0 {
        show_error(app, "代理未启动，无法切换监控。");
        return;
    }
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    else {
        show_error(app, "切换监控失败：HTTP 客户端初始化失败");
        return;
    };

    let base = format!("http://127.0.0.1:{port}/config/baseurl");
    let current = match client.get(&base).send().await {
        Ok(r) => parse_json_body(r).await,
        Err(e) => {
            show_error(app, &format!("切换监控失败：{e}"));
            return;
        }
    };
    let action = if current
        .as_ref()
        .and_then(|v| v.get("monitoring"))
        .and_then(|m| m.as_bool())
        == Some(true)
    {
        "disable"
    } else {
        "enable"
    };

    match client
        .post(&base)
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "action": action }).to_string())
        .send()
        .await
    {
        Ok(resp) => {
            let ok = resp.status().is_success();
            let data = parse_json_body(resp).await;
            let body_ok = data
                .as_ref()
                .and_then(|v| v.get("ok"))
                .and_then(|v| v.as_bool())
                == Some(true);
            if !ok || !body_ok {
                let msg = data
                    .as_ref()
                    .and_then(|v| v.get("error"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知错误");
                show_error(app, &format!("切换监控失败：{msg}"));
                return;
            }
            let monitoring = data
                .as_ref()
                .and_then(|v| v.get("monitoring"))
                .and_then(|m| m.as_bool())
                .unwrap_or(false);
            TRAY.monitor_on.store(monitoring, Ordering::Relaxed);
            println!("[tray] 监控已{}", if monitoring { "开启" } else { "关闭" });
            apply_tray_menu(app);
            refresh_monitor_state(app).await;
        }
        Err(e) => show_error(app, &format!("切换监控失败：{e}")),
    }
}

/// 托盘「重启代理」：停掉应用内监听再重新起（Node 的 `stopProxy()` + `startProxyIfDown()`）。
///
/// 为什么能真的重启：`proxy::stop_background()` 会 abort 掉 serve 任务并 await 到监听 socket
/// 已经 drop，端口立即可重绑 —— 见 `proxy/mod.rs` 的 `SERVE_TASKS`。
async fn restart_proxy(app: &AppHandle) {
    crate::MONITOR_PORT.store(0, Ordering::Relaxed);
    proxy::stop_background().await;
    match proxy::start_background(Some(proxy::config_port())).await {
        Ok(port) => {
            crate::MONITOR_PORT.store(port, Ordering::Relaxed);
            println!("[tray] 代理已重启，监听 :{port}");
        }
        Err(e) => {
            eprintln!("[tray] 代理重启失败：{e}");
            show_error(app, &format!("重启代理失败：{e}"));
        }
    }
    refresh_monitor_state(app).await;
}

/// 页面缩放：`delta == 0` 是「实际大小」，否则按半个 zoom level 步进。
///
/// Tauri 的 `set_zoom` 只写不读，所以当前级别由 `TRAY.zoom_level_pct` 自己记；
/// 夹到边界时把**记录值也夹住**，否则连点会记下一个越界级别，反向要连点很多下才回来。
fn set_zoom(app: &AppHandle, delta: i32) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let current = TRAY.zoom_level_pct.load(Ordering::Relaxed);
    let next = if delta == 0 { 0 } else { current + delta };
    let level = next as f64 / 100.0;
    let factor = 1.2f64.powf(level).clamp(ZOOM_MIN, ZOOM_MAX);
    let clamped = (factor.ln() / 1.2f64.ln() * 100.0).round() as i32;
    if win.set_zoom(factor).is_ok() {
        TRAY.zoom_level_pct.store(clamped, Ordering::Relaxed);
    }
}

fn with_main_window(app: &AppHandle, f: impl FnOnce(&tauri::WebviewWindow<Wry>)) {
    if let Some(win) = app.get_webview_window("main") {
        f(&win);
    }
}

/// 与 Node 的 `dialog.showErrorBox` 对应（非阻塞版，避免卡住主线程）。
fn show_error(app: &AppHandle, message: &str) {
    app.dialog()
        .message(message)
        .title("实时监控")
        .show(|_| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 跨语言一致性：Rust 发出的事件名必须能在渲染层实现里找到。
    ///
    /// 这条断言防的是「菜单改事件名、TS 没跟着改」这类一半一半的改动 ——
    /// 那种 bug 不会让任何构建失败，只会让导入静默失效。
    ///
    /// 两种引号都认：TS 侧当前是单引号，但这是格式选择，不该让测试变成格式警察。
    #[test]
    fn import_event_name_matches_renderer() {
        let renderer = include_str!("../../src/api/tauri.ts");
        let single = format!("'{EVENT_IMPORT_SESSION}'");
        let double = format!("\"{EVENT_IMPORT_SESSION}\"");
        assert!(
            renderer.contains(&single) || renderer.contains(&double),
            "src/api/tauri.ts 里找不到 {single} / {double}；事件名两侧已漂移"
        );
    }
}
