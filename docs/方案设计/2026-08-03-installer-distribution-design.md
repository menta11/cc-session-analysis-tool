# Electron 安装包分发 · 设计文档

> 日期：2026-08-03 · 状态：已批准 · 目标：为 `ai-code-session-analyzer` 添加 Win/Mac 安装包分发能力

## 背景

项目当前只有 `electron-vite build`（编译到 `out/`，供 `preview` 运行），**没有安装包分发**。需要让团队能在 Windows / macOS 上产出可分发的安装包。

## 目标

- Windows：**NSIS 安装程序**（`.exe`）+ **portable 免安装**（`.exe`）
- macOS：**`.dmg`**（内含 `.app`）+ **`.zip`**（`.app` 免安装包）
- Win 机打 Win 包，Mac 机打 Mac 包（electron-builder 不支持跨平台交叉编译 Mac 包）
- 构建指令拆为：`build`（编译，通用）+ `dist-win` / `dist-mac`（打包，分平台）
- 无签名证书 → 用 **ad-hoc 自签名**（Mac 必须签名才能启动；Win 有 SmartScreen 提示）

## 架构

```
electron-vite build  →  out/   (编译产物，已存在)
        ↓
electron-builder    →  dist/  (安装包)
        ├── Windows: NSIS .exe + portable .exe
        └── macOS:   .dmg + .zip (内含 .app)
```

两阶段流水线：**编译（`build`）与打包（`dist-*`）分离**，`dist-*` 依赖 `build` 保证用最新产物。

## 1. 依赖

```bash
npm install -D electron-builder
```

devDependency（仅在打包机需要）。

## 2. package.json

新增 scripts + author 字段（mac 打包必需）：

```json
"scripts": {
  "build": "electron-vite build",
  "dist:win": "npm run build && electron-builder --win",
  "dist:mac": "npm run build && electron-builder --mac"
},
"author": "jlc"
```

- `dist:win` / `dist:mac` 内部先 `build` 再打包
- `main` 字段已指向 `out/main/index.js`（electron-builder 读取该字段确定入口，已就位）

## 3. electron-builder.yml（新增，放项目根）

```yaml
appId: com.jlc.ai-code-session-analyzer
productName: AI Code Session Analyzer
directories:
  output: dist
files:
  - '!**/.vscode/*'
  - '!src/*'
  - '!electron.vite.config.{js,ts,mjs,cjs}'
  - '!{.eslintignore,.eslintrc.cjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}'
  - '!{.env,.env.*,.npmrc,pnpm-lock.yaml}'
  - '!justfile'
  - '!justfile.*'
  - '!docs/**'
  - '!test/**'
  - '!{dist,out}/**'
win:
  target:
    - nsis
    - portable
  executableName: ai-code-session-analyzer
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
mac:
  target:
    - dmg
    - zip
  category: public.app-category.developer-tools
```

要点：
- `files` 用**排除式**（electron-vite 官方模板模式），确保 `out/` 与 `package.json` 全保留
- `directories.output: dist` → 安装包输出到 `dist/`
- `win.target: [nsis, portable]` → Windows 双形态
- `mac.target: [dmg, zip]` → dmg 内含 .app，zip 即 .app 打包
- 无证书 → electron-builder 自动 ad-hoc 签名

## 4. .gitignore

新增忽略 `dist/`（当前只忽略 `out/`）：

```
dist/
```

## 5. justfile recipe

新增两个打包 recipe（`build` 已存在，保持通用）：

```just
# 构建 Windows 安装包 (NSIS + portable) -> dist/
dist-win: build
    npm run dist:win

# 构建 macOS 安装包 (dmg + zip) -> dist/
dist-mac: build
    npm run dist:mac
```

- 依赖 `build` 保证最新产物
- Win 机跑 `just dist-win`，Mac 机跑 `just dist-mac`

## 6. 验证

1. `npm run typecheck` 仍通过
2. `just dist-win` → 检查 `dist/` 产出 NSIS `.exe` + portable `.exe`
3. Windows 本机实测：安装 NSIS 安装包、运行 portable
4. macOS 需在 Mac 机上验证（`just dist-mac` → `dist/` 产出 `.dmg` + `.zip`）——本机（Windows）无法验证

## 关键约束

- **electron-builder 不支持跨平台编译 Mac 包**（dmg 必须 Mac 上做）→ 拆 `dist-win` / `dist-mac` 的根本原因，`build` 保持通用
- 主进程只依赖 `electron` + `node:` 内建（已确认 `out/main/index.js` 的 require），无需额外 `files` 配置 npm 依赖，asar 内无 node_modules 问题
- 无证书签名：
  - Windows：SmartScreen 提示「未知发布者」，可继续安装
  - macOS：ad-hoc 签名，本机可运行；跨机分发需右键→打开（Gatekeeper），后续需要时再买 Apple Developer ID（$99/年）
- renderer 的 React 等已打进 bundle（`externalizeDepsPlugin` 只外置 electron/node 内建），不随 asar 分发

## 后续可选项（本次不做）

- 代码签名证书配置（Win EV 证书 / Apple Developer ID）
- 自动更新（electron-updater）
- CI 打包（GitHub Actions 等）
