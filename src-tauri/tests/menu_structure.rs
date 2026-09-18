//! 应用菜单 / 托盘菜单的**结构**断言 —— 真实构造 Tauri 菜单对象（MockRuntime）后断言层级、
//! id 与标签，用来钉住「文件 → 导入会话」这条路存在、以及托盘标签逐字对齐 Node 参考实现。
//!
//! **为什么是 `harness = false` 的独立测试二进制**：muda（Tauri 菜单的底层库）在 macOS 上
//! 硬性要求 `Menu` / `MenuChild` 只能在**主线程**创建，而 `cargo test` 的普通用例跑在派生
//! 线程上 —— 实测直接构造会 panic：
//!   `muda::Menu can only be created on the main thread`
//! `harness = false` 后由本文件的 `main()` 执行，正是进程主线程，于是可以构造真菜单。
//! （先试过把这两个用例写成普通 `#[test]`，`cargo test` 实测 3 failed，故改为此形态。）
//!
//! **这个测试不覆盖什么**：它只证明菜单长什么样，**不证明点了会发生什么** —— 点击、
//! 文件选择框、事件送达到渲染层这些都点不动，需要人工确认（见方案 §8bis）。

use tauri::menu::{Menu, MenuItemKind};
use tauri::test::MockRuntime;

fn main() {
    app_menu_structure();
    tray_menu_labels();
    println!("menu_structure: 2/2 OK");
}

/// 顶层有 文件/编辑/视图；「文件」下第一项就是「导入会话 (.jsonl)…」且 id 固定。
fn app_menu_structure() {
    let app = tauri::test::mock_app();
    let menu = app_lib::build_app_menu(app.handle()).expect("构建应用菜单");
    let tops = menu.items().expect("顶层菜单项");

    let labels: Vec<String> = tops
        .iter()
        .filter_map(|i| i.as_submenu().and_then(|s| s.text().ok()))
        .collect();
    for expected in ["文件", "编辑", "视图"] {
        assert!(
            labels.contains(&expected.to_string()),
            "顶层菜单缺少「{expected}」，实际：{labels:?}"
        );
    }
    // macOS 上第一项必须是 app 子菜单（关于/服务/隐藏/退出），其余平台没有。
    let first = labels.first().map(String::as_str);
    if cfg!(target_os = "macos") {
        assert_eq!(first, Some("Claude 会话工具集"), "macOS 首项应为 app 子菜单");
    } else {
        assert_eq!(first, Some("文件"), "非 macOS 首项应为「文件」");
    }

    let file = tops
        .iter()
        .filter_map(|i| i.as_submenu())
        .find(|s| s.text().ok().as_deref() == Some("文件"))
        .expect("「文件」子菜单");
    let file_items = file.items().expect("文件子菜单项");
    let import = file_items
        .iter()
        .filter_map(|i| i.as_menuitem())
        .find(|m| m.id().0 == "import_session")
        .expect("「文件」下应有 id=import_session 的菜单项");
    assert_eq!(import.text().unwrap(), "导入会话 (.jsonl)…");
    // 顺序也钉住：导入项必须是第一项（Node 里它就在最前面）。
    let first_is_import = matches!(
        file_items.first(),
        Some(MenuItemKind::MenuItem(m)) if m.id().0 == "import_session"
    );
    assert!(first_is_import, "「导入会话」应是「文件」的第一项");
}

/// 托盘标签逐字对齐 Node 的 `buildMenuTemplate()`：`实时监控 (Running|Stopped)` /
/// `●监控中` / `○已停用` / `重启代理`。
fn tray_menu_labels() {
    let app = tauri::test::mock_app();

    let texts = |menu: &Menu<MockRuntime>| -> Vec<String> {
        menu.items()
            .expect("托盘菜单项")
            .iter()
            .filter_map(|i| i.as_menuitem().and_then(|m| m.text().ok()))
            .collect()
    };

    let running_off = texts(&app_lib::build_tray_menu(app.handle(), true, false).expect("托盘菜单"));
    assert!(running_off.contains(&"实时监控 (Running)".to_string()), "{running_off:?}");
    assert!(running_off.contains(&"○已停用".to_string()), "{running_off:?}");
    assert!(running_off.contains(&"打开主窗口".to_string()), "{running_off:?}");
    assert!(running_off.contains(&"重启代理".to_string()), "{running_off:?}");
    assert!(running_off.contains(&"退出".to_string()), "{running_off:?}");

    let stopped_on = texts(&app_lib::build_tray_menu(app.handle(), false, true).expect("托盘菜单"));
    assert!(stopped_on.contains(&"实时监控 (Stopped)".to_string()), "{stopped_on:?}");
    assert!(stopped_on.contains(&"●监控中".to_string()), "{stopped_on:?}");
}
