//! `fs_ops` ↔ Node 参考实现的**差分核验** —— Rust 侧半个探针。
//!
//! 为什么需要它：`src-tauri/src/fs_ops.rs` 顶部的「语义严格对齐 Node」是**读 Node 源码推理出来的**，
//! 它的单测也是照着这个推理写的（断言的是自己的期望，不是 Node 的真实输出）。本探针把同一批输入
//! 同时喂给两个实现，逐项比**完整结果**，用来把那条推理换成独立信息源。
//!
//! 形态：**默认忽略**（`#[ignore]`），必须由 `test/tools/fs-ops-differential.mjs` 驱动 ——
//! 那个脚本负责建语料、跑 Node 侧、再把这个测试跑起来并读回 `rust.json`。这样 `cargo test`
//! 基线既不依赖语料目录、也不会因为探针而变慢或被跳过时假装通过（`#[ignore]` 是诚实的「未跑」，
//! 不是「绿」）。
//!
//! 协议（与 Node 侧共用）：
//!   - 入参：环境变量 `CCSA_FS_DIFF_DIR` 指向语料目录，其中有 `manifest.json`：
//!     `{ "cases": [ { "id", "func", "path"?, "max_bytes"?, "contents"?, "home_env"?, "unset_home"? } ] }`，
//!     `func` ∈ `read_dir` / `stat` / `read_text` / `read_head` / `write_text` / `home_dir`
//!   - `path` 里的 `{SIDE}` 由两侧各自替换（`rust` / `node`），用于写文件这类必须分侧落盘的用例
//!   - 出参：写 `<dir>/rust.json`：`{ "caseCount", "results": [ { "id", "result" } ] }`
//!   - `result` 统一为 `{ok:true,value}` 或 `{ok:false,raw,errnoName}`。
//!     **错误只比 `errnoName`（Node 的 `err.code` 名）**：`fs_ops` 把错误类型擦成了 `String`，
//!     拿不到 `io::ErrorKind`，只能从 `… (os error N)` 反推 errno 再映射；两侧的错误**文案**
//!     本来就来自各自运行时，不是同一信息源，逐字比文案没有意义（同方案文档 §5 第 13 条）。

use app_lib::fs_ops::{home_dir, read_dir, read_head, read_text, stat, write_text};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;

#[derive(Deserialize)]
struct Manifest {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    id: String,
    func: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    max_bytes: Option<u64>,
    #[serde(default)]
    contents: Option<String>,
    #[serde(default)]
    home_env: Option<String>,
    #[serde(default)]
    unset_home: bool,
}

/// 从 `… (os error N)` 里抽 errno 并映射成 Node 的 `err.code` 名。未知 errno 返回 `None`
/// （**不猜**）——猜一个名字只会把「两侧错误类别不同」粉饰成匹配。
fn errno_name(raw: &str) -> Option<&'static str> {
    let n: i32 = raw
        .rsplit_once("(os error ")?
        .1
        .split(')')
        .next()?
        .parse()
        .ok()?;
    Some(match n {
        1 => "EPERM",
        2 => "ENOENT",
        13 => "EACCES",
        20 => "ENOTDIR",
        21 => "EISDIR",
        22 => "EINVAL",
        _ => return None,
    })
}

fn err_json(raw: String) -> Value {
    json!({ "ok": false, "raw": raw, "errnoName": errno_name(&raw) })
}

fn home_key() -> &'static str {
    if cfg!(windows) {
        "USERPROFILE"
    } else {
        "HOME"
    }
}

async fn run_case(c: &Case) -> Value {
    match c.func.as_str() {
        "read_dir" => match read_dir(c.path.clone().expect("read_dir 需要 path")).await {
            Ok(entries) => json!({
                "ok": true,
                "value": entries
                    .iter()
                    .map(|e| json!({ "name": e.name, "isDir": e.is_dir, "isFile": e.is_file }))
                    .collect::<Vec<_>>(),
            }),
            Err(e) => err_json(e),
        },
        "stat" => match stat(c.path.clone().expect("stat 需要 path")).await {
            Ok(s) => json!({
                "ok": true,
                "value": { "isFile": s.is_file, "size": s.size, "mtimeMs": s.mtime_ms },
            }),
            Err(e) => err_json(e),
        },
        "read_text" => match read_text(c.path.clone().expect("read_text 需要 path")).await {
            Ok(v) => json!({ "ok": true, "value": v }),
            Err(e) => err_json(e),
        },
        "read_head" => match read_head(
            c.path.clone().expect("read_head 需要 path"),
            c.max_bytes.expect("read_head 需要 max_bytes"),
        )
        .await
        {
            Ok(v) => json!({ "ok": true, "value": v }),
            Err(e) => err_json(e),
        },
        // 写盘用例：写完立刻用 **std::fs**（不经 fs_ops，避免用被测原语验证被测原语）读回，
        // 记录内容与字节数 —— 这才是「语义对齐 fs.writeFile」可观测的那部分。
        "write_text" => {
            let path = c
                .path
                .clone()
                .expect("write_text 需要 path")
                .replace("{SIDE}", "rust");
            match write_text(path.clone(), c.contents.clone().unwrap_or_default()).await {
                Err(e) => err_json(e),
                Ok(()) => {
                    let read_back = std::fs::read(&path)
                        .ok()
                        .map(|b| String::from_utf8_lossy(&b).into_owned());
                    let size = std::fs::metadata(&path).ok().map(|m| m.len());
                    json!({ "ok": true, "value": { "readBack": read_back, "sizeBytes": size } })
                }
            }
        }
        // home_dir 用例：按 manifest 指定临时改本进程环境（跑完还原），这样「HOME 设置」与
        // 「HOME 未设置」两条路都能在同一进程里被驱动。
        "home_dir" => {
            let key = home_key();
            let saved = std::env::var(key).ok();
            if c.unset_home {
                std::env::remove_var(key);
            } else {
                std::env::set_var(key, c.home_env.clone().unwrap_or_default());
            }
            let out = home_dir();
            match saved {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
            match out {
                Ok(v) => json!({ "ok": true, "value": v }),
                Err(e) => err_json(e),
            }
        }
        other => panic!("manifest 里出现未知 func: {other:?}（不允许静默跳过）"),
    }
}

#[tokio::test]
#[ignore = "差分探针：需 CCSA_FS_DIFF_DIR 指向语料目录，由 test/tools/fs-ops-differential.mjs 驱动"]
async fn dump_cases() {
    let dir = std::env::var("CCSA_FS_DIFF_DIR")
        .expect("必须设置 CCSA_FS_DIFF_DIR 指向含 manifest.json 的语料目录");
    let dir = PathBuf::from(dir);
    let manifest_text = std::fs::read_to_string(dir.join("manifest.json"))
        .expect("读不到 manifest.json —— 请用 test/tools/fs-ops-differential.mjs 驱动本测试");
    let manifest: Manifest = serde_json::from_str(&manifest_text).expect("manifest.json 解析失败");

    let mut results = Vec::with_capacity(manifest.cases.len());
    for c in &manifest.cases {
        results.push(json!({ "id": c.id, "result": run_case(c).await }));
    }

    let dump = json!({ "caseCount": results.len(), "results": results });
    std::fs::write(
        dir.join("rust.json"),
        serde_json::to_string(&dump).expect("序列化 rust.json"),
    )
    .expect("写 rust.json 失败");
    println!(
        "fs_ops_differential: 写出 {} 条用例结果 → {}",
        manifest.cases.len(),
        dir.join("rust.json").display()
    );
}
