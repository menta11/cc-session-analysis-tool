#!/usr/bin/env node
/**
 * `claude` / `terminal`（`ProcBridge` 的 Rust 侧）↔ Node 参考实现的差分核验 —— 驱动脚本。
 *
 * 背景：`src-tauri/src/claude.rs` 的「与 Node 的 runProcess 等价」「用户可见错误文案逐字不变」是
 * **读 Node 源码推理**出来的，从未被同输入差分验证过。本脚本把同一批命令同时喂给两侧：
 *   - Node 侧：`core/procBridgeNode.ts`（esbuild 现打成 ESM 后动态 import）
 *   - Rust 侧：`cargo test --test proc_differential -- --ignored`（见该文件的协议说明）
 * 然后逐项比**完整结果**：有序 stdout 行序列（核心契约 —— 行切分、末行 flush、CRLF）、
 * `{ok,error,stderr}` 形状、退出码处理、超时行为（必须杀掉 + 已收到的行不丢）、`execText` 的
 * `{ok,out}`、`spawnDetached` 的 `{ok,markerSeen}`、`defaultCwd`。
 *
 * 用法（仓库根）：
 *   node test/tools/proc-differential.mjs
 * 环境变量：
 *   CCSA_PROC_DIFF_KEEP=1      跑完保留临时语料目录并打印路径（排查用）
 *   CCSA_PROC_DIFF_SELFTEST=1  只验证「差分本身能报出差异」：把某条 Node 结果改一个字符，
 *                              要求 harness 恰好在那条上报 lines mismatch
 * 退出码：0 = 全部匹配（或自检通过）；1 = 有 mismatch / 探针自身出错。
 *
 * **归一化声明**（只归一层与语义无关的传输差异，别的都不动）：
 *   1. 对象**键**递归排序 —— Rust `json!` 走 `serde_json::Map`（BTreeMap，字典序），Node 是对象字面量序；
 *      键序不是语义（`src/api/procBridgeTauri.ts` 按名读取），不归一化会产生**假 mismatch**
 *      （fs 差分实测过同一现象）。**数组顺序一律不动** —— 有序行序列就是本轮要比的核心契约。
 *   2. `elapsedMs` **不比数值**，只比「是否在自家 timeout + 裕量内返回」与「是否根本没返回
 *      （probeTimedOut）」。两侧调度器/进程启动开销不同，毫秒级数值不可比。
 *   3. `spawn_detached` 的 `error` **只记录不比较文案**：Node 的失败被 `child.on('error')` 吞掉，
 *      永远不产生 error（见 `core/procBridgeNode.ts:103-105`），而 Rust 会格式化一条 —— 两侧
 *      没有同一信息源；文案差异在报告里原样打印，但判据是 `ok` 与 `markerSeen`。
 *   4. `error`（run_lines 的用户可见错误文案）**逐字比较**：`claude.rs` 明文承诺「统一走 shell 把
 *      找不到命令的文案差异消掉」「用户可见错误文案逐字不变」，且两侧用的是同一个 `/bin/sh`。
 *      所以这里刻意不走「只比形状」那条更弱的口径 —— 逐字比才是对那条承诺的检验。（真实差异见报告。）
 *   5. **唯一一处对真实差异的归一化**：`line_count_racy` 的用例（`run_lines/timeout_ticker`，脚本每
 *      50ms 吐一行 `tick`）只比「行内容的集合 + 双方都至少一行」，不比**行数**。行数是「600ms 窗口里
 *      塞得进几次 50ms」的结果，与调度器赛跑、天生不可复现（本轮实测 Node 10 行 / Rust 11 行，
 *      上一次两边都是 11 行 —— 留着逐字比就是一条 flaky 用例）。时间到必返回、非 ok、超时文案、
 *      行内容仍逐字比，所以「超时覆盖整个读取过程（而不是空闲超时）」这条语义仍然被钉住。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const KEEP = process.env.CCSA_PROC_DIFF_KEEP === '1'
const SELFTEST = process.env.CCSA_PROC_DIFF_SELFTEST === '1'

const tmp = mkdtempSync(join(tmpdir(), 'ccsa-procdiff-'))
const corpus = join(tmp, 'corpus')
mkdirSync(corpus, { recursive: true })

// 前置条件：脚本/数据路径会作为 **argv** 交给两侧。Node 的 `shell:true` 是**不引号**地
// join argv（见 core/procBridgeNode.ts 注释与实测），所以路径里一旦有空白就会制造**假 mismatch**。
// 这是本轮 harness 自身的假象源，必须先钉死。
if (/\s/.test(tmp)) {
  console.error(`[procdiff] 临时目录路径含空白，Node 的 shell 拼接会把它切碎 → 本 harness 不可信: ${tmp}`)
  process.exit(1)
}

function cleanup() {
  if (!KEEP) rmSync(tmp, { recursive: true, force: true })
}
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(130))

// ── 语料：脚本 + 数据文件 ─────────────────────────────────────────────────────
const sh = (name, body) => {
  const p = join(corpus, name)
  writeFileSync(p, body.endsWith('\n') ? body : body + '\n')
  return p
}
const data = (name, body) => {
  const p = join(corpus, name)
  writeFileSync(p, body)
  return p
}
const R = String.raw

// 纯 stdout 形状
const S_MULTILINE = sh('out_multiline.sh', R`printf 'l1\nl2\nl3\n'`)
const S_NO_TRAILING_NL = sh('out_no_trailing_nl.sh', R`printf 'abc'`)
const S_EMPTY = sh('out_empty.sh', ':')
const S_CRLF = sh('out_crlf.sh', R`printf 'a\r\nb\r\n'`)
const S_CRLF_NO_TRAILING = sh('out_crlf_no_trailing.sh', R`printf 'x\r\ny'`)
const S_LONE_CR = sh('out_lone_cr.sh', R`printf 'a\rb\n'`)
const S_CR_AT_EOF = sh('out_cr_at_eof.sh', R`printf 'abc\r'`)
const S_MIXED_EOL = sh('out_mixed_eol.sh', R`printf 'a\r\r\n\nb'`)
const S_MB = sh('out_mb.sh', R`printf '你好\n世界\n'`)
const S_EMOJI = sh('out_emoji.sh', R`printf '😀x\n😀y\n'`)
const S_BOM = sh('out_bom.sh', R`printf '\357\273\277hello\n'`)
// 非法 UTF-8：Node 的 `d.toString()` 是有损解码（U+FFFD），Rust 的 `BufReader::lines()` 见
// invalid UTF-8 会 `Err` 且 `while let Ok(...)` 会**静默停止**。两种策略在坏字节处分道扬镳。
const S_BAD_UTF8 = sh('out_invalid_utf8.sh', R`printf '\377\376abc\n'`)
const S_BAD_UTF8_MID = sh('out_invalid_utf8_mid.sh', R`printf 'ok1\n'; printf '\377'; printf '\nok2\n'`)
// 大输出（缓冲/背压）：5 万行 ≈ 0.9 MB；单行 1.5 MB 无换行；1 MB 多字节跨 chunk 边界
const S_HUGE = sh('out_huge.sh', R`yes LINE-abcdefghij | head -n 50000`)
const S_ONE_HUGE_LINE = sh('out_one_huge_line.sh', R`head -c 1500000 /dev/zero | tr '\0' 'a'`)
const S_HUGE_MB = sh('out_huge_mb.sh', R`yes '你好世界你好世界' | head -n 30000`)

// stderr 形状 / 退出码
const S_STDERR_OK = sh('stderr_ok.sh', R`printf 'out-line\n'; printf 'err-line\n' >&2`)
const S_STDERR_FAIL = sh('stderr_fail.sh', R`printf 'out-before\n'; printf 'boom\n' >&2; exit 1`)
const S_STDERR_NO_TRAILING_NL = sh('stderr_no_trailing_nl.sh', R`printf 'boom' >&2; exit 2`)
const S_STDERR_CRLF = sh('stderr_crlf.sh', R`printf 'boom\r\n' >&2; exit 2`)
const S_STDERR_EMPTY_EXIT3 = sh('stderr_empty_exit3.sh', R`exit 3`)
const S_STDERR_LONG_ASCII = sh('stderr_long_ascii.sh', `printf '${'E'.repeat(400)}' >&2; printf '\\n' >&2; exit 4`)
// 300 的截断口径：Node `stderrText.slice(0,300)`（UTF-16 单元）vs Rust `truncate_chars(trim_end,300)`（字符）
const S_STDERR_LONG_MB = sh('stderr_long_mb.sh', `printf '${'你'.repeat(400)}' >&2; printf '\\n' >&2; exit 5`)
const S_STDERR_LONG_EMOJI = sh('stderr_long_emoji.sh', `printf '${'😀'.repeat(400)}' >&2; printf '\\n' >&2; exit 6`)
// 尾部空白：Node 原样 slice，Rust `trim_end()`
const S_STDERR_TRAILING_WS = sh('stderr_trailing_ws.sh', R`printf 'boom   \n\n' >&2; exit 7`)
const S_BOTH_EXIT7 = sh('both_exit7.sh', R`printf 'out\n'; printf 'err\n' >&2; exit 7`)
const S_BIG_BOTH = sh('big_both_streams.sh', R`head -c 300000 /dev/zero | tr '\0' 'o'; printf '\n'; head -c 300000 /dev/zero | tr '\0' 'e' >&2; printf '\n' >&2`)
const S_BIG_STDERR_THEN_READ = sh('big_stderr_then_read.sh', R`head -c 300000 /dev/zero | tr '\0' 'e' >&2; printf '\n' >&2; cat`)
// 超时：`exec` 保证直接子进程就是 sleep（kill 命中它，不留孤儿）
const S_TIMEOUT_BASIC = sh('timeout_basic.sh', R`printf 'before\n'; exec sleep 4`)
const S_TIMEOUT_WITH_STDERR = sh('timeout_with_stderr.sh', R`printf 'before\n'; printf 'early-err\n' >&2; exec sleep 4`)
const S_TIMEOUT_TICKER = sh('timeout_ticker.sh', R`while :; do printf 'tick\n'; sleep 0.05; done`)
// 杀进程用的信号：Node `child.kill()` 默认 SIGTERM，Rust `tokio::process::Child::kill()` 是 SIGKILL。
// 脚本捕获 TERM 后写 marker 再 exit：能写出来 = 收到的是 SIGTERM（可被捕获），写不出来 = 被 SIGKILL。
// 用 `sleep 0.2` 轮询而不是一个长 `sleep`：bash 会把 trap 推迟到**当前前台命令**结束之后，
// 一个长 sleep 会让 marker 迟很久才出现（也拖慢探针）；0.2s 轮询让 Node 侧 ~200ms 内可观察到，
// 且被 SIGKILL 后残留的孤儿 sleep 也在 200ms 内自己退出。
const S_TRAP_TERM = sh('trap_term.sh', R`trap "printf trapped > $1; exit 0" TERM; printf 'before\n'; while :; do sleep 0.2; done`)
const S_EXIT127 = sh('exit127_in_script.sh', R`definitely-not-a-real-cmd-ccsa`)
// 子进程自杀（被信号终止）：Node 的 exit code 是 null，Rust 的 `st.code()` 是 None
const S_KILL_SELF = sh('kill_self.sh', R`printf 'out\n'; kill -9 $$`)

// exec_text 的数据文件
const D_MULTILINE = data('data_multiline.txt', 'l1\nl2\nl3\n')
const D_NO_TRAILING = data('data_no_trailing.txt', 'abc')
const D_EMPTY = data('data_empty.txt', '')
const D_CRLF = data('data_crlf.txt', 'a\r\nb\r\n')
const D_MB = data('data_mb.txt', '你好\n世界\n')
const D_BOM = data('data_bom.txt', '\uFEFFhello\n')
const D_BAD_UTF8 = data('data_invalid_utf8.bin', Buffer.from([0xff, 0xfe, 0x61, 0x62, 0x63, 0x0a]))
// 1.2 MB > Node `spawnSync` 的默认 `maxBuffer`（1 MiB）
const D_BIG = data('data_big.txt', '0123456789abcdef\n'.repeat(Math.ceil(1200000 / 17)))

// ── 用例表 ────────────────────────────────────────────────────────────────────
const cases = []
let seq = 0
const nextId = (base) => `${base}#${++seq}`

function addRunLines(id, { cmd, args = [], stdin = '', timeoutMs = 5000, label = 'claude', outerBoundMs, settleMs, echoCheck = false, wcBytes = null, marker = null, markerWaitMs = 0, lineCountRacy = false, note }) {
  cases.push({
    id,
    func: 'run_lines',
    cmd,
    args,
    stdin_text: stdin,
    timeout_ms: timeoutMs,
    label,
    outer_bound_ms: outerBoundMs,
    settle_ms: settleMs,
    echo_check: echoCheck,
    wc_bytes: wcBytes,
    marker,
    marker_wait_ms: markerWaitMs,
    line_count_racy: lineCountRacy,
    note,
  })
}
function addExecText(id, { cmd, args = [], note }) {
  cases.push({ id, func: 'exec_text', cmd, args, note })
}
function addSpawn(id, { exe, args = [], cwd, marker = null, note }) {
  cases.push({ id, func: 'spawn_detached', exe, args, cwd: cwd ?? join(tmp, 'side', '{SIDE}'), marker, note })
}

const shRun = (id, script, opts) => addRunLines(id, { cmd: 'sh', args: [script], ...opts })

// ① 行切分 / flush / 换行
shRun('run_lines/multiline', S_MULTILINE)
shRun('run_lines/no_trailing_nl', S_NO_TRAILING_NL)
shRun('run_lines/empty_output', S_EMPTY)
shRun('run_lines/crlf', S_CRLF)
shRun('run_lines/crlf_no_trailing_nl', S_CRLF_NO_TRAILING)
shRun('run_lines/lone_cr', S_LONE_CR)
shRun('run_lines/cr_at_eof', S_CR_AT_EOF)
shRun('run_lines/mixed_eol', S_MIXED_EOL)
shRun('run_lines/multibyte', S_MB)
shRun('run_lines/emoji', S_EMOJI)
shRun('run_lines/bom', S_BOM)
shRun('run_lines/invalid_utf8', S_BAD_UTF8)
shRun('run_lines/invalid_utf8_mid_stream', S_BAD_UTF8_MID)

// ② 大输出 / 背压 / 单行超大
shRun('run_lines/huge_50k_lines', S_HUGE, { timeoutMs: 15000 })
shRun('run_lines/one_huge_line', S_ONE_HUGE_LINE, { timeoutMs: 15000 })
shRun('run_lines/huge_multibyte', S_HUGE_MB, { timeoutMs: 15000 })
addRunLines('run_lines/cat_big_file', { cmd: 'cat', args: [D_BIG], timeoutMs: 15000 })

// ③ stdin：负载到达 + EOF + 不被 shell 解析
const STDIN_PLAIN = 'single-line\n'
const STDIN_MULTI = 'a\nb\nc\n'
const STDIN_NO_TRAILING = 'abc'
const STDIN_SHELL_META = 'a|b\nc;d\ne$f\n`g`\nh"i\'j\nk\\l\n$(echo pwned)\n~tilde\n% s\n&\n>\n<\n*[x]\n一 二\n'
const STDIN_LONE_CR = 'a\rb\n'
const STDIN_NUL = 'x\u0000y\n'
addRunLines('run_lines/stdin_plain', { cmd: 'cat', stdin: STDIN_PLAIN, echoCheck: true })
addRunLines('run_lines/stdin_multi', { cmd: 'cat', stdin: STDIN_MULTI, echoCheck: true })
addRunLines('run_lines/stdin_no_trailing_nl', { cmd: 'cat', stdin: STDIN_NO_TRAILING, echoCheck: true })
addRunLines('run_lines/stdin_empty', { cmd: 'cat', stdin: '', echoCheck: true })
addRunLines('run_lines/stdin_shell_metachars', { cmd: 'cat', stdin: STDIN_SHELL_META, echoCheck: true })
addRunLines('run_lines/stdin_lone_cr', { cmd: 'cat', stdin: STDIN_LONE_CR, echoCheck: true })
addRunLines('run_lines/stdin_nul_byte', { cmd: 'cat', stdin: STDIN_NUL, echoCheck: true })
// 整负载到达（用 `wc -c`，独立不变量：输出数字应等于 stdin 的 UTF-8 字节数）
const STDIN_1MB = 'x'.repeat(1_000_000 - 1) + '\n'
addRunLines('run_lines/stdin_1mb_wc', { cmd: 'wc', args: ['-c'], stdin: STDIN_1MB, timeoutMs: 10000, wcBytes: Buffer.byteLength(STDIN_1MB, 'utf8') })
// ⚠️ 死锁探针：子进程在读完 stdin 前就把 stdout 写满（cat 边读边回显），而 Rust 是
// 「先 write_all 整个 stdin（在 read 之前）」→ 双方互相阻塞。外加上限让探针能观察「没返回」。
addRunLines('run_lines/stdin_1mb_cat_echo', { cmd: 'cat', stdin: STDIN_1MB, timeoutMs: 2000, outerBoundMs: 4000 })
addRunLines('run_lines/stdin_1mb_child_writes_stderr_first', { cmd: 'sh', args: [S_BIG_STDERR_THEN_READ], stdin: STDIN_1MB, timeoutMs: 2000, outerBoundMs: 4000 })
// 子进程**完全不读 stdin** 就退出，而父进程还在写 1MB：两侧都必须忽略 broken pipe 并把
// 已有的 stdout 行完整交付（Node `stdin.on('error')` 忽略 / Rust `let _ = write_all`）。
addRunLines('run_lines/stdin_1mb_child_never_reads', { cmd: 'sh', args: [S_MULTILINE], stdin: STDIN_1MB, timeoutMs: 10000 })

// ④ 退出码 / stderr
shRun('run_lines/exit0_with_stderr', S_STDERR_OK)
shRun('run_lines/exit1_with_stderr', S_STDERR_FAIL)
shRun('run_lines/exit2_stderr_no_trailing_nl', S_STDERR_NO_TRAILING_NL)
shRun('run_lines/exit2_stderr_crlf', S_STDERR_CRLF)
shRun('run_lines/exit3_empty_stderr', S_STDERR_EMPTY_EXIT3)
shRun('run_lines/exit4_stderr_400_ascii', S_STDERR_LONG_ASCII)
shRun('run_lines/exit5_stderr_400_cjk', S_STDERR_LONG_MB)
shRun('run_lines/exit6_stderr_400_emoji', S_STDERR_LONG_EMOJI)
shRun('run_lines/exit7_stderr_trailing_ws', S_STDERR_TRAILING_WS)
shRun('run_lines/exit127_in_script', S_EXIT127)
// 缺失命令：不经脚本，直接让 shell 报 command not found
addRunLines('run_lines/missing_command', { cmd: 'definitely-not-a-real-cmd-ccsa' })
addRunLines('run_lines/missing_command_label_given', { cmd: 'definitely-not-a-real-cmd-ccsa', label: 'claude' })
// 大输出 + 大 stderr 并发（stderr 不并发收集会因管道填满互相阻塞）
shRun('run_lines/big_stdout_and_stderr', S_BIG_BOTH, { timeoutMs: 15000 })

// ⑤ 超时：必须杀掉、返回、且超时前的行不丢
shRun('run_lines/timeout_basic', S_TIMEOUT_BASIC, { timeoutMs: 800, settleMs: 150 })
shRun('run_lines/timeout_with_stderr', S_TIMEOUT_WITH_STDERR, { timeoutMs: 800, settleMs: 150 })
shRun('run_lines/timeout_ticker', S_TIMEOUT_TICKER, { timeoutMs: 600, settleMs: 150, lineCountRacy: true })
// 超时用的是哪个信号：脚本捕获 TERM 写 marker（能写 = SIGTERM 可捕获；写不出 = SIGKILL）
const TERM_MARKER = join(tmp, 'side', '{SIDE}', 'term.marker')
addRunLines('run_lines/timeout_kill_signal', {
  cmd: 'sh',
  args: [S_TRAP_TERM, TERM_MARKER],
  timeoutMs: 500,
  settleMs: 300,
  marker: TERM_MARKER,
  // 观察窗必须大于脚本里**当前前台 `sleep`** 的时长：bash 会把 TERM 的 trap 推迟到该命令结束之后。
  // 窗口太短会得到一条**假 match**（本轮先踩过：脚本用 `sleep 2`、窗口 1.5s 时两侧都没看到
  // marker，看上去"一致"，其实什么都没证明）。现在脚本用 0.2s 轮询，1.5s 已足够。
  markerWaitMs: 1500,
})
// 被信号杀死（不是正常退出）：退出码在 Node 是 null、在 Rust `st.code()` 是 None
addRunLines('run_lines/exit_by_signal', { cmd: 'sh', args: [S_KILL_SELF] })

// ⑥ argv 里的 shell 元字符 —— Node `shell:true` 是 `[file,...args].join(' ')`（**不引号**），
//    Rust `build_command` 对每个参数 `sh_quote`。二者在「argv 带空白/管道/分号」时必然分道扬镳。
addRunLines('run_lines/argv_special_chars', { cmd: 'echo', args: ['a b|c;d'] })
addRunLines('run_lines/argv_quotes_and_space', { cmd: 'echo', args: ["it's a test"] })
addRunLines('run_lines/argv_printf_format', { cmd: 'printf', args: ['%s\\n', 'a b|c;d'] })

// ⑦ exec_text：spawnSync 语义
addExecText('exec_text/echo_hello', { cmd: 'echo', args: ['hello'] })
addExecText('exec_text/cat_multiline', { cmd: 'cat', args: [D_MULTILINE] })
addExecText('exec_text/cat_no_trailing_nl', { cmd: 'cat', args: [D_NO_TRAILING] })
addExecText('exec_text/cat_empty', { cmd: 'cat', args: [D_EMPTY] })
addExecText('exec_text/cat_crlf', { cmd: 'cat', args: [D_CRLF] })
addExecText('exec_text/cat_multibyte', { cmd: 'cat', args: [D_MB] })
addExecText('exec_text/cat_bom', { cmd: 'cat', args: [D_BOM] })
addExecText('exec_text/cat_invalid_utf8', { cmd: 'cat', args: [D_BAD_UTF8] })
addExecText('exec_text/cat_1_2mb_over_maxbuffer', { cmd: 'cat', args: [D_BIG] })
addExecText('exec_text/which_sh', { cmd: 'which', args: ['sh'] })
addExecText('exec_text/which_missing', { cmd: 'which', args: ['definitely-not-a-real-cmd-ccsa'] })
addExecText('exec_text/missing_command', { cmd: 'definitely-not-a-real-cmd-ccsa' })
addExecText('exec_text/script_stdout_and_stderr_exit7', { cmd: 'sh', args: [S_BOTH_EXIT7] })
addExecText('exec_text/argv_special_printf', { cmd: 'printf', args: ['%s\\n', 'a b|c;d'] })
addExecText('exec_text/argv_special_echo', { cmd: 'echo', args: ['a b|c'] })

// ⑧ spawnDetached / defaultCwd
mkdirSync(join(tmp, 'side', 'node'), { recursive: true })
mkdirSync(join(tmp, 'side', 'rust'), { recursive: true })
addSpawn('spawn_detached/valid_marker', {
  exe: 'sh',
  args: ['-c', `printf ok > ${join(tmp, 'side', '{SIDE}', 'marker.txt')}`],
  marker: join(tmp, 'side', '{SIDE}', 'marker.txt'),
})
addSpawn('spawn_detached/valid_cwd_relative', {
  exe: 'sh',
  args: ['-c', 'printf cwd > rel-marker.txt'],
  marker: join(tmp, 'side', '{SIDE}', 'rel-marker.txt'),
})
addSpawn('spawn_detached/missing_exe', { exe: 'definitely-not-a-real-cmd-ccsa' })
addSpawn('spawn_detached/bad_cwd', { exe: 'sh', args: ['-c', 'exit 0'], cwd: join(tmp, 'side', '{SIDE}', 'no-such-dir') })
cases.push({ id: 'default_cwd/darwin_home', func: 'default_cwd' })

const manifest = { tmp, corpus, cases }
// harness 自检：字段类型必须是「能真的驱动两侧」的那一种。防的是「脚本路径位置传了对象」
// 这类会让 manifest 语法上合法、却在 Rust 侧 deserialize 失败（或更糟：静默跑错命令）的错。
for (const c of cases) {
  const bad = []
  if (typeof c.id !== 'string' || typeof c.func !== 'string') bad.push('id/func 非字符串')
  if (c.args && !(Array.isArray(c.args) && c.args.every((a) => typeof a === 'string'))) bad.push('args 含非字符串')
  for (const k of ['cmd', 'stdin_text', 'label', 'exe', 'cwd', 'marker']) {
    if (c[k] !== undefined && c[k] !== null && typeof c[k] !== 'string') bad.push(`${k} 非字符串（${typeof c[k]}）`)
  }
  for (const k of ['timeout_ms', 'outer_bound_ms', 'settle_ms', 'wc_bytes', 'marker_wait_ms']) {
    if (c[k] !== undefined && c[k] !== null && typeof c[k] !== 'number') bad.push(`${k} 非数字`)
  }
  for (const k of ['echo_check', 'line_count_racy']) {
    if (c[k] !== undefined && typeof c[k] !== 'boolean') bad.push(`${k} 非布尔`)
  }
  if (c.func === 'run_lines' && typeof c.cmd !== 'string') bad.push('run_lines 缺 cmd')
  if (c.func === 'run_lines' && typeof c.timeout_ms !== 'number') bad.push('run_lines 缺显式 timeout_ms')
  if (c.func === 'exec_text' && typeof c.cmd !== 'string') bad.push('exec_text 缺 cmd')
  if (c.func === 'spawn_detached' && (typeof c.exe !== 'string' || typeof c.cwd !== 'string')) bad.push('spawn_detached 缺 exe/cwd')
  if (bad.length) {
    console.error(`[procdiff] 用例 ${c.id} 字段类型不合法：${bad.join('; ')} —— 拒绝在语料本身有错时判绿`)
    process.exit(1)
  }
}
writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(manifest))
console.log(`[procdiff] 语料 ${cases.length} 条用例 → ${corpus}`)

// ── Node 侧 ──────────────────────────────────────────────────────────────────
const entry = join(tmp, 'entry.ts')
writeFileSync(entry, `export { nodeProcBridge } from ${JSON.stringify(join(REPO, 'core/procBridgeNode.ts'))}\n`)
const bundle = join(tmp, 'bundle.mjs')
execFileSync(
  join(REPO, 'node_modules/.bin/esbuild'),
  [entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`, '--log-level=warning'],
  { cwd: REPO, stdio: ['ignore', 'inherit', 'inherit'] },
)
const { nodeProcBridge } = await import(pathToFileURL(bundle).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SENTINEL = Symbol('timed-out')
/** 给一个 promise 套探针侧硬上限：返回 {timedOut:true} 而不是让观察者被挂死。 */
function withBound(promise, boundMs) {
  return new Promise((resolveRace) => {
    const timer = setTimeout(() => resolveRace(SENTINEL), boundMs)
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer)
        resolveRace(v)
      },
      // runLines/execText/spawnDetached 都不该 reject（它们把失败编码进返回值）；
      // 真 reject 了就让它显形，不要被当成超时。
      (e) => {
        clearTimeout(timer)
        resolveRace({ __rejected: e instanceof Error ? e.message : String(e) })
      },
    )
  })
}

async function runNode(c) {
  if (c.func === 'run_lines') {
    const sub = (s) => (s == null ? s : s.replace('{SIDE}', 'node'))
    const lines = []
    const started = Date.now()
    const p = nodeProcBridge.runLines(c.cmd, c.args.map(sub), c.stdin_text, (l) => lines.push(l), {
      timeoutMs: c.timeout_ms,
      label: c.label ?? undefined,
    })
    const bound = c.outer_bound_ms ?? c.timeout_ms + 3000
    const raced = await withBound(p, bound)
    const elapsedMs = Date.now() - started
    if (raced === SENTINEL) {
      return { probeTimedOut: true, ok: null, lines, error: null, stderr: null, elapsedMs, lateLines: 0, markerSeen: false }
    }
    if (raced && raced.__rejected) return { rejected: raced.__rejected }
    // 有界观察窗：Node 的「close 时 flush 末行」发生在 resolve 之后（超时路径已 resolve）
    let lateLines = 0
    if (c.settle_ms) {
      const before = lines.length
      await sleep(c.settle_ms)
      lateLines = lines.length - before
    }
    // 可选 marker（超时杀进程用的信号能不能被捕获 —— 见语料注释）
    let markerSeen = false
    const marker = sub(c.marker)
    if (marker) {
      const wait = c.marker_wait_ms || 0
      const deadline = Date.now() + wait
      do {
        markerSeen = existsSync(marker)
        if (!markerSeen) await sleep(20)
      } while (!markerSeen && Date.now() < deadline)
    }
    return {
      probeTimedOut: false,
      ok: raced.ok,
      lines,
      error: raced.error ?? null,
      stderr: raced.stderr,
      elapsedMs,
      lateLines,
      markerSeen,
    }
  }
  if (c.func === 'exec_text') {
    const r = await nodeProcBridge.execText(c.cmd, c.args)
    return { ok: r.ok, out: r.out, error: r.error ?? null, invokeError: null }
  }
  if (c.func === 'spawn_detached') {
    const sub = (s) => (s == null ? s : s.replace('{SIDE}', 'node'))
    let r
    try {
      r = await nodeProcBridge.spawnDetached(sub(c.exe), c.args.map(sub), sub(c.cwd))
    } catch (e) {
      r = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    let markerSeen = false
    const marker = sub(c.marker)
    if (marker) {
      for (let i = 0; i < 100 && !markerSeen; i++) {
        markerSeen = existsSync(marker)
        if (!markerSeen) await sleep(20)
      }
    }
    return { ok: r.ok, error: r.error ?? null, markerSeen }
  }
  if (c.func === 'default_cwd') {
    return { ok: true, value: await nodeProcBridge.defaultCwd() }
  }
  throw new Error(`未知 func ${c.func}`)
}

const nodeResults = new Map()
for (const c of cases) {
  const r = await runNode(c)
  if (r && r.rejected) {
    console.error(`[procdiff] Node 侧用例 ${c.id} 抛异常（不该发生）: ${r.rejected}`)
    process.exit(1)
  }
  nodeResults.set(c.id, r)
}

// 独立不变量 1：`cat` 回显 = stdin 原样（不经 shell 解析）。只对无 `\r` 的负载做，
// 因为 `\r?\n` 行切分**有意**把 CRLF 归一（这不是丢失，是契约）。
const echoViolations = []
for (const c of cases) {
  if (!c.echo_check) continue
  const n = nodeResults.get(c.id)
  const reconstructed = n.lines.length === 0 ? '' : n.lines.join('\n') + (c.stdin_text.endsWith('\n') ? '\n' : '')
  if (reconstructed !== c.stdin_text) {
    echoViolations.push({ id: c.id, side: 'node', got: reconstructed, want: c.stdin_text })
  }
}
// 独立不变量 2：`wc -c` 的数字 = stdin 的 UTF-8 字节数（钉「整负载真的到达了」）
const wcViolations = []
for (const c of cases) {
  if (c.wc_bytes == null) continue
  const n = nodeResults.get(c.id)
  const got = Number(String(n.lines[0] ?? '').trim())
  if (got !== c.wc_bytes) wcViolations.push({ id: c.id, side: 'node', got, want: c.wc_bytes })
}

// ── Rust 侧 ──────────────────────────────────────────────────────────────────
let cargoOut
try {
  cargoOut = execFileSync(
    'cargo',
    ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--test', 'proc_differential', '--', '--ignored', '--nocapture'],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, CCSA_PROC_DIFF_DIR: tmp }, maxBuffer: 256 * 1024 * 1024 },
  )
} catch (e) {
  console.error('[procdiff] cargo test 失败：')
  console.error(e.stdout || '')
  console.error(e.stderr || '')
  process.exit(1)
}
if (!cargoOut.includes('proc_differential: 写出')) {
  console.error('[procdiff] cargo test 输出里没有探针的完成标记 —— 探针可能没被真正执行（拒绝在无声中判绿）')
  console.error(cargoOut)
  process.exit(1)
}
const rustDump = JSON.parse(readFileSync(join(tmp, 'rust.json'), 'utf8'))
if (rustDump.caseCount !== cases.length || rustDump.results.length !== cases.length) {
  console.error(`[procdiff] Rust 侧用例数 ${rustDump.results.length} ≠ manifest ${cases.length}（拒绝在缺数据时判绿）`)
  process.exit(1)
}
const rustResults = new Map(rustDump.results.map((r) => [r.id, r.result]))
for (const c of cases) {
  if (!rustResults.has(c.id)) {
    console.error(`[procdiff] Rust 侧缺用例 ${c.id}`)
    process.exit(1)
  }
}
console.log(`[procdiff] Rust 侧 ${rustResults.size} 条结果已读回`)

// 把两侧的独立不变量都补齐（回显 / wc 数字）
for (const c of cases) {
  if (c.echo_check) {
    const r = rustResults.get(c.id)
    if (!r.probeTimedOut) {
      const reconstructed = r.lines.length === 0 ? '' : r.lines.join('\n') + (c.stdin_text.endsWith('\n') ? '\n' : '')
      if (reconstructed !== c.stdin_text) echoViolations.push({ id: c.id, side: 'rust', got: reconstructed, want: c.stdin_text })
    }
  }
  if (c.wc_bytes != null) {
    const r = rustResults.get(c.id)
    if (!r.probeTimedOut) {
      const got = Number(String((r.lines ?? [])[0] ?? '').trim())
      if (got !== c.wc_bytes) wcViolations.push({ id: c.id, side: 'rust', got, want: c.wc_bytes })
    }
  }
}

// ── 差分 ─────────────────────────────────────────────────────────────────────
// 规范序列化：对象键递归排序（见文件头「归一化声明」1）；数组顺序不动。
function canon(v) {
  if (Array.isArray(v)) return v.map(canon)
  if (v && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k])
    return o
  }
  return v
}
const j = (v) => JSON.stringify(canon(v))

// §5 明列的有意偏差（不当作新发现，但仍计数并单列）
const SECTION5_DELIBERATE = new Set(['default_cwd/darwin_home'])
// 代码注释里明文声明的、**不在 §5 清单**里的偏差（仍计数并单列，附理由）
const DOCUMENTED_DEVIATION = new Map([
  ['run_lines/argv_special_chars', 'claude.rs 明文：Rust 对每个 argv 做 sh_quote；Node 的 shell:true 是 [file,...args].join(" ") 不引号'],
  ['run_lines/argv_quotes_and_space', '同上'],
  ['run_lines/argv_printf_format', '同上'],
  ['exec_text/argv_special_printf', '同上'],
  ['exec_text/argv_special_echo', '同上'],
])
// **参考实现自身的缺陷**：这些是 Node 侧的既有行为，Rust 刻意**不照抄**（照抄等于把 bug 搬过来）。
// 仍计入 mismatch 并逐条打印理由；只是不当作「尚未解释的新发现」。
const KNOWN_REFERENCE_SHORTFALL = new Map([
  ['run_lines/huge_multibyte', 'Node 按 data chunk 各自 toString()，多字节字符跨读边界被切成 U+FFFD（本轮实测 9 处/30000 行）；Rust 整行正确解码。对齐它 = 故意引入乱码'],
  ['run_lines/timeout_kill_signal', 'Node child.kill() 是 SIGTERM（脚本 trap 到并写出 marker，实测进程活到 sleep 结束）；Rust tokio Child::kill() 是 SIGKILL（marker 从未出现）。契约要求「超时必须杀掉」，Rust 更硬'],
  ['exec_text/cat_1_2mb_over_maxbuffer', 'Node spawnSync 默认 maxBuffer=1 MiB（+1 个 64 KiB 块），1.2 MB 输出被截到 1114112 字符；Rust 不截断。execText 的真实调用只有 which/--help，量级远小于此'],
  ['spawn_detached/missing_exe', 'Node spawn 的 ENOENT 是**异步** error 且被 child.on("error") 吞掉 → 恒 ok:true；Rust 返回真实失败（terminal.rs 明文「命令不存在 → 明确的 Err」）'],
  ['spawn_detached/bad_cwd', '同上：坏 cwd 的 ENOENT 在 Node 同样被吞 → ok:true，Rust 返回 Err'],
])

function classify(c, n, r) {
  const diffs = []
  if (c.func === 'run_lines') {
    if (!!n.probeTimedOut !== !!r.probeTimedOut) return { kind: 'probe-timeout' }
    if (n.probeTimedOut && r.probeTimedOut) return { kind: 'both-probe-timeout' }
    if (n.ok !== r.ok) diffs.push('ok')
    // `line_count_racy` 的用例（持续输出的 ticker）：**行数**取决于「50ms 的间隔里塞得进几次」，
    // 与调度器赛跑、天生不可比。这里只比「行内容的集合」与「双方都至少收到一行」，行数差异不计。
    // 这是本轮**唯一**一处对真实差异的归一化，且只作用于这一条用例；其余用例仍逐字节比完整有序行序列。
    if (c.line_count_racy) {
      const uniq = (a) => j([...new Set(a)])
      if (uniq(n.lines) !== uniq(r.lines) || n.lines.length === 0 || r.lines.length === 0) diffs.push('lines')
    } else if (j(n.lines) !== j(r.lines)) diffs.push('lines')
    if ((n.error ?? null) !== (r.error ?? null)) diffs.push('error')
    if ((n.stderr ?? null) !== (r.stderr ?? null)) diffs.push('stderr')
    if (!!n.markerSeen !== !!r.markerSeen) diffs.push('markerSeen')
  } else if (c.func === 'exec_text') {
    if (r.invokeError != null) return { kind: 'rust-invoke-error' }
    if (n.ok !== r.ok) diffs.push('ok')
    if (n.out !== r.out) diffs.push('out')
    if ((n.error ?? null) !== (r.error ?? null)) diffs.push('error')
  } else if (c.func === 'spawn_detached') {
    if (n.ok !== r.ok) diffs.push('ok')
    if (n.markerSeen !== r.markerSeen) diffs.push('markerSeen')
  } else if (c.func === 'default_cwd') {
    if (j(n.value) !== j(r.value)) diffs.push('value')
  } else {
    throw new Error(`未知 func ${c.func}`)
  }
  return diffs.length ? { kind: diffs.join('+') } : { kind: 'match' }
}

const rows = []
for (const c of cases) {
  let n = nodeResults.get(c.id)
  let r = rustResults.get(c.id)
  if (SELFTEST && c.id === 'run_lines/multiline') {
    // 只用于证伪 harness：把那一条 Node 结果的第一个行改一个字符
    n = { ...n, lines: [n.lines[0] + 'X', ...n.lines.slice(1)] }
  }
  const cls = classify(c, n, r)
  rows.push({ c, n, r, ...cls })
}
const mismatches = rows.filter((x) => x.kind !== 'match' && x.kind !== 'both-probe-timeout')
const bothTimedOut = rows.filter((x) => x.kind === 'both-probe-timeout')
const byKind = {}
for (const x of mismatches) byKind[x.kind] = (byKind[x.kind] ?? 0) + 1
const isKnown = (x) =>
  SECTION5_DELIBERATE.has(x.c.id) || DOCUMENTED_DEVIATION.has(x.c.id) || KNOWN_REFERENCE_SHORTFALL.has(x.c.id)
// 判据（gate）只看「**尚未解释**的不匹配」：已知偏差/参考实现缺陷仍**计数、仍逐条打印**，
// 不参与 pass/fail 只是因为「照抄 Node 的 bug」不该是验收目标 —— 不是把它们归一化掉。
const unexplained = mismatches.filter((x) => !isKnown(x))

// ── 输出 ─────────────────────────────────────────────────────────────────────
const short = (s) => (s === null || s === undefined ? String(s) : s.length > 260 ? `${s.slice(0, 260)}…(${s.length} 字符)` : s)
// 行序列差异的定位：长数组只打印前 8 项看不出问题在哪（本轮 huge_multibyte 就是被这个掩盖的）
function firstLineDiff(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}
function countLineDiffs(a, b) {
  let c = 0
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) c++
  return c
}
const cmdLine = (c) => {
  if (c.func === 'run_lines') return `runLines(${JSON.stringify(c.cmd)}, ${JSON.stringify(c.args)}, stdin=${c.stdin_text.length}B, timeout=${c.timeout_ms}ms)`
  if (c.func === 'exec_text') return `execText(${JSON.stringify(c.cmd)}, ${JSON.stringify(c.args)})`
  if (c.func === 'spawn_detached') return `spawnDetached(${JSON.stringify(c.exe)}, ${JSON.stringify(c.args)}, cwd=${JSON.stringify(c.cwd)})`
  return `defaultCwd()`
}
console.log('\n===== proc ↔ Node 差分报告 =====')
console.log(`用例数: ${cases.length}   匹配: ${rows.length - mismatches.length - bothTimedOut.length}   不匹配: ${mismatches.length}   ${mismatches.length ? JSON.stringify(byKind) : ''}`)
{
  const byFunc = {}
  for (const x of rows) {
    const t = (byFunc[x.c.func] ??= { total: 0, match: 0, mismatch: 0 })
    t.total++
    if (x.kind === 'match' || x.kind === 'both-probe-timeout') t.match++
    else t.mismatch++
  }
  console.log('按原语: ' + Object.entries(byFunc).map(([f, t]) => `${f} ${t.match}/${t.total} 匹配`).join('  |  '))
}
const countIf = (pred) => mismatches.filter(pred).length
console.log(
  `\n不匹配归类：§5 明列有意偏差 ${countIf((x) => SECTION5_DELIBERATE.has(x.c.id))} 条；` +
    `代码注释声明偏差 ${countIf((x) => DOCUMENTED_DEVIATION.has(x.c.id))} 条；` +
    `参考实现自身缺陷(刻意不照抄) ${countIf((x) => KNOWN_REFERENCE_SHORTFALL.has(x.c.id))} 条；` +
    `**尚未解释 ${unexplained.length} 条**（这一项 = 判据）`,
)
for (const x of bothTimedOut) console.log(`(两侧都未在上限内返回: ${x.c.id})`)

if (mismatches.length) {
  console.log('\n-- 不匹配明细（含有意偏差与已知缺陷，逐条标类别）--')
  for (const x of mismatches) {
    const tag = SECTION5_DELIBERATE.has(x.c.id)
      ? '有意偏差(§5)'
      : DOCUMENTED_DEVIATION.has(x.c.id)
        ? '注释声明偏差'
        : KNOWN_REFERENCE_SHORTFALL.has(x.c.id)
          ? '参考实现缺陷(不照抄)'
          : '尚未解释'
    console.log(`\n[${x.kind}] <${tag}> ${x.c.id}${x.c.note ? `  (${x.c.note})` : ''}`)
    if (KNOWN_REFERENCE_SHORTFALL.has(x.c.id)) console.log(`    why : ${KNOWN_REFERENCE_SHORTFALL.get(x.c.id)}`)
    if (DOCUMENTED_DEVIATION.has(x.c.id)) console.log(`    why : ${DOCUMENTED_DEVIATION.get(x.c.id)}`)
    console.log(`    cmd : ${cmdLine(x.c)}`)
    if (x.n.probeTimedOut || x.r.probeTimedOut) {
      console.log(`    Node: probeTimedOut=${x.n.probeTimedOut} lines=${x.n.lines.length} elapsed=${x.n.elapsedMs}ms ${x.n.error ? `error=${short(x.n.error)}` : ''}`)
      console.log(`    Rust: probeTimedOut=${x.r.probeTimedOut} lines=${x.r.lines.length} elapsed=${x.r.elapsedMs}ms ${x.r.error ? `error=${short(x.r.error)}` : ''}`)
      continue
    }
    if (x.c.func === 'run_lines') {
      console.log(`    Node: ok=${x.n.ok} lines=(${x.n.lines.length}) ${short(j(x.n.lines.slice(0, 8)))} error=${short(x.n.error)} stderr=${short(x.n.stderr)}${x.c.marker ? ` markerSeen=${x.n.markerSeen}` : ''}`)
      console.log(`    Rust: ok=${x.r.ok} lines=(${x.r.lines.length}) ${short(j(x.r.lines.slice(0, 8)))} error=${short(x.r.error)} stderr=${short(x.r.stderr)}${x.c.marker ? ` markerSeen=${x.r.markerSeen}` : ''}`)
      if (x.kind.includes('lines')) {
        const k = firstLineDiff(x.n.lines, x.r.lines)
        const dn = k >= 0 ? x.n.lines[k] : null
        const dr = k >= 0 ? x.r.lines[k] : null
        console.log(`    firstDiff: #${k}（共 ${countLineDiffs(x.n.lines, x.r.lines)} 处） Node=${short(JSON.stringify(dn))} Rust=${short(JSON.stringify(dr))}`)
      }
    } else if (x.c.func === 'exec_text') {
      console.log(`    Node: ok=${x.n.ok} out=${short(x.n.out)} error=${short(x.n.error)}`)
      console.log(`    Rust: ok=${x.r.ok} out=${short(x.r.out)} invokeError=${short(x.r.invokeError)} error=${short(x.r.error)}`)
    } else if (x.c.func === 'spawn_detached') {
      console.log(`    Node: ok=${x.n.ok} markerSeen=${x.n.markerSeen} error=${short(x.n.error)}`)
      console.log(`    Rust: ok=${x.r.ok} markerSeen=${x.r.markerSeen} error=${short(x.r.error)}`)
    } else {
      console.log(`    Node: ${short(j(x.n))}`)
      console.log(`    Rust: ${short(j(x.r))}`)
    }
  }
}

console.log(`\n-- 独立不变量 --`)
console.log(`   cat 回显 = stdin 原样（不经 shell 解析）: 违反 ${echoViolations.length} 条`)
for (const v of echoViolations) console.log(`   ! [${v.side}] ${v.id} got=${short(JSON.stringify(v.got))} want=${short(JSON.stringify(v.want))}`)
console.log(`   wc -c 数字 = stdin UTF-8 字节数（整负载到达）: 违反 ${wcViolations.length} 条`)
for (const v of wcViolations) console.log(`   ! [${v.side}] ${v.id} got=${v.got} want=${v.want}`)

console.log('\n-- 超时用例耗时（只记录，不比具体数值）--')
for (const x of rows.filter((x) => x.c.settle_ms)) {
  console.log(`   ${x.c.id}: Node ${x.n.elapsedMs}ms(片段后补 ${x.n.lateLines} 行)  Rust ${x.r.elapsedMs}ms  kind=${x.kind}`)
}

let pass = unexplained.length === 0 && echoViolations.length === 0 && wcViolations.length === 0 && bothTimedOut.length === 0
if (SELFTEST) {
  const hit = unexplained.some((x) => x.c.id === 'run_lines/multiline' && x.kind.includes('lines'))
  console.log(`\n[SELFTEST] 注入的 run_lines/multiline 一个字符差异被捕获: ${hit ? '是' : '否'}`)
  pass = hit
  console.log(hit ? '[SELFTEST] OK —— 差分确实能报出差异' : '[SELFTEST] FAIL —— 差分对注入差异无反应')
}
if (KEEP) console.log(`\n[procdiff] 保留临时目录: ${tmp}`)
process.exit(pass ? 0 : 1)
