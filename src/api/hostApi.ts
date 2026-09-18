import type { MetaCache, SessionMeta } from '../../core/discovery/metaCache'
import type { SessionRef } from '../../core/discovery/scan'
import type { Session } from '../../core/parser/types'
import type { LogSummary } from '../../core/view/logView'
import type { LogScope } from '../../core/ai/logDigest'
import type { ViewWindow } from '../../core/view/window'

/** 保存对话框的过滤器：决定用户在对话框里能选哪些扩展名 */
export interface SaveFilter {
  name: string
  extensions: string[]
}

export interface AnalyzeResult {
  ok: boolean
  text: string
  error?: string
  sessionId?: string
  costUsd?: number
  durationMs?: number
  numTurns?: number
}

/**
 * 一次分析请求要分析什么。三种目标的**输入是三种东西**（整会话 / 某个子 agent 节点 / 筛选后的记录表），
 * 所以用判别联合而不是「位置参数 + 可选的 focusToolUseId / window」——
 * 后者到了这个参数数量就会出现「node 模式忘传 focusToolUseId」「log 模式的表传进了 window 那个坑」。
 */
export type AnalyzeTarget =
  /** 整会话（`window` 存在时只分析该时间窗内的完整轮次） */
  | { kind: 'whole'; window?: ViewWindow }
  /** 聚焦某个子 agent 调用 */
  | { kind: 'node'; focusToolUseId: string }
  /** 日志视图筛选后的记录表（`summary` 是整会话口径，用于对照） */
  | { kind: 'log'; scope: LogScope; summary: LogSummary }

/**
 * 流式 chunk 的归属。**为什么要它**：树视图与日志视图可以在同一个会话上同时跑分析，
 * 只按 `sessionPath` 过滤会让两边的报告互相串行 —— 你点「用 claude 分析」，吐出来的
 * 却是底部那份整会话报告的续写。
 */
export type AnalyzeTag = 'tree' | 'log'

export interface AnalyzeChunk {
  sessionPath: string
  tag: AnalyzeTag
  text: string
}

/**
 * 渲染层用到的宿主能力接口。
 *
 * 契约来源是 `src/api/tauri.ts` 的实现面 —— 它逐条对应 `src-tauri/src/lib.rs` 里注册的
 * `invoke_handler` 命令。业务组件只 import 这里的 `api`，不直接 `invoke(...)`，
 * 于是 Rust 侧命令改名 / 改形时，编译期就能在 TS 这侧露出来。
 *
 * 注意：`window.ccMonitor`（5 个方法）**不在这里**。那是给内嵌 `dashboard.html` / `mini.html`
 * 用的桥 —— 那两个页面由 proxy 以 HTTP 提供、被 iframe 加载，不属于 React 应用。
 * 它由 `src-tauri/src/float_window.rs` 的 inlined plugin 注入，授权见 `capabilities/float.json`。
 */
export interface HostApi {
  /** 会话列表**骨架**（只 read_dir + stat，不读文件内容；元数据由 `readSessionMeta` 按需取） */
  scanProjects(): Promise<SessionRef[]>
  /** 读单个会话的元数据（标题 / cwd / 首条提问）。宿主一次 IPC，失败不得抛出。 */
  readSessionMeta(path: string): Promise<SessionMeta>
  /** 读元数据缓存（文件不存在/坏 JSON → 空缓存，不得抛出） */
  loadMetaCache(): Promise<MetaCache>
  /** 写元数据缓存（写失败只告警，不影响本次结果） */
  saveMetaCache(cache: MetaCache): Promise<void>
  loadSession(path: string): Promise<Session>
  analyzeReport(sessionPath: string, target: AnalyzeTarget): Promise<AnalyzeResult>
  /** 订阅流式 chunk，返回取消订阅函数。**按 `tag` 各自认领**，同会话并发分析不串线。 */
  onAnalyzeChunk(cb: (chunk: AnalyzeChunk) => void): () => void
  /**
   * 弹保存对话框并返回用户选定的绝对路径（取消 → null）。**只选路径，不写盘。**
   *
   * 与写盘分成两步：写什么（报告正文）由调用方在自己手里，宿主只负责「问到路径」和「写进去」；
   * 合成一个方法就得把内容也塞进签名，宿主反而要知道业务文案的生成方式。
   */
  chooseSavePath(name: string, filters: SaveFilter[]): Promise<string | null>
  /** 把文本写到绝对路径（覆盖写；父目录由宿主或调用方保证存在） */
  writeTextFile(path: string, text: string): Promise<void>
  openTerminal(claudeId: string): Promise<{ ok: boolean; error?: string }>
  /** 在系统文件管理器里打开一个目录（会话 jsonl 所在的文件夹）。只保证窗口打开了。 */
  openDir(dir: string): Promise<{ ok: boolean; error?: string }>
  /** 菜单「导入会话」推送路径，返回取消订阅函数 */
  onImportSession(cb: (path: string) => void): () => void
  getMonitorPort(): Promise<number>
  /** 代理存活探测（宿主侧发起，规避渲染页跨源 CORS） */
  pingMonitor(): Promise<boolean>
  enterFloatMode(): Promise<void>
}
