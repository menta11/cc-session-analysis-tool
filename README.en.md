# CC Session Analysis Tool

**Claude Code session time-analysis tool** — recursive "work vs wait" time breakdown + AI bottleneck analysis (Electron desktop app, Win / Mac)

**English** · [简体中文](./README.md)

---

## What this is

An Electron desktop app that reads Claude Code session transcripts
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
produce a markdown bottleneck analysis from the structured digest.

> Core invariant: `wallMs = waitUser + localTool + compute`, enforced by interval
> complement in `breakdownOf`.

## Features

- 📂 Auto-scans all top-level sessions under `~/.claude/projects/` (mtime desc)
- 🌳 Recursive time-breakdown tree: expandable to any sub-agent depth
- 🎨 Gantt-style intervals + time bars (Okabe-Ito color-blind-safe, CSS-var driven, light/dark)
- 🔗 Automatic sub-agent transcript linking (by `agentId`, with a result-text regex fallback)
- 🤖 AI report: whole-session analysis / per-node diagnosis modes, streamed back
- 🖥️ One-click `claude --resume <id>` in a new terminal to continue a session
- 🧪 `core/` pure logic is framework-free and fully unit-tested

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- npm (bundled with Node)
- **(optional, only for the AI report feature)** local `claude` CLI installed and logged in

## Quick start

```bash
npm install          # install deps
npm run dev         # dev mode (hot reload main + renderer)
```

Build / preview:

```bash
npm run build       # build main / preload / renderer bundles → out/
npm run preview     # run the built app
```

## Common commands

| Command | Description |
| --- | --- |
| `npm run dev` | electron-vite dev (hot reload) |
| `npm run build` | build all three bundles to `out/` |
| `npm run preview` | run the built app |
| `npm test` | vitest run (one-shot) |
| `npm run test:watch` | vitest watch |
| `npm run typecheck` | `tsc --noEmit` (both node + web tsconfigs) |

Run a single test:

```bash
npx vitest run test/parser.test.ts
npx vitest run -t "parses session metadata and turn structure"
```

There is no separate lint script; `tsc --noEmit` under `strict` + `noUnusedLocals` +
`noUnusedParameters` is the type/quality gate. Run `npm run typecheck` before opening a PR.

## Real-sample smoke tests (bring your own path)

`test/real-sample*.smoke.test.ts` hard-code a machine-local session path and are
**not checked in** (gitignored; the local files are kept, not deleted).

Instead, a path-less template is provided:
[`test/real-sample.smoke.template.ts`](./test/real-sample.smoke.template.ts):

1. Copy it to `test/real-sample.smoke.test.ts` (the copy is auto-ignored — write local
   values freely)
2. Fill in `BASE` / `MAIN` / `PROJECTS_ROOT` with one of your own sessions:
   `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`
3. Tune the `expect(...)` values to your sample (counts/durations won't match across
   sessions; the template only does structural checks)
4. `npx vitest run test/real-sample.smoke.test.ts`

The template file (`.template.ts`) is neither collected by vitest nor typechecked —
it's reference-only until renamed.

## Project structure

```
core/        # pure logic (no React / Electron deps), fully unit-tested
  parser/    # JSONL → Session tree (two-pass, tolerant parsing, tool_use↔tool_result pairing)
  discovery/ # scan top-level sessions + locate & recursively link sub-agent transcripts
  model/     # time-decomposition model: classify / timeline (interval union) / timeBreakdown (invariant)
  view/      # pure data → display structures (tree + formatters)
  ai/        # prompt for the local claude CLI: digest + fileMap + analyzeRequest
electron/    # host process: window / menu / IPC; claude CLI spawn; terminal open
src/         # React renderer (App / SessionList / TimeTree / DetailPanel / AiReport)
test/        # vitest unit tests + fixtures + real-sample template
```

The data flow is a one-way pipeline: **parse → link → model → view / AI**.
`core/` is the pure logic layer shared by all three bundles (main / preload / renderer);
Electron and React are thin adapters over it.

## Tech stack

- Electron 31 + electron-vite 2 (three bundles: main / preload / renderer)
- React 18 + react-markdown + remark-gfm
- TypeScript 5 (strict)
- vitest 2

## Non-source directories

`调研/`, `原型/`, `方案设计/` are research notes, reference-repo clones, prototypes,
and design docs — **not part of the app**. Under `调研/`, the `*.zip` archives and
`*-temp/` working clones are gitignored; only the `.md` research reports are tracked.
The source of truth for behavior is `core/` + `electron/` + `src/`.

## License

Private project; no open-source license assigned yet.
