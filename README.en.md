# CC Session Analysis Tool

**Claude Code session time-analysis tool** — recursive "work vs wait" time breakdown + AI bottleneck analysis (Tauri v2 desktop app, macOS / Windows / Linux)

**English** · [简体中文](./README.md)

---

## What this is

A Tauri v2 desktop app that reads Claude Code session transcripts
(`~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`) and recursively breaks down
where a session's wall-clock went:

- **LLM thinking (compute)** — model thinking time (derived: wall minus the rest)
- **Local tool**
  - **direct** — directly executed Bash / other tools
  - **delegated** — `Agent` / `Task` calls delegated to sub-agents
- **Wait user** — `AskUserQuestion` intervals + inter-turn gaps

Sub-agent transcripts are recursively hung onto the `Agent` call that dispatched them,
so you can drill down level by level. Parallel sub-agent intervals are **unioned**
(not summed) to avoid "parallel inflation."

It also ships an "AI report" feature that shells out to the local `claude` CLI to
produce a markdown bottleneck analysis from the structured digest, plus a second page
hosting an embedded MITM proxy (cc-monitor) for live request monitoring.

> Core invariant: `wallMs = waitUser + localTool + compute`, enforced by interval
> complement in `breakdownOf`.

## Features

- 📂 Auto-scans all top-level sessions under `~/.claude/projects/` (mtime desc)
- 🌳 Recursive time-breakdown tree: expandable to any sub-agent depth
- 🎨 Gantt-style intervals + time bars (Okabe-Ito color-blind-safe, CSS-var driven, light/dark)
- 🔗 Automatic sub-agent transcript linking (by `agentId`, with a result-text regex fallback)
- 🤖 AI report: whole-session analysis / per-node diagnosis modes, streamed back
- 🖥️ One-click `claude --resume <id>` in a new terminal to continue a session
- 📡 Live monitoring page: embedded cc-monitor proxy with dashboard
- 🧪 `core/` pure logic is framework-free and fully unit-tested

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- npm (bundled with Node)
- [Rust toolchain](https://rustup.rs/) (stable) — required to build the Tauri host
- **(optional, only for the AI report feature)** local `claude` CLI installed and logged in

On Windows you also need the MSVC build tools (or the `x86_64-pc-windows-msvc`
target) for `cargo build`.

## Quick start

```bash
npm install          # install deps
just dev             # = npm run dev → tauri dev (Rust host auto-restarts + renderer HMR)
```

Build a distributable for the current platform:

```bash
just build           # = npm run build → tauri build
                     #   → src-tauri/target/release/bundle/
just renderer        # renderer layer only (Vite) → out/tauri-renderer/, no Rust rebuild
```

## Common commands

| Command | Description |
| --- | --- |
| `just dev` | `tauri dev` (Rust-side auto-restart + renderer HMR) |
| `just build` | build a distributable for the host platform |
| `just package <platform>` | build installers for `mac` / `win` / `linux` and collect into `releases/` |
| `just renderer` | renderer layer only (Vite), no Rust rebuild |
| `just test` | vitest run (one-shot) |
| `just test-watch` | vitest watch |
| `just test-rust` | `cargo test` |
| `just test-contract` | build `proxy-standalone` + run the Node↔Rust differential contract suite |
| `just typecheck` | `tsc --noEmit` (both node + web tsconfigs) |
| `just ci` | typecheck + test + bundle-size guard (pre-commit self-check) |

The npm scripts (`npm test` / `npm run typecheck` / `npm run build:renderer`) are
equivalents; the `just` recipes add the heavier suites and the packaging entry points.

Run a single test:

```bash
just test-one test/parser.test.ts
just test-name "parses session metadata and turn structure"
```

There is no separate lint script; `tsc --noEmit` under `strict` + `noUnusedLocals` +
`noUnusedParameters` is the type/quality gate. Run `just ci` before opening a PR, and
add `just test-rust` (plus `just test-contract` if you touched the proxy) when you
change Rust code.

## Packaging

```bash
just package             # all three platforms (skips the ones the host can't build)
just package mac         # macOS: .app + .dmg
just package win         # Windows: NSIS Setup
just package linux       # Linux: deb + rpm + AppImage (containerised off-Linux, both arches)
just releases            # collect only, no rebuild
```

Deliverables land flat in the repo-root `releases/` (no subdirectories). The Tauri CLI
writes into `src-tauri/target/release/bundle/<format>/`, so `package` runs
`build/collect-releases.mjs` at the end to move them over.

## Real-sample smoke tests (bring your own path)

Four path-less templates are provided — they are neither collected by vitest
(`include: ['test/**/*.test.ts']` does not match `.template.ts`) nor typechecked:

- [`test/real-sample.smoke.template.ts`](./test/real-sample.smoke.template.ts) — all-in-one
- [`test/real-sample-breakdown.smoke.template.ts`](./test/real-sample-breakdown.smoke.template.ts)
- [`test/real-sample-digest.smoke.template.ts`](./test/real-sample-digest.smoke.template.ts)
- [`test/real-sample-subagents.smoke.template.ts`](./test/real-sample-subagents.smoke.template.ts)

1. Copy one to its `.smoke.test.ts` name (drop `.template`)
2. Fill in `BASE` / `MAIN` / `PROJECTS_ROOT` with one of your own sessions:
   `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`
3. Tune the `expect(...)` values to your sample (counts/durations won't match across
   sessions; the templates only do structural checks)
4. `npx vitest run test/real-sample.smoke.test.ts`

The copied `.smoke.test.ts` is gitignored, so you can hard-code local paths freely.

## Project structure

```
core/        # pure logic (no React / Tauri / Node-only globals), fully unit-tested
  parser/    # JSONL → Session tree (two-pass, tolerant parsing, tool_use↔tool_result pairing)
  discovery/ # scan top-level sessions + locate & recursively link sub-agent transcripts
  model/     # time-decomposition model: classify / timeline (interval union) / timeBreakdown (invariant)
  view/      # pure data → display structures (tree / log rows / time bars)
  ai/        # prompt for the local claude CLI: digest + fileMap + analyzeRequest
src-tauri/   # Rust host: syscalls, subprocess, windows/tray, embedded MITM proxy
src/         # React renderer: pages/ + components/ + api/ (host adapter layer)
vendor/      # cc-monitor Node reference implementation — read-only, compiled in via include_str!
build/       # packaging & release-collection scripts + bundle-size guard
test/        # vitest unit tests + fixtures; test/proxy-contract/ is the Node↔Rust contract suite
```

The data flow is a one-way pipeline: **parse → link → model → view / AI**.
`core/` is the pure logic layer used by both the renderer and the Rust host — it is
framework-free and IO goes through the injectable
[`core/fsBridge.ts`](./core/fsBridge.ts) / [`core/procBridge.ts`](./core/procBridge.ts).
Rust and React are thin adapters over it.

### Build layout (Tauri v2, two halves)

- **Renderer** → `vite.tauri.config.ts` bundles `src/` (React, alias `@` → `src/`) into
  `out/tauri-renderer/`, consumed by `src-tauri/tauri.conf.json`'s `frontendDist`.
- **Rust host** → `src-tauri/` (cargo). Business logic is **not** in Rust: the TS in
  `core/` gets its IO through the bridges injected by `src/api/`; Rust only provides
  syscalls / subprocess / windows / the embedded proxy.

## Tech stack

- Tauri v2 + Rust (host), React 18 + react-markdown + remark-gfm (renderer)
- TypeScript 5 (strict), Vite 5, vitest 2
- Embedded MITM proxy shared between a read-only Node reference implementation and the
  Rust port, verified by a black-box differential contract suite

## Non-source directories

`docs/调研/`, `docs/原型/`, `docs/方案设计/` are research notes, reference-repo clones,
prototypes, and design docs — **not part of the app**.
The source of truth for behavior is `core/` + `src-tauri/` + `src/`.

## License

Released under the [MIT License](LICENSE) — © 2026 mengtao Liu.
