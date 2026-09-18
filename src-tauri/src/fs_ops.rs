//! 文件系统原语 —— `core/` 里 3 个触碰 `node:fs` 的文件所需的**全部**系统调用面。
//!
//! 设计约束（Stage 2 的核心架构决定）：**只替换 syscall 层，不搬业务逻辑**。
//! `core/discovery/scan.ts` 的噪音过滤 / 双预算 / 标题提取、`core/parser/parse.ts` 的全部解析
//! 都留在 TS —— 它们有 145 条测试覆盖，重写成 Rust 等于丢掉测试资产并引入语义漂移。
//! 这里是 syscall 边界上的全部命令（`readTextSync` 除外 —— 只有同步宿主能实现，Tauri 桥按契约抛可读
//! 错误），语义严格对齐 Node：
//!
//! | 本模块 | 对齐 |
//! |---|---|
//! | `read_dir` | `fs.promises.readdir(dir, { withFileTypes: true })`，含 libuv 的 **strcmp 名字序** |
//! | `stat` | `fs.promises.stat`（跟随符号链接），`mtimeMs` 按 Node 的 `sec*1000 + nsec/1e6` 算 |
//! | `read_text` | `fs.readFileSync(path, 'utf8')`（有损解码）|
//! | `read_head` | `readline`（`crlfDelay: Infinity`）行 + `line.length + 1`（**UTF-16 单元**）配额 |
//! | `write_text` | `fs.writeFile(path, text, 'utf8')`（整文件覆盖，父目录不存在则报错）|
//! | `home_dir` | `os.homedir()`：环境变量**已定义即用（含空串）**，未定义才回退 `getpwuid(getuid())` |
//!
//! 这些「严格对齐」不是读 Node 源码推理出来的：`test/tools/fs-ops-differential.mjs` 用同一批语料
//! 同时驱动本模块与 `core/fsBridgeNode.ts`、逐项比完整结果（见方案文档 §8bis 的 2026-09-15 两条日志）。
//! 2026-09-15 的第二条把首次差分查出的 10 类偏差逐条按 Node 修掉 —— 凡与本文件注释不符者，以差分与
//! Node 为准。
use serde::Serialize;
use std::time::UNIX_EPOCH;

#[derive(Serialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub is_dir: bool,
    pub is_file: bool,
}

#[derive(Serialize)]
pub struct StatInfo {
    pub is_file: bool,
    pub size: u64,
    /// 毫秒浮点，对齐 Node 的 `stats.mtimeMs`（scan.ts 直接拿它排序）。
    /// **不能**用 `as_millis()` 截断：Node 保留亚毫秒（`sec*1000 + nsec/1e6` 的 double 结果），
    /// 截断会让两侧在同一文件上给出不同数值（首轮差分查出 10 例）。
    pub mtime_ms: f64,
}

/// 读目录。`is_dir`/`is_file` 为 lstat 语义（不跟随符号链接）——与 Node 的 `Dirent` 一致。
///
/// 顺序也对齐 Node：libuv 的 `uv_fs_scandir` 用 `strcmp` 对名字排序（macOS 走 `scandir(3)`，
/// 比较函数是 `uv__fs_scandir_sort`），而 Rust 的 `read_dir` 给的是 readdir 原序。首轮差分实测
/// `read_dir/many` 上两者顺序不同。这里按 UTF-8 **字节序**排 —— 与 `strcmp` 对合法 UTF-8 名字
/// 的比较结果一致（`strcmp` 比 unsigned char，Rust `str` 的 `Ord` 也是字节序）。
#[tauri::command]
pub async fn read_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let mut rd = tokio::fs::read_dir(&path).await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
        let ft = entry.file_type().await.map_err(|e| e.to_string())?;
        out.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir: ft.is_dir(),
            is_file: ft.is_file(),
        });
    }
    out.sort_by(|a, b| a.name.as_bytes().cmp(b.name.as_bytes()));
    Ok(out)
}

/// `SystemTime` → Node `stats.mtimeMs` 的毫秒浮点。
///
/// Node 的 C++ 侧是 `(double)tv_sec * 1000 + (double)tv_nsec / 1e6`（两步 double 运算），**不是**
/// 先把纳秒整体转成一个数再除 —— 两者在某些纳秒值上给出不同的 double（首轮差分与独立探针都实测到：
/// `mtimeNs=1789366606113271890` 时前者给 `1789366606113.272`、后者给 `1789366606113.2717`）。
/// 这里逐字照抄前者的运算次序。
fn mtime_ms_from(t: std::time::SystemTime) -> f64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => ms_from_parts(d.as_secs(), d.subsec_nanos()),
        // 1970 之前的 mtime（理论上可达：文件系统允许负时间戳）→ 按 0 处理，与原来一致
        Err(_) => 0.0,
    }
}

/// `mtimeMs` 的算式本体，**独立于 `SystemTime`**。
///
/// 拆出来是为了能测：Windows 的 `SystemTime` 是 FILETIME，只有 **100ns** 粒度，
/// 把纳秒级的输入塞进去再取出来会先被量化掉（`112_978_180` ns → `112_978_100` ns），
/// 于是拿 `UNIX_EPOCH + Duration::new(...)` 当输入的单测在 Windows 上必红 ——
/// 而算式本身是和 Node 逐位一致的。输入的精度与算法的精度是两件事，别让前者替后者背锅。
fn ms_from_parts(secs: u64, nanos: u32) -> f64 {
    secs as f64 * 1000.0 + nanos as f64 / 1_000_000.0
}

/// 取元信息。`tokio::fs::metadata` 跟随符号链接，与 Node 的 `fs.stat` 一致
/// （Node 的 `lstat` 才是"不跟随"，scan.ts 用的是 `stat`）。
#[tauri::command]
pub async fn stat(path: String) -> Result<StatInfo, String> {
    let md = tokio::fs::metadata(&path).await.map_err(|e| e.to_string())?;
    let mtime_ms = md.modified().map(mtime_ms_from).unwrap_or(0.0);
    Ok(StatInfo {
        is_file: md.is_file(),
        size: md.len(),
        mtime_ms,
    })
}

/// 家目录。对齐 Node `os.homedir()`：**环境变量已定义就直接用（空串也算已定义）**，只有当它
/// 根本没定义时才回退到系统查询（POSIX 是 `getpwuid_r(getuid())`，走 `std::env::home_dir()`）。
///
/// 这两处细节都是差分核验出来的，且都反直觉：
///   - 空串**不**回退 —— Node 走 `uv_os_getenv`，它只区分「有/无」，不区分「空/非空」；
///     而 `std::env::home_dir()` 自己会把空 `HOME` 当未设置。所以这里必须先自己读环境变量。
///   - 未设置时**要**回退 —— Rust 原来直接报错，Node 给出 `getpwuid` 的家目录（首轮差分 ⑩）。
///
/// Windows 取 `USERPROFILE`（Node 在 Windows 上同样先看它），未定义时同样回退系统查询。
#[tauri::command]
pub fn home_dir() -> Result<String, String> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    if let Some(v) = std::env::var_os(key) {
        return Ok(v.to_string_lossy().into_owned());
    }
    // 走到这里说明环境变量不存在 → 回退系统查询。`std::env::home_dir` 自带的「HOME 非空才用」
    // 逻辑不会生效（HOME 此刻不存在），它只会走 getpwuid 那支。
    #[allow(deprecated)] // std::env::home_dir 直到 Rust 1.85 才取消弃用，本 crate 声明 rust-version = 1.77
    match std::env::home_dir() {
        Some(p) => Ok(p.to_string_lossy().into_owned()),
        None => Err(format!("环境变量 {key} 未设置，且无法从系统取得家目录")),
    }
}

/// 整文件读为字符串。对非法 UTF-8 做**有损**替换，与 `readFileSync(p, 'utf8')` 的可观测行为一致
/// （会话文件理论上都是合法 UTF-8，这里只为对齐边界行为）。
#[tauri::command]
pub async fn read_text(path: String) -> Result<String, String> {
    let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// 把一行（已剥掉行界的原始字节）按 Node 的配额规则尝试收下：代价是 `UTF-16 单元数 + 1`。
/// 收下返回 `true`；超配额返回 `false`（调用方据此结束）。
fn commit_line(lines: &mut Vec<String>, used: &mut usize, limit: usize, bytes: &[u8]) -> bool {
    let line = String::from_utf8_lossy(bytes).into_owned();
    let cost = line.encode_utf16().count() + 1;
    if used.saturating_add(cost) > limit {
        return false;
    }
    *used += cost;
    lines.push(line);
    true
}

/// Node `readHead` 的收尾：`lines.join('\n') + '\n'`；一行都没有则 `""`。
fn assemble_head(lines: &[String]) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

/// 读文件头部，与 Node 参考实现 `fsBridgeNode.ts::readHead` 逐项对齐 —— 不是「按字节截断再回退到
/// 最后一个换行」，而是 `readline` 的**行 + UTF-16 配额**：
///
///   - 行界是 `\r\n` / `\n` / 孤立 `\r` 三者（`crlfDelay: Infinity`），返回时统一以 `\n` 连接
///     并**补一个尾 `\n`**。于是 CRLF 归一为 LF、末行没有换行也会补上（首轮差分 ①②③）。
///   - 配额单位是 **UTF-16 单元**（`line.length + 1`），不是字节（首轮差分 ④）。按字节计会让
///     多字节文件少读若干行 —— 曾实测丢掉承载 `cwd` 的那一行，使解析结果从 `{cwd:…}` 变成 `{}`（⑤）。
///   - 空文件 / 第一行就超配额 → `""`（不是半行）；恰好到 EOF 的那一行同样按 cost 判定（⑥）。
///   - 读失败（权限 / 被删 / 是目录）**不抛错**，返回已读到的整行（⑦），与 Node 的 `try/catch` 一致。
///
/// 行对齐这条承诺仍成立且更强：返回值要么是空串，要么以 `\n` 结尾；其行序列一定是原文行序列的
/// 前缀（差分脚本里有独立不变量在查）。
#[tauri::command]
pub async fn read_head(path: String, max_bytes: u64) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let limit = usize::try_from(max_bytes).unwrap_or(usize::MAX);
    let mut f = match tokio::fs::File::open(&path).await {
        // 打不开 → Node 的 createReadStream 报错被 catch、lines 为空 → ""
        Ok(f) => f,
        Err(_) => return Ok(String::new()),
    };

    let mut lines: Vec<String> = Vec::new();
    let mut used: usize = 0;
    let mut cur: Vec<u8> = Vec::new();
    // 超长单行的内存护栏：UTF-16 单元数 ≥ 字节数 / 3（最坏是 3 字节的 BMP 字符），所以当前行超过
    // 3×limit 字节就一定塞不进配额，可以提前结束 —— 与 Node「整行读完再判超限」的结果相同。
    let cur_cap = limit.saturating_mul(3).saturating_add(4);
    let mut skip_lf = false; // 上一个字节是 \r：紧随其后的 \n 属于同一个行界
    let mut buf = vec![0u8; 64 * 1024];

    loop {
        let n = match f.read(&mut buf).await {
            Ok(0) => break, // EOF：下面 flush 末尾没有行界收尾的残行
            Ok(n) => n,
            // 读中途失败 → 丢掉残行、保留已收下的整行（Node 的 for-await 抛错时也是这个形状）
            Err(_) => return Ok(assemble_head(&lines)),
        };
        for &b in &buf[..n] {
            let is_lf = b == b'\n';
            if skip_lf {
                skip_lf = false;
                if is_lf {
                    continue; // \r\n 只算一个行界
                }
            }
            if is_lf || b == b'\r' {
                if !commit_line(&mut lines, &mut used, limit, &cur) {
                    return Ok(assemble_head(&lines)); // 配额耗尽：与 Node 的 break 一致
                }
                cur.clear();
                skip_lf = b == b'\r';
            } else {
                cur.push(b);
                if cur.len() > cur_cap {
                    return Ok(assemble_head(&lines));
                }
            }
        }
    }

    // EOF 处未以行界收尾的残行，readline 也会作为完整一行产出（流 close 时 flush）
    if !cur.is_empty() {
        commit_line(&mut lines, &mut used, limit, &cur);
    }
    Ok(assemble_head(&lines))
}

/// 写文本文件（整文件覆盖）。服务于「导出 markdown」：路径来自系统保存对话框。
///
/// 语义对齐 `fs.writeFile(path, text, 'utf8')`：父目录不存在会报错（不自动创建），
/// 这与 Electron 版一致 —— 对话框给出的路径父目录一定存在。
#[tauri::command]
pub async fn write_text(path: String, contents: String) -> Result<(), String> {
    tokio::fs::write(&path, contents.as_bytes())
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 建一个临时目录（不引第三方 crate，避免仅为测试加依赖）
    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "ccsa-fsops-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write(path: &std::path::Path, content: &str) {
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    /// read_head 的核心承诺：返回**行对齐**前缀，绝不给出半行。
    /// 这一条是 `scan.ts` 行首 `"type"` 正则与配额统计不被污染的前提。
    ///
    /// cap=7 的账（Node 口径 `line.length + 1`）：第 1 行 `aaaa` cost 5 ≤ 7 → 收下；再收 `bbbb`
    /// 要 5，5+5=10 > 7 → 停。所以给 `"aaaa\n"`。**不是**「按字节截断后回退到换行」，是配额本来
    /// 就停在这里 —— 两种推理在这条输入上恰好同解，故旧注释也是对的，但机制不同。
    #[tokio::test]
    async fn read_head_truncates_at_last_newline() {
        let d = tmpdir("head-align");
        let f = d.join("s.jsonl");
        write(&f, "aaaa\nbbbb\ncccc\n");

        let got = read_head(f.to_string_lossy().into_owned(), 7).await.unwrap();
        assert_eq!(got, "aaaa\n");

        std::fs::remove_dir_all(&d).ok();
    }

    #[tokio::test]
    async fn read_head_returns_whole_file_when_under_cap() {
        let d = tmpdir("head-whole");
        let f = d.join("s.jsonl");
        write(&f, "aaa\n");
        let got = read_head(f.to_string_lossy().into_owned(), 4096).await.unwrap();
        assert_eq!(got, "aaa\n");
        std::fs::remove_dir_all(&d).ok();
    }

    /// 第一行就超配额 → 宁可返回空串，也不能返回半行
    #[tokio::test]
    async fn read_head_returns_empty_when_first_line_exceeds_quota() {
        let d = tmpdir("head-nonl");
        let f = d.join("s.jsonl");
        write(&f, "aaaaaaaaaaaaaaaaaaaa");
        let got = read_head(f.to_string_lossy().into_owned(), 4).await.unwrap();
        assert_eq!(got, "");
        std::fs::remove_dir_all(&d).ok();
    }

    /// 配额按 **UTF-16 单元**（而不是字节）计，逐值对齐 Node 参考实现。
    ///
    /// 旧版单测在这里断言 `cap9 → "你好\n"`，那是**按字节推理**出来的期望，**与 Node 相反**：
    /// `"你好\n世界\n"` 两行的 cost 各是 `2 + 1 = 3`，cap=9 时两行都收得下 → `"你好\n世界\n"`。
    /// 这正是首轮差分查出的 ④（上限口径）在单测里的表现 —— 绿测钉的是推理而非参考实现。
    /// 下面的期望值取自 Node 侧实测（`nodeFsBridge.readHead`），差分脚本会再核一遍。
    #[tokio::test]
    async fn read_head_counts_utf16_units_like_node() {
        let d = tmpdir("head-mb");
        let f = d.join("s.jsonl");
        write(&f, "你好\n世界\n");
        let p = f.to_string_lossy().into_owned();

        assert_eq!(read_head(p.clone(), 5).await.unwrap(), "你好\n"); // 3 ≤ 5 < 6
        assert_eq!(read_head(p.clone(), 9).await.unwrap(), "你好\n世界\n"); // 两行共 6 ≤ 9
        assert_eq!(read_head(p, 2).await.unwrap(), ""); // 第一行 cost 3 > 2

        std::fs::remove_dir_all(&d).ok();
    }

    /// 行界与收尾逐字对齐 Node 的 `readline`（`crlfDelay: Infinity`）+ `join('\n') + '\n'`：
    /// `\r\n` 归一为 `\n`、孤立 `\r` 也是行界、末行没有换行会**补上**换行（首轮差分 ①②③）。
    #[tokio::test]
    async fn read_head_normalizes_line_endings_like_readline() {
        let d = tmpdir("head-eol");
        let p = |name: &str, text: &str| {
            let f = d.join(name);
            write(&f, text);
            f.to_string_lossy().into_owned()
        };

        assert_eq!(
            read_head(p("crlf.jsonl", "a\r\nb\r\n"), 4096).await.unwrap(),
            "a\nb\n"
        );
        assert_eq!(read_head(p("cr.jsonl", "a\rb\n"), 4096).await.unwrap(), "a\nb\n");
        assert_eq!(read_head(p("nonl.jsonl", "abc"), 4096).await.unwrap(), "abc\n");
        // 两行内容相同的相邻行界只算一个（\r\n）
        assert_eq!(read_head(p("crlf2.jsonl", "a\r\r\nb\n"), 4096).await.unwrap(), "a\n\nb\n");
        // 空文件一行都没有 → 空串；只有一个换行 → 一个空行（再补尾换行）→ "\n"
        assert_eq!(read_head(p("empty.jsonl", ""), 4096).await.unwrap(), "");
        assert_eq!(read_head(p("onlynl.jsonl", "\n"), 4096).await.unwrap(), "\n");

        std::fs::remove_dir_all(&d).ok();
    }

    /// 顺序也是语义：libuv 的 `uv_fs_scandir` 用 `strcmp` 排名字，所以 Node 的 `readdir` 是字典序。
    /// 旧版这里**先 `sort` 再比**，于是顺序差异根本测不到（首轮差分 ⑨ 就是这么漏掉的）。
    #[tokio::test]
    async fn read_dir_returns_strcmp_order_like_libuv() {
        let d = tmpdir("dir");
        write(&d.join("b.jsonl"), "hello");
        write(&d.join("A.jsonl"), "hello");
        write(&d.join("_x.jsonl"), "hello");
        std::fs::create_dir_all(d.join("sub")).unwrap();

        // 直接比，不排序：字节序 A(0x41) < _(0x5F) < b(0x62) < s(0x73)
        let entries = read_dir(d.to_string_lossy().into_owned()).await.unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["A.jsonl", "_x.jsonl", "b.jsonl", "sub"]);
        assert!(entries[0].is_file && !entries[0].is_dir);
        assert!(entries[3].is_dir && !entries[3].is_file);

        let st = stat(d.join("A.jsonl").to_string_lossy().into_owned())
            .await
            .unwrap();
        assert!(st.is_file);
        assert_eq!(st.size, 5);

        std::fs::remove_dir_all(&d).ok();
    }

    /// `mtimeMs` 的 double 运算次序对齐 Node：`sec*1000 + nsec/1e6`（两步运算），**既不**先整体转成
    /// 纳秒再除、**也不**截断到整毫秒。期望值都来自 Node 侧实测（见首轮差分与独立探针）：
    ///
    /// **必须打 `ms_from_parts`，不能打 `mtime_ms_from`**：后者要先把输入装进 `SystemTime`，
    /// 而 Windows 的 `SystemTime` 只有 100ns 粒度，纳秒级的测试输入会在这一趟被量化掉
    /// （`112_978_180` → `112_978_100`），于是下面第 2 行在 Windows 上必红 —— 红的是输入的精度，
    /// 不是算式。算式本身与 Node 逐位一致，本轮已复核。
    ///
    /// | `mtimeNs` | Node `stats.mtimeMs` | `Number(ns)/1e6` |
    /// |---|---|---|
    /// | 1789366606112978180 | 1789366606112.9783 | 1789366606112.9783 |
    /// | 1789366606113271890 | **1789366606113.272** | 1789366606113.2717 ❌ |
    /// | 1789366606113541516 | **1789366606113.5415** | 1789366606113.5417 ❌ |
    ///
    /// 后两行是关键：它们能区分「两步运算」与「整体转 ns 再除」两种写法 —— 旧实现两种都不是
    /// （它 `as_millis()` 截断，给 `1789366606113`），所以三个值能一起把错误写法钉死。
    #[test]
    fn mtime_ms_matches_node_float_arithmetic() {
        assert_eq!(ms_from_parts(1_789_366_606, 0), 1_789_366_606_000.0);
        assert_eq!(ms_from_parts(1_789_366_606, 112_978_180), 1_789_366_606_112.9783);
        assert_eq!(ms_from_parts(1_789_366_606, 113_271_890), 1_789_366_606_113.272);
        assert_eq!(ms_from_parts(1_789_366_606, 113_541_516), 1_789_366_606_113.5415);
    }

    #[tokio::test]
    async fn read_text_is_lossy_like_node() {
        let d = tmpdir("text");
        let f = d.join("raw.bin");
        std::fs::write(&f, [0xffu8, 0xfe, 0x41]).unwrap();
        let got = read_text(f.to_string_lossy().into_owned()).await.unwrap();
        // 与 Buffer.from(bytes).toString('utf8') 一致：非法字节 → U+FFFD，合法字节保留
        assert!(got.ends_with('A'));
        assert!(got.contains('\u{FFFD}'));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn home_dir_reads_env() {
        // 测试环境里 HOME 一定有；只断言"能拿到"。**刻意不动进程环境** —— 单测在同一进程里并发跑，
        // set_var/remove_var 会串到别的用例。「未设置 → getpwuid 回退」与「空串 → 原样返回」两条
        // 分支由 `test/tools/fs-ops-differential.mjs` 的 `home_dir/{unset,empty,set}` 三条用例覆盖
        // （那个探针是单线程逐例跑的，改环境安全）。
        let got = home_dir();
        assert!(got.is_ok(), "home_dir 失败: {got:?}");
        assert!(!got.unwrap().is_empty());
    }

    #[tokio::test]
    async fn missing_paths_error_rather_than_panic() {
        let missing = "/definitely/not/here/ccsa".to_string();
        // 报错的三个原语：错误经 Result 返回，不 panic（上层 readSessionMeta / scan 各自 catch）
        assert!(read_dir(missing.clone()).await.is_err());
        assert!(stat(missing.clone()).await.is_err());
        assert!(read_text(missing.clone()).await.is_err());
        // read_head 是**例外**：Node 的 readHead 把打开/读失败吞掉并返回已读部分，这里逐字对齐
        // （首轮差分 ⑦）。旧版断言 `.is_err()` 与参考实现相反，故改掉。
        assert_eq!(read_head(missing, 16).await.unwrap(), "");
    }
}
