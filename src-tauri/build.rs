fn main() {
    // ── 悬浮窗 `ccMonitor` 桥 ─────────────────────────────────────────────
    //
    // 做成 **inlined plugin** 而不是 `Builder::invoke_handler` 的应用命令，理由见
    // `src/float_window.rs` 模块头：Tauri 的 ACL 里有一句全局开关 —— 只要声明了 app manifest
    // （`AppManifest::commands`），**所有**应用命令都会开始要求逐条放行，连本地主窗口都会
    // 被拒；而 inlined plugin 有自己独立的 manifest（`float:allow-*`），`has_app_acl` 保持
    // false，现有 11 个应用命令的行为一行不变。
    //
    // 这里列出的命令名会被 tauri-build 生成为权限 `float:allow-<名字>`（命令名里的 `_`
    // 转成 `-`，见 tauri-utils 的 `autogenerate_command_permissions`），
    // `capabilities/float.json` 里引用的就是这些标识符。
    // 这份清单与 `float_window.rs` 的 `BRIDGE` / `plugin()` 必须一致 —— 由该文件的单测
    // `every_shim_command_is_declared_in_the_acl_manifest_source` 交叉断言。
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "float",
            tauri_build::InlinedPlugin::new().commands(&[
                "enter",
                "back_to_dashboard",
                "resize",
                "drag_start",
                "drag_move",
            ]),
        ),
    )
    .expect("tauri-build 失败");

    embed_test_manifest();
}

/// 给**测试二进制**嵌一份 Windows 应用清单。
///
/// 为什么需要：`muda`（Tauri 菜单的底层库）的 Windows 后端静态导入
/// `comctl32.dll!TaskDialogIndirect`，而该符号只由 comctl32 **v6** 导出 —— v6 要靠
/// Side-by-Side 激活上下文加载，也就是可执行文件里得嵌一份声明。
///
/// `tauri-build` 只给**应用二进制**嵌清单；cargo 构建的集成测试二进制（`tests/menu_structure.rs`）
/// 拿不到，于是加载即失败、一行输出都没有：
///
/// ```text
/// menu_structure-*.exe (exit code: 0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND)
/// ```
///
/// 用 `rustc-link-arg-tests`（只作用于 `--test` 目标）而不是 `-bins`：应用二进制已由
/// tauri-build 处理，重复嵌反而可能撞车。选项前缀用 `-` 而不是 `/` —— MSVC 链接器两种都收，
/// 但 `-` 不会踩到「link-arg 必须以 `-` 开头」这类工具链约定。
fn embed_test_manifest() {
    if !cfg!(windows) {
        return;
    }
    let manifest = std::path::Path::new("tests/comctl32-v6.manifest");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let abs = manifest
        .canonicalize()
        .expect("tests/comctl32-v6.manifest 不存在");
    println!("cargo:rustc-link-arg-tests=-MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-tests=-MANIFESTINPUT:{}", abs.display());
}
