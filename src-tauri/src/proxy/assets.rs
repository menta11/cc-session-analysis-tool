//! `dashboard.html` / `mini.html` 的内嵌静态服务 + 页面路由表。
//!
//! 行为对齐 Electron 版（`proxy.js` 的 serveDashboardHtml / serveMiniHtml）：
//! - `GET /` 与 `GET /index.html` → dashboard，**容忍查询串**（`?theme=` 由宿主 iframe 首帧带入）；
//! - `GET /mini.html` → 悬浮窗页面；
//! - **服务端不做任何注入**：HTML 原样返回，主题由页面内的脚本自己读 query 解析。
//!
//! 一处有意的差别：Node 在 `DEV` 下每次读磁盘以实现热加载，这里改为**编译期 `include_str!` 嵌入**。
//! 理由：打包后的应用不该依赖磁盘上还存在这几个文件；顺带省掉运行期 IO 与"文件被删/改坏"这类失败模式。
//! 代价是失去热加载 —— 而这在 Tauri 里由"改完重新构建"承担，本来就是正常流程。
//!
//! 模块很小但单独拆出来的价值：路由表是**纯函数**，能不依赖网络直接单测（见文末）。

/// dashboard / mini 都用它。与 Node 的 `writeHead` 逐字一致（含 charset）。
pub const CONTENT_TYPE_HTML: &str = "text/html; charset=utf-8";

/// 编译期嵌入 —— 这两个文件是自包含单文件（CSS/JS 全内联），所以没有"外部资源路径"问题。
pub const DASHBOARD_HTML: &str = include_str!("../../../vendor/cc-monitor/dashboard.html");
pub const MINI_HTML: &str = include_str!("../../../vendor/cc-monitor/mini.html");

/// 页面路由表：请求目标 → 要原样吐出的 HTML；`None` = 不是页面，继续走后面的逻辑。
///
/// 查询串必须容忍：`/`、`/?theme=dark`、`/index.html?theme=light` 都要命中同一页
/// （Node 侧是 `req.url.split('?')[0]`，这里等价）。
pub fn page_for(target: &str) -> Option<&'static str> {
    match path_of(target) {
        "/" | "/index.html" => Some(DASHBOARD_HTML),
        "/mini.html" => Some(MINI_HTML),
        _ => None,
    }
}

/// dev 热加载辅助端点（`/__dev_mtime__`、`/__dev_mini_mtime__`）。
///
/// Node 只在 `DEV` 下注册它们。内嵌模式下既没有 mtime 也不需要热加载，所以**明确 404**。
/// 之所以要专门认出来：**绝不能让它们落到 passthrough 上** —— 那会把一个本地辅助端点
/// 当成 API 请求转发给上游（Node 侧也用 blocklist 避免这件事）。
pub fn is_dev_mtime_endpoint(target: &str) -> bool {
    // 与 Node 的 STREAM_REQUEST_BLOCKLIST 逐字一致（proxy.js 里就这两个）。
    // ⚠️ 曾经这里写的是 `/__dev_dashboard_mtime__` —— 那是**凭空猜的名字**：
    // dashboard.html 真正探测的是 `/__dev_mtime__`，猜错导致探测请求落到 passthrough、
    // 被转发到上游；上游若返回 200 JSON，页面还会进入 1Hz 的上游轮询。
    // 更糟的是当时的单测断言的也是那个错名字，于是绿灯掩盖了 bug（测试钉错了对象）。
    // 现在名字由下方 `recognises_every_dev_endpoint_the_pages_actually_probe` 直接从
    // dashboard.html / mini.html 的源码里抽取比对，名字一改测试就会红。
    matches!(path_of(target), "/__dev_mtime__" | "/__dev_mini_mtime__")
}

/// 去掉查询串。与 Node 的 `req.url.split('?')[0]` 等价。
fn path_of(target: &str) -> &str {
    target.split('?').next().unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashboard_hits_root_and_index_and_tolerates_query() {
        for t in [
            "/",
            "/?theme=dark",
            "/index.html",
            "/index.html?theme=light",
            "/?theme=dark&extra=1",
        ] {
            assert_eq!(page_for(t), Some(DASHBOARD_HTML), "目标 {t} 应命中 dashboard");
        }
    }

    #[test]
    fn mini_hits_its_own_path() {
        assert_eq!(page_for("/mini.html"), Some(MINI_HTML));
        assert_eq!(page_for("/mini.html?theme=dark"), Some(MINI_HTML));
    }

    /// 关键回归：这些路径**必须**继续走后面的逻辑（状态 / 配置 / 计数 / 透传），
    /// 不能被页面路由吃掉 —— 否则会把 API 请求变成 HTML 响应。
    #[test]
    fn api_paths_are_not_treated_as_pages() {
        for t in [
            "/status",
            "/config/baseurl",
            "/tokencount",
            "/v1/messages",
            "/v1/messages?beta=true",
            "/foo",
        ] {
            assert_eq!(page_for(t), None, "目标 {t} 不该被页面路由命中");
        }
    }

    #[test]
    fn embedded_pages_are_the_real_files_not_placeholders() {
        // 防呆：万一 include_str 路径写错（编译期就会失败，但防止嵌成别的小文件）
        assert!(
            DASHBOARD_HTML.len() > 50_000,
            "dashboard.html 大小异常：{}",
            DASHBOARD_HTML.len()
        );
        assert!(DASHBOARD_HTML.contains("<html"), "dashboard.html 不像 HTML");
        assert!(MINI_HTML.contains("<html"), "mini.html 不像 HTML");
    }

    #[test]
    fn dev_mtime_endpoints_are_recognised_so_they_get_404d() {
        assert!(is_dev_mtime_endpoint("/__dev_mtime__"));
        assert!(is_dev_mtime_endpoint("/__dev_mini_mtime__"));
        assert!(is_dev_mtime_endpoint("/__dev_mini_mtime__?x=1"));
        // 正常的页面/接口不能被误判
        assert!(!is_dev_mtime_endpoint("/mini.html"));
        assert!(!is_dev_mtime_endpoint("/status"));
        // 曾经猜错的那个名字**不该**被认出来（认出来等于没修）
        assert!(!is_dev_mtime_endpoint("/__dev_dashboard_mtime__"));
    }

    /// 这条测试的输入**直接来自消费者源码**（dashboard.html / mini.html 里真实 fetch 的目标），
    /// 而不是手抄的常量。
    ///
    /// 为什么必须这样：上一版把名字猜成 `/__dev_dashboard_mtime__`（全仓只存在于本文件里），
    /// 而单测断言的正是那个错名字 —— 于是绿灯把 bug 盖住了：页面探测 `/__dev_mtime__` 时
    /// `is_dev_mtime_endpoint` 返回 false，请求落到 passthrough 被转发到上游（上游回 200 JSON
    /// 还会让页面进入 1Hz 上游轮询并污染捕获环）。
    /// 从页面源码抽取名字之后，**消费者改名字，这条测试就会红** —— 它钉的是正确的对象。
    #[test]
    fn recognises_every_dev_endpoint_the_pages_actually_probe() {
        let mut checked = 0usize;
        for (name, html) in [("dashboard.html", DASHBOARD_HTML), ("mini.html", MINI_HTML)] {
            for (idx, _) in html.match_indices("/__dev") {
                let rest = &html[idx..];
                // 一直取到引号/空白/括号等非路径字符为止
                let end = rest
                    .find(|c: char| {
                        !(c.is_ascii_alphanumeric() || c == '_' || c == '/' || c == '?')
                    })
                    .unwrap_or(rest.len());
                let path = rest[..end].split('?').next().unwrap_or(&rest[..end]);
                assert!(
                    is_dev_mtime_endpoint(path),
                    "{name} 真实探测的 {path} 未被 is_dev_mtime_endpoint 识别 → 会被 passthrough 转发到上游"
                );
                checked += 1;
            }
        }
        // 防空转：抽不到任何名字说明这个测试自己失效了，不能默默通过
        assert!(
            checked >= 2,
            "没有从页面源码里抽到 dev 端点，测试本身已失效（checked={checked}）"
        );
    }
}
