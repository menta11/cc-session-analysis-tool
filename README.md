# Claude Code 会话耗时分析工具

一个 Tauri v2 桌面应用（macOS + Windows + Linux），解析 Claude Code 的会话 transcript
（`~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`），递归分解一段会话的总耗时时间花在了哪里——
LLM 思考、本地工具（直接 Bash/其它 vs 委派子 agent）、等用户。子 agent transcript 递归挂载，
可逐层下钻某个 `Agent` 调用到底耗在哪。另提供「AI 报告」：shell 调用本地 `claude` CLI，
基于结构化摘要生成 markdown 堵塞点分析。

## 核心理念

**总耗时不变式**：`wallMs = waitUser + localTool + compute`

- `waitUser`：AskUserQuestion 区间 + 轮间间隙（人离开但后台 agent 在跑的部分让给委派，不算空闲）
- `localTool`：直接工具（Bash/其它）+ 委派子 agent 的调度区间
- `compute`：模型思考（总耗时内其余覆盖的补集，派生而来）

并行子 agent 的调度区间会重叠，因此取**并集时长**而非求和，避免「并行膨胀」。
子 agent 优先用其自身 transcript 的实际总耗时（异步后台 agent 的真实运行时长）。

## 命令

```bash
npm install              # 装依赖
npm run dev              # tauri dev（Rust 侧自动重启 + 渲染层 HMR）
npm run build            # tauri build（产物落 Tauri 自己的工作区 src-tauri/target/release/bundle/）
npm run build:renderer   # 只构建渲染层（Vite）→ out/tauri-renderer/，不碰 Rust
npm test                 # vitest run（一次性）
npm run test:watch       # vitest watch
npm run typecheck        # tsc --noEmit（tsconfig.node.json + tsconfig.web.json）

# justfile 里的常用入口（等价包装 + 两个重的套件）
just dev                 # = npm run dev
just test-rust           # cargo test
just test-contract       # 构建 proxy-standalone + 跑 Node↔Rust 差分契约套件
just ci                  # typecheck + test + 体积护栏
```

## 打包

```bash
just package             # 三平台都打（本机打不了的那个打印一行原因后跳过）
just package mac         # macOS：.app + .dmg
just package win         # Windows：NSIS Setup
just package linux       # Linux：deb + rpm + AppImage（非 Linux 宿主进容器，两个架构都打）
just releases            # 只收拢不构建（bundle/ 里已有当前版本产物时用）

just package-linux-offline   # 另出「自带依赖」的离线安装包 → releases/*.tar.gz
just assert-linux-offline    # 断网重打一遍 Linux 包，证明构建阶段零下载
```

同一平台在不同宿主上的打法不同，分派规则写在 `build/package.mjs` 一处，不在 justfile 里：
macOS 只能在 macOS 上打；Windows 在 Windows 上是原生的、在 macOS 上经 `cargo-xwin` 交叉；
Linux 在 Linux 上是原生的、在别的宿主上进容器（见 `build/linux/`）。

交付物只出现在仓库根的 `releases/`，**平铺无子目录**。Tauri CLI 把产物写进
`src-tauri/target/release/bundle/<格式>/`（它的固定布局，没有配置项可改），所以 `package` 末尾会跑一次
`build/collect-releases.mjs` 把它们搬过来 —— 只搬 `package.json` 当前版本的那些，旧版本残留会被清掉，
搬完 `bundle/` 里不再留第二份。

macOS 的 dmg 制作会调 AppleScript 让 Finder 摆好窗口图标，这一步需要**「系统设置 → 隐私与安全性 →
自动化」里给终端放行 Finder**。首次跑会弹授权框；弹不出来（无人值守/无 GUI 会话）会以
`bundle_dmg.sh` 失败告终，此时可用 `CI=true just package mac` 跳过摆图标那一步（dmg 照常可用，只是打开后
窗口是默认排布）。

容器链路的 Linux 包默认只出 deb + rpm（这两种不需要任何外网资源）；要 AppImage 得显式开
`BUNDLES=deb,rpm,appimage just package linux` —— 它的 linuxdeploy 由 tauri 打包器每次从 GitHub
现下、解到 `/tmp`，没有缓存能力。

跑单个测试：

```bash
npx vitest run test/parser.test.ts
npx vitest run -t "parses session metadata and turn structure"
```

无独立 lint 脚本；`tsc --noEmit`（`strict` + `noUnusedLocals` + `noUnusedParameters`）即质量门禁。
声明完成前请跑 `npm run typecheck`。

## 架构

数据流是单向管线：**parse → link → model → view/AI**。

| 层 | 职责 |
|---|---|
| `core/parser/` | JSONL → Session 树（两遍解析、per-line 容错、tool_use↔tool_result 配对算单次耗时） |
| `core/discovery/` | 扫描项目目录、反解 sanitized-cwd、建 agentId→path 索引、递归挂载子 agent transcript |
| `core/model/` | 时间分解模型（工具分类、区间并集、总耗时不变式） |
| `core/view/` | 纯数据 → 显示结构（树、甘特段、格式化器） |
| `core/ai/` | 给本地 `claude` CLI 拼提示词（摘要 digest + 取证文件地图） |
| `src-tauri/` | Tauri v2 宿主：窗口/菜单/托盘/悬浮窗、fs 与子进程命令、内嵌 MITM 代理 |
| `src/` | React 渲染层：会话列表、时间树、详情面板、AI 报告 |

`core/` 无任何框架依赖（不碰 React/Tauri），全部单测覆盖。Rust/React 仅作薄适配层。

### 构建布局（Tauri v2 两半）

- **渲染层** → `vite.tauri.config.ts` 把 `src/`（React，别名 `@` → `src/`）打进
  `out/tauri-renderer/`，由 `src-tauri/tauri.conf.json` 的 `frontendDist` 消费。
  `devUrl` 硬编码 `http://localhost:5173`，所以该 config 里 `server.strictPort = true`——
  端口被占时宁可当场失败，也不让 Vite 悄悄换端口、而 Tauri 打开一个空白窗口。
- **Rust 宿主** → `src-tauri/`（cargo）。业务逻辑**不在** Rust 里：`core/` 的 TS 代码经
  `src/api/` 注入的桥拿 IO，Rust 只提供 syscall / 子进程 / 窗口 / 内嵌代理。

`vendor/cc-monitor/` 是**逐字搬运的上游参考实现**（Node MITM 代理 + dashboard/mini 页面 +
tray 图标），**只读**：`src-tauri/` 编译期把其中几个资产 `include_str!` 进二进制，
`test/proxy-contract/` 把它当**差分黄金基准**。详见 `vendor/cc-monitor/README.md`。

## 关键约定

- **所有时间为 ms-epoch 数字**，模型层绝不出现 ISO 字符串；`parseTimestamp` 在边界转换。
- **容错解析是硬规则**：JSONL 逐行 try/catch，坏行进 `parseWarnings`，绝不抛；stream-json、
  `extractStructuredResult` 同理（未知/异常形状 → `null`，不丢数据）。
- **`subagent: true` 解析选项**：解析子 agent transcript 时必须传，否则其 `isSidechain` 消息被排除、
  transcript 看起来是空的。
- **总耗时不变式** 由 `breakdownOf` 的区间补集保证——任何新类别都必须纳入这套代数，否则甘特与数字会对不上。

## 非源码目录

`docs/方案设计/` 存放设计文档（耗时分析总方案、AI 报告链路、AI 追问终端链路），**不是**应用一部分。
当前行为以 `core/` + `src-tauri/` + `src/` 为准。
