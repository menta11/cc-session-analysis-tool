# vendor/cc-monitor —— 上游参考实现（逐字搬运，禁止编辑）

这里的文件**逐字搬运**自 cc-monitor-app，**一行都不许改**。它们同时被两个消费方使用：

| 消费方 | 用的是什么 | 怎么用 |
|---|---|---|
| `test/proxy-contract/` | `proxy.js` 作为 **Node 黄金基准（golden）** | 以子进程 `node vendor/cc-monitor/proxy.js` 启动，与 Rust SUT 跑同一批契约用例做**差分** |
| `src-tauri/` | `dashboard.html` / `mini.html` / `config.json` / `assets/trayTemplate.png` | `include_str!` / `include_bytes!` **编译期内嵌**进二进制 |

## 为什么放在这里而不是 `electron/`

Tauri v2 迁移完成后 Electron 壳已被**完全删除**，但 `proxy.js` 不是「Electron 的代码」——
它是 Rust 侧 `src-tauri/src/proxy/` 的**差分参照物**。整个验证体系里最值钱的一条就是
「同一批黑盒用例同时跑 Node 参考实现与 Rust 实现」，把它一起删掉会让契约套件**静默退化**：

```ts
// test/proxy-contract/harness.ts
available: () => existsSync(PROXY_JS)   // ← 文件不在 = Node 那一半被静默跳过，套件照样全绿
```

因此它被保留为 vendored 参考实现，与 Electron 解耦。

## 为什么 `__dirname` 相对布局必须保持

`proxy.js` 自己用 `const MONITOR_DIR = __dirname` 定位 `config.json` / `dashboard.html` / `mini.html`。
所以这几个文件必须**和 proxy.js 同级**，移动本目录时必须整体移动，不能只搬其中一个。

## 校验搬运没有被改动

```sh
# 与上游逐字节比对（如果有上游副本）
shasum -a 256 vendor/cc-monitor/proxy.js

# 契约套件必须真的跑了两边（而不是只剩 Rust 一边）
npx vitest run test/proxy-contract/    # 期望 99 passed / 0 skipped
```

搬运时的哈希（2026-09-12，Electron 移除同轮记录）：

```
9f8a7b31b913492b5a4e8814e36aa4524e77b67bdfa0aca212afdc740a2ceb8c  proxy.js
8b2ab8c3c5e419b61eaa014894959817e4d1f928c11fa1e2a9adac5baf6c4865  shared/config.js
2a886c1a72459c8a79708fb8bacd4bbc53d04501246300eeccb5e45296696c8c  shared/safe-settings-writer.js
2e50b276868e39aa988a47e452fdcef181b5fc54dc7e6ee122e28ebfdb77b9ea  config.json
016f7168d285f4da41380d769875f758ea1a360fa2fda183451f85b3532d552d  dashboard.html
395395d139a30d87a680f90fd9724c76ba08cb8123da01bc2754da9a2853fbb6  mini.html
571c09a772aed409c6ccff470d78b82b7f495aa7fe6a50c561aa9c394c124919  assets/trayTemplate.png
```
