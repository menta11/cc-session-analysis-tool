# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Electron desktop app (Win + Mac) that analyzes Claude Code session transcripts
(`~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`) and produces a recursive
"work vs wait" time breakdown of where a session's wall-clock went — LLM thinking,
local tools (direct Bash/other vs delegated sub-agents), and waiting-on-user. Sub-agent
transcripts are linked recursively so a delegated `Agent` call can be drilled into. A
"AI report" feature shells out to the local `claude` CLI to produce a markdown bottleneck
analysis from the structured digest.

## Commands

```bash
npm run dev          # electron-vite dev (hot reload main + renderer)
npm run build       # build all three bundles (main/preload/renderer) → out/
npm run preview     # run the built app
npm test            # vitest run (one-shot)
npm run test:watch  # vitest watch
npm run typecheck   # tsc --noEmit for both tsconfig.node.json + tsconfig.web.json
```

Run a single test file / test name:

```bash
npx vitest run test/parser.test.ts
npx vitest run -t "parses session metadata and turn structure"
```

There is no separate lint script; `tsc --noEmit` under `strict` + `noUnusedLocals` +
`noUnusedParameters` is the type/quality gate. Run `npm run typecheck` before declaring work done.

## Build layout (electron-vite, three bundles)

`electron.vite.config.ts` defines three independent build entries — keep each file in its
declared entry or it won't ship:

- **main** → `electron/main/index.ts` (Node, ESM, `externalizeDepsPlugin` keeps runtime deps out of bundle)
- **preload** → `electron/preload/index.ts` (runs in renderer with contextBridge)
- **renderer** → `src/index.html` (+ `src/**`, React, alias `@` → `src/`)

`core/**/*.ts` is shared pure logic **imported by all three** and covered by `tsconfig.json`.
`tsconfig.node.json` (electron + core) and `tsconfig.web.json` (src + core) both extend it.
Renderer has DOM libs + `jsx: react-jsx`; main/preload do not.

## Code map

The data flow is a one-way pipeline: **parse → link → model → view/AI**. Everything in
`core/` is fs/process-touching or pure functions, framework-agnostic and unit-tested in
isolation. Electron and React are thin adapters over `core/`.

### `core/parser/` — JSONL → Session tree
- `types.ts` — the central data model. `Session`/`Turn`/`ToolCall`/`AssistantMsg`/`UserMsg`
  + `StructuredResult` (per-tool-name discriminated union) + `NodeTime`. Field naming is
  camelCase; all times are ms-epoch numbers.
- `parse.ts` — `parseJsonl(path, opts?)` / `parseLines(lines, ...)`. **Two-pass**: pass 1
  reads lines with per-line JSON tolerance, collects session metadata (first-seen-wins),
  filters noise events (`SKIP_TYPES`), and tracks wall-clock min/max across *all* event
  types (incl. system/progress) so trailing system events aren't lost. Pass 2 stable-sorts
  by timestamp, rebuilds `Turn` tree, and pairs `tool_use`↔`tool_result` by `tool_use_id` to
  compute per-call `durationMs`. The `subagent: true` option keeps `isSidechain` messages on
  the main line (default false excludes them so sidechain isn't double-counted with the transcript).
- `blocks.ts` — content-block extraction + usage dict parsing + result preview truncation
  (`RESULT_PREVIEW_LIMIT = 5KB`).
- `toolResult.ts` — `extractStructuredResult(toolName, toolUseResult)` maps the top-level
  `toolUseResult` object into the `StructuredResult` union. Non-object or unknown tool → `null` (never throws, never drops).

### `core/discovery/` — finding & linking sub-agent transcripts
- `scan.ts` — `scanProjects(root)` lists all top-level sessions under
  `~/.claude/projects/<project>/` (mtime desc). Skips same-named dirs (subagent sidecar).
  `defaultProjectsRoot()` is fs-only (Electron overrides via `app.getPath('home')`).
- `projectDir.ts` — `decodeProjectDir(name)`: reverse the sanitized-cwd dir name to a
  readable path (Windows `D--foo-bar` → `D:/foo-bar`; Unix `-Users-foo` → `/Users/foo`,
  lossy on internal `-`).
- `agentIndex.ts` — `buildAgentIndex(sessionDir)`: scans `subagents/` (preferred),
  `agents/` (fallback), and `subagents/workflows/<runId>/` for `agent-<id>.jsonl`, building
  an `agentId → path` map. Filename-direct, never reads file contents.
- `linkSubagents.ts` — `linkSubagents(session, index, parseChild)`: recursively hangs each
  sub-agent transcript onto its dispatching `Agent`/`Task` call's `childSession`. Link key
  is `structuredResult.agentId` first, with a `result`-text regex fallback for async agents
  that omit a structured `agentId`. Caches by agentId to avoid re-parse and cycles. Returns
  `unresolved` for diagnosis (never blocks).

### `core/model/` — the time-decomposition model (the conceptual heart)
- `classify.ts` — `classifyTool(name)`: `Agent`/`Task`→`delegated`, `AskUserQuestion`→`wait-user`,
  else `direct`.
- `timeline.ts` — `unionDuration(intervals)`: merge overlapping intervals and return total
  covered ms. **Critical for parallel sub-agents**: their dispatch intervals overlap, so we
  take the union (not the sum) to avoid "parallel inflation."
- `timeBreakdown.ts` — the core invariant: `wallMs = waitUser + localTool + compute`
  (compute = model thinking, derived as the complement). `sessionIntervals(session)` builds
  per-category wall-clock intervals (gantt-shaped); `breakdownOf(session)` reduces them to
  `NodeTime`. `waitUser` = AskUserQuestion intervals + inter-turn gaps, then *minus* any
  overlap with active tools (person left but a background agent ran → that's delegated, not
  idle). `compute` is the complement of (waitUser ∪ direct ∪ delegated) within
  `[startedAt, endedAt]`. `complement()` is exported and reused by the view layer.

### `core/view/` — pure data → display structures
- `format.ts` — small formatters: `fmtMs` (`1h2m3s`), `pct`, `bar` (█ progress),
  `fmtRelative`, `fmtSize`.
- `treeView.ts` — `buildTreeNode(session)`: turns a `Session` into the display tree
  (`root → waitUser / localTool[direct + delegated[agent…recursive]] / compute`). Each node
  carries its category color (CSS-var based, Okabe-Ito) and gantt `segments` (absolute ts).
  Agent nodes are `expandable` when they have a `childSession` (renderer recurses). Direct
  tools are bucketed: `Bash` alone, everything else → `other`.

### `core/ai/` — building the prompt for the local claude CLI
- `template.ts` — `getSystemPrompt()` returns `templates/agent-run.md` inlined via Vite
  `?raw` (build-time). Single template shared by whole-session and node-diagnosis modes.
- `templates/agent-run.md` — the system prompt: role, strict output format (overview →
  staged key events table → slow-cause analysis → evidence → optimization), and hard
  constraints (numbers must be quoted from the given data, never recomputed from raw timestamps).
- `prompt.ts` — `buildDigest(session, opts?)` produces the markdown "facts" digest
  (breakdown, time-bucket table, inter-turn gaps, error summary, diagnostic facts, slowest
  direct tools, full sub-agent table, parallelism). `buildFileMap(session, opts)` produces
  the evidence map (main file + all sub-agent files sorted by duration + dig hints for top-5
  slow sub-agents + parallel groups). `DigestOpts.parentAgentCall` switches into node
  diagnosis mode (adds parent/child reconciliation).
- `analyzeRequest.ts` — `buildAnalyzeRequest(session, opts)`: orchestrates digest+fileMap.
  `kind:'whole'` analyzes the whole session; `kind:'node'` recursively locates the
  `focusToolUseId`'s `Agent` call and its parent session, builds the child's digest
  (with parent reconciliation) and the child's sub-file-map.

### `electron/` — the host process
- `main/index.ts` — Electron main: window/menu/IPC. `session:load` parses + links + caches
  the `Session` (with `agentIndex` + `projectsRoot`) in a `sessionCache` map so `analyze:run`
  can reassemble the prompt in-process. `projectsRoot` must be the **session's parent dir**
  (`dirname(path minus .jsonl)`), NOT the session dir itself — otherwise `relOf` strips the
  whole `<sessionId>.jsonl` down to `.jsonl` (regression covered in `fileMap.test.ts`).
  `analyze:run` streams chunks back via `analyze:chunk` IPC. `terminal:open` opens an OS
  terminal on `claude --resume <id>`.
- `main/claudeCli.ts` — spawns the local `claude` CLI. **Key Windows quirk**: `claude` is a
  `.cmd` shim that needs `shell:true`, so argv is unsafe (cmd.exe would slice `|` in tables).
  The system prompt is therefore **inlined into stdin** (`buildStdin`), never passed as
  `--append-system-prompt` argv. Capability-probes `--help` once (cached) to pick the best
  output mode: `--include-partial-messages` (true streaming deltas) > plain `stream-json`
  (whole assistant message) > raw `-p` text. Parses NDJSON stream lines via
  `parseStreamJsonLine` (tolerant — bad JSON → `other`, never throws).
- `main/terminal.ts` — `openTerminal(id)`: cross-platform `claude --resume <id>` in a new
  OS terminal. `id` must be a UUID (guard). **cwd-sensitive**: resume must run from the same
  cwd as the analysis call, because claude stores sessions under
  `~/.claude/projects/<sanitize(cwd)>/<id>.jsonl` — different cwd → "No conversation found."
  Win uses `cmd /c start "" /d <cwd> cmd /k ...`; mac uses `osascript` → Terminal.app.
- `preload/index.ts` — `contextBridge.exposeInMainWorld('api', …)`. The renderer's only
  Node-surface. `src/preload.d.ts` types `window.api`.

### `src/` — React renderer
- `App.tsx` — top-level state: session list (`scanProjects`), loaded `Session`, selected tree
  node, per-session report state map (keyed by path), theme. Layout: sidebar `SessionList` +
  a nested `SplitPane` (TimeTree + DetailPanel on top, `AiReport` on the bottom). `analyze()`
  subscribes to `onAnalyzeChunk` and accumulates streaming text into state.
- `components/SessionList.tsx`, `TimeTree.tsx` (renders `buildTreeNode` output, recurses on
  expandable agent nodes), `DetailPanel.tsx` (selected node detail; can trigger node-level
  `analyze('node', toolUseId)`), `AiReport.tsx` (renders streaming markdown via
  `react-markdown` + `remark-gfm`; buttons to generate / export .md / open claude terminal),
  `SplitPane.tsx` (reusable vertical/horizontal splitter).
- `styles.css` — defines the CSS variables the view layer references (`--cat-wait`,
  `--cat-direct`, `--cat-delegated`, `--cat-compute`, spacing, typography) for both light/dark.

## Conventions worth knowing

- **All times are ms-epoch numbers.** Never ISO strings in the model layer; `parseTimestamp`
  converts at the boundary.
- **`core/` has zero framework deps** (no React, no Electron) and is fully unit-tested.
  New logic that touches the model should land in `core/` with a `test/*.test.ts`. The
  Electron/React layers stay thin.
- **Tolerant parsing is a hard rule.** JSONL rows are decoded per-line with try/catch; bad
  lines → `parseWarnings`, never thrown. Same for stream-json (`parseStreamJsonLine` →
  `other`) and `extractStructuredResult` (unknown/odd shape → `null`). Don't introduce throws
  on untrusted transcript data.
- **`subagent: true` parse option** must be passed when parsing a sub-agent transcript, else
  its `isSidechain` messages get excluded and the transcript looks empty.
- **Wall-clock invariant** `wallMs = waitUser + localTool + compute` is enforced in
  `breakdownOf` via interval complement — any new category must slot into this algebra or the
  gantt and the numbers will disagree.
- Tests use real-ish fixtures under `test/fixtures/` (`mini_session.jsonl` for unit,
  `sample-session/` with a `subagents/agent-*.jsonl` sidecar for linking).
- **`test/real-sample*.smoke.test.ts` are gitignored** — they hard-code a machine-local
  session path under `~/.claude/projects/<sanitized-cwd>/<id>.jsonl` plus sample-specific
  counts/durations that won't match anyone else's transcript. A path-less, numbers-agnostic
  `test/real-sample.smoke.template.ts` is checked in instead: copy it to
  `real-sample.smoke.test.ts`, fill in `BASE`/`MAIN`/`PROJECTS_ROOT` with your own session,
  tune the `expect(...)` values to your sample, and run. The copy is auto-ignored so you can
  write local values freely. The template itself (`.template.ts`) is neither collected by
  vitest (`include: test/**/*.test.ts`) nor typechecked (neither node/web tsconfig includes
  `test/`), so it stays inert until renamed.

## Non-source directories

`调研/`, `原型/`, `方案设计/` are research notes, reference-repo clones, prototypes, and
design docs — **not** part of the app. Don't edit code there or treat those trees as
authoritative for current behavior; the source of truth is `core/` + `electron/` + `src/`.
