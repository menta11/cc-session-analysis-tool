//! 悬浮窗（§6.2 真正剩下的那一点）：远程 `mini.html` 的 `window.ccMonitor` 桥。
//!
//! # 为什么需要这一整个模块
//!
//! Electron 的悬浮窗是一个 frameless/transparent/always-on-top 的 `BrowserWindow`，它
//! `loadURL('http://localhost:<port>/mini.html')` 时**带同一个 preload**，于是
//! `window.ccMonitor` 被 `contextBridge` 注入进那个远程页面（见 迁移前 Electron 壳的 `preload/index.ts`（已删除））。
//!
//! Tauri 里"窗口加载远程 URL"同样能拿到 IPC（初始化脚本对所有 main frame 都注入，见
//! `tauri-2.11.5/src/manager/webview.rs` 的 `prepare_pending_webview`），但**授权完全不同**：
//! 远程 origin 必须由 capability 里的 `remote` 字段显式放行（`tauri-2.11.5/src/webview/mod.rs`
//! `on_message` 里那句 "ensures remote content can never reach custom commands unless an
//! explicit `remote` capability has been configured for them"）。本模块就是那份放行 + 5 个
//! 窗口控制命令 + 注入 `ccMonitor` 的初始化脚本。
//!
//! 为什么做成 **inlined plugin** 而不是 `Builder::invoke_handler` 的应用命令：
//! 应用命令走 `has_app_acl_manifest` 那条全局开关 —— 一旦声明了 app manifest，
//! **所有**应用命令（`read_text`/`run_lines`/… 11 个）都必须在 capability 里逐个显式放行，
//! 否则连本地主窗口都会开始被拒。inlined plugin 有自己独立的 ACL manifest
//! （`float:allow-*`）与 `has_app_acl_manifest` 无关，爆炸半径只有这个悬浮窗。
//!
//! # 逐条对照的 Node 参考实现（只读未改）
//!
//! 迁移前 Electron 壳的 `monitorHost.ts`（已删除）：
//! - `createFloatWindow()` 的窗口标志：`width/height: 1`（初始最小，等 mini 上报真实尺寸）、
//!   `frame: false`、`transparent: true`、`alwaysOnTop: true`、`resizable: false`、
//!   `skipTaskbar: true`、`show: false`、`backgroundThrottling: false`；
//! - `monitor:enter-float` / `monitor:back-to-dashboard`；
//! - `monitor:resize-float`：`setSize(w, h)`，**首次**真实尺寸时按
//!   `(workArea.width - w - 110, 8)` 摆到右上角；
//! - `monitor:float-drag-start` / `monitor:float-drag-move`：自己实现拖动
//!   （弃 `-webkit-app-region: drag`，那会吞掉 click）。
//!
//! # 与 Node 的已知差异（如实记录）
//!
//! 1. 页面 origin 用 `http://127.0.0.1:<port>`（Node 用 `localhost`）。理由与 `monitor_ping`
//!    一致：避免 `localhost` 在 IPv6/IPv4 解析上的差异。代理两个地址都监听。
//! 2. Electron 的 `setSize/setPosition/getBounds/workArea` 都是 **DIP（逻辑像素）**，而 Tauri 的
//!    `work_area()`/`outer_position()` 是**物理像素**。所以这里显式除以/换算 `scale_factor`，
//!    否则 Retina 上会按 2× 定位到屏幕外。
//! 3. `mini.html` 的 `window.ccMonitor.getPort()`（dashboard 用）**不注入**：dashboard 由代理
//!    自己托管，`window.location.port` 就是真值，它自带 try/catch 回退（见文件末尾单测）。

use std::sync::atomic::Ordering;
use std::sync::{Mutex, MutexGuard};
// 只有 debug 的 smoke 钩子在等代理就绪时用到它；release 里那一段被 cfg 掉，
// 所以导入也得跟着 cfg，否则 release 构建会报 unused_imports（实测有）。
#[cfg(debug_assertions)]
use std::time::Duration;

use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

/// 悬浮窗的窗口 label。capability `float` 用 `"windows": ["float"]` 指向它。
pub const FLOAT_LABEL: &str = "float";

/// inlined plugin 名。capability 里的权限前缀（`float:allow-*`）与 build.rs 的注册名都是它。
pub const PLUGIN_NAME: &str = "float";

/// 右上角定位的横向留白（Node 的字面量 `110`）。
pub const TOP_RIGHT_MARGIN_X: f64 = 110.0;
/// 右上角定位的纵向坐标（Node 的字面量 `8`，**不是** 相对工作区顶部）。
pub const TOP_RIGHT_Y: f64 = 8.0;
/// `mini.html` 初始窗口是 1×1，`ResizeObserver` 首帧可能也报 0/极小值；
/// Node 用 `dims.w > 1 && dims.h > 1` 判定"这才是真实尺寸"，这里照抄（严格大于）。
pub const MIN_REAL_DIM: f64 = 1.0;

/// `ccMonitor` 方法名 → 插件命令名 → JS 形参表 → IPC 载荷表达式。
///
/// 这是**单一事实来源**：`cc_monitor_shim()` 由它生成 JS，末尾的单测再拿它去交叉断言
/// `mini.html` 的调用点、`dashboard.html` 的调用点、`src/preload.d.ts` 的契约、
/// 以及 `build.rs` 的 ACL 命令清单 —— 这四处的任何一处漂移都不会让构建失败，只会让悬浮窗静默失灵。
pub const BRIDGE: [(&str, &str, &str, &str); 5] = [
    ("enterFloatMode", "enter", "", "{}"),
    ("backToDashboard", "back_to_dashboard", "", "{}"),
    ("resizeFloat", "resize", "w, h", "{ w: w, h: h }"),
    ("floatDragStart", "drag_start", "x, y", "{ x: x, y: y }"),
    ("floatDragMove", "drag_move", "x, y", "{ x: x, y: y }"),
];

/// 注入悬浮窗（远程 `mini.html`）的 `window.ccMonitor` 垫片。
///
/// 这是 Electron preload 的对应物：`contextBridge.exposeInMainWorld('ccMonitor', …)` 换成
/// 在页面脚本之前执行的初始化脚本。用 `Object.defineProperty` + `freeze`（与 Tauri 的
/// `__TAURI_INTERNALS__` 同风格），免得页面上的脚本把桥换掉。
pub fn cc_monitor_shim() -> String {
    let mut methods = String::new();
    for (method, cmd, params, payload) in BRIDGE {
        methods.push_str(&format!(
            "    {method}: function ({params}) {{ return invoke('plugin:{PLUGIN_NAME}|{cmd}', {payload}); }},\n"
        ));
    }
    format!(
        "// 悬浮窗 ccMonitor 桥（由 Rust 侧 initialization_script 注入，等价于 Electron 的 preload）\n\
         (function () {{\n\
         \x20 var invoke = window.__TAURI_INTERNALS__.invoke;\n\
         \x20 Object.defineProperty(window, 'ccMonitor', {{\n\
         \x20   value: Object.freeze({{\n\
         {methods}\
         \x20   }}),\n\
         \x20 }});\n\
         }})();\n"
    )
}

// ── 纯几何逻辑（可单测，不依赖任何窗口对象）──────────────────────────────

/// 右上角定位：`(work_area_width - window_w - 110, 8)`。
///
/// 逐字对齐 Node 的 `floatWin.setPosition(sw - dims.w - 110, 8)`（`sw = workArea.width`）。
/// 注意它用的是**宽度**减窗口宽、而 y 是个常数 8 —— 不是"相对工作区顶部的 8"。
/// 这是 Node 的既有行为（macOS 上工作区 y 通常是菜单栏高度），照抄不"顺手修正"。
pub fn top_right_position(work_area_width: f64, window_w: f64) -> (f64, f64) {
    (work_area_width - window_w - TOP_RIGHT_MARGIN_X, TOP_RIGHT_Y)
}

/// 拖动位移：`起点 + (当前鼠标 - 按下时鼠标)`，与 Node 的
/// `setPosition(bounds.x + (x - mouse.x), bounds.y + (y - mouse.y))` 同式。
pub fn drag_position(origin: (f64, f64), from_mouse: (f64, f64), to_mouse: (f64, f64)) -> (f64, f64) {
    (
        origin.0 + (to_mouse.0 - from_mouse.0),
        origin.1 + (to_mouse.1 - from_mouse.1),
    )
}

/// 「首次真实尺寸才定位」的状态机（Node 的 `floatPositioned` 标志）。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct FloatGeometry {
    positioned: bool,
}

impl FloatGeometry {
    pub fn is_positioned(&self) -> bool {
        self.positioned
    }

    /// 新建窗口时重置（Node 在 `monitor:enter-float` 的 `createFloatWindow()` 分支里做）。
    pub fn reset(&mut self) {
        self.positioned = false;
    }

    /// `mini.html` 上报尺寸时调用。返回 `Some((x, y))` 表示"这次要摆到右上角"。
    ///
    /// 三种情况都返回 `None`（且**不**消耗掉"首次"机会，除非真的定位成功）：
    /// - 已经定位过；
    /// - 报上来的还不是真实尺寸（`w`/`h` 不大于 1）；
    /// - 拿不到主显示器工作区宽度（Tauri 的 `primary_monitor()` 可能返回 `None`）。
    ///
    /// 第三条是刻意的：宁可不定位、等下一次上报，也不要拿 0 去减、把窗口摆到屏幕外。
    pub fn on_resize(&mut self, w: f64, h: f64, work_area_width: Option<f64>) -> Option<(f64, f64)> {
        if self.positioned || w <= MIN_REAL_DIM || h <= MIN_REAL_DIM {
            return None;
        }
        let width = work_area_width?;
        self.positioned = true;
        Some(top_right_position(width, w))
    }
}

/// 拖动锚点：`(按下时的窗口位置, 按下时的鼠标屏幕坐标)`。
///
/// Node 侧是两个模块级变量 `floatDragMouse` / `floatDragWin`，且 **mouseup 时不清空**
/// （它只清 `down`，不清拖动锚点）。这里保持同一行为；`moved()` 在没 `begin()` 过时返回
/// `None`，对应 Node 的 `if (!floatDragMouse || !floatDragWin) return`。
#[derive(Debug, Default)]
pub struct DragState {
    anchor: Option<((f64, f64), (f64, f64))>,
}

impl DragState {
    pub fn begin(&mut self, origin: (f64, f64), mouse: (f64, f64)) {
        self.anchor = Some((origin, mouse));
    }

    pub fn moved(&self, mouse: (f64, f64)) -> Option<(f64, f64)> {
        self.anchor.map(|(origin, from)| drag_position(origin, from, mouse))
    }
}

// ── 进程内状态 ─────────────────────────────────────────────────────────
//
// 用 static 而不是 `tauri::State`：插件命令要泛型化（`R: Runtime`，测试里跑 MockRuntime），
// 走 State 就得在插件 `setup` 里 `manage`，而这两块状态本来就是全局单例（一个进程只有一个悬浮窗）。
// `Mutex::new` 自 Rust 1.63 起是 const，所以可以直接 static 初始化（与 shell.rs 的 TRAY 同风格）。

struct FloatState {
    geometry: Mutex<FloatGeometry>,
    drag: Mutex<DragState>,
}

static FLOAT: FloatState = FloatState {
    geometry: Mutex::new(FloatGeometry { positioned: false }),
    drag: Mutex::new(DragState { anchor: None }),
};

/// 中毒（持锁时 panic）不该让悬浮窗彻底失灵，所以取内部值继续用。
fn geometry() -> MutexGuard<'static, FloatGeometry> {
    FLOAT.geometry.lock().unwrap_or_else(|e| e.into_inner())
}

fn drag() -> MutexGuard<'static, DragState> {
    FLOAT.drag.lock().unwrap_or_else(|e| e.into_inner())
}

// ── 窗口操作 ───────────────────────────────────────────────────────────

/// 主显示器**工作区**的逻辑宽度，等价于 Electron 的
/// `screen.getPrimaryDisplay().workArea.width`（DIP）。
///
/// Tauri 的 `Monitor::work_area()` 是物理像素、`scale_factor()` 是缩放比，两者相除才是 DIP。
fn work_area_logical_width<R: Runtime>(window: &WebviewWindow<R>) -> Option<f64> {
    let monitor = window.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    if scale <= 0.0 {
        return None;
    }
    Some(monitor.work_area().size.width as f64 / scale)
}

/// 建悬浮窗 —— 标志逐条对照 Node 的 `createFloatWindow()`。
fn create_float_window<R: Runtime>(
    app: &AppHandle<R>,
    port: u16,
) -> Result<WebviewWindow<R>, String> {
    let target = format!("http://127.0.0.1:{port}/mini.html");
    let url: url::Url = target
        .parse()
        .map_err(|e| format!("悬浮窗 URL 非法（{target}）：{e}"))?;

    WebviewWindowBuilder::new(app, FLOAT_LABEL, WebviewUrl::External(url))
        // width: 1, height: 1 —— 初始最小，由 mini.html 的 ResizeObserver 上报真实尺寸
        .inner_size(1.0, 1.0)
        // frame: false
        .decorations(false)
        // transparent: true
        .transparent(true)
        // alwaysOnTop: true
        .always_on_top(true)
        // resizable: false
        .resizable(false)
        // skipTaskbar: true
        .skip_taskbar(true)
        // show: false —— 由 enter 分支显式 show()
        .visible(false)
        // 透明窗口不自带系统阴影：mini.html 自己画 CSS 阴影并留了 --shadow-pad 余量，
        // 再叠一层原生阴影会重复。Electron 的 transparent 窗口同样没有原生阴影。
        .shadow(false)
        // backgroundThrottling: false —— 透明/失焦窗口不节流，poll 才实时。
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        // 注入 window.ccMonitor（等价于 Electron 的 preload）
        .initialization_script(cc_monitor_shim())
        .build()
        .map_err(|e| format!("创建悬浮窗失败：{e}"))
}

/// `monitor:enter-float`：显示悬浮窗（没有就建），并隐藏主窗口（React 状态保留在渲染层）。
pub async fn enter_impl<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    // 代理还在异步启动时 MONITOR_PORT 是 0；用配置端口兜底，页面照常加载
    // （Node 用的也是配置端口，代理没起来时行为一致：窗口在、数据空）。
    let port = {
        let ready = crate::MONITOR_PORT.load(Ordering::Relaxed);
        if ready == 0 {
            crate::proxy::config_port()
        } else {
            ready
        }
    };

    let window = match app.get_webview_window(FLOAT_LABEL) {
        Some(existing) => existing,
        None => {
            // Node：新建窗口时才把 floatPositioned 清掉
            geometry().reset();
            create_float_window(app, port)?
        }
    };

    window
        .show()
        .map_err(|e| format!("显示悬浮窗失败：{e}"))?;
    // Electron 的 show() 会把窗口激活；Tauri 的 show() 不会，所以补一次 focus。
    let _ = window.set_focus();
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    println!("[float] 进入悬浮窗模式：mini.html @ 127.0.0.1:{port}");
    Ok(())
}

/// `monitor:back-to-dashboard`：销毁悬浮窗 + 恢复主窗口。
async fn back_to_dashboard_impl<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(FLOAT_LABEL) {
        window
            .destroy()
            .map_err(|e| format!("关闭悬浮窗失败：{e}"))?;
    }
    crate::shell::show_main_window(app);
    println!("[float] 返回 dashboard");
    Ok(())
}

// ── 命令（都是 `plugin:float|<name>`）──────────────────────────────────

/// `ccMonitor.enterFloatMode()`。**主窗口**也调它（dashboard 的悬浮框按钮）。
#[tauri::command]
async fn enter<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    enter_impl(&app).await
}

/// `ccMonitor.backToDashboard()`。悬浮窗里点一下（`mouseup` 且没拖过）就回 dashboard。
#[tauri::command]
async fn back_to_dashboard<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    back_to_dashboard_impl(&app).await
}

/// `ccMonitor.resizeFloat(w, h)` —— mini.html 的 ResizeObserver 上报卡片尺寸。
#[tauri::command]
async fn resize<R: Runtime>(window: WebviewWindow<R>, w: f64, h: f64) -> Result<(), String> {
    window
        .set_size(LogicalSize::new(w, h))
        .map_err(|e| format!("调整悬浮窗大小失败：{e}"))?;

    // 只有"还没定位过"才需要去问显示器工作区（也才可能改位置）——
    // 之后每次 resize 都省掉一次 monitor 查询。
    let need_position = !geometry().is_positioned();
    let mut note = String::new();
    if need_position {
        let work_area_width = work_area_logical_width(&window);
        let mut g = geometry();
        if let Some((x, y)) = g.on_resize(w, h, work_area_width) {
            drop(g); // 先放锁再做窗口 IO，避免持锁跨越系统调用
            window
                .set_position(LogicalPosition::new(x, y))
                .map_err(|e| format!("定位悬浮窗失败：{e}"))?;
            note = format!("，首次定位 ({x}, {y})，工作区宽 {work_area_width:?}");
        }
    }

    // 这行日志是「远程 origin 的 IPC 真的被放行 + programmatic set_size 真的生效」的
    // 唯一可远程观察的证据（见方案 §8bis 的实测记录），刻意保留。
    let actual = window
        .inner_size()
        .map(|s| format!("{}x{}", s.width, s.height))
        .unwrap_or_else(|_| "读取失败".to_string());
    println!("[float] resize 上报 {w}x{h} → 实际 {actual}{note}");
    Ok(())
}

/// `ccMonitor.floatDragStart(x, y)`：记下窗口当前位置与按下时的鼠标屏幕坐标。
#[tauri::command]
async fn drag_start<R: Runtime>(window: WebviewWindow<R>, x: f64, y: f64) -> Result<(), String> {
    let scale = window
        .scale_factor()
        .map_err(|e| format!("读取缩放比失败：{e}"))?;
    let origin = window
        .outer_position()
        .map_err(|e| format!("读取悬浮窗位置失败：{e}"))?
        .to_logical::<f64>(scale);
    drag().begin((origin.x, origin.y), (x, y));
    Ok(())
}

/// `ccMonitor.floatDragMove(x, y)`：`起点 + 鼠标位移`（Node 同式）。
#[tauri::command]
async fn drag_move<R: Runtime>(window: WebviewWindow<R>, x: f64, y: f64) -> Result<(), String> {
    // 没 start 过就忽略 —— Node 的 `if (!floatDragMouse || !floatDragWin) return`
    let Some((next_x, next_y)) = drag().moved((x, y)) else {
        return Ok(());
    };
    window
        .set_position(LogicalPosition::new(next_x, next_y))
        .map_err(|e| format!("移动悬浮窗失败：{e}"))
}

/// 注册这个 inlined plugin。命令名必须与 `build.rs` 里 `InlinedPlugin::commands` 的清单一致
/// （`build.rs` 生成 ACL 权限 `float:allow-*`），由文末单测交叉断言。
///
/// `#![plugin(float)]` 这个内层属性**不能省**，尽管当前去掉它也能跑。名字只能写字面量：
/// 宏用 `attr.parse_args::<Ident>()` 取它，给常量路径直接编译失败 —— 所以这里与 `build.rs`
/// 一样是「字面量 + 单测交叉断言」，见文末那个断言测试。
///
/// `tauri-macros` 的 `generate_handler!` 要靠它才把命令名拼成 `plugin:float|<命令>` 去比对
/// `allowed-commands.json`（`handler.rs` 的 `command_prefix`）；没有它时宏只认 `CARGO_PKG_NAME`
/// 那条回退，而本 crate 不叫 `tauri-plugin-*` → `plugin_name = None` → 宏在
/// `if plugin_name.is_none() && !has_app_acl { return }` 处以「应用命令一律保留」提前返回。
/// 也就是说：**当前的安全来自 `has_app_acl == false` 这个全局开关，不是来自本文件**。
/// 哪天有人给应用加了 app manifest（`build.rs` 里声明 `AppManifest::commands`）使该开关翻转，
/// 上面那个前缀就会退化成空串、拿裸名 `enter` 去找 `plugin:float|enter`，5 条命令连同
/// `lib.rs` 的 12 个应用命令会被一起静默裁掉（悬浮窗失灵，且构建不报错）。
///
/// 补上之后裁剪逻辑对本插件真正生效：这 5 条都在 `capabilities/float.json` 的允许集里，
/// 行为与今天一致；但今后谁漏了某条权限，会在构建期被裁掉而不是攒到运行期才炸。
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new(PLUGIN_NAME)
        .invoke_handler(tauri::generate_handler![
            #![plugin(float)]
            enter,
            back_to_dashboard,
            resize,
            drag_start,
            drag_move
        ])
        .build()
}

/// 验证钩子：`ACA_FLOAT_SMOKE=1` 时启动即走一遍真实的 `enter` 路径。
///
/// 为什么要有它：悬浮窗平时只能靠**点** dashboard 的按钮才会出现，而"远程 origin 的 IPC
/// 到底有没有被 capability 放行"是本任务唯一的硬结论，不能只靠读源码。这个钩子让
/// `ACA_FLOAT_SMOKE=1 HOME=<sandbox> <debug 二进制>` 就能把整条链路跑起来，并在日志里留下
/// `[float] resize 上报 …` 这行 —— 它同时证明：远程页面加载了、`ccMonitor` 垫片注入了、
/// IPC 被 ACL 放行了、Rust 命令执行了、几何计算拿到真实工作区了。
///
/// 只在 debug 构建里存在（release 不带这个后门）。等代理起来再建窗，避免首个 poll 落空。
#[cfg(debug_assertions)]
pub fn spawn_smoke_if_requested<R: Runtime>(app: &AppHandle<R>) {
    if std::env::var_os("ACA_FLOAT_SMOKE").is_none() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..100 {
            if crate::MONITOR_PORT.load(Ordering::Relaxed) != 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        match enter_impl(&app).await {
            Ok(()) => println!("[float] smoke：已按 ACA_FLOAT_SMOKE 唤起悬浮窗"),
            Err(e) => eprintln!("[float] smoke 失败：{e}"),
        }

        // 再等首帧 resize 落定，然后**照 mini.html 的 mousedown/mousemove 参数**走一遍拖动，
        // 把「outer_position → 逻辑坐标 → set_position」这段 DPI 转换也变成可观测的实测值
        // （纯算式由单测覆盖，这里验的是真窗口上的那层胶水）。
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let Some(window) = app.get_webview_window(FLOAT_LABEL) else {
            return;
        };
        let scale = window.scale_factor().unwrap_or(1.0);
        let read_pos = || {
            window
                .outer_position()
                .map(|p| {
                    let l = p.to_logical::<f64>(scale);
                    (l.x, l.y)
                })
                .map_err(|e| e.to_string())
        };
        let before = read_pos();
        let started = drag_start(window.clone(), 100.0, 100.0).await;
        let moved = drag_move(window.clone(), 150.0, 130.0).await;
        // 关键：`set_position` 是**派发给主线程事件循环异步执行**的，不是同步改 NSWindow；
        // 紧接着读 `outer_position()` 会读到旧值 —— 第一版实测就是 before == after，
        // 差点误判成"拖动没生效"。这里等一拍再读。
        tokio::time::sleep(Duration::from_millis(400)).await;
        let after = read_pos();
        println!(
            "[float] smoke 拖动（鼠标 (100,100)→(150,130)，期望窗口 +50/+30）：{before:?} → {after:?}（start={started:?} move={moved:?}）"
        );
    });
}

#[cfg(not(debug_assertions))]
pub fn spawn_smoke_if_requested<R: Runtime>(_app: &AppHandle<R>) {}

#[cfg(test)]
mod tests {
    use super::*;
    use regex::Regex;

    // ── 几何：右上角定位 ────────────────────────────────────────────

    #[test]
    fn top_right_is_110px_from_the_right_edge_and_y_is_8() {
        // Electron 的 (sw - w - 110, 8)：1440 宽、240 宽卡片 → 1090
        assert_eq!(top_right_position(1440.0, 240.0), (1090.0, 8.0));
        // 逐字对齐 Node 的字面量，防止有人"顺手"改成别的留白或相对工作区顶部
        assert_eq!(TOP_RIGHT_MARGIN_X, 110.0);
        assert_eq!(TOP_RIGHT_Y, 8.0);
        // 窗口比工作区还宽时 x 为负 —— Node 不做夹取，这里也不夹（如实保留）
        assert_eq!(top_right_position(100.0, 240.0), (-250.0, 8.0));
    }

    #[test]
    fn first_real_size_wins_and_later_resizes_do_not_reposition() {
        let mut g = FloatGeometry::default();
        // mini.html 初始 1x1（以及 RO 首帧可能的 0/极小值）都不是"真实尺寸"
        assert_eq!(g.on_resize(1.0, 1.0, Some(1440.0)), None);
        assert_eq!(g.on_resize(0.0, 0.0, Some(1440.0)), None);
        assert_eq!(g.on_resize(18.0, 1.0, Some(1440.0)), None, "h 不大于 1 不算真实尺寸");
        assert!(!g.is_positioned(), "没定位成功就不该消耗掉首次机会");

        // 第一次真实尺寸 → 定位
        assert_eq!(g.on_resize(240.0, 60.0, Some(1440.0)), Some((1090.0, 8.0)));
        assert!(g.is_positioned());
        // 之后尺寸怎么变都不再重定位（用户可能已经把它拖走了）
        assert_eq!(g.on_resize(300.0, 80.0, Some(1440.0)), None);
        assert_eq!(g.on_resize(240.0, 60.0, Some(1920.0)), None);
    }

    #[test]
    fn missing_work_area_defers_positioning_instead_of_using_zero() {
        let mut g = FloatGeometry::default();
        assert_eq!(g.on_resize(240.0, 60.0, None), None);
        assert!(!g.is_positioned());
        // 下一次拿到工作区仍然会定位（不是"永久放弃"）
        assert_eq!(g.on_resize(240.0, 60.0, Some(1440.0)), Some((1090.0, 8.0)));
    }

    #[test]
    fn reset_lets_a_newly_created_window_position_again() {
        let mut g = FloatGeometry::default();
        assert_eq!(g.on_resize(240.0, 60.0, Some(1440.0)), Some((1090.0, 8.0)));
        g.reset();
        assert!(!g.is_positioned());
        assert_eq!(g.on_resize(240.0, 60.0, Some(1440.0)), Some((1090.0, 8.0)));
    }

    // ── 几何：自定义拖动 ────────────────────────────────────────────

    #[test]
    fn drag_is_origin_plus_mouse_delta() {
        // Node: bounds.x + (x - mouse.x)
        assert_eq!(
            drag_position((100.0, 200.0), (10.0, 20.0), (30.0, 50.0)),
            (120.0, 230.0)
        );
        // 往回拖
        assert_eq!(
            drag_position((100.0, 200.0), (10.0, 20.0), (-5.0, -5.0)),
            (85.0, 175.0)
        );
        // 鼠标没动 → 窗口不动
        assert_eq!(
            drag_position((7.5, -3.25), (10.0, 20.0), (10.0, 20.0)),
            (7.5, -3.25)
        );
    }

    #[test]
    fn drag_state_ignores_moves_before_a_start() {
        let mut d = DragState::default();
        // Node: 没有 floatDragWin / floatDragMouse 时 move 直接 return
        assert_eq!(d.moved((50.0, 50.0)), None);
        d.begin((100.0, 200.0), (10.0, 20.0));
        assert_eq!(d.moved((30.0, 50.0)), Some((120.0, 230.0)));
        // 再 begin 一次会换锚点（Node 的 mousedown 分支同义）
        d.begin((0.0, 0.0), (300.0, 300.0));
        assert_eq!(d.moved((305.0, 300.0)), Some((5.0, 0.0)));
    }

    // ── 桥的四方一致性（这几处漂移都不会让构建失败）────────────────

    /// `mini.html` / `dashboard.html` 里 `window.ccMonitor.X` 的调用点，必须都被垫片覆盖。
    #[test]
    fn shim_covers_every_ccmonitor_call_the_embedded_pages_make() {
        let call = Regex::new(r"window\.ccMonitor\.([A-Za-z_][A-Za-z0-9_]*)").unwrap();
        let declared: Vec<&str> = BRIDGE.iter().map(|(m, ..)| *m).collect();
        let shim = cc_monitor_shim();

        for (file, src) in [
            ("mini.html", crate::proxy::assets::MINI_HTML),
            ("dashboard.html", crate::proxy::assets::DASHBOARD_HTML),
        ] {
            let calls: Vec<&str> = call
                .captures_iter(src)
                .map(|c| c.get(1).unwrap().as_str())
                .collect();
            assert!(!calls.is_empty(), "{file} 里应该至少有一个 ccMonitor 调用点");
            for name in calls {
                // dashboard 的 getPort() 是唯一例外：dashboard 由代理自己托管，
                // window.location.port 就是真值（它自带 try/catch 回退），不需要桥。
                if name == "getPort" {
                    assert!(
                        src.contains("window.location.port"),
                        "getPort 不在桥里，dashboard 必须保留 location.port 回退"
                    );
                    assert!(
                        !shim.contains("getPort"),
                        "垫片不该凭空提供 getPort（代理端口只有页面自己知道）"
                    );
                    continue;
                }
                assert!(
                    declared.contains(&name),
                    "{file} 调用了 ccMonitor.{name}，但垫片没提供（BRIDGE 里没有）"
                );
                assert!(
                    shim.contains(&format!("{name}: function")),
                    "垫片里找不到 {name}: function"
                );
            }
        }
    }

    /// 垫片的方法集合，必须与**两个内嵌页面真正调用**的 ccMonitor 方法集合完全相同（不多不少）。
    ///
    /// 契约来源从 `src/preload.d.ts` 换成页面本身：Electron 壳随全量迁移删除后那份 d.ts 不再存在。
    /// 改从**消费方**取 ground truth 也更硬 —— 声明文件会忘记跟着改，调用点不会。
    /// 实测两集合相等：BRIDGE 的 5 个方法 = 页面调用的 6 个名字去掉 `getPort`。
    #[test]
    fn shim_method_set_equals_the_calls_the_embedded_pages_make() {
        let call = Regex::new(r"window\.ccMonitor\.([A-Za-z_][A-Za-z0-9_]*)").unwrap();
        let mut called: Vec<String> = Vec::new();
        for src in [
            crate::proxy::assets::MINI_HTML,
            crate::proxy::assets::DASHBOARD_HTML,
        ] {
            for c in call.captures_iter(src) {
                let name = c.get(1).unwrap().as_str();
                // getPort 是唯一例外：页面自己用 window.location.port 回退，垫片刻意不提供
                // （见上面 shim_covers_every_ccmonitor_call_the_embedded_pages_make）。
                if name != "getPort" {
                    called.push(name.to_string());
                }
            }
        }
        called.sort();
        called.dedup();

        let mut shimmed: Vec<String> = BRIDGE.iter().map(|(m, ..)| m.to_string()).collect();
        shimmed.sort();

        assert_eq!(
            shimmed, called,
            "垫片方法集合与页面实际调用的 ccMonitor 方法集合不一致（方法名或数量漂移）"
        );
        assert_eq!(shimmed.len(), 5, "契约是 5 个方法");
    }

    /// 垫片调用的每个插件命令，都必须在 `build.rs` 的 ACL 清单里 —— 否则远程 IPC 会被拒。
    #[test]
    fn every_shim_command_is_declared_in_the_acl_manifest_source() {
        let build_rs = include_str!("../build.rs");
        assert!(
            build_rs.contains(PLUGIN_NAME),
            "build.rs 没有注册 {PLUGIN_NAME} 这个 inlined plugin"
        );

        // `plugin()` 里那句 `#![plugin(<名字>)]` 是**字面量**（宏用 parse_args::<Ident>() 取它，
        // 写成常量路径编译不过），所以它会与 PLUGIN_NAME 各自漂移。这条断言把两者钉在一起：
        // 少了它，命令前缀会退化成空串，5 条桥命令会被 removeUnusedCommands 静默裁掉
        // （判据是构建产物里的 allowed-commands.json，测试跑不到，只能在这里拦）。
        let source = include_str!("float_window.rs");
        assert!(
            source.contains(&format!("#![plugin({PLUGIN_NAME})]")),
            "plugin() 的 generate_handler 缺少 #![plugin({PLUGIN_NAME})] 内层属性 —— \
             没有它，命令前缀退化成空串，这 5 条桥命令会被命令裁剪静默删掉"
        );

        for (method, cmd, ..) in BRIDGE {
            assert!(
                build_rs.contains(&format!("\"{cmd}\"")),
                "BRIDGE 里的 {method} → {cmd} 没出现在 build.rs 的 InlinedPlugin::commands 里"
            );
            let shim = cc_monitor_shim();
            assert!(
                shim.contains(&format!("plugin:{PLUGIN_NAME}|{cmd}")),
                "垫片没有把 {method} 指向 plugin:{PLUGIN_NAME}|{cmd}"
            );
        }
    }

    /// 垫片是注入到**远程页面**里的：命令名必须带 `plugin:` 前缀（应用命令的形式在这里会被拒）。
    #[test]
    fn shim_invokes_plugin_commands_not_app_commands() {
        let shim = cc_monitor_shim();
        let invoke = Regex::new(r"invoke\('([^']+)'").unwrap();
        let cmds: Vec<&str> = invoke
            .captures_iter(&shim)
            .map(|c| c.get(1).unwrap().as_str())
            .collect();
        assert_eq!(cmds.len(), BRIDGE.len(), "每个方法恰好一次 invoke");
        for cmd in cmds {
            assert!(
                cmd.starts_with(&format!("plugin:{PLUGIN_NAME}|")),
                "{cmd} 不是插件命令 —— 远程 origin 拿不到应用命令"
            );
        }
        assert!(
            shim.contains("__TAURI_INTERNALS__.invoke"),
            "垫片用的应该是 Tauri 注入的 invoke"
        );
    }

    /// 悬浮窗的页面地址必须落在 capability `remote.urls` 的模式内。
    ///
    /// 这条容易踩的坑实测过：URLPattern 里 `http://127.0.0.1/*` 的 port 段是**空字面量**，
    /// 匹配不上 `:8090`；必须写成 `:*`（见方案 §8bis 的实测输出）。
    #[test]
    fn float_url_is_covered_by_the_remote_capability_pattern() {
        let capability = include_str!("../capabilities/float.json");
        assert!(
            capability.contains("http://127.0.0.1:*/*"),
            "capability 的 remote.urls 必须给端口加 :* 通配"
        );
        assert!(
            capability.contains(&format!("\"{FLOAT_LABEL}\"")),
            "capability 必须指向窗口 label {FLOAT_LABEL}"
        );
        let pattern = include_str!("../capabilities/float.json");
        // 端口是可配置的（config.json），所以不能把默认 8090 写死在断言里：
        // 这里用一个"非默认端口"验证模式本身覆盖任意端口。
        let probe: tauri::utils::acl::RemoteUrlPattern =
            "http://127.0.0.1:*/*".parse().expect("URLPattern 可解析");
        for port in [8090u16, 9123, 1] {
            let url: url::Url = format!("http://127.0.0.1:{port}/mini.html").parse().unwrap();
            assert!(probe.test(&url), "{url} 应被 {pattern:?} 覆盖");
        }
        let evil: url::Url = "https://evil.example/mini.html".parse().unwrap();
        assert!(!probe.test(&evil), "别的域名不该被放行");
    }

    // ── 真正的 ACL 断言：用 build.rs **生成**的 ACL 产物做判权 ────────────
    //
    // 为什么不用 `tauri::test::get_ipc_response` + `generate_context!()`：
    // `generate_context!()` 在 macOS 上会 `#[no_mangle]` 嵌一个 `_EMBED_INFO_PLIST` 符号，
    // 同一个二进制里只能展开一次 —— lib.rs 的 `run()` 已经用过了，lib 的单测再来一次实测直接
    // 编译失败：`error: symbol `_EMBED_INFO_PLIST` is already defined`。
    // 所以这里退一层：读 build.rs 写出的 `gen/schemas/{acl-manifests,capabilities}.json`，
    // 走 `Resolved::resolve` + `RuntimeAuthority::resolve_access` ——
    // 后者正是 IPC 路径（`Webview::on_message`）里判权的那个函数（`invoke.acl.is_none()` 的分母），
    // 判据与线上完全一致，且用的是真实生成的 capability 文件而不是手抄的期望值。
    mod acl {
        use super::super::*;
        use std::collections::BTreeMap;

        use tauri::ipc::{Origin, RuntimeAuthority};
        use tauri::utils::acl::capability::Capability;
        use tauri::utils::acl::manifest::Manifest;
        use tauri::utils::acl::resolved::Resolved;
        use tauri::utils::platform::Target;

        /// 悬浮窗真实加载的地址（端口可配置，8090 是默认值）。
        const REMOTE_MINI: &str = "http://127.0.0.1:8090/mini.html";

        fn authority() -> RuntimeAuthority {
            let acl: BTreeMap<String, Manifest> =
                serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json"))
                    .expect("解析 gen/schemas/acl-manifests.json");
            let capabilities: BTreeMap<String, Capability> =
                serde_json::from_str(include_str!("../gen/schemas/capabilities.json"))
                    .expect("解析 gen/schemas/capabilities.json");
            let resolved =
                Resolved::resolve(&acl, capabilities, Target::current()).expect("解析 ACL");
            tauri::runtime_authority!(acl, resolved)
        }

        /// 与 `on_message` 同义：`Some` = 放行，`None` = 拒绝。
        fn allowed(auth: &RuntimeAuthority, cmd: &str, window: &str, origin: &Origin) -> bool {
            auth.resolve_access(cmd, window, window, origin).is_some()
        }

        fn remote(url: &str) -> Origin {
            Origin::Remote {
                url: url.parse().expect("URL 可解析"),
            }
        }

        /// 前提：悬浮窗的地址**不是** app origin —— 这正是"必须配 remote capability"的原因。
        ///
        /// 用的是 `is_local_url` 内部同一套判断（`get_app_url().make_relative(current)`）。
        #[test]
        fn float_url_is_not_the_local_app_origin() {
            let app_url = url::Url::parse("tauri://localhost").unwrap();
            let float_url = url::Url::parse(REMOTE_MINI).unwrap();
            assert!(
                app_url.make_relative(&float_url).is_none(),
                "127.0.0.1:8090 不该被当成 app URL"
            );
            // 反向对照：真正 app origin 下的页面是"相对"的（说明这个判据不是永远返回 None）
            let own = url::Url::parse("tauri://localhost/index.html").unwrap();
            assert!(app_url.make_relative(&own).is_some());
        }

        /// 正面：远程 `mini.html` 能用 5 个桥命令 —— 这就是 §6.2 选项 (b) 的落地证明。
        #[test]
        fn remote_mini_page_is_granted_the_float_bridge() {
            let auth = authority();
            for (method, cmd, ..) in BRIDGE {
                assert!(
                    allowed(&auth, &format!("plugin:{PLUGIN_NAME}|{cmd}"), FLOAT_LABEL, &remote(REMOTE_MINI)),
                    "远程 mini.html 调 {method}（plugin:{PLUGIN_NAME}|{cmd}）应被放行"
                );
            }
        }

        /// 反面：**别的** remote origin 拿不到（否则 `remote.urls` 等于没写）。
        #[test]
        fn other_remote_origins_are_denied() {
            let auth = authority();
            for origin in [
                "https://evil.example/mini.html",
                "http://127.0.0.1.evil.example/mini.html", // 主机名以 127.0.0.1 开头但并非它
                "http://localhost:8090/mini.html",         // 只放行了 127.0.0.1，不放行 localhost
                "http://127.0.0.2:8090/mini.html",         // 另一个回环地址
                "http://[::1]:8090/mini.html",             // 代理也监听 ::1，但 capability 没放行
            ] {
                assert!(
                    !allowed(
                        &auth,
                        &format!("plugin:{PLUGIN_NAME}|resize"),
                        FLOAT_LABEL,
                        &remote(origin)
                    ),
                    "{origin} 不该被放行"
                );
            }
        }

        /// 反面：主窗口只被授予 `enter`，不能反过来摆布悬浮窗。
        #[test]
        fn main_window_may_enter_float_mode_but_not_drive_the_float_window() {
            let auth = authority();
            assert!(
                allowed(&auth, &format!("plugin:{PLUGIN_NAME}|enter"), "main", &Origin::Local),
                "dashboard 的悬浮框按钮要能进悬浮模式"
            );
            assert!(
                !allowed(&auth, &format!("plugin:{PLUGIN_NAME}|resize"), "main", &Origin::Local),
                "主窗口不该有权 resize 悬浮窗"
            );
        }

        /// 反面：主窗口的 capability 没有 `remote`，所以远程内容进不来。
        #[test]
        fn remote_content_cannot_reach_the_main_window_capability() {
            let auth = authority();
            assert!(
                !allowed(
                    &auth,
                    &format!("plugin:{PLUGIN_NAME}|enter"),
                    "main",
                    &remote(REMOTE_MINI)
                ),
                "主窗口的权限只对本地 origin 生效"
            );
        }

        /// 反面：窗口 label 不匹配也拿不到（capability 的 `windows: ["float"]` 真的在起作用）。
        #[test]
        fn a_different_window_label_does_not_get_the_float_bridge() {
            let auth = authority();
            assert!(
                !allowed(
                    &auth,
                    &format!("plugin:{PLUGIN_NAME}|resize"),
                    "some-other-window",
                    &remote(REMOTE_MINI)
                ),
                "只有 label=float 的窗口能驱动悬浮窗"
            );
        }
    }
}
