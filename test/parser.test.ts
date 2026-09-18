import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { parseJsonl, parseLines } from '../core/parser/parse'

const FIXTURE = fileURLToPath(new URL('./fixtures/mini_session.jsonl', import.meta.url))

describe('parseJsonl — basic structure', () => {
  it('parses session metadata and turn structure', () => {
    const s = parseJsonl(FIXTURE)

    expect(s.sessionId).toBe('mini')
    expect(s.cwd).toBe('/home/user/proj')
    expect(s.gitBranch).toBe('main')
    expect(s.version).toBe('2.1.110')

    expect(s.turns).toHaveLength(2)
    const [t0, t1] = s.turns

    expect(t0.userMsg?.text).toBe('run my tests')
    expect(t0.assistantMsgs).toHaveLength(2)
    expect(t0.toolCalls).toHaveLength(2)

    expect(t1.userMsg?.text).toBe('now summarize')
    expect(t1.assistantMsgs).toHaveLength(1)
    expect(t1.toolCalls).toHaveLength(0)
  })
})

describe('parseJsonl — content blocks', () => {
  it('parses thinking/text/tool_use blocks of the first assistant msg', () => {
    const s = parseJsonl(FIXTURE)
    const blocks = s.turns[0].assistantMsgs[0].blocks

    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toMatchObject({ type: 'thinking', text: 'I should run pytest', signature: 'sig1' })
    expect(blocks[1]).toMatchObject({ type: 'text', text: 'Running your tests.' })
    expect(blocks[2]).toMatchObject({ type: 'tool_use', name: 'Bash' })
  })
})

describe('parseJsonl — tool pairing', () => {
  it('pairs tool_use↔tool_result by id and computes wall-clock duration', () => {
    const s = parseJsonl(FIXTURE)
    const byName = new Map(s.turns[0].toolCalls.map((c) => [c.name, c]))

    const bash = byName.get('Bash')!
    expect(bash.isError).toBe(false)
    expect(bash.tsEnd).not.toBeNull()
    expect(bash.result).toBe('3 passed in 0.2s')
    expect(bash.durationMs).toBeGreaterThanOrEqual(1400) // a1 12:00:01 → u2 12:00:02.5 = 1500ms
    expect(bash.durationMs).toBeLessThanOrEqual(1600)

    const read = byName.get('Read')!
    expect(read.isError).toBe(true)
    expect(read.result).toBe('file not found')
  })
})

describe('parseJsonl — usage', () => {
  it('parses token usage incl ephemeral cache breakdown', () => {
    const s = parseJsonl(FIXTURE)
    const u = s.turns[0].assistantMsgs[0].usage

    expect(u.input).toBe(10)
    expect(u.cacheCreation).toBe(100)
    expect(u.cacheRead).toBe(200)
    expect(u.output).toBe(50)
    expect(u.serviceTier).toBe('standard')
    expect(u.ephemeral1h).toBe(100)
  })
})

describe('parseJsonl — sidechain isolation', () => {
  it('keeps sidechain messages out of main turns', () => {
    const s = parseJsonl(FIXTURE)
    expect(s.sidechainMsgs).toHaveLength(1)
    for (const turn of s.turns) {
      for (const a of turn.assistantMsgs) {
        expect(a.isSidechain).toBe(false)
      }
    }
  })
})

describe('parseJsonl — noise filtering', () => {
  it('skips progress events and captures turn_duration', () => {
    const s = parseJsonl(FIXTURE)
    expect(s.skippedCounts.progress ?? 0).toBe(1)
    // ts 必须一起留：turn_duration 不是每轮都发，只能靠时刻匹配到某一轮（见 types.ts::TurnDuration）
    expect(s.systemTurnDurations).toEqual([{ ts: Date.parse('2026-04-24T12:00:07.000Z'), durationMs: 6000 }])
  })
})

describe('parseLines — tolerance', () => {
  it('skips malformed JSON lines with a warning instead of throwing', () => {
    const lines = [
      '{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"hi"}}',
      '{not json',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1,"output_tokens":1}}}',
    ]
    const s = parseLines(lines, 'm')

    expect(s.parseWarnings).toHaveLength(1)
    expect(s.turns).toHaveLength(1)
    expect(s.turns[0].assistantMsgs).toHaveLength(1)
  })

  it('truncates tool results over the 5KB preview limit', () => {
    const big = 'x'.repeat(6 * 1024)
    const lines = [
      '{"type":"user","uuid":"u1","parentUuid":null,"timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"go"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}],"usage":{}}}',
      '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:00:02.000Z","sessionId":"m","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"' + big + '"}]}}',
    ]
    const s = parseLines(lines, 'm')

    expect(s.turns[0].toolCalls).toHaveLength(1)
    const tc = s.turns[0].toolCalls[0]
    expect(tc.resultTruncated).toBe(true)
    expect(tc.result).not.toBeNull()
    expect(tc.result!.length).toBe(5 * 1024)
  })
})

describe('parseLines — new-format meta noise', () => {
  const userLine = (content: string, isMeta?: boolean) =>
    `{"type":"user","message":{"role":"user","content":${JSON.stringify(content)}},"timestamp":"2026-08-20T07:00:00.000Z",${isMeta ? `"isMeta":${isMeta},` : ''}"sessionId":"m"}`

  it('does not create turns from isMeta system-injected user events', () => {
    const s = parseLines(
      [
        userLine('你好'),
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"timestamp":"2026-08-20T07:00:10.000Z"}',
        userLine('[Image: source: C:\\Temp\\paste.png]', true),
        userLine('真实提问'),
      ],
      'm',
    )
    // isMeta 图片通知不产生轮次：真实提问应成为第二轮
    expect(s.turns).toHaveLength(2)
    expect(s.turns[1].userMsg?.text).toBe('真实提问')
  })

  it('does not create turns from task-notification user events', () => {
    const s = parseLines(
      [
        '{"type":"user","message":{"role":"user","content":"发起任务"},"timestamp":"2026-08-20T07:00:00.000Z"}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]},"timestamp":"2026-08-20T07:00:10.000Z"}',
        '{"type":"user","message":{"role":"user","content":"<task-notification>\\n<task-id>a36235b4710c2a21b</task-id>\\n<output-file>C:\\\\tmp\\\\o.json</output-file>\\n</task-notification>"},"timestamp":"2026-08-20T07:00:20.000Z"}',
        '{"type":"user","message":{"role":"user","content":"下一个问题"},"timestamp":"2026-08-20T07:01:00.000Z"}',
      ],
      'm',
    )
    expect(s.turns).toHaveLength(2)
    expect(s.turns[1].userMsg?.text).toBe('下一个问题')
  })
})

/**
 * 打断标记：用户按 Esc 时 cc 落的 user 记录，正文就是标记本身
 * （本机 1189 个会话里共 560 条）。它不是用户说的话，解析层把它标出来。
 */
describe('parseLines — 打断标记', () => {
  const askLine =
    '{"type":"user","uuid":"u1","message":{"role":"user","content":"你好"},"timestamp":"2026-08-20T07:00:00.000Z","sessionId":"m"}'
  const markerLine = (text: string) =>
    `{"type":"user","uuid":"u2","message":{"role":"user","content":${JSON.stringify(text)}},"timestamp":"2026-08-20T07:00:10.000Z","sessionId":"m"}`

  it('整条正文就是标记（打断回复 / 打断工具调用两种写法）→ isInterrupt', () => {
    for (const marker of ['[Request interrupted by user]', '[Request interrupted by user for tool use]']) {
      const s = parseLines([askLine, markerLine(marker)], 'm')
      expect(s.turns[0].userMsg?.isInterrupt).toBe(false)
      expect(s.turns[1].userMsg?.isInterrupt).toBe(true)
      expect(s.turns[1].userMsg?.text).toBe(marker)
    }
  })

  it('正文里夹着标记的长消息不算打断（cc 会把标记拼进用户的下一条消息）', () => {
    const s = parseLines([askLine, markerLine('1、[Request interrupted by user]操作是 用户打断')], 'm')
    expect(s.turns[1].userMsg?.isInterrupt).toBe(false)
  })

  it('标记两侧带空白也认（照抄的正文不一定贴着边界）', () => {
    const s = parseLines([askLine, markerLine('  [Request interrupted by user]  ')], 'm')
    expect(s.turns[1].userMsg?.isInterrupt).toBe(true)
  })
})

/**
 * 本地命令记录（`/compact`、`/clear`、`/plugin`…）不是用户说的话。
 * 本机分布：`<command-name>` 回显 498 条、技能调用 200 条、命令输出 93 条、裸命令 16 条。
 */
describe('parseLines — 本地命令记录', () => {
  const cmdLine = (uuid: string, text: string, sec: number) =>
    `{"type":"user","uuid":"${uuid}","message":{"role":"user","content":${JSON.stringify(text)}},"timestamp":"2026-08-20T07:00:${String(sec).padStart(2, '0')}.000Z","sessionId":"m"}`

  it('三种壳都认，给出命令名（裸命令 / cc 的 <command-name> 回显 / 命令输出）', () => {
    const s = parseLines(
      [
        cmdLine('u1', '/compact', 0),
        cmdLine('u2', '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>', 1),
        cmdLine('u3', '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>', 2),
        cmdLine('u4', '/clear', 3),
        // 输出记录自己不带命令名 → 认本文件里最近那条命令
        cmdLine('u5', '<local-command-stdout>Cleared (ctrl+o to see full summary)</local-command-stdout>', 4),
      ],
      'm',
    )
    expect(s.turns.map((t) => t.userMsg?.commandName)).toEqual(['compact', 'compact', 'compact', 'clear', 'clear'])
  })

  it('带 args 的技能调用不算命令记录：用户在那条消息里真的说了话', () => {
    const s = parseLines(
      [
        cmdLine('u1', '<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>30m 检测整个工程</command-args>', 0),
        cmdLine('u2', '/compact', 1),
      ],
      'm',
    )
    expect(s.turns[0].userMsg?.commandName).toBeNull()
    expect(s.turns[0].userMsg?.text).toContain('30m 检测整个工程')
    expect(s.turns[1].userMsg?.commandName).toBe('compact')
  })

  it('一路没有命令时，输出记录不硬认一个命令名', () => {
    const s = parseLines([cmdLine('u1', '<local-command-stdout>(no content)</local-command-stdout>', 0)], 'm')
    expect(s.turns[0].userMsg?.commandName).toBeNull()
  })

  it('普通提问与打断标记都不是命令记录', () => {
    const s = parseLines([cmdLine('u1', '帮我看看这个', 0), cmdLine('u2', '[Request interrupted by user]', 1)], 'm')
    expect(s.turns.map((t) => t.userMsg?.commandName)).toEqual([null, null])
  })
})

/**
 * cc 把**一条 API 消息**按内容块拆成多条 jsonl 记录（共享 `message.id`）。
 * 不合并的话，界面上「模型的这一条响应」会被拆成好几行：
 * 思考在一行、正文在另一行、它发起的工具在第三行。
 */
describe('parseLines — 一条 API 消息拆成多条记录', () => {
  const lines = [
    '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"开始"}}',
    '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"id":"M1","model":"x","role":"assistant","content":[{"type":"thinking","thinking":"先看看"}],"usage":{"output_tokens":50}}}',
    '{"type":"assistant","uuid":"a2","parentUuid":"a1","timestamp":"2026-04-24T12:00:03.000Z","sessionId":"m","message":{"id":"M1","model":"x","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}],"usage":{"output_tokens":50}}}',
    '{"type":"assistant","uuid":"a3","parentUuid":"a2","timestamp":"2026-04-24T12:00:05.000Z","sessionId":"m","message":{"id":"M1","model":"x","role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/a"}}],"usage":{"output_tokens":50}}}',
    '{"type":"user","uuid":"u2","parentUuid":"a3","timestamp":"2026-04-24T12:00:09.000Z","sessionId":"m","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}',
    '{"type":"user","uuid":"u3","parentUuid":"u2","timestamp":"2026-04-24T12:00:11.000Z","sessionId":"m","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"ok"}]}}',
  ]

  it('按 message.id 合成一条：块按记录顺序拼接，时刻取「写完」的那条', () => {
    const s = parseLines(lines, 'm')
    expect(s.turns[0].assistantMsgs).toHaveLength(1)
    const msg = s.turns[0].assistantMsgs[0]
    expect(msg.blocks.map((b) => b.type)).toEqual(['thinking', 'tool_use', 'tool_use'])
    expect(msg.ts).toBe(Date.parse('2026-04-24T12:00:05.000Z'))
    expect(msg.uuid).toBe('a1') // 链头那条记录的 uuid
    expect(msg.usage.output).toBe(50) // 同一条消息的各记录 usage 相同，不重复累加
  })

  it('工具的开始时刻不早于发起它的消息写完（先前记录只是块落盘的中间态）', () => {
    const s = parseLines(lines, 'm')
    const done = Date.parse('2026-04-24T12:00:05.000Z')
    const [t1, t2] = s.turns[0].toolCalls
    expect(t1.tsStart).toBe(done) // 原本落在 12:00:03，那会儿模型还在吐后面的块
    expect(t1.durationMs).toBe(4000) // 12:00:05 → 12:00:09
    expect(t2.tsStart).toBe(done)
    expect(t2.durationMs).toBe(6000)
  })

  /**
   * 真实 transcript 里同一条消息的 usage 是**边写边落**的：先落的记录只写了 input、output 为 0，
   * 缓存那几项也还没有，末条才是补齐的完整账（子 agent transcript 里几乎条条如此）——
   * token 账取第一条会把「输出」整列读成 0。
   */
  it('token 账取最后一条补齐的记录：output 与缓存几项不留在中间态', () => {
    const s = parseLines(
      [
        '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","message":{"role":"user","content":"开始"}}',
        '{"type":"assistant","uuid":"a1","timestamp":"2026-04-24T12:00:01.000Z","message":{"id":"M1","model":"x","role":"assistant","content":[{"type":"thinking","thinking":"先看看"}],"usage":{"input_tokens":4662,"output_tokens":0}}}',
        '{"type":"assistant","uuid":"a2","timestamp":"2026-04-24T12:00:02.000Z","message":{"id":"M1","model":"x","role":"assistant","content":[{"type":"text","text":"看一下"}],"usage":{"input_tokens":2662,"output_tokens":128,"cache_read_input_tokens":12032,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}',
      ],
      'm',
    )
    const msg = s.turns[0].assistantMsgs[0]
    expect(msg.blocks).toHaveLength(2)
    expect(msg.usage.output).toBe(128)
    expect(msg.usage.input).toBe(2662)
    expect(msg.usage.cacheRead).toBe(12032)
  })

  it('不带 usage 的后续记录不抹掉已有的 token 账', () => {
    const s = parseLines(
      [
        '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","message":{"role":"user","content":"开始"}}',
        '{"type":"assistant","uuid":"a1","timestamp":"2026-04-24T12:00:01.000Z","message":{"id":"M1","model":"x","role":"assistant","content":[{"type":"thinking","thinking":"先看看"}],"usage":{"input_tokens":10,"output_tokens":50}}}',
        '{"type":"assistant","uuid":"a2","timestamp":"2026-04-24T12:00:02.000Z","message":{"id":"M1","model":"x","role":"assistant","content":[{"type":"text","text":"看一下"}]}}',
        '{"type":"assistant","uuid":"a3","timestamp":"2026-04-24T12:00:03.000Z","message":{"id":"M1","model":"x","role":"assistant","content":[{"type":"text","text":"再补一句"}],"usage":{}}}',
      ],
      'm',
    )
    expect(s.turns[0].assistantMsgs[0].usage.output).toBe(50)
  })

  it('缺 message.id 的记录各成一条（老样本与合成消息）', () => {
    const s = parseLines(
      [
        '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","message":{"role":"user","content":"开始"}}',
        '{"type":"assistant","uuid":"a1","timestamp":"2026-04-24T12:00:01.000Z","message":{"model":"x","role":"assistant","content":[{"type":"thinking","thinking":"甲"}]}}',
        '{"type":"assistant","uuid":"a2","timestamp":"2026-04-24T12:00:02.000Z","message":{"model":"x","role":"assistant","content":[{"type":"thinking","thinking":"乙"}]}}',
      ],
      'm',
    )
    expect(s.turns[0].assistantMsgs).toHaveLength(2)
  })
})

describe('parseLines — 上游 API 错误', () => {
  const USER_LINE =
    '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"开始"}}'

  /**
   * 与真样本同形：cc 把上游报错写成一条 `<synthetic>` 的 assistant 记录，正文就是错误说明，
   * 三个错误字段另挂在记录上（本机 86 条，见 core/parser/types.ts 的 ApiError）。
   */
  const errLine = (extra: string): string =>
    `{"type":"assistant","uuid":"e1","parentUuid":"u1","timestamp":"2026-04-24T12:00:02.000Z","sessionId":"m","isApiErrorMessage":true,${extra}"message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"API Error: 上游返回超限"}]}}`

  it('isApiErrorMessage 的记录带出归类与 HTTP 码', () => {
    const s = parseLines([USER_LINE, errLine('"error":"max_output_tokens","apiErrorStatus":400,')], 'm')
    expect(s.turns[0].assistantMsgs[0].apiError).toEqual({ kind: 'max_output_tokens', status: 400 })
  })

  it('两个字段都可能缺，缺了归 null 而不猜', () => {
    const s = parseLines([USER_LINE, errLine('')], 'm')
    expect(s.turns[0].assistantMsgs[0].apiError).toEqual({ kind: null, status: null })
  })

  it('反例：/compact 的摘要是普通消息 —— 它同样是 <synthetic>，不能拿 isSynthetic 当错误判据', () => {
    const summary =
      '{"type":"assistant","uuid":"c1","parentUuid":"u1","timestamp":"2026-04-24T12:00:02.000Z","sessionId":"m","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"本次对话摘要"}]}}'
    const msg = parseLines([USER_LINE, summary], 'm').turns[0].assistantMsgs[0]
    expect(msg.isSynthetic).toBe(true)
    expect(msg.apiError).toBeNull()
  })

  it('形状不对（字符串状态码 / 非字符串归类）按缺失处理，不抛异常', () => {
    const s = parseLines([USER_LINE, errLine('"error":42,"apiErrorStatus":"400",')], 'm')
    expect(s.turns[0].assistantMsgs[0].apiError).toEqual({ kind: null, status: null })
  })
})
