//! 子进程执行 —— `ProcBridge` 的 Rust 侧实现（见 core/procBridge.ts 的约定）。
//!
//! 覆盖的是 迁移前 Electron 壳的 `claudeCli.ts`（已删除） 里那段 `runProcess` / `spawnSync` 的等价物：
//! 起进程 → 写 stdin → **按行**回传 stdout → 判退出码，外加超时必杀。
//!
//! ## 关于 `shell: true`（§6.3 要求「必须保留」的那条）
//!
//! Node 的 `spawn(cmd, args, { shell: true })` 在两个平台都会**经 shell** 执行：
//! Unix 是 `/bin/sh -c "claude -p --verbose …"`，Windows 是 `cmd.exe /d /s /c "claude …"`。
//! 这里**两边都走 shell**，理由不是「照抄」，而是为了让**可观测行为**一致：
//!   - Windows 下 `claude` 是 `.cmd` shim，不经 `cmd.exe` 根本解析不到（这是当初加 shell 的**真正原因**）；
//!   - Unix 下改直接 `execvp` 也能跑，但**找不到 claude 时**的行为会变：Node 走 shell 时是
//!     「sh: claude: command not found」+ 退出码 127，直连则是 spawn 直接 ENOENT。
//!     那会让用户看到的错误文案与迁移前不同 —— 所以这边统一走 shell，把这个差异消掉。
//!
//! 安全性没有因此变差：argv 只有固定 token（`-p` / `--verbose` / `--output-format` / `stream-json`），
//! **全部负载走 stdin**（这也是原实现刻意不用 `--append-system-prompt` 的原因，见 buildStdin 注释）。
//! 即便如此，拼 shell 命令行时仍对每个参数做引号转义，不依赖「反正没有特殊字符」这个假设。
use serde::Serialize;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[derive(Serialize, Clone)]
pub struct RunLinesOutcome {
    pub ok: bool,
    pub error: Option<String>,
    pub stderr: String,
}

#[derive(Serialize, Clone)]
pub struct ExecTextOutcome {
    pub ok: bool,
    pub out: String,
    pub error: Option<String>,
}

/// 单引号包裹（POSIX）。单引号本身用 `'\''` 转义。
#[cfg(unix)]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(unix)]
fn build_command(cmd: &str, args: &[String]) -> Command {
    let mut line = sh_quote(cmd);
    for a in args {
        line.push(' ');
        line.push_str(&sh_quote(a));
    }
    // 必须写 **/bin/sh** 而不是 PATH 上的 `sh`：Node 的 `shell:true` 在 POSIX 上硬编码
    // `file = '/bin/sh'`，于是 shell 报「command not found」之类错误时前缀是 `/bin/sh:`。
    // 写 `sh` 会让前缀变成 `sh:` —— 这正是「统一走 shell 以消掉用户可见文案差异」那条决定
    // 想消掉的差异，只是换了个位置。差分实测：`/bin/sh: xxx: command not found` vs `sh: xxx: …`。
    let mut c = Command::new("/bin/sh");
    c.arg("-c").arg(line);
    c
}

/// Windows 经 `cmd /C`：`claude.cmd` shim 必须这样才解析得到。
/// 参数以 argv 形式交给 cmd.exe（Rust 会在拼命令行时按需加引号）。
#[cfg(windows)]
fn build_command(cmd: &str, args: &[String]) -> Command {
    let mut c = Command::new("cmd");
    c.arg("/C").arg(cmd).args(args);
    c
}

/// 按 **UTF-16 码元**（不是字符、不是字节）截断，对齐 Node 的 `String#slice(0, 300)`。
///
/// 为什么口径是 UTF-16：Node 的 `stderrText.slice(0, 300)` 数的就是 UTF-16 码元 —— BMP 字符 1 个、
/// emoji 等增补平面字符 2 个。按 Rust 的 `chars()` 数会把 300 个 emoji 当成 300（Node 只取 150），
/// 于是同一条错误在两侧显示的长度不同（差分实测：Node 313 字符 / Rust 613 字符）。
///
/// 唯一的残余差别：Node 的切口正好落在**代理对中间**时会留下一个孤立代理项（显示成 U+FFFD），
/// 而 Rust 的 `String` 不能存孤立代理项 —— 这里选择**丢掉**那个不完整的字符（绝不切出 U+FFFD）。
fn truncate_utf16_units(s: &str, max_units: usize) -> String {
    let mut used = 0usize;
    let mut out = String::new();
    for c in s.chars() {
        let w = c.len_utf16();
        if used + w > max_units {
            break;
        }
        used += w;
        out.push(c);
    }
    out
}

/// 逐行跑命令并把每行交给 `on_line`。
///
/// 之所以把「通知」做成回调而不是直接 `app.emit`：这样核心逻辑不必持有 `AppHandle`，
/// **可以在没有 Tauri 运行时的普通 `#[tokio::test]` 里测**（见文件末尾的单测）。
/// `#[tauri::command] run_lines` 只是把它包一层、把回调接到事件上。
pub async fn run_lines_with<F>(
    cmd: &str,
    args: &[String],
    stdin_text: &str,
    timeout_ms: u64,
    label: &str,
    mut on_line: F,
) -> RunLinesOutcome
where
    F: FnMut(String),
{
    let mut command = build_command(cmd, args);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            return RunLinesOutcome {
                ok: false,
                error: Some(format!("无法启动 {label}：{e}")),
                stderr: String::new(),
            }
        }
    };

    // 写 stdin 与读 stdout **必须并发**，不能「先 await 写完整个 stdin、再去读 stdout」。
    //
    // 为什么：Node 的 `stdin.write(...)` 是**非阻塞排队**（libuv 缓冲），调用方立刻转去装
    // stdout/stderr 的 data 监听器 —— 子进程边读 stdin、父进程边读 stdout。若这里同步写完再读，
    // 一旦子进程在读完 stdin 前就把 stdout 管道写满（`cat` 回显就是最小模型），双方互相阻塞：
    // 子进程写不动 stdout 就不再读 stdin，父进程写不动 stdin 就永远到不了「开始读 stdout」那一步。
    // 这不是理论风险：差分语料 `run_lines/stdin_1mb_cat_echo` 与
    // `stdin_1mb_child_writes_stderr_first` 在修复前**永久挂住**（探针侧 4s 硬上限实测）。
    // 写完 `si` 随之 drop，即关闭 stdin → 子进程看到 EOF（对应 Node 的 `stdin.end()`）。
    let stdin_owned = stdin_text.to_owned();
    let stdin_task = child.stdin.take().map(|mut si| {
        tokio::spawn(async move {
            // 进程可能不看 stdin 就退出（broken pipe），与 Node 一样忽略
            let _ = si.write_all(stdin_owned.as_bytes()).await;
        })
    });

    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill().await;
        return RunLinesOutcome {
            ok: false,
            error: Some(format!("{label} 进程 stdio 不可用")),
            stderr: String::new(),
        };
    };

    // stderr 并发收集（不并发读会因管道缓冲填满而互相阻塞）。
    //
    // 用**共享字节缓冲**而不是「让 task 返回 String」：超时/异常路径必须能**不等 EOF** 就取到已有内容。
    // 为什么这是硬要求：被 kill 的进程若留下继承了 stdio 管道的孙进程，stderr 永远等不到 EOF；
    // 此时若 `await` 这个 task，超时路径就从「按时返回」退化成「永久挂住」——比迁移前的 Node 更糟
    // （Node 在 setTimeout 回调里直接 resolve，根本不看 stdio 有没有关）。
    //
    // 存**原始字节**、最后统一有损解码：Node 是 `stderrText += chunk.toString()`（原样累积、不按行重组）。
    // 按行读再补 `\n` 会在两处偏离 Node —— 无尾换行的 stderr 被补成 `boom\n`、CRLF 被归一成 `\n`，
    // 而错误文案里带着这段文本，用户可见（差分实测过）。
    let stderr_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let mut stderr_task = {
        let buf = stderr_buf.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut chunk = [0u8; 8192];
            loop {
                match reader.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.lock().unwrap().extend_from_slice(&chunk[..n]),
                }
            }
        })
    };

    // 超时覆盖**整个读取过程**（与 Node 的 setTimeout 语义一致），不是「空闲超时」。
    //
    // 按行读 stdout 用**原始字节**收行后**有损解码**，而不是 `BufReader::lines()`：`lines()` 遇到
    // 非法 UTF-8 会返回 `Err`，`while let Ok(Some(..))` 于是**静默停止**，坏字节之后的**所有行全丢**
    // （语义从「有一个坏字节」变成「流断了」）。Node 是 `Buffer#toString()` 的有损解码：坏字节变
    // U+FFFD 且**继续读**。差分实测：`run_lines/invalid_utf8_mid_stream` 修复前 Rust 只给 `["ok1"]`、
    // Node 给 `["ok1","\u{FFFD}","ok2"]`。行界与 Node 的 `split(/\r?\n/)` 逐字对齐：`\n` 结尾去掉，
    // 若为 `\r\n` 再吃掉 `\r`；孤立 `\r`（含 EOF 处的）不算行界，保留在行内。
    let mut reader = BufReader::new(stdout);
    let read_all = async {
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    if buf.last() == Some(&b'\n') {
                        buf.pop();
                        if buf.last() == Some(&b'\r') {
                            buf.pop();
                        }
                    }
                    on_line(String::from_utf8_lossy(&buf).into_owned());
                }
                Err(_) => break,
            }
        }
    };
    let timed_out = tokio::time::timeout(Duration::from_millis(timeout_ms), read_all)
        .await
        .is_err();

    if timed_out {
        let _ = child.kill().await;
    }
    let status = child.wait().await;
    // 收拾 stdin 写入任务：正常路径它早就写完；超时/子进程提前退出时最多再等 200ms 就 abort。
    if let Some(mut h) = stdin_task {
        if tokio::time::timeout(Duration::from_millis(200), &mut h)
            .await
            .is_err()
        {
            h.abort();
        }
    }
    // 尽力等 stderr 读干净（最多 200ms）；超时就放弃等待并把 task 停掉，改用已缓冲的部分。
    if tokio::time::timeout(Duration::from_millis(200), &mut stderr_task)
        .await
        .is_err()
    {
        stderr_task.abort();
    }
    let stderr_text = {
        let buf = stderr_buf.lock().unwrap();
        String::from_utf8_lossy(&buf).into_owned()
    };

    if timed_out {
        return RunLinesOutcome {
            ok: false,
            error: Some(format!("调用 {label} 超时")),
            stderr: stderr_text,
        };
    }

    match status {
        Ok(st) if st.success() => RunLinesOutcome {
            ok: true,
            error: None,
            stderr: stderr_text,
        },
        Ok(st) => {
            let code = st
                .code()
                .map(|c| c.to_string())
                // Node 的 `close(code)` 在被信号终止时给的是 `null`，模板串出来就是字面量 "null"。
                // 「用户可见错误文案逐字不变」要求这里也是 "null"（此前写的是 "unknown"；差分实测过）。
                .unwrap_or_else(|| "null".to_string());
            let suffix = if stderr_text.is_empty() {
                String::new()
            } else {
                // Node 是 `'：' + stderrText.slice(0, 300)`：**不做 trim**、也不补省略号。
                // 此前这里 `trim_end()` 会把尾随空白/换行吃掉，与 Node 的文案不同（差分实测过）。
                format!("：{}", truncate_utf16_units(&stderr_text, 300))
            };
            RunLinesOutcome {
                ok: false,
                error: Some(format!("{label} 退出码 {code}{suffix}")),
                stderr: stderr_text,
            }
        }
        Err(e) => RunLinesOutcome {
            ok: false,
            error: Some(format!("{label} 进程等待失败：{e}")),
            stderr: stderr_text,
        },
    }
}

/// 逐行流式执行，每行经 `proc:line:<stream_id>` 事件推给渲染层。
#[tauri::command]
pub async fn run_lines(
    app: tauri::AppHandle,
    stream_id: String,
    cmd: String,
    args: Vec<String>,
    stdin_text: String,
    timeout_ms: Option<u64>,
    label: Option<String>,
) -> Result<RunLinesOutcome, String> {
    use tauri::Emitter;
    let event = format!("proc:line:{stream_id}");
    let label = label.unwrap_or_else(|| cmd.clone());
    Ok(run_lines_with(
        &cmd,
        &args,
        &stdin_text,
        timeout_ms.unwrap_or(180_000),
        &label,
        move |line| {
            // 事件发失败（窗口已关）不影响进程继续跑完；忽略返回值即可
            let _ = app.emit(&event, line);
        },
    )
    .await)
}

/// 一次性命令，收集 stdout+stderr。**非零退出码不算失败**（对齐 Node `spawnSync` ——
/// `which nonexistent` 就是非零退出，调用方靠 out 是否为空判断）。
#[tauri::command]
pub async fn exec_text(cmd: String, args: Vec<String>) -> Result<ExecTextOutcome, String> {
    match build_command(&cmd, &args).output().await {
        Ok(o) => {
            let mut out = String::from_utf8_lossy(&o.stdout).into_owned();
            out.push_str(&String::from_utf8_lossy(&o.stderr));
            Ok(ExecTextOutcome {
                ok: true,
                out,
                error: None,
            })
        }
        Err(e) => Ok(ExecTextOutcome {
            ok: false,
            out: String::new(),
            error: Some(e.to_string()),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Arc / Mutex 已由外层 use 引入（核心逻辑的 stderr 共享缓冲要用）

    /// 核心契约：写进 stdin 的内容能按行回调出来，且进程正常退出 → ok。
    /// 用 `cat` 当被测命令：它把 stdin 原样回显到 stdout，天然是「按行流式」的最小模型。
    #[cfg(unix)]
    #[tokio::test]
    async fn run_lines_streams_stdin_lines_back() {
        let got = Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        let out = run_lines_with("cat", &[], "line1\nline2\nline3\n", 5_000, "cat", |l| {
            sink.lock().unwrap().push(l)
        })
        .await;
        assert!(out.ok, "cat 应该正常退出: {:?}", out.error);
        assert_eq!(*got.lock().unwrap(), vec!["line1", "line2", "line3"]);
    }

    /// 末行没有换行也必须回调（原 Node 实现的 `if (lineBuf) onLine(lineBuf)` flush 语义）。
    /// 少了这条，claude 最后一段不带换行的输出会整个丢掉。
    #[cfg(unix)]
    #[tokio::test]
    async fn run_lines_flushes_final_line_without_newline() {
        let got = Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        let out = run_lines_with("cat", &[], "no-newline-at-end", 5_000, "cat", |l| {
            sink.lock().unwrap().push(l)
        })
        .await;
        assert!(out.ok);
        assert_eq!(*got.lock().unwrap(), vec!["no-newline-at-end"]);
    }

    /// 非零退出码 → ok:false，且错误文案里带退出码与 stderr（用户可见，必须有信息量）
    #[cfg(unix)]
    #[tokio::test]
    async fn run_lines_reports_nonzero_exit_with_stderr() {
        let out = run_lines_with(
            "sh",
            &["-c".to_string(), "echo boom >&2; exit 3".to_string()],
            "",
            5_000,
            "claude",
            |_| {},
        )
        .await;
        assert!(!out.ok);
        let err = out.error.unwrap();
        assert!(err.contains("claude 退出码 3"), "实际: {err}");
        assert!(err.contains("boom"), "错误文案应带 stderr，实际: {err}");
    }

    /// 超时必须杀掉并返回，而不是永远挂着
    #[cfg(unix)]
    #[tokio::test]
    async fn run_lines_times_out_and_kills() {
        let started = std::time::Instant::now();
        let out = run_lines_with(
            "sh",
            &["-c".to_string(), "sleep 30".to_string()],
            "",
            300, // 300ms 就超时
            "claude",
            |_| {},
        )
        .await;
        assert!(!out.ok);
        assert_eq!(out.error.as_deref(), Some("调用 claude 超时"));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "超时后应立即返回，实际耗时 {:?}",
            started.elapsed()
        );
    }

    /// 超时前已经收到的行不能丢（Node 版同样如此：先回调、后 resolve 超时）
    #[cfg(unix)]
    #[tokio::test]
    async fn run_lines_keeps_lines_received_before_timeout() {
        let got = Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        let out = run_lines_with(
            "sh",
            // `exec` 不可省：否则 bash 把 sleep 留成孤儿（kill 只杀直接子进程），
            // 测试跑完 30s 内会挂着一个 `sleep 30`
            &["-c".to_string(), "echo before-timeout; exec sleep 30".to_string()],
            "",
            500,
            "claude",
            |l| sink.lock().unwrap().push(l),
        )
        .await;
        assert!(!out.ok);
        assert_eq!(*got.lock().unwrap(), vec!["before-timeout"]);
    }

    /// 命令不存在 → 走 shell 的话是退出码 127（与 Node shell:true 的可观测行为一致），
    /// 且 shell 错误前缀必须是 `/bin/sh:`（Node 在 POSIX 上硬编码 `/bin/sh`；写 `sh` 会变 `sh:`）。
    #[cfg(unix)]
    #[tokio::test]
    async fn run_lines_missing_command_matches_node_shell_behaviour() {
        let out = run_lines_with("definitely-not-a-real-cmd-ccsa", &[], "", 5_000, "claude", |_| {}).await;
        assert!(!out.ok);
        let err = out.error.unwrap();
        assert!(err.contains("127"), "经 shell 应得到退出码 127，实际: {err}");
        assert!(
            err.contains("/bin/sh: definitely-not-a-real-cmd-ccsa: command not found"),
            "shell 错误前缀必须与 Node 同款 `/bin/sh:`，实际: {err}"
        );
    }

    /// 非法 UTF-8 不能截断流：坏字节处有损解码成 U+FFFD 并**继续**（对齐 Node 的 `toString()`）。
    /// 修复前 `BufReader::lines()` 遇非法 UTF-8 返回 Err，`while let Ok(..)` 静默停止 —— 之后的行全丢。
    #[cfg(unix)]
    #[tokio::test]
    async fn run_lines_delivers_lines_after_invalid_utf8() {
        let got = Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        let out = run_lines_with(
            "sh",
            &["-c".to_string(), r"printf 'ok1\n'; printf '\377'; printf '\nok2\n'".to_string()],
            "",
            5_000,
            "claude",
            |l| sink.lock().unwrap().push(l),
        )
        .await;
        assert!(out.ok, "{:?}", out.error);
        let lines = got.lock().unwrap().clone();
        assert_eq!(lines.len(), 3, "坏字节之后的行不能丢，实际: {lines:?}");
        assert_eq!(lines[0], "ok1");
        assert_eq!(lines[2], "ok2");
        assert!(
            lines[1].contains('\u{FFFD}'),
            "坏字节应有损解码成 U+FFFD，实际: {:?}",
            lines[1]
        );
    }

    /// 大 stdin + 边读边回显的子进程不能死锁：写 stdin 必须与读 stdout **并发**。
    /// 修复前 `write_all(stdin)` 在开始读 stdout 之前 await，1MB 时两边互相阻塞（此测试会超时）。
    #[cfg(unix)]
    #[tokio::test]
    async fn run_lines_does_not_deadlock_on_large_stdin_echo() {
        let payload = "x".repeat(1_000_000 - 1) + "\n";
        let got = Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        let out = tokio::time::timeout(
            Duration::from_secs(10),
            run_lines_with("cat", &[], &payload, 5_000, "cat", move |l| {
                sink.lock().unwrap().push(l)
            }),
        )
        .await
        .expect("1MB stdin + cat 回显不该死锁（修复前会永久挂住）");
        assert!(out.ok, "{:?}", out.error);
        let lines = got.lock().unwrap().clone();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].len(), payload.len() - 1);
    }

    /// execText：非零退出码不算失败（which 找不到目标就是非零退出）
    #[cfg(unix)]
    #[tokio::test]
    async fn exec_text_treats_nonzero_exit_as_ok_with_output() {
        let r = exec_text("sh".into(), vec!["-c".into(), "echo out; echo err >&2; exit 1".into()])
            .await
            .unwrap();
        assert!(r.ok, "非零退出不应判为失败");
        assert!(r.out.contains("out"));
        assert!(r.out.contains("err"));
    }

    /// 截断口径 = Node 的 `String#slice(0, 300)`：按 **UTF-16 码元**数（emoji 等增补平面字符算 2）。
    #[test]
    fn truncate_utf16_units_matches_node_slice() {
        let s = "你好世界再见";
        let t = truncate_utf16_units(s, 3);
        assert_eq!(t, "你好世");
        assert!(!t.contains('\u{FFFD}'));
        // 不超长时原样返回
        assert_eq!(truncate_utf16_units("短", 10), "短");
        // 400 个 emoji（各 2 个 UTF-16 码元）截 300 → 150 个，与 Node 的 slice(0, 300) 相同
        let emoji = "😀".repeat(400);
        assert_eq!(truncate_utf16_units(&emoji, 300), "😀".repeat(150));
        // 切口正好落在代理对中间：Node 会留下孤立代理项，这里丢掉整个字符（不产生 U+FFFD）
        assert_eq!(truncate_utf16_units("a😀b", 2), "a");
    }

    /// 参数里的引号/空格被正确转义（不依赖「反正没有特殊字符」）
    #[cfg(unix)]
    #[tokio::test]
    async fn arguments_are_quoted_for_shell() {
        let got = Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        let out = run_lines_with(
            "echo",
            &["a b|c;d".to_string(), "it's".to_string()],
            "",
            5_000,
            "echo",
            |l| sink.lock().unwrap().push(l),
        )
        .await;
        assert!(out.ok, "{:?}", out.error);
        let joined = got.lock().unwrap().join("\n");
        // 若没转义，`|` 与 `;` 会被 shell 当成管道/分隔符，输出就不是原样的两段文本
        assert!(joined.contains("a b|c;d"), "实际: {joined}");
        assert!(joined.contains("it's"), "实际: {joined}");
    }
}
