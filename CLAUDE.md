# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Tauri v2 desktop app (macOS + Windows + Linux) that analyzes Claude Code session transcripts
(`~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`) and produces a recursive
"work vs wait" time breakdown of where a session's wall-clock went — LLM thinking,
local tools (direct Bash/other vs delegated sub-agents), and waiting-on-user. Sub-agent
transcripts are linked recursively so a delegated `Agent` call can be drilled into. An
"AI report" feature shells out to the local `claude` CLI to produce a markdown bottleneck
analysis from the structured digest. A second page hosts an embedded MITM proxy (cc-monitor)
for live request monitoring.

## Commands

```bash
just dev             # tauri dev（Rust 侧改动自动重启 + 渲染层 HMR）
just build           # 构建本机平台可分发产物 -> src-tauri/target/release/bundle/
just package <平台>  # 打安装包并收拢进 releases/（mac / win / linux）
just renderer        # 只构建渲染层，不碰 Rust（快速验证前端）
just test            # vitest run（一次性）
just test-watch      # vitest watch
just typecheck       # tsc --noEmit（node + web 两份 tsconfig）
just test-rust       # cargo test
just test-contract   # 构建 Rust proxy-standalone + 跑全部契约用例（Node 与 Rust 两半都跑）
just ci              # typecheck + test + assert-size（提交前自检）
```

等价的 npm 脚本：`npm test` / `npm run typecheck` / `npm run build:renderer`。
单文件 / 单用例：`just test-one test/parser.test.ts`、`just test-name "用例名"`。

渲染层与 Rust 两侧都有类型/编译门禁 —— 改完跑 `just ci`，改到 Rust 再补 `just test-rust`，
动过 proxy 的透传 / SSE / header / settings 再加 `just test-contract`。

## 必守铁律

违反这些不会报错，只会静默错。改代码前先过一遍：

- **`core/` 不许碰 Node-only 全局**（`setImmediate` / `Buffer` / `__dirname` / 裸 `process.*`）—— 它是
  渲染层也要用的代码。yield 用 `core/yield.ts`，IO 走 `core/fsBridge.ts` / `core/procBridge.ts`；按宿主
  分叉的值用 `typeof process !== 'undefined'` 守卫。`tsconfig.web.json` 会在 typecheck 拦，vitest 在 Node
  下跑 —— 它**拦不住**。
- **`core/` 加逻辑必须带 `test/*.test.ts`**：框架无关、IO 走可注入桥，Rust / React 只做薄适配。
- **解析一律容错**：坏行 → `parseWarnings`，未知形状 → `null` / `other`，禁止在不可信 transcript 数据上抛异常。
- **时间统一 ms-epoch 数字**：边界处 `parseTimestamp` 转换，模型层不出现 ISO 字符串。
- **别读没人看的东西**：需要文件内容的特性挂到视口（`metaLoader` + `SessionList` 里的视口观察器）并按
  `(path, mtime, size)` 缓存，启动成本跟**可见行数**走、不跟会话总数走。唯一例外是「这条会话有没有记录」
  （`scanProjects` 只读 ≤ 64 KB 文件的头一次，判据进缓存）。
- **两个视图读同一份数字**：日志视图与树视图是同一份解析的两种聚合，共享数字必须来自共享函数
  （`breakdownOf` / `CATEGORY_COLORS` / `childWallOf` / `interTurnGaps` / `findToolPath`）——
  对不上是接线 bug，不是舍入差。
- **时间分解的代数不许破**：`wallMs = waitUser + localTool + compute` 由区间补集算出（`breakdownOf`），
  新加的时间类别必须进这个等式，否则甘特图与数字会各说一套。
- **渲染层三个静默坑**：列表行是 `React.memo` 的，回调必须 `useCallback` 稳定（否则上千行全量重渲）；
  注册式 effect 要能在自己的 cleanup 之后重新注册（`StrictMode` 在 dev 下是 mount → cleanup → mount）；
  加载指示器要由「有没有请求在飞」驱动，**不要**由「最终状态到齐了没有」驱动 —— 在这套按需读的设计里
  后者恒为假。
- **解析子 agent transcript 必须传 `subagent: true`**，否则 `isSidechain` 消息全被排除、子表空白
  （`src/api/tauri.ts::loadSession` 是唯一读取处）。
- **`package.json` 的 `dependencies` 必须恰好是 `["@tauri-apps/plugin-dialog"]`**：渲染层依赖全放
  `devDependencies`（Vite 打进产物）。`just ci` 里的体积护栏会拦（产物 ≤ 2 MB）。
- **capability 只列用到的命令，禁止 `core:default` / `dialog:default` 这类通配**：`tauri.conf.json` 开了
  `build.removeUnusedCommands`，裁剪按 capability 的允许集走 —— 写通配等于把几十条用不到的命令重新标成
  「已用」、白付裁剪；漏列则命令在构建期被裁掉。`tauri dev` 与 `tauri build` 都设该变量（实测两边都在
  `target/{debug,release}/build/*/out/` 落了 `allowed-commands.json`），所以错在 dev 阶段就暴露。
  应用自定义命令与 inlined plugin 不受影响（本仓无 app manifest → `has_app_acl = false`）。
- **改 `vendor/cc-monitor/proxy.js` 的透传 / SSE 分帧 / header / base URL / settings 改写前**，先跑
  `just test-contract`。两条铁律：SSE 分帧必须在**字节层**（latin1 定位 `\n\n` 再逐 event
  utf8 解码，改成 `toString('utf8')` 累积会永久丢字节）；SSE 流出错必须 `res.destroy()` 收掉客户端连接，
  否则 cc 侧永久挂起。
- **`vendor/cc-monitor/` 只读**：逐字搬来的上游参考，`include_str!` 进二进制、也是契约套件的差分黄金。
- **测试不许假设宿主是 POSIX**（开发机是 Windows）：期望路径别用 `node:path` 拼（桥收到的是
  `core/paths.ts::joinPath` 的 `/` 口径）；`chmod` 造不出「读不到」，读失败要按宿主桥的口径注入；
  别比对 `sh` 回显的路径字符串（Git Bash 把 `C:\...\Temp` 映射成 `/tmp`），改验落点；
  `SystemTime` 在 Windows 只有 100 ns 精度，别拿它当纳秒输入的管道 —— 测算式打纯函数。
- **UI 光标只说真话**：可点击用 `pointer`，只有右键复制用 `default`，**不要用 `copy`**
  （macOS 渲染成「箭头带加号」，还会盖掉外层行的 `pointer`）。

## 目录地图

| 目录 | 是什么 |
|---|---|
| `core/` | 业务逻辑全部在这（框架无关 + 单测）：`parser/` 解析 JSONL 成会话树、`discovery/` 会话列表与子 agent / workflow 关联、`model/` 时间分解（`wallMs = waitUser + localTool + compute`）、`view/` 数据 → 展示结构（树 / 日志行 / 时间栏）、`ai/` 给本地 `claude` CLI 拼提示词 |
| `src-tauri/` | Rust 宿主：syscall、子进程、窗口、托盘、内嵌 MITM 代理（`src/proxy/`，与 `vendor/` 那份 Node 实现共用一套契约测试） |
| `src/` | React 渲染层：`pages/` + `components/` + `api/`（宿主适配层），只做展示与编排 |
| `vendor/cc-monitor/` | cc-monitor 的 Node 参考实现，**只读**；`include_str!` 进 Rust 二进制，契约套件的差分黄金 |
| `build/` | 打包与产物收集（`package.mjs` / `collect-releases.mjs` / 体积护栏 / Linux 容器链路） |
| `test/` | 单测与 fixture；`test/proxy-contract/` 是 Node ↔ Rust 的黑盒差分契约套件 |
| `docs/` | 调研 / 原型 / 方案设计笔记，**不是现状**，别拿它当权威；源码里也不引用它们 |

## 真实样本冒烟测试

`test/real-sample*.smoke.template.ts` 是**模板**，不参与 vitest 收集
（`include: ['test/**/*.test.ts']` 匹配不到 `.template.ts`），也不参与 typecheck。
用法：复制成去掉 `.template` 的名字（如 `real-sample.smoke.template.ts` →
`real-sample.smoke.test.ts`），把 `BASE` / `MAIN` / `PROJECTS_ROOT` 填成你自己的会话路径，
按你的样本调整 `expect(...)` 数值，再跑。

两者都是**本机绝对路径 + 本机样本的具体数字**，所以实际的 `.smoke.test.ts` 已被 `.gitignore`
忽略（`test/real-sample*.smoke.test.ts`），不会入库。四个模板分别是：
`real-sample`（一体式：parse + breakdown + subagents + digest）、
`real-sample-{breakdown,subagents,digest}`（分项，断言更深）。
