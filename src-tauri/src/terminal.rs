//! 「脱离父进程起一个进程」原语 —— 服务于「在 OS 终端打开 `claude --resume`」。
//!
//! 分工（与其它模块一致）：命令**怎么拼**是纯逻辑，留在 TS（`core/terminal.ts`，有测试，
//! 还顺带补了 Linux）；这里只负责真正起进程，并且必须是 **detached** 语义 ——
//! 关掉本应用不能杀掉用户的终端窗口。
use std::process::Stdio;
use tokio::process::Command;

/// 脱离父进程启动（不等待、不接管 stdio）。
///
/// 与 Node `spawn(exe, args, { detached: true, stdio: 'ignore' }).unref()` 的对应关系：
/// - `stdio = null` ↔ `stdio: 'ignore'`
/// - `process_group(0)`（Unix）↔ `detached: true` —— 让子进程进独立进程组，
///   父进程收到的 Ctrl-C 不会波及终端窗口。Node 用的是 `setsid()`（还会脱离控制终端），
///   这里用进程组已覆盖实际影响；差别记在此处以免被误认为等价。
/// - `unref()` 在 Rust 没有对应物（那是不让事件循环被子进程吊住）；Rust 侧改成
///   **后台任务回收子进程**，避免它退出后变成僵尸。
#[tauri::command]
pub async fn spawn_detached(exe: String, args: Vec<String>, cwd: String) -> Result<(), String> {
    let mut cmd = Command::new(&exe);
    cmd.args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(unix)]
    cmd.process_group(0);

    // 文案必须中性：本原语由两个动作共用 —— 开终端续接（core/terminal.ts::openTerminal）
    // 与在文件管理器里打开目录（::openDir）。写死「终端」会让「打开位置」失败时对用户胡说
    // （他点的是文件夹，没碰过终端）。真正失败的原因通常与两者都无关：目录不存在、命令不在 PATH。
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动进程失败（{exe}）：{e}"))?;

    // 不 wait：立刻返回，用户已经在终端窗口里了。
    // 但仍要有人回收，否则终端退出后本进程会留一个僵尸 —— 交给后台任务。
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 起进程 → 立刻返回（不等它结束），且目标确实被执行了。
    /// 用一个"写文件后立即退出"的命令来观察，避免真的去开终端窗口。
    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_detached_returns_immediately_and_runs_the_command() {
        let dir = std::env::temp_dir().join(format!("ccsa-term-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let marker = dir.join("marker.txt");
        let _ = std::fs::remove_file(&marker);

        let started = std::time::Instant::now();
        spawn_detached(
            "sh".to_string(),
            vec![
                "-c".to_string(),
                format!("printf done > {}", marker.display()),
            ],
            dir.to_string_lossy().into_owned(),
        )
        .await
        .expect("spawn_detached 应该成功");
        // 立刻返回：不等子进程写完
        assert!(
            started.elapsed() < std::time::Duration::from_millis(500),
            "spawn_detached 不该等待子进程，实际 {:?}",
            started.elapsed()
        );

        // 轮询等它落盘（证明命令确实被执行、cwd 也生效）
        let mut ok = false;
        for _ in 0..50 {
            if marker.exists() {
                ok = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(ok, "子进程没有被执行（marker 未出现）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// cwd 生效：在给定目录里创建文件，而不是在进程当前目录
    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_detached_honours_cwd() {
        let dir = std::env::temp_dir().join(format!("ccsa-term-cwd-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::remove_file(dir.join("here.txt"));

        spawn_detached(
            "sh".to_string(),
            vec!["-c".to_string(), "printf x > here.txt".to_string()],
            dir.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();

        let mut ok = false;
        for _ in 0..50 {
            if dir.join("here.txt").exists() {
                ok = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(ok, "cwd 未生效");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 命令不存在 → 明确的 Err（而不是 panic 或静默成功）
    #[tokio::test]
    async fn spawn_detached_reports_missing_command() {
        let err = spawn_detached(
            "definitely-not-a-real-cmd-ccsa".to_string(),
            vec![],
            std::env::temp_dir().to_string_lossy().into_owned(),
        )
        .await
        .expect_err("不存在的命令应返回 Err");
        assert!(err.contains("启动进程失败"), "实际: {err}");
    }
}
