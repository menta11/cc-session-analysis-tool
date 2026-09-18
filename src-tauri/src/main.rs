// Windows release 构建不弹控制台窗口（与 Tauri 模板一致）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    app_lib::run()
}
