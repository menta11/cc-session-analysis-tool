//! cc-monitor 内嵌 HTTP 代理。
//!
//! **为什么是整体搬入而不是重写**：参考实现已经通过 `test/proxy-contract/CONTRACT.md` 的全部用例
//! （85 条契约 + 160 例分帧 golden + 49 条 Rust 单测）。把它搬成正式模块等于**直接继承这份证据**；
//! 推倒重写会让这些证据全部作废。
//!
//! 「进程入口」拆成两种用法 ——
//!   - **应用内**：`start_background()`，由 `lib.rs` 的 setup 调用；起不来只告警，
//!     绝不阻塞主功能（会话分析不依赖代理）。
//!   - **独立进程**：`src/bin/proxy-standalone.rs`。契约测试必须能 spawn 一个进程再用 HTTP 驱动它，
//!     所以两种入口都要有，且**共用同一份实现**（这正是让契约测试对"真实模块"生效的关键）。
//!
//! 已覆盖：透传 / SSE 字节保真 / 请求头 / 上游错误 / 502 / base URL 优先级 /
//! settings 四道闸 / token 计数。
//!
//! 诊断层进度（proxy.js 后半）：dashboard 与 mini 页面服务、capture ring（`/requests/recent`、
//! `/requests/clear`、`/requests/stream`）、`/events`、`/events/stream`、`/events/clear` 已接；
//! agent 表（`agents.rs`）已接出**身份解析 + 每流状态 + 显示状态机（`calcAgentStatus`）+
//! idle cleanup + 十个状态转换事件**，`/status` 已是 Node `buildStatus()` 的完整形状；
//! `/event/detail` 与 `/event/detail/stream` 已接（含捕获条目的 `details` 诊断快照）；
//! `/agent/prompts`、`/agent/kill`、`/session`、`/config/idle`、`/cleanup/debug` 均已接。
//! **proxy.js 的全部事件来源（含字节损坏取证、流末 no-delta 分流、收尾类、60s 看门狗）
//! 已于 2026-09-15 补齐** —— 完整清单见 `events.rs` 模块头。
pub mod agents;
pub mod assets;
pub mod broadcast;
pub mod capture;
pub mod detail;
pub mod env;
pub mod events;
pub mod log;
pub mod router;
pub mod safe_write;
pub mod session;
pub mod settings;
pub mod sse;
pub mod state;
pub mod upstream;

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use router::{AppState, Upstream};

/// 应用内监听任务的句柄（托盘「重启代理」用，2.4 壳层）。
///
/// 为什么需要它：`axum::serve` 一旦 spawn 出来就没有句柄可停；而如果用
/// `with_graceful_shutdown`，只要还有长连 SSE（`/requests/stream`、`/events/stream`）
/// 就永远等不到「无连接」状态，端口也就永远不释放 —— 「重启」会直接卡住。
/// `abort()` 让任务在下一个 await 点被取消、监听 socket 立即 drop，端口随即可重绑；
/// 这正是「重启」要的语义（长连客户端会看到连接重置，与 Node 的 `stopProxy()` 同效）。
///
/// **独立进程入口（`run_standalone`）不用这个表**：它自己 await 自己那批句柄。
///
/// 表里除监听任务外还有 **idle cleanup timer**（`spawn_cleanup_loop`）—— 它同样必须
/// 在停止时被 abort，否则「重启代理」会攒下第二个 timer（Node 的 `stopProxy()` 里
/// `clearInterval(_cleanupTimer)` 就是干这件事）。
static SERVE_TASKS: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>> =
    std::sync::Mutex::new(Vec::new());

/// 起 idle cleanup 自走 timer（Node `proxy.js:2577` 的 `setInterval(_tickCleanup, 10s)`）。
///
/// 为什么必须是**独立 timer** 而不是挂在 `/status` 里顺带跑：旧实现嵌在 `buildStatus()`，
/// 只在 dashboard 轮询时才有机会执行；标签页 hidden / 应用没开 → 轮询停 → 2h+ 不清。
/// Node 因此专门改成独立 `setInterval` 并留了注释，本实现照抄这一决策。
///
/// 一轮 = `_tickCleanup()`：**先**对每个 agent 做状态 diff 并发转换事件（`/events` 的来源），
/// **再**跑一轮 `runCleanupPass()`。顺序不能反 —— cleanup 会删 agent，先删会少发一轮事件。
///
/// 拿的是 `AppState` 的**克隆**（`AppState: Clone`，字段都是 `Arc`/`Client` 等廉价克隆），
/// 因为 `tokio::spawn` 要求 `'static`；事件写入直接调 `router::record_event`（只读其中
/// `events_log` / `events` / `capture` 三个字段）。
///
/// `_logExpired` 的控制台明细未迁（纯 stdout 旁路，见 `agents.rs` 模块头），所以这里
/// 不打印候选明细；这与 `/cleanup/debug` 的结构化载荷无关。
fn spawn_cleanup_loop(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(agents::CLEANUP_INTERVAL_MS));
        // tokio 的 `interval` **第一次 tick 立即完成**，而 Node 的 `setInterval` 是**等满一个周期
        // 才第一次触发**。先消费掉那个立即 tick，第一次清理才落在 +10s（与 Node 同相位）。
        ticker.tick().await;
        loop {
            ticker.tick().await;
            // `IDLE_CLEANUP_MS_MAIN` 每轮现读：`/config/idle` 改过的值必须立刻影响清理判定
            // （Node 读的就是那个模块级变量）。先取值再进 `tick_at`，两把锁不交叠。
            let idle = *state.idle_cleanup_ms_main.lock().expect("idle config poisoned");
            let outcome = state.agents.tick_at(capture::now_ms(), idle as i64);
            for ev in &outcome.transitions {
                router::record_event(&state, ev.to_event_input(), None);
            }
        }
    })
}

/// 与 Electron 版**共用同一份** `config.json`（编译期嵌入 → 保证两侧端口同值）。
/// 迁移收尾（Electron 移除）时再决定这份配置最终落在哪 —— 现在共用是刻意的，
/// 避免迁移期出现"两个端口来源"的漂移。
const CONFIG_JSON: &str = include_str!("../../../vendor/cc-monitor/config.json");

/// `config.json` 里的 port。读不到就退回 8080（与 `shared/config.js` 的 `DEFAULTS` 一致）。
pub fn config_port() -> u16 {
    serde_json::from_str::<serde_json::Value>(CONFIG_JSON)
        .ok()
        .and_then(|v| v.get("port").and_then(|p| p.as_u64()))
        .map(|p| p as u16)
        .unwrap_or(8080)
}

/// 组装代理状态：解析上游、建分词器、建 HTTP 客户端。
///
/// 分词器用 `tiktoken-rs` 的 o200k_base（词表编译期嵌入、运行期零下载）—— 与 Node 版
/// `gpt-tokenizer` 的 o200k_base 逐例等值，已由契约 C15 钉住。
pub async fn build_state(default_port: Option<u16>) -> Result<AppState, String> {
    let env = env::Env::from_process_with_default(default_port)?;
    let direct = upstream::direct_base_url(&env);
    let parsed_upstream = Upstream::parse(&direct)?;

    // 环路守卫：生产下上游指向 loopback = 转发给自己，直接拒绝（测试用 CC_MONITOR_LOOP_BYPASS=1 放行）
    if !env.loop_bypass && parsed_upstream.is_loopback() {
        return Err(format!("API URL points to localhost ({direct})"));
    }

    if upstream::resolve_explicit_api_url(&env).is_none() {
        eprintln!("[proxy] WARN: 未解析出可用上游；/config/baseurl 会报 available=false");
        for row in upstream::upstream_source_report(&env) {
            eprintln!(
                "[proxy]   • {} : {}{}",
                row.name,
                if row.raw.is_empty() { "未设置" } else { &row.raw },
                if row.raw.is_empty() || row.why.is_empty() {
                    String::new()
                } else {
                    format!("   ← {}", row.why)
                }
            );
        }
    }

    let started = std::time::Instant::now();
    let bpe = Arc::new(
        tiktoken_rs::o200k_base().map_err(|e| format!("o200k_base 分词器初始化失败: {e}"))?,
    );
    eprintln!(
        "[proxy] o200k_base tokenizer ready in {}ms (ranks embedded at compile time)",
        started.elapsed().as_millis()
    );

    let client = reqwest::Client::builder()
        // 绝不跟随跳转：3xx 必须原样到达客户端（契约 C4）
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("reqwest client 构建失败: {e}"))?;

    // 在 `env` 被 move 进 AppState 之前先算出 `IDLE_CLEANUP_MS_MAIN` 的初值
    // （= Node 的 `applyStateOverrides()`，语义含「有限且非负才生效 + 1h 上限」）。
    let idle_cleanup_ms_main = state::initial_idle_cleanup_ms_main(&env);
    // 同理，日志目录也要在 `env` 被 move 之前解析（Node 在模块加载时算一次）。
    let log = log::ProxyLog::from_env(env.log_dir.as_deref());

    Ok(AppState {
        env: Arc::new(env),
        client,
        upstream: Arc::new(parsed_upstream),
        bpe,
        // 捕获环：进程内共享、定容（CAPTURE_MAX）LRU。诊断层的唯一数据源。
        capture: Arc::new(capture::CaptureRing::new()),
        // 请求广播器：`/requests/stream` 的实时推送（捕获生命周期节点调用 `send`）。
        requests: broadcast::RequestBroadcaster::new(),
        // 异常事件环 + 事件广播器：与捕获环**相互独立**（Node 里 `events` 与 `captureRing`
        // 是两个数组），`/events*` 专用。原因见 events.rs 模块头。
        events_log: Arc::new(events::EventLog::new()),
        events: events::EventsBroadcaster::new(),
        // `/event/detail/stream` 的逐字 delta 频道（按 cid 过滤，独立于上面两条流）。
        detail: detail::DetailBroadcaster::new(),
        // agent 表：身份解析（`getAgentId`）+ 每流 `lastDeltaType`（`phase`）+ 活跃流句柄
        // （`/agent/kill`）+ 实时 prompt（`/agent/prompts`）。见 agents.rs 模块头。
        agents: Arc::new(agents::AgentRegistry::new()),
        // `IDLE_CLEANUP_MS_MAIN`：Node 是模块级可变变量，启动时由 `applyStateOverrides()`
        // 用状态文件覆盖、运行中由 `/config/idle` 改。这里挂在 AppState 上。
        idle_cleanup_ms_main: Arc::new(std::sync::Mutex::new(idle_cleanup_ms_main)),
        // 请求日志落盘（Node 的 `logLine`）：目录来自 `CC_MONITOR_LOG_DIR`，未设置则回落
        // `cwd/logs` —— 与 Node 逐字同义，见 `log.rs` 模块头。
        log: Arc::new(log),
    })
}

/// 绑定端口：127.0.0.1 是**必须成功**的（端口被占用要报错，绝不偷偷换端口 —— 契约要求）；
/// `[::1]` 尽力而为，因为 `http://localhost:PORT` 在部分系统上先解析到 IPv6。
async fn bind_listeners(port: u16) -> Result<Vec<tokio::net::TcpListener>, String> {
    let mut listeners = Vec::new();
    match tokio::net::TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)).await
    {
        Ok(l) => listeners.push(l),
        Err(e) => {
            return Err(format!(
                "cannot listen on 127.0.0.1:{port}: {e}（端口被占用；拒绝换端口）"
            ))
        }
    }
    match tokio::net::TcpListener::bind(SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port)).await
    {
        Ok(l) => listeners.push(l),
        Err(e) => eprintln!("[proxy] WARN: cannot listen on [::1]:{port}: {e}（仅 IPv4 继续）"),
    }
    Ok(listeners)
}

/// **应用内启动**：起在后台，返回实际监听端口。
///
/// 失败时由调用方决定怎么处理 —— 本应用里"代理起不来"不应阻塞主功能（会话分析不依赖代理）。
pub async fn start_background(default_port: Option<u16>) -> Result<u16, String> {
    let state = build_state(default_port).await?;
    let port = state.env.port;
    let app = router::router(state.clone());
    let listeners = bind_listeners(port).await?;
    let mut tasks = Vec::new();
    for listener in listeners {
        let app = app.clone();
        tasks.push(tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("[proxy] serve error: {e}");
            }
        }));
    }
    // idle cleanup timer 随监听一起起（Node 在 `server.on('listening')` 里起）。
    tasks.push(spawn_cleanup_loop(state));
    // 记下句柄供 `stop_background()` 用。若调用方没先 stop 就又 start（不该发生），
    // 这里只是**追加**而不是覆盖，于是 stop 时两批会被一起清掉，不会漏掉旧监听。
    match SERVE_TASKS.lock() {
        Ok(mut guard) => guard.extend(tasks),
        Err(poisoned) => poisoned.into_inner().extend(tasks),
    }
    println!("cc-monitor proxy on :{port}");
    Ok(port)
}

/// 停掉**应用内**监听（若在跑）—— 托盘「重启代理」的前半段。
///
/// 会 `await` 每个被 abort 的任务，确保监听 socket 已 drop 再返回：否则紧接着的
/// rebind 会偶发 `Address already in use`（abort 只是投递取消请求，任务真正结束是异步的）。
pub async fn stop_background() {
    let tasks: Vec<tokio::task::JoinHandle<()>> = match SERVE_TASKS.lock() {
        Ok(mut guard) => guard.drain(..).collect(),
        // 锁中毒也照样把句柄取出来停掉：留着一个不该活的监听比 panic 更糟。
        Err(poisoned) => poisoned.into_inner().drain(..).collect(),
    };
    for task in tasks {
        task.abort();
        let _ = task.await;
    }
}

/// **独立进程入口**（`src/bin/proxy-standalone.rs` 调它）：阻塞直到服务结束。
///
/// 进程契约（契约 §1）都由它保证：端口被占用即非 0 退出、绝不换端口、就绪后 `/status` 可访问。
pub async fn run_standalone() -> Result<(), String> {
    let state = build_state(None).await?;
    let port = state.env.port;
    let app = router::router(state.clone());
    let listeners = bind_listeners(port).await?;

    println!("Status: http://localhost:{port}/status");
    println!(
        "API: {}://{}{}",
        state.upstream.scheme, state.upstream.authority, state.upstream.path_prefix
    );

    let mut handles = Vec::new();
    for listener in listeners {
        let app = app.clone();
        handles.push(tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("[proxy] serve error: {e}");
            }
        }));
    }
    // 与 `start_background` 同款：cleanup timer 随监听一起起。
    // **单独拿在手里、不进下面那个 await 循环**：它是 `loop {}` 永不返回的任务，
    // 若被 `await` 会让 `run_standalone` 永远卡住。句柄留到函数末尾（进程退出时 runtime
    // 整体 drop，任务随之取消）。
    let _cleanup = spawn_cleanup_loop(state);
    for handle in handles {
        let _ = handle.await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 端口来源：必须与 Electron 版共用一份 config.json，否则两侧会漂移
    #[test]
    fn config_port_matches_shared_config_json() {
        let expect: u16 = serde_json::from_str::<serde_json::Value>(CONFIG_JSON)
            .unwrap()
            .get("port")
            .unwrap()
            .as_u64()
            .unwrap() as u16;
        assert_eq!(config_port(), expect);
        assert_eq!(config_port(), 8090, "vendor/cc-monitor/config.json 的 port 变了？");
    }

    /// 环境变量优先于 config.json 默认值（否则契约测试的沙箱端口会被 config 覆盖）
    #[test]
    fn env_port_overrides_default() {
        // 注意：不改本进程环境（并行测试会互相干扰），只验证"未设置时用传入默认值"这条分支
        let env = env::Env::from_process_with_default(Some(12345)).expect("env 构造");
        // 测试进程里通常没有 CC_MONITOR_PORT，命中 default_port 分支
        if std::env::var("CC_MONITOR_PORT").is_err() {
            assert_eq!(env.port, 12345);
        }
    }

    /// 托盘「重启代理」依赖的生命周期语义：**停掉之后端口必须真的能立刻重绑**。
    ///
    /// 这条测试盯的是 `stop_background()` 里那个不起眼但关键的点：`abort()` 只是投递取消请求，
    /// 任务真正结束（监听 socket 被 drop）是异步的 —— 所以必须 `await` 句柄。少了那个 await，
    /// 下面这行 `TcpListener::bind` 会偶发 `Address already in use`（真实的重启就会失败）。
    ///
    /// 端口用「先绑 `:0` 拿一个空闲端口再放掉」确定，不写死：写死会与机器上别的进程撞车。
    /// 也**不写 `CC_MONITOR_PORT`**（进程级 env 会串到并行测试）。
    #[tokio::test]
    async fn stop_background_frees_the_port_so_it_can_be_restarted() {
        // 环路守卫：若开发机的 ANTHROPIC_BASE_URL 指向 localhost，`build_state` 会直接拒绝启动。
        // 契约测试也是这么绕过的（`CC_MONITOR_LOOP_BYPASS=1`）。**本测试是全仓唯一调用
        // `build_state` 的用例**，所以临时设/还原这个变量不会干扰并行跑的其它测试。
        let prev_bypass = std::env::var("CC_MONITOR_LOOP_BYPASS").ok();
        std::env::set_var("CC_MONITOR_LOOP_BYPASS", "1");

        let probe = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("拿一个空闲端口");
        let port = probe.local_addr().unwrap().port();
        drop(probe);

        let first = start_background(Some(port)).await.expect("首次启动代理");
        assert_eq!(first, port);
        assert!(port_accepts(port).await, "启动后 {port} 应可连接");

        stop_background().await;
        // 关键断言：停掉之后**立刻**能重绑 —— 证明监听 socket 真的释放了
        let rebound = tokio::net::TcpListener::bind(("127.0.0.1", port)).await;
        assert!(rebound.is_ok(), "stop_background 之后端口没释放：{rebound:?}");
        drop(rebound);

        // 再启一次 —— 正是托盘「重启代理」走的路径
        let second = start_background(Some(port)).await.expect("重启代理");
        assert_eq!(second, port);
        assert!(port_accepts(port).await, "重启后 {port} 应可连接");

        stop_background().await;

        match prev_bypass {
            Some(v) => std::env::set_var("CC_MONITOR_LOOP_BYPASS", v),
            None => std::env::remove_var("CC_MONITOR_LOOP_BYPASS"),
        }
    }

    /// 能不能连上 `127.0.0.1:port` —— 就绪探测的最小形式（不引额外依赖）。
    async fn port_accepts(port: u16) -> bool {
        tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
    }
}
