# CC Session Analysis Tool

**Claude Code 会话耗时分析工具** — 递归「工作 vs 等待」时间分解 + AI 堵塞点分析（Electron 桌面应用，Win / Mac）

[English](./README.en.md) · **简体中文**

---

## 这是什么

一个 Electron 桌面应用，读取 Claude Code 的会话 transcript
（`~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`），
递归地拆解一场会话的墙钟时间花在了哪里：

- **LLM thinking（compute）** — 模型思考时间（派生：墙钟扣去其他段）
- **本地工具（local tool）**
  - **direct** — 直接执行的 Bash / 其他工具
  - **delegated** — 委派给子 agent 的 `Agent` / `Task` 调用
- **等待用户（wait user）** — `AskUserQuestion` 区间 + 轮间间隙

子 agent 的 transcript 会被递归挂到分发它的 `Agent` 调用上，可逐层下钻；
并行的子 agent 区间取**并集**（而非求和），避免「并行虚高」。

此外内置「AI 报告」：调用本机 `claude` CLI，基于结构化 digest 产出一份
markdown 堵塞点分析。

> 核心不变式：`wallMs = waitUser + localTool + compute`，由区间求补在 `breakdownOf` 中保证。

## 功能

- 📂 自动扫描 `~/.claude/projects/` 下所有顶层会话（按 mtime 倒序）
- 🌳 递归时间分解树：可展开下钻到任意层级的子 agent
- 🎨 Gantt 风格区间 + 时间条（Okabe-Ito 色盲安全配色，CSS 变量驱动，明/暗主题）
- 🔗 子 agent transcript 自动链接（按 `agentId`，含 result 文本正则兜底）
- 🤖 AI 报告：整会话分析 / 单节点诊断两种模式，流式回传
- 🖥️ 一键在新终端 `claude --resume <id>` 继续会话
- 🧪 `core/` 纯逻辑零框架依赖、全单测覆盖

## 前置要求

- [Node.js](https://nodejs.org/) ≥ 18
- npm（随 Node 附带）
- **（可选，仅 AI 报告功能需要）** 本机已安装并登录 `claude` CLI

## 快速开始

```bash
npm install          # 安装依赖
npm run dev         # 开发模式（main + renderer 热重载）
```

构建 / 预览：

```bash
npm run build       # 构建 main / preload / renderer 三套 bundle → out/
npm run preview     # 运行构建产物
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | electron-vite 开发模式（热重载） |
| `npm run build` | 构建全部三个 bundle 到 `out/` |
| `npm run preview` | 运行已构建的应用 |
| `npm test` | vitest 一次性跑全部测试 |
| `npm run test:watch` | vitest 监听模式 |
| `npm run typecheck` | `tsc --noEmit`（node + web 两套 tsconfig） |

跑单个测试：

```bash
npx vitest run test/parser.test.ts
npx vitest run -t "parses session metadata and turn structure"
```

本项目无独立 lint 脚本；`tsc --noEmit`（`strict` + `noUnusedLocals` + `noUnusedParameters`）
即是类型 / 质量门禁。提 PR 前请先 `npm run typecheck`。

## 真实样本烟雾测试（路径自填）

`test/real-sample*.smoke.test.ts` 硬编码了本机会话绝对路径，**不进版本库**
（被 `.gitignore` 拦下，本地文件保留不删）。

取而代之，仓库提供路径留空的模板
[`test/real-sample.smoke.template.ts`](./test/real-sample.smoke.template.ts)：

1. 复制为 `test/real-sample.smoke.test.ts`（复制件自动被 ignore，可放心写死本机值）
2. 把 `BASE` / `MAIN` / `PROJECTS_ROOT` 改成你本机的一份会话：
   `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`
3. 视需要把 `expect(...)` 数值改成你样本的真实值（不同会话数值不重合，模板只做结构性校验）
4. `npx vitest run test/real-sample.smoke.test.ts`

模板文件 (`.template.ts`) 既不被 vitest 收集，也不进 typecheck，纯参考用。

## 项目结构

```
core/        # 纯逻辑（无 React / Electron 依赖），全单测
  parser/    # JSONL → Session 树（两遍扫描、容错解析、tool_use↔tool_result 配对）
  discovery/ # 扫描顶层会话 + 子 agent transcript 定位与递归链接
  model/     # 时间分解模型：classify / timeline（区间并集）/ timeBreakdown（不变式）
  view/      # 纯数据 → 显示结构（树 + 格式化）
  ai/        # 给本地 claude CLI 的 prompt：digest + fileMap + analyzeRequest
electron/    # 宿主进程：窗口 / 菜单 / IPC；claude CLI spawn；终端打开
src/         # React 渲染层（App / SessionList / TimeTree / DetailPanel / AiReport）
test/        # vitest 单测 + fixtures + real-sample 模板
```

数据流是单向管道：**parse → link → model → view / AI**。
`core/` 是被三端（main / preload / renderer）共享的纯逻辑层，Electron 与 React
只是它上面的薄适配层。

## 技术栈

- Electron 31 + electron-vite 2（三 bundle：main / preload / renderer）
- React 18 + react-markdown + remark-gfm
- TypeScript 5（strict）
- vitest 2

## 非源码目录

`调研/`、`原型/`、`方案设计/` 是调研笔记、参考仓库克隆、原型与设计文档，
**不属于应用代码**。`调研/` 下的 `*.zip` 与 `*-temp/` 临时克隆已被 gitignore，
仅 `.md` 调研报告进版本库。源代码事实来源是 `core/` + `electron/` + `src/`。

## 许可

私有项目，暂未指定开源许可。
