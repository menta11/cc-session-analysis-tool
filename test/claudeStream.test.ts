/**
 * `runClaudeStream` 的编排逻辑测试 —— 补上此前的空白。
 *
 * `test/claudeCli.test.ts` 只覆盖了两个纯函数（buildStdin / parseStreamJsonLine），
 * 而真正容易在迁移中悄悄改坏的是**编排策略**：
 *   - 按能力选 argv（partial → 带 --include-partial-messages；只有 stream-json → 不带；都没有 → 裸 -p）
 *   - delta 与整 assistant 消息**二选一**（partial 下 delta 已累积，整消息必须跳过，否则内容翻倍）
 *   - 遥测（sessionId / cost / duration / numTurns）从 system 与 result 事件里取出
 *   - 错误/超时如实透传（ok:false + error）
 *
 * 测法：用一个**假的 ProcBridge** 替换掉真实子进程（core/procBridge.ts 的可注入设计正好为此），
 * 于是不需要安装 claude CLI、也不碰网络。每个用例都用 `vi.resetModules()` 拿一份全新的
 * claudeCli 实例 —— 因为它的路径/能力探测带模块级 Promise 缓存，不重置就串场。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ProcBridge, RunLinesResult } from '../core/procBridge'

interface FakeState {
  args?: string[]
  stdin?: string
  timeoutMs?: number
}

function makeFake(o: {
  path?: string | null
  help?: string
  lines?: string[]
  result?: RunLinesResult
}): ProcBridge & { state: FakeState } {
  const state: FakeState = {}
  return {
    state,
    platform: 'darwin',
    async execText(cmd) {
      // 第一次是 which/where claude，第二次是 claude --help
      if (cmd === 'which' || cmd === 'where') return { ok: true, out: o.path ?? '' }
      return { ok: true, out: o.help ?? '' }
    },
    async runLines(_cmd, args, stdinText, onLine, opts) {
      state.args = args
      state.stdin = stdinText
      state.timeoutMs = opts?.timeoutMs
      for (const l of o.lines ?? []) onLine(l)
      return o.result ?? { ok: true, stderr: '' }
    },
  }
}

/** 拿一份装了指定桥的全新 claudeCli（绕开模块级探测缓存） */
async function loadCli(bridge: ProcBridge) {
  vi.resetModules()
  const pb = await import('../core/procBridge')
  pb.setProcBridge(bridge)
  return import('../core/ai/claudeCli')
}

const SYS = 'SYS-PROMPT'
const DATA = 'DATA-BODY'

describe('runClaudeStream 编排', () => {
  it('partial 模式：delta 逐段透出，整 assistant 消息被跳过（不重复），遥测齐全', async () => {
    const b = makeFake({
      path: '/usr/local/bin/claude',
      help: 'options: --output-format stream-json --include-partial-messages',
      lines: [
        '{"type":"system","subtype":"init","session_id":"sess-1"}',
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}}',
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}}',
        // 同一份文本又出现在整消息里 —— 必须跳过，否则 text 变成 "你好你好"
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"你好"}]}}',
        '{"type":"result","session_id":"sess-1","total_cost_usd":0.0123,"duration_ms":4500,"num_turns":3}',
      ],
    })
    const cli = await loadCli(b)
    const chunks: string[] = []
    const r = await cli.runClaudeStream(DATA, SYS, (t) => chunks.push(t))

    expect(chunks).toEqual(['你', '好'])
    expect(r.text).toBe('你好')
    expect(r.ok).toBe(true)
    expect(r.sessionId).toBe('sess-1')
    expect(r.costUsd).toBe(0.0123)
    expect(r.durationMs).toBe(4500)
    expect(r.numTurns).toBe(3)
    expect(b.state.args).toEqual([
      '-p',
      '--verbose',
      '--include-partial-messages',
      '--output-format',
      'stream-json',
    ])
    // 负载全部走 stdin（argv 里带 `|` 会被 cmd.exe 切碎，见 buildStdin 注释）
    expect(b.state.stdin).toBe(cli.buildStdin(SYS, DATA))
  })

  it('只有 stream-json（无 partial）：整 assistant 消息一次性透出，argv 不带 partial 开关', async () => {
    const b = makeFake({
      path: '/usr/local/bin/claude',
      help: 'options: --output-format stream-json',
      lines: [
        '{"type":"system","subtype":"init","session_id":"sess-2"}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"完整"}]}}',
      ],
    })
    const cli = await loadCli(b)
    const chunks: string[] = []
    const r = await cli.runClaudeStream(DATA, SYS, (t) => chunks.push(t))

    expect(chunks).toEqual(['完整'])
    expect(r.text).toBe('完整')
    expect(b.state.args).toEqual(['-p', '--verbose', '--output-format', 'stream-json'])
  })

  it('两种能力都不支持：裸 -p，按行累积原文并 trimEnd，不做解析也不流式透出', async () => {
    const b = makeFake({ path: '/usr/local/bin/claude', help: 'no stream json here', lines: ['line1', 'line2'] })
    const cli = await loadCli(b)
    const chunks: string[] = []
    const r = await cli.runClaudeStream(DATA, SYS, (t) => chunks.push(t))

    expect(b.state.args).toEqual(['-p'])
    expect(r.text).toBe('line1\nline2') // 累积后 trimEnd（丢掉末尾换行）
    expect(chunks).toEqual([]) // 非流式模式下确实不回调（与原实现一致）
    expect(r.sessionId).toBeUndefined()
    expect(r.costUsd).toBeUndefined()
  })

  it('claude 不在 PATH：能力探测为 false，退化为裸 -p，而不是抛异常', async () => {
    const b = makeFake({ path: '', help: 'whatever' })
    const cli = await loadCli(b)
    const r = await cli.runClaudeStream(DATA, SYS, () => {})
    expect(b.state.args).toEqual(['-p'])
    expect(r.ok).toBe(true)
  })

  it('子进程失败/超时：ok:false 与 error 如实透传，已收到的 delta 不丢', async () => {
    const b = makeFake({
      path: '/usr/local/bin/claude',
      help: 'stream-json include-partial-messages',
      lines: [
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"半截"}}}',
      ],
      result: { ok: false, error: '调用 claude 超时', stderr: 'boom' },
    })
    const cli = await loadCli(b)
    const chunks: string[] = []
    const r = await cli.runClaudeStream(DATA, SYS, (t) => chunks.push(t), { timeoutMs: 1234 })

    expect(r.ok).toBe(false)
    expect(r.error).toBe('调用 claude 超时')
    expect(r.text).toBe('半截') // 超时前收到的内容仍返回
    expect(chunks).toEqual(['半截'])
    expect(b.state.timeoutMs).toBe(1234) // timeoutMs 透传到桥
  })

  it('坏行/空行不影响流式解析（容错）', async () => {
    const b = makeFake({
      path: '/x/claude',
      help: 'stream-json include-partial-messages',
      lines: [
        '',
        '   ',
        'not json at all',
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}}',
      ],
    })
    const cli = await loadCli(b)
    const chunks: string[] = []
    const r = await cli.runClaudeStream(DATA, SYS, (t) => chunks.push(t))
    expect(chunks).toEqual(['ok'])
    expect(r.text).toBe('ok')
  })
})
