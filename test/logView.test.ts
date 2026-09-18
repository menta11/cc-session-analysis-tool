import { describe, it, expect } from 'vitest'
import { parseLines } from '../core/parser/parse'
import { breakdownOf } from '../core/model/timeBreakdown'
import { subagentLabel } from '../core/view/treeView'
import {
  DURATION_SCALE_COLOR,
  DURATION_SORTS,
  EMPTY_DURATION_QUERY,
  EMPTY_LOG_FILTER,
  GROUP_LLM,
  LOG_KIND_STYLE,
  LOG_KINDS,
  USER_ASK_LABEL,
  USER_INTERRUPT_LABEL,
  USER_LLM_KIND_LABEL,
  axisForWindow,
  axisPos,
  buildLogRows,
  describeLogFilter,
  durationBounds,
  durationSortOption,
  filterLogRows,
  fmtRowTokens,
  intersectsWindow,
  logBoundaries,
  logSpanLabel,
  logSummary,
  LOG_STATUS_LABEL,
  UNFILTERED_LABEL,
  buildTimeline,
  kindLabelOf,
  nextDurationSort,
  rowSpan,
  sortLogRows,
  timeAxisOf,
  withDurationOp,
  type DurationQuery,
  type LogFilter,
  type LogPanel,
  type LogRow,
} from '../core/view/logView'

/**
 * 时序（全部 UTC，相对 12:00:00 = 0ms）：
 *   0s    用户提问
 *   1s    LLM 回复（带一个 Bash 调用）         → 模型行耗时 1s（距会话开始）
 *   11s   Bash 结束（10s） + LLM 规划（带 Agent 委派）→ 委派行 100s
 *   111s  AskUserQuestion 发出（等用户 50s）
 *   161s  该轮最后活动结束 → 轮间间隙 39s
 *   200s  用户再次提问
 *   205s  最后一条 LLM 回复（5s）
 *   合计 = 1+10+0+100+0+50+39+5 = 205s = 会话总耗时（串行场景下逐行相加就是总耗时）
 */
const lines = [
  '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","cwd":"/home/me/proj","message":{"role":"user","content":"开始"}}',
  '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"text","text":"先看一下 parse.ts"},{"type":"tool_use","id":"toolu_01Ab3xKmQ7pR9vTe","name":"Bash","input":{"command":"git log --oneline -25","description":"Show recent commits"}}],"usage":{"input_tokens":1000,"cache_read_input_tokens":200,"output_tokens":40}}}',
  '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:00:11.000Z","sessionId":"m","toolUseResult":{"stdout":"533fff4 init\\n62f2ca8 fix","stderr":"","interrupted":false},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01Ab3xKmQ7pR9vTe","content":"533fff4 init"}]}}',
  '{"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"2026-04-24T12:00:11.000Z","sessionId":"m","message":{"model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"thinking","thinking":"规划下一步：交给子 agent 扫描"},{"type":"tool_use","id":"toolu_01Rt5Nbx00000000","name":"Agent","input":{"description":"扫描标题提取逻辑"}}],"usage":{"input_tokens":2000,"cache_read_input_tokens":10000,"output_tokens":300}}}',
  '{"type":"user","uuid":"u3","parentUuid":"a2","timestamp":"2026-04-24T12:01:51.000Z","sessionId":"m","toolUseResult":{"agentId":"child","agentType":"explore","totalDurationMs":99000,"totalTokens":500,"totalToolUseCount":3,"isAsync":false,"description":"扫描标题提取逻辑"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01Rt5Nbx00000000","content":"done"}]}}',
  '{"type":"assistant","uuid":"a3","parentUuid":"u3","timestamp":"2026-04-24T12:01:51.000Z","sessionId":"m","message":{"model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"tool_use","id":"toolu_01AskUser0000000","name":"AskUserQuestion","input":{"questions":[{"question":"要继续吗"}]}}],"usage":{}}}',
  '{"type":"user","uuid":"u4","parentUuid":"a3","timestamp":"2026-04-24T12:02:41.000Z","sessionId":"m","toolUseResult":{"questions":[],"answers":[]},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01AskUser0000000","content":"继续"}]}}',
  '{"type":"user","uuid":"u5","timestamp":"2026-04-24T12:03:20.000Z","sessionId":"m","message":{"role":"user","content":"next"}}',
  '{"type":"assistant","uuid":"a4","parentUuid":"u5","timestamp":"2026-04-24T12:03:25.000Z","sessionId":"m","message":{"model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":12,"output_tokens":3}}}',
]

const session = (): ReturnType<typeof parseLines> => parseLines(lines, 'm')

/**
 * 分段面板摊平成一段文本：段名 + 段正文按序拼起来。
 *
 * 分段面板没有 `body`（两段各自成块、各自滚动，见 `LogPanel.sections`），断言「这一块里到底有
 * 哪几段、各是什么」要把它们读回来 —— 只断言 `sections.length` 报不出「输出丢了」这种错。
 */
const sectionsText = (p: LogPanel): string => (p.sections ?? []).map((s) => `${s.title}\n${s.body}`).join('\n\n')

/** 手搓一行（只用于测不经过解析的纯函数）：默认值给全，用例只覆盖自己关心的那几个字段。 */
const rowOf = (patch: Partial<LogRow>): LogRow => ({
  id: 'r1',
  fullId: 'r1',
  kind: 'tool',
  ts: 0,
  action: 'Bash',
  summary: 'x',
  status: 'ok',
  tokens: null,
  durationMs: 0,
  turn: 0,
  invokedTools: [],
  leadId: null,
  mergedWith: null,
  panels: [],
  ...patch,
})

describe('buildLogRows', () => {
  it('开场那一对并成一行；其余响应与它发起的那一个工具并成一行', () => {
    const rows = buildLogRows(session())
    // u1+a1 并成开场那一对（它发起的 Bash 因此单独一行）；a2+Agent 并成「想 + 做」一步
    expect(rows.map((r) => r.kind)).toEqual(['llm', 'tool', 'subagent', 'llm', 'wait', 'wait', 'llm'])
    expect(rows.map((r) => r.id)).toEqual([
      'a1',
      'toolu_01Ab3x',
      'toolu_01Rt5N',
      'a3',
      'toolu_01AskU',
      'gap#1',
      'a4',
    ])
    expect(rows[0].mergedWith).toBe('user')
    expect(rows[0].action).toBe('提问 + claude-sonnet-4-5')
    expect(rows[0].summary).toContain('→ Bash')
    // 开场那条响应发起的工具：单独一行，操作列就是工具名
    expect(rows[1].mergedWith).toBeNull()
    expect(rows[1].action).toBe('Bash')
    // 之后的响应与它的工具并成一行：操作列写清是哪两半，完整 ID 不截断（供展开详情与复制用）
    expect(rows[2].mergedWith).toBe('tool')
    expect(rows[2].action).toBe('tool_use + Agent · explore')
    expect(rows[2].fullId).toBe('toolu_01Rt5Nbx00000000')
    // 等用户行不吃这条合并（等的是人，不是这一步的工作量）
    expect(rows[4].action).toBe('AskUserQuestion')
    expect(rows[5].id).toBe('gap#1')
  })

  it('工具记录先于消息写完落盘时，提问仍与它那一轮的响应并成一行', () => {
    // 真形态（本机 40 个大会话里 48 轮如此）：tool_use 块的记录先落盘、工具结果也先回来，
    // 那条消息的收尾记录最后才落盘。于是工具行的时刻早于它所属响应的「答完」时刻，
    // 提问行与响应行之间夹着一个工具行 —— 按相邻两行配对时，这些轮的提问永远是孤行。
    const lines = [
      '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"开始"}}',
      '{"type":"assistant","uuid":"a1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"id":"M1","model":"x","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/a/b.ts"}}],"usage":{}}}',
      '{"type":"user","uuid":"u2","timestamp":"2026-04-24T12:00:02.500Z","sessionId":"m","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}',
      '{"type":"assistant","uuid":"a2","timestamp":"2026-04-24T12:00:03.000Z","sessionId":"m","message":{"id":"M1","model":"x","role":"assistant","content":[{"type":"text","text":"读完了"}],"usage":{}}}',
    ]
    const rows = buildLogRows(parseLines(lines, 'm'))
    expect(rows.map((r) => r.kind)).toEqual(['tool', 'llm'])
    const qa = rows[1]
    expect(qa.mergedWith).toBe('user')
    expect(qa.panels[0].body).toBe('开始')
    // 耗时 = 提问 → 答完。不是模型行的「距上一条事件」（那会只剩 500ms，把提问到开始生成的一段漏掉）
    expect(qa.durationMs).toBe(3_000)
    expect(rowSpan(qa)).toEqual({
      start: Date.parse('2026-04-24T12:00:00.000Z'),
      end: Date.parse('2026-04-24T12:00:03.000Z'),
    })
  })

  it('第一行的耗时从该轮的提问算起，不从文件首条记录算起', () => {
    // 会话文件开头常有一批非对话记录（attachment/快照），它们的时刻远早于第一次提问。
    // 拿它当第一行的起点，会把这中间的全部时间算成「模型第一次思考」。
    const withPreamble = [
      '{"type":"attachment","uuid":"att1","timestamp":"2026-04-24T09:00:00.000Z","sessionId":"m"}',
      '{"type":"file-history-snapshot","uuid":"snap","timestamp":"2026-04-24T09:00:01.000Z","sessionId":"m"}',
      ...lines,
    ]
    const first = buildLogRows(parseLines(withPreamble, 'm'))[0]
    // 第一行是那对问答：12:00:00 提问 → 12:00:01 回复（1 秒），
    // 若错用文件首条记录当起点，这里会变成 09:00 → 12:00 的 3 小时
    expect(first.durationMs).toBe(1_000)
    expect(rowSpan(first)).toEqual({
      start: Date.parse('2026-04-24T12:00:00.000Z'),
      end: Date.parse('2026-04-24T12:00:01.000Z'),
    })
  })

  it('耗时逐类同源：工具=解析器实测、委派=子 agent 区间、模型=距上一条事件、等用户=轮间间隙', () => {
    const rows = buildLogRows(session())
    const ms = Object.fromEntries(rows.map((r) => [r.id, r.durationMs]))
    // 开场那一对 = 提问 → 答完（一次往返），它发起的工具另算一行
    expect(ms['a1']).toBe(1_000) // 提问 → 模型答完
    expect(ms['toolu_01Ab3x']).toBe(10_000) // 11s 结果 − 1s 开跑
    expect(ms['toolu_01Rt5N']).toBe(100_000) // 委派实测区间（「想 0s + 做 100s」）
    expect(ms['a3']).toBe(0) // 紧接委派结束
    expect(ms['toolu_01AskU']).toBe(50_000) // AskUserQuestion 111s → 161s
    expect(ms['gap#1']).toBe(39_000) // 161s → 200s
    expect(ms['a4']).toBe(5_000) // 用户提问 → 回复
    // 串行场景下逐行相加 = 会话总耗时（并行/后台 agent 重叠时会超过，那是刻意的口径），
    // 合并只把两行并一行，和不变
    const sum = rows.reduce((a, r) => a + r.durationMs, 0)
    expect(sum).toBe(205_000)
  })

  it('摘要与操作列取自真实内容：命令/路径/提问/模型名/agent 类型', () => {
    const rows = buildLogRows(session())
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId['toolu_01Ab3x'].summary).toBe('git log --oneline -25')
    expect(byId['toolu_01Rt5N'].summary).toBe('扫描标题提取逻辑')
    expect(byId['toolu_01AskU'].action).toBe('AskUserQuestion')
    expect(byId['toolu_01AskU'].summary).toBe('要继续吗')
    expect(byId['gap#1'].action).toBe('—')
    expect(byId['gap#1'].summary).toBe('等待用户输入（轮间间隙）')
    // 没有合并的模型行：操作列是模型名（去掉日期后缀），摘要 = 发起的工具 + 文本预览
    // （token 不在这里 —— 它有自己的「输入/输出」列，见下面那组用例）
    expect(byId['a3'].action).toBe('claude-sonnet-4-5')
    expect(byId['a3'].summary).toBe('→ AskUserQuestion')
    expect(byId['a4'].summary).toBe('ok')
  })

  it('输入/输出列：模型那半的账跟着行走，输入含缓存读与缓存写', () => {
    const rows = buildLogRows(session())
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    // a4 单独一行：input 12（无缓存）+ output 3
    expect(byId['a4'].tokens).toEqual({ input: 12, output: 3 })
    // 开场那一对（u1 + a1）：账取模型那半 —— 1000 非缓存 + 200 缓存读
    expect(byId['a1'].tokens).toEqual({ input: 1200, output: 40 })
    // 「想 + 做」那一步（a2 + Agent）：同样取模型那半 —— 2000 + 10000 缓存读
    expect(byId['toolu_01Rt5N'].tokens).toEqual({ input: 12_000, output: 300 })
  })

  it('输入/输出列：没有模型那半的行留空（不是 0 —— 那是「调了模型但没花 token」）', () => {
    const rows = buildLogRows(session())
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId['gap#1'].tokens).toBeNull() // 等用户
    expect(byId['toolu_01Ab3x'].tokens).toBeNull() // 开场那对发起的工具：单独一行，没有模型半
    // a3 的 usage 是 {}（合成响应）：有模型半但一个数都没有 → 也没有账
    expect(byId['toolu_01AskU'].tokens).toBeNull()
  })

  it('token 列的写法：紧凑数对；没有账 → 空串（格子留空）', () => {
    expect(fmtRowTokens({ input: 12, output: 3 })).toBe('12 / 3')
    expect(fmtRowTokens({ input: 1200, output: 40 })).toBe('1.2k / 40')
    expect(fmtRowTokens({ input: 1_234_567, output: 5000 })).toBe('1.2M / 5.0k')
    expect(fmtRowTokens(null)).toBe('')
    // 0 是合法读数（就是没读到），照写 —— 与「没有账」不是一回事
    expect(fmtRowTokens({ input: 0, output: 0 })).toBe('0 / 0')
  })

  it('模型响应的 token 账写在 meta 上（展开区没有列头交代单位）', () => {
    const rows = buildLogRows(session())
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId['a4'].panels[1].meta).toBe('in 12 / out 3')
  })

  it('状态：工具看 is_error，等用户行没有成败可言（na）', () => {
    const rows = buildLogRows(session())
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId['toolu_01Ab3x'].status).toBe('ok')
    expect(byId['gap#1'].status).toBe('na')
    expect(byId['a4'].status).toBe('ok')
  })

  it('失败调用带 error 状态，且展开面板里能看到错误输出', () => {
    const errLines = [
      lines[0],
      '{"type":"assistant","uuid":"e1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"toolu_err","name":"Bash","input":{"command":"npm run typecheck"}}],"usage":{}}}',
      '{"type":"user","uuid":"e2","timestamp":"2026-04-24T12:00:05.000Z","sessionId":"m","toolUseResult":{"stdout":"","stderr":"TS2304: 找不到 setImmediate","interrupted":false},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_err","is_error":true,"content":"TS2304"}]}}',
    ]
    const row = buildLogRows(parseLines(errLines, 'm')).find((r) => r.status === 'error')
    expect(row?.panels.find((p) => p.label === '响应 · tool_result')?.body).toContain('TS2304')
  })

  it('开场那一对的展开分两块：提问那半与模型那半各自成组', () => {
    const rows = buildLogRows(session())
    const qa = rows[0]
    expect(qa.mergedWith).toBe('user')
    expect(qa.action).toBe('提问 + claude-sonnet-4-5')
    // 提问那半一块（组名＝提问行的操作名）；a1 带正文（"先看一下 parse.ts"）→ 模型那半一块
    expect(qa.panels.map((p) => p.label)).toEqual(['提问', GROUP_LLM])
    expect(qa.panels.map((p) => p.group)).toEqual(['提问', GROUP_LLM])
    expect(qa.panels[0].body).toBe('开始')
    // 模型那半是分段面板：只有输出那一段（a1 没有思考），且两段各有自己的体量说明
    expect(qa.panels[1].sections?.map((s) => s.title)).toEqual(['输出'])
    expect(sectionsText(qa.panels[1])).toBe('输出\n先看一下 parse.ts')
    // 模型那半带着 token 账（分组名一处定义：GROUP_LLM）
    expect(qa.panels[1].meta).toBe('in 1.2k / out 40')
    // 工具那半不在这一行：它自己一行，请求/响应/运行情况都在那边
    const bash = rows[1]
    expect(bash.mergedWith).toBeNull()
    expect(bash.panels.map((p) => p.label)).toEqual(['请求 · tool_use', '响应 · tool_result', '运行情况'])
    expect(bash.panels.find((p) => p.label === '响应 · tool_result')?.durationMs).toBe(10_000)
    // 「想 + 做」合并行分两块：模型那半与工具那半，组名是工具的操作名
    const delegated = rows[2]
    expect(delegated.mergedWith).toBe('tool')
    expect(delegated.panels.map((p) => p.label)).toEqual(['请求 · tool_use', '响应 · tool_result'])
    // 类型列文字：合并行明说由哪两半组成（徽章、筛选 chip、交给 claude 的记录表共用这一个函数）
    expect(kindLabelOf(qa)).toBe('用户+LLM')
    expect(kindLabelOf(rows[3])).toBe('LLM')
    expect(kindLabelOf(rows[5])).toBe('等用户')
  })

  it('展开面板：工具行给请求/响应/运行情况，模型行给思考/输出，间隙行给区间', () => {
    const rows = buildLogRows(session())
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    // 等用户行（AskUserQuestion 属等用户，永远不并进问答行）
    // AskUserQuestion 没有 cc 自报的运行数据，就没有「运行情况」面板
    expect(byId['toolu_01AskU'].panels.map((p) => p.label)).toEqual(['请求 · tool_use', '响应 · tool_result'])
    expect(byId['toolu_01AskU'].panels[0].body).toContain('"question": "要继续吗"')
    // 这条响应只有 tool_use 块：没文本也没思考 → 模型那半没有面板（展开区只剩上面那行工具信息）
    expect(byId['a3'].panels.map((p) => p.label)).toEqual([])
    // 问答行：提问那半在前；模型那半的正文（思考 + 输出）合成一块面板、各是一段
    expect(byId['a4'].panels.map((p) => p.label)).toEqual(['提问', GROUP_LLM])
    expect(sectionsText(byId['a4'].panels[1])).toBe('输出\nok')
    expect(byId['a4'].panels[1].meta).toBe('in 12 / out 3')
    expect(byId['gap#1'].panels.map((p) => p.label)).toEqual(['等待区间'])
    // 时间按本地时区渲染，只钉形状（时区无关）
    expect(byId['gap#1'].panels[0].meta).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} → \d{2}:\d{2}:\d{2}\.\d{3}$/)
  })

  it('运行情况面板：只报非默认值与体量，正常情况不把默认值念一遍', () => {
    const rows = buildLogRows(session())
    const bash = rows.find((r) => r.id === 'toolu_01Ab3x')
    const panel = bash?.panels.find((p) => p.label === '运行情况')
    expect(panel?.meta).toBe('Bash')
    // 只有 stdout 有内容；没中断就不写「中断 否」，stderr 是空的也不写
    expect(panel?.body).toContain('stdout')
    expect(panel?.body).not.toContain('中断')
    expect(panel?.body).not.toContain('stderr')
    // 响应体量归「响应 · tool_result」的 meta（状态 · 体量），耗时另走 durationMs，不塞进运行情况
    const res = bash?.panels.find((p) => p.label === '响应 · tool_result')
    expect(res?.meta).toBe('ok · 12 字符')
    expect(res?.durationMs).toBe(10_000)
  })

  it('中断/撞上超时上限的工具在运行情况里明说', () => {
    const timedOut = [
      lines[0],
      '{"type":"assistant","uuid":"e1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"x","role":"assistant","content":[{"type":"tool_use","id":"toolu_to","name":"Bash","input":{"command":"sleep 999"}}],"usage":{}}}',
      '{"type":"user","uuid":"e2","timestamp":"2026-04-24T12:00:05.000Z","sessionId":"m","toolUseResult":{"stdout":"partial","stderr":"","interrupted":true,"timedOutAfterMs":120000},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_to","content":"partial"}]}}',
    ]
    const panel = buildLogRows(parseLines(timedOut, 'm'))
      .find((r) => r.id === 'toolu_to')
      ?.panels.find((p) => p.label === '运行情况')
    expect(panel?.body).toContain('已中断')
    expect(panel?.body).toContain('超时上限')
  })

  it('没有 cc 自报数据的工具（如 Read）不产生空的运行情况面板', () => {
    const rows = buildLogRows(session())
    const read = rows.find((r) => r.action === 'Read')
    expect(read?.panels.some((p) => p.label === '运行情况')).not.toBe(true)
  })

  it('模型行带发起的工具名，工具行指回发起它的模型行（视图据此圈成一组）', () => {
    const rows = buildLogRows(session())
    // 没被合并的模型行（AskUserQuestion 属等用户）仍然是组头
    const llm = rows.find((r) => r.id === 'a3')
    expect(llm?.invokedTools).toEqual(['AskUserQuestion'])
    expect(rows.find((r) => r.id === 'toolu_01AskU')?.leadId).toBe(llm?.fullId)
    // 纯文本回复不是组头（它后面没有承接的工具行）
    expect(rows.find((r) => r.id === 'a4')?.invokedTools).toEqual([])
    // 轮间间隙既不是组头也不是组员
    const gap = rows.find((r) => r.id === 'gap#1')
    expect(gap?.invokedTools).toEqual([])
    expect(gap?.leadId).toBeNull()
  })

  it('每行带轮号，模型/工具行属某轮、轮间间隙不属于任何轮', () => {
    const rows = buildLogRows(session())
    expect(rows.find((r) => r.id === 'gap#1')?.turn).toBeNull()
    // 问答行取模型那半的轮号（提问行的轮号本来就与它相同）
    expect(rows.find((r) => r.id === 'a1')?.turn).toBe(0)
    expect(rows.find((r) => r.id === 'toolu_01Ab3x')?.turn).toBe(0)
  })

  it('本轮对账：把 cc 自报的 turn_duration 挂到该轮第一条记录上', () => {
    // 最后一条 assistant 在 205s，cc 紧随其后（100ms）发出该轮的 turn_duration
    const withTd = [
      ...lines,
      '{"type":"system","subtype":"turn_duration","uuid":"s1","timestamp":"2026-04-24T12:03:25.100Z","sessionId":"m","durationMs":5000,"messageCount":9}',
    ]
    const rows = buildLogRows(parseLines(withTd, 'm'))
    const withReconcile = rows.filter((r) => r.panels.some((p) => p.label === '本轮对账 · cc 自报'))
    expect(withReconcile).toHaveLength(1)
    // 挂在第 2 轮的第一条记录上（该轮 = u5 提问 → a4 回复）
    expect(withReconcile[0].id).toBe('a4') // 挂在该轮第一条工作记录上；轮首那条提问行只放提问
    const reconcile = withReconcile[0].panels.find((p) => p.label === '本轮对账 · cc 自报')
    expect(reconcile?.body).toContain('cc 自报      5s')
    expect(reconcile?.body).toContain('本地覆盖')
    expect(reconcile?.body).toContain('轮内等用户')
  })

  it('cc 没记 turn_duration 的会话不出对账面板（不是每轮都有）', () => {
    const s = session()
    s.systemTurnDurations = []
    expect(buildLogRows(s).some((r) => r.panels.some((p) => p.label === '本轮对账 · cc 自报'))).toBe(false)
  })

  it('空会话不炸：没有轮次就没有行', () => {
    expect(buildLogRows(parseLines([], 'm'))).toEqual([])
  })
})

describe('logSummary', () => {
  it('与分解模型同一个口径（不是第二套算法）', () => {
    const s = session()
    // 不是「值相等」而是**同一个对象**：它俩是同一个函数，没有第二套算法可漂
    expect(logSummary(s)).toEqual(breakdownOf(s))
    // 顺带钉住数值：等用户 = 50s 提问等待 + 39s 轮间间隙
    expect(logSummary(s).waitUserMs).toBe(89_000)
    expect(logSummary(s).wallMs).toBe(205_000)
    // 「本地工具」是并集：在这里恰好等于三类之和，但类型上它是独立的一个数（见 breakdownLines）
    expect(logSummary(s)).toHaveProperty('localToolMs')
  })
})

describe('filterLogRows', () => {
  const rows = (): LogRow[] => buildLogRows(session())
  /** 只写关心的那几项，其余走空筛选 —— 新增筛选项时不必改每一条用例 */
  const f = (patch: Partial<LogFilter>): LogFilter => ({ ...EMPTY_LOG_FILTER, ...patch })

  it('类型多选：空 = 不过滤，选了就只留这几类（多选是并集）', () => {
    expect(filterLogRows(rows(), EMPTY_LOG_FILTER)).toHaveLength(7)
    expect(filterLogRows(rows(), f({ kinds: ['subagent'] })).map((r) => r.id)).toEqual(['toolu_01Rt5N'])
    expect(filterLogRows(rows(), f({ kinds: ['wait'] }))).toHaveLength(2)
    // 两类一起选 = 并集（「等用户」本就有两条：AskUserQuestion 工具行 + 轮间间隙行）
    expect(filterLogRows(rows(), f({ kinds: ['subagent', 'wait'] })).map((r) => r.id).sort()).toEqual([
      'gap#1',
      'toolu_01AskU',
      'toolu_01Rt5N',
    ])
    // 五类全选 = 不剩什么可滤的，与不选同一结果（没有「选了全部」这个额外说法）
    expect(filterLogRows(rows(), f({ kinds: LOG_KINDS }))).toHaveLength(7)
  })

  it('状态多选：空 = 不过滤，选了的留下', () => {
    const r = rows()
    expect(filterLogRows(r, f({ statuses: ['ok'] })).every((x) => x.status === 'ok')).toBe(true)
    expect(filterLogRows(r, f({ statuses: ['na'] })).map((x) => x.id)).toContain('gap#1')
    expect(filterLogRows(r, f({ statuses: ['ok', 'na'] }))).toHaveLength(7)
  })

  it('关键词命中记录 ID / 操作 / 摘要，且不分大小写', () => {
    const r = rows()
    expect(filterLogRows(r, f({ query: 'git log' })).map((x) => x.id)).toEqual(['toolu_01Ab3x'])
    expect(filterLogRows(r, f({ query: 'AGENT · EXPLORE' })).map((x) => x.id)).toEqual(['toolu_01Rt5N'])
    expect(filterLogRows(r, f({ query: 'toolu_01AskU' })).map((x) => x.id)).toEqual(['toolu_01AskU'])
    expect(filterLogRows(r, f({ query: '   ' }))).toHaveLength(7)
    expect(filterLogRows(r, f({ query: '不存在的词' }))).toEqual([])
  })

  it('条件叠加', () => {
    const r = rows()
    // 三条 llm 行（两条开场那一对 + a3 这条未合并的响应）的操作列都带模型名
    // （「想 + 做」合并行的操作列写的是 `tool_use + Agent · explore`）
    expect(filterLogRows(r, f({ kinds: ['llm'], query: 'claude' }))).toHaveLength(3)
    // 本 fixture 里每个提问都与它的响应并成了一行 → 没有独立的「用户」行
    // （独立用户行只在没有响应的提问、打断标记那类场景里出现，见下面的用例）
    expect(filterLogRows(r, f({ kinds: ['user'] }))).toEqual([])
    expect(filterLogRows(r, f({ kinds: ['llm'], statuses: ['na'] }))).toEqual([])
  })
})

describe('耗时筛选', () => {
  const q = (patch: Partial<DurationQuery>): DurationQuery => ({ op: 'gt', a: '', b: '', unit: 's', ...patch })

  it('默认状态：高于 + 空阈值 + 单位秒（进视图不该自带任何过滤）', () => {
    expect(EMPTY_DURATION_QUERY).toEqual({ op: 'gt', a: '', b: '', unit: 's' })
    expect(durationBounds(EMPTY_DURATION_QUERY)).toEqual({ minMs: null, maxMs: null })
  })

  it('三种模式换算成毫秒边界：高于取 a、低于取 a、区间取 a/b', () => {
    expect(durationBounds(q({ op: 'gt', a: '1.5' }))).toEqual({ minMs: 1500, maxMs: null })
    expect(durationBounds(q({ op: 'lt', a: '60' }))).toEqual({ minMs: null, maxMs: 60_000 })
    expect(durationBounds(q({ op: 'between', a: '1.5', b: '60' }))).toEqual({ minMs: 1500, maxMs: 60_000 })
  })

  it('单位决定换算：ms / s / m 是同一根轴（与耗时列的量级档共用）', () => {
    expect(durationBounds(q({ a: '200', unit: 'ms' }))).toEqual({ minMs: 200, maxMs: null })
    expect(durationBounds(q({ a: '200', unit: 's' }))).toEqual({ minMs: 200_000, maxMs: null })
    expect(durationBounds(q({ a: '2', unit: 'm' }))).toEqual({ minMs: 120_000, maxMs: null })
  })

  it('空串 / 非数字 / 负数 = 没填（筛选框没有提交按钮，敲到一半的非法值不该报错也不该乱过滤）', () => {
    for (const bad of ['', '   ', 'abc', '-1', '1.2.3', 'NaN']) {
      expect(durationBounds(q({ a: bad }))).toEqual({ minMs: null, maxMs: null })
    }
  })

  it('区间写反了自动对调；只填一边就是单边', () => {
    expect(durationBounds(q({ op: 'between', a: '60', b: '1.5' }))).toEqual({ minMs: 1500, maxMs: 60_000 })
    expect(durationBounds(q({ op: 'between', a: '1.5', b: '' }))).toEqual({ minMs: 1500, maxMs: null })
    expect(durationBounds(q({ op: 'between', a: '', b: '60' }))).toEqual({ minMs: null, maxMs: 60_000 })
  })

  it('切换操作符时阈值搬到保持原意的字段（不然「低于 60」变成「高于 60」）', () => {
    const lt = q({ op: 'lt', a: '60' })
    expect(withDurationOp(lt, 'between')).toEqual({ op: 'between', a: '', b: '60', unit: 's' })
    expect(withDurationOp(q({ op: 'between', a: '1.5', b: '60' }), 'lt')).toEqual({ op: 'lt', a: '60', b: '60', unit: 's' })
    // 高于 ⇄ 区间：a 本来就是这个阈值（区间时是下限），原地不动
    expect(withDurationOp(q({ op: 'gt', a: '1.5' }), 'between')).toEqual({ op: 'between', a: '1.5', b: '', unit: 's' })
    expect(withDurationOp(q({ op: 'between', a: '1.5', b: '60' }), 'gt')).toEqual({ op: 'gt', a: '1.5', b: '60', unit: 's' })
    // 点回同一个模式：原样返回，不产生新对象（避免多余渲染）
    const same = q({ op: 'lt', a: '60' })
    expect(withDurationOp(same, 'lt')).toBe(same)
  })

  it('过滤含边界：高于 10s 留下整整 10s 那条，且 0 耗时行不算「高于」', () => {
    const rows = buildLogRows(session())
    const ids = (patch: Partial<LogFilter>): string[] =>
      filterLogRows(rows, { ...EMPTY_LOG_FILTER, ...patch }).map((r) => r.id)
    expect(ids({ duration: { minMs: 10_000, maxMs: null } })).toEqual([
      'toolu_01Ab3x',
      'toolu_01Rt5N',
      'toolu_01AskU',
      'gap#1',
    ])
    expect(ids({ duration: { minMs: null, maxMs: 5000 } })).toEqual(['a1', 'a3', 'a4'])
    expect(ids({ duration: { minMs: 5000, maxMs: 50_000 } })).toEqual([
      'toolu_01Ab3x',
      'toolu_01AskU',
      'gap#1',
      'a4',
    ])
    expect(ids({ duration: { minMs: 200_000, maxMs: null } })).toEqual([])
  })

  it('与其它条件叠加', () => {
    const rows = buildLogRows(session())
    expect(
      filterLogRows(rows, {
        ...EMPTY_LOG_FILTER,
        kinds: ['tool'],
        duration: { minMs: 5000, maxMs: null },
      }).map((r) => r.id),
    ).toEqual(['toolu_01Ab3x'])
  })
})

describe('describeLogFilter', () => {
  const rows = (): LogRow[] => buildLogRows(session())
  const label = (patch: Partial<LogFilter>): string =>
    describeLogFilter({ ...EMPTY_LOG_FILTER, ...patch })

  it('一条都没设时说明是「未筛选」，而不是空串', () => {
    expect(label({})).toBe(UNFILTERED_LABEL)
    // 搜索框里只有空格同样算没填（与 filterLogRows 的 trim 口径一致）
    expect(label({ query: '   ' })).toBe(UNFILTERED_LABEL)
  })

  it('类型与状态用界面上的叫法，不是机器读的 kind/status', () => {
    expect(label({ kinds: ['tool', 'llm'], statuses: ['error'] })).toBe('类型=工具,LLM；状态=失败')
    // 「没跑完」也是筛选维的合法取值（虽然筛选 chip 不提供这一项）
    expect(label({ statuses: ['na'] })).toBe('状态=未跑完')
  })

  it('耗时阈值按填的数值反格式化，关键词原样引起来', () => {
    expect(label({ duration: { minMs: 5_000, maxMs: null } })).toBe('耗时≥5.00s')
    expect(label({ duration: { minMs: null, maxMs: 120_000 } })).toBe('耗时≤2m0s')
    expect(label({ query: 'pytest' })).toBe('关键词「pytest」')
  })

  it('时间选区带上两个端点，多条件是分号连起来的一句', () => {
    const ts = session().startedAt!
    const text = label({
      kinds: ['tool'],
      query: 'pytest',
      window: { start: ts, end: ts + 1_000 },
    })
    expect(text).toMatch(/^类型=工具；关键词「pytest」；时间选区 \d{2}:\d{2}:\d{2}\.\d{3}~\d{2}:\d{2}:\d{2}\.\d{3}$/)
  })

  it('关键词里的换行被压平：这句话要拼进 digest 的一行里，带换行就把那行拆成两行', () => {
    expect(label({ query: 'a|b\nc' })).toBe('关键词「a|b c」')
  })

  it('筛选后一条都不剩时也照样说得出来（说明来自条件，不来自结果）', () => {
    const empty = filterLogRows(rows(), { ...EMPTY_LOG_FILTER, statuses: ['error'] })
    expect(empty).toHaveLength(0)
    expect(label({ statuses: ['error'] })).toBe('状态=失败')
  })
})

describe('logSpanLabel', () => {
  const at = (h: number, m: number): number => new Date(2026, 0, 2, h, m, 0, 0).getTime()

  it('取这批记录的首尾，不是会话首尾', () => {
    const rows = [
      rowOf({ ts: at(12, 0), durationMs: 60_000 }),
      rowOf({ ts: at(10, 0), durationMs: 30_000 }),
    ]
    expect(logSpanLabel(rows)).toBe('01-02 10:00 ~ 01-02 12:01')
  })

  it('结束时刻按「开始 + 耗时」算：跑得久的记录把范围撑到它真正结束的那一刻', () => {
    expect(logSpanLabel([rowOf({ ts: at(10, 0), durationMs: 5 * 60_000 })])).toBe('01-02 10:00 ~ 01-02 10:05')
  })

  it('一条都没有时明说没有，不返回一个假区间', () => {
    expect(logSpanLabel([])).toBe('(无记录)')
  })
})

describe('日志视图的配色与标签', () => {
  it('耗时列量级配色：三档齐全，且复用的是既有类别变量而不是新色号', () => {
    expect(Object.keys(DURATION_SCALE_COLOR).sort()).toEqual(['m', 'ms', 's'])
    expect(DURATION_SCALE_COLOR.ms).toBe('var(--text-tertiary)')
    expect(DURATION_SCALE_COLOR.s).toBe('var(--cat-direct)')
    expect(DURATION_SCALE_COLOR.m).toBe('var(--cat-delegated)')
  })

  it('类别标签与配色集中一处（徽章/筛选 chip/占比条都读它）', () => {
    expect(Object.values(LOG_KIND_STYLE).map((s) => s.label)).toEqual([
      'LLM', '工具', 'Agent', 'workflow', '等用户', '用户',
    ])
    expect(LOG_KIND_STYLE.llm.color).toBe('var(--cat-compute)')
    expect(LOG_KIND_STYLE.llm.soft).toBe('var(--cat-compute-soft)')
  })

  it('状态标签三态齐全（筛选 chip 取前两项，交给 claude 的记录表写全）', () => {
    expect(LOG_STATUS_LABEL).toEqual({ ok: '成功', error: '失败', na: '未跑完' })
  })
})

describe('buildTimeline — 时间栏', () => {
  it('位置与宽度按整段时长归一化，第一块落在 0', () => {
    const rows = buildLogRows(session())
    const blocks = buildTimeline(rows)
    expect(blocks).toHaveLength(rows.length)
    expect(blocks[0].start).toBe(0)
    // 第一块是问答行（提问 0s → 答完 1s），全会话 205s
    expect(blocks[0].width).toBeCloseTo(1_000 / 205_000, 9)
    expect(blocks[1].width).toBeCloseTo(10_000 / 205_000, 9) // 紧接着的 Bash 执行
    expect(blocks.every((b) => b.start >= 0 && b.start <= 1)).toBe(true)
    expect(blocks.every((b) => b.width >= 0 && b.start + b.width <= 1 + 1e-9)).toBe(true)
  })

  it('没有记录就没有时间栏', () => {
    expect(buildTimeline([])).toEqual([])
  })

  it('所有记录挤在同一刻也不出 NaN', () => {
    const [b] = buildTimeline([rowOf({ ts: 1000, durationMs: 0 })])
    expect(b.start).toBe(0)
    expect(Number.isNaN(b.width)).toBe(false)
    expect(b.width).toBe(0)
  })

  it('耗时轻重：最长的那条 = 1，短的仍有可见高度（对数刻度）', () => {
    const blocks = buildTimeline([
      rowOf({ id: 'short', fullId: 'short', ts: 0, durationMs: 100 }),
      rowOf({ id: 'long', fullId: 'long', ts: 100, durationMs: 100_000 }),
    ])
    const short = blocks.find((b) => b.id === 'short')
    const long = blocks.find((b) => b.id === 'long')
    expect(long?.intensity).toBeCloseTo(1, 9)
    expect(short?.intensity).toBeLessThan(long?.intensity ?? 0)
    // 线性刻度下 100ms / 100s 只有 0.001，看着像没有活动
    expect(short?.intensity).toBeGreaterThan(0.3)
  })

  it('耗时为 0 的行不占高度', () => {
    expect(buildTimeline([rowOf({ durationMs: 0 })])[0].intensity).toBe(0)
  })

  it('每块带类别色与悬停文案（时刻 · 类型 · 耗时 · 动作）', () => {
    const rows = buildLogRows(session())
    const blocks = buildTimeline(rows)
    const toolBlock = blocks.find((b) => b.color === LOG_KIND_STYLE.tool.color)
    expect(toolBlock?.label).toContain('工具')
    expect(toolBlock?.label).toContain('Bash')
    expect(toolBlock?.id).toBe(rows.find((r) => r.kind === 'tool')?.fullId)
    // 问答行的悬停文案走 kindLabelOf：与徽章同一句话（不写「LLM」）
    const qaBlock = blocks.find((b) => b.color === LOG_KIND_STYLE.llm.color)
    expect(qaBlock?.label).toContain('用户+LLM')
  })
})

describe('耗时排序 — 耗时列表头', () => {
  const three = (): LogRow[] => [
    rowOf({ id: 'a', fullId: 'a', ts: 0, durationMs: 5_000 }),
    rowOf({ id: 'b', fullId: 'b', ts: 1_000, durationMs: 60_000 }),
    rowOf({ id: 'c', fullId: 'c', ts: 2_000, durationMs: 200 }),
  ]

  it('三档：正常＝原序（连引用都不换）、倒序＝大到小、正序＝小到大', () => {
    const rows = three()
    // 引用不变 → 视图那层的 memo 不必重建
    expect(sortLogRows(rows, 'normal')).toBe(rows)
    expect(sortLogRows(rows, 'desc').map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(sortLogRows(rows, 'asc').map((r) => r.id)).toEqual(['c', 'a', 'b'])
  })

  it('只动次序：行对象一个不换、一个不改（行组件 memo 因此不必重算正文）', () => {
    const rows = three()
    const sorted = sortLogRows(rows, 'desc')
    expect(sorted).toHaveLength(rows.length)
    expect(sorted.every((r) => rows.includes(r))).toBe(true)
  })

  it('耗时相同保持原有时序：同样慢的两条仍按发生的先后读', () => {
    const rows = [
      rowOf({ id: '早', fullId: '早', ts: 0, durationMs: 1_000 }),
      rowOf({ id: '晚', fullId: '晚', ts: 9_000, durationMs: 1_000 }),
    ]
    expect(sortLogRows(rows, 'desc').map((r) => r.id)).toEqual(['早', '晚'])
    expect(sortLogRows(rows, 'asc').map((r) => r.id)).toEqual(['早', '晚'])
  })

  it('排的是耗时列显示的那个数：问答行按「提问 → 答完」排', () => {
    const rows = buildLogRows(session())
    const sorted = sortLogRows(rows, 'desc')
    // 本 fixture 最慢的是委派那步（100s），开场那一对是提问 0s → 答完 1s
    expect(rows.find((r) => r.mergedWith === 'user')?.durationMs).toBe(1_000)
    expect(sorted.map((r) => r.durationMs)).toEqual([...rows.map((r) => r.durationMs)].sort((a, b) => b - a))
  })

  it('点表头循环切换：正常 → 倒序 → 正序 → 正常', () => {
    expect(nextDurationSort('normal')).toBe('desc')
    expect(nextDurationSort('desc')).toBe('asc')
    expect(nextDurationSort('asc')).toBe('normal')
  })

  it('档位定义自洽：三档齐全、各有名字与箭头；查不到的档回退原序', () => {
    expect(DURATION_SORTS.map((o) => o.value)).toEqual(['normal', 'desc', 'asc'])
    expect(DURATION_SORTS.every((o) => o.label.length > 0 && o.indicator.length > 0)).toBe(true)
    expect(durationSortOption('normal').label).toBe('正常')
  })

  it('时间栏只在原序下成立：按耗时重排后，横轴（时刻）已经对不上列表', () => {
    expect(durationSortOption('normal').keepsTimeline).toBe(true)
    expect(DURATION_SORTS.filter((o) => o.value !== 'normal').every((o) => !o.keepsTimeline)).toBe(true)
  })
})

/**
 * 一条 API 消息在 jsonl 里是多条记录（共享 `message.id`），解析时已合回一条（见 types.ts::AssistantMsg）。
 * 这里钉住它对**行**的影响：模型的这一条响应就是一行，思考/正文/工具都在这一行的展开里。
 */
describe('buildLogRows — 一条模型响应 = 一行', () => {
  const lines = [
    '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"开始"}}',
    '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"id":"M1","model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"thinking","thinking":"先想一下"}],"usage":{}}}',
    '{"type":"assistant","uuid":"a2","parentUuid":"a1","timestamp":"2026-04-24T12:00:03.000Z","sessionId":"m","message":{"id":"M1","model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"text","text":"答案是 42"}],"usage":{"output_tokens":9}}}',
    '{"type":"user","uuid":"u2","parentUuid":"a2","timestamp":"2026-04-24T12:01:00.000Z","sessionId":"m","message":{"role":"user","content":"看看文件"}}',
    '{"type":"assistant","uuid":"b1","parentUuid":"u2","timestamp":"2026-04-24T12:01:01.000Z","sessionId":"m","message":{"id":"M2","model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"thinking","thinking":"先列目录"}],"usage":{}}}',
    '{"type":"assistant","uuid":"b2","parentUuid":"b1","timestamp":"2026-04-24T12:01:02.000Z","sessionId":"m","message":{"id":"M2","model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}],"usage":{"output_tokens":12}}}',
    '{"type":"user","uuid":"u3","parentUuid":"b2","timestamp":"2026-04-24T12:01:04.000Z","sessionId":"m","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"a.ts b.ts"}]}}',
  ]

  it('思考与正文在同一行、同一块面板：展开同时看得到「思考」和「输出」', () => {
    const rows = buildLogRows(parseLines(lines, 'm'))
    // M1 的两条记录（思考 / 正文）合成一条消息 → 一行问答；本 fixture 两轮 → 两条问答行
    const llm = rows.filter((r) => r.kind === 'llm')
    expect(llm).toHaveLength(2)
    expect(llm[0].panels.map((p) => p.label)).toEqual(['提问', GROUP_LLM])
    // 一块面板里两段各自成块（各滚各的），顺序是思考 → 输出
    expect(llm[0].panels[1].sections?.map((s) => s.title)).toEqual(['思考', '输出'])
    expect(sectionsText(llm[0].panels[1])).toBe('思考\n先想一下\n\n输出\n答案是 42')
    expect(llm[0].summary).toContain('答案是 42')
  })

  it('「想 + 做」：第二条响应与它发起的工具并成一行，思考跟着走', () => {
    // 一轮里两条响应：第一条归开场那一对（它发起的工具单独一行），第二条起才并「想 + 做」
    const lines = [
      '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"开始"}}',
      '{"type":"assistant","uuid":"a1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"id":"M1","model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"text","text":"先看看文件"}],"usage":{}}}',
      '{"type":"assistant","uuid":"a2","timestamp":"2026-04-24T12:00:03.000Z","sessionId":"m","message":{"id":"M2","model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"thinking","thinking":"先列目录"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}],"usage":{}}}',
      '{"type":"user","uuid":"u2","timestamp":"2026-04-24T12:00:05.000Z","sessionId":"m","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"a.ts b.ts"}]}}',
    ]
    const rows = buildLogRows(parseLines(lines, 'm'))
    expect(rows.map((r) => r.mergedWith)).toEqual(['user', 'tool'])
    const merged = rows[1]
    expect(merged.action).toBe('tool_use + Bash')
    expect(merged.kind).toBe('tool')
    // 模型那半与工具那半各成一组：思考在模型那半里
    expect(sectionsText(merged.panels[0])).toBe('思考\n先列目录')
    expect(merged.panels.some((p) => p.group === 'Bash')).toBe(true)
    // 这一步 = 想（12:00:01 → 写完 12:00:03）∪ 做（12:00:03 → 结果 12:00:05）
    expect(merged.durationMs).toBe(4_000)
    expect(rowSpan(merged)).toEqual({
      start: Date.parse('2026-04-24T12:00:01.000Z'),
      end: Date.parse('2026-04-24T12:00:05.000Z'),
    })
    // 类型列：直连工具的「想 + 做」写 LLM+工具（委派那一类写 Agent，见类型列文案那组用例）
    expect(kindLabelOf(merged)).toBe('LLM+工具')
  })
})

/** 会话起始时刻（fixture 全部用 UTC，相对它算偏移更好读） */
const BASE = Date.parse('2026-04-24T12:00:00.000Z')

describe('rowSpan — 一行占哪一段时间', () => {
  it('模型行是「生成完的时刻往前推 durationMs」', () => {
    expect(rowSpan(rowOf({ kind: 'llm', ts: 5000, durationMs: 2000 }))).toEqual({ start: 3000, end: 5000 })
  })

  it('其余行是「本行时刻起这么长」', () => {
    expect(rowSpan(rowOf({ ts: 1000, durationMs: 400 }))).toEqual({ start: 1000, end: 1400 })
  })

  it('零耗时行退化成一点', () => {
    expect(rowSpan(rowOf({ kind: 'user', ts: 800, durationMs: 0 }))).toEqual({ start: 800, end: 800 })
  })

  it('问答行 = 提问 → 答完：起点落在提问那一刻，比它发起的工具还早', () => {
    const parsed = session()
    const merged = buildLogRows(parsed).find((r) => r.mergedWith === 'user')
    const span = rowSpan(merged!)
    // 0s~1s：提问 → 模型答完（那 10s 的 Bash 执行是紧接着的下一行）
    expect(span).toEqual({ start: BASE, end: BASE + 1_000 })
    expect(span.start).toBe(parsed.turns[0].userMsg?.ts)
    expect(span.start).toBeLessThan(parsed.turns[0].toolCalls[0].tsStart)
  })
})

describe('timeAxisOf / axisPos / axisForWindow — 时间标尺', () => {
  const axisOfSession = (): ReturnType<typeof timeAxisOf> => timeAxisOf(buildLogRows(session()))

  it('从全部行算：最早起点、总跨度、最长耗时', () => {
    expect(axisOfSession()).toEqual({ lo: BASE, total: 205_000, maxDurationMs: 100_000 })
  })

  it('空数组也给安全值（默认参数在空数组时照样求值，函数体里的早退保不住它）', () => {
    expect(timeAxisOf([])).toEqual({ lo: 0, total: 1, maxDurationMs: 1 })
    expect(buildTimeline([])).toEqual([])
  })

  it('位置归一化到 0~1，越界夹在两头（不出负值也不出 >1）', () => {
    const axis = { lo: 1000, total: 1000, maxDurationMs: 1 }
    expect(axisPos(axis, 1000)).toBe(0)
    expect(axisPos(axis, 1500)).toBe(0.5)
    expect(axisPos(axis, 2000)).toBe(1)
    expect(axisPos(axis, 0)).toBe(0)
    expect(axisPos(axis, 99_999)).toBe(1)
  })

  it('waterfall 的轴：有选区就放大到选区，没有就整条时间轴', () => {
    const axis = axisOfSession()
    expect(axisForWindow(axis, null)).toBe(axis)
    const zoomed = axisForWindow(axis, { start: BASE + 111_000, end: BASE + 161_000 })
    expect(zoomed).toEqual({ lo: BASE + 111_000, total: 50_000, maxDurationMs: 100_000 })
    // 退化区间（两端同刻）不放大，退回整条轴 —— 否则后面的除法会归零
    expect(axisForWindow(axis, { start: BASE, end: BASE })).toBe(axis)
  })
})

describe('intersectsWindow / logBoundaries — 时间选区', () => {
  const w = { start: 1000, end: 2000 }

  it('双闭：端点上的记录算在内（不然刚吸附上来的那条会被自己排除掉）', () => {
    expect(intersectsWindow({ start: 1000, end: 1500 }, w)).toBe(true)
    expect(intersectsWindow({ start: 1500, end: 2000 }, w)).toBe(true)
    expect(intersectsWindow({ start: 500, end: 1000 }, w)).toBe(true)
    expect(intersectsWindow({ start: 2000, end: 3000 }, w)).toBe(true)
    expect(intersectsWindow({ start: 500, end: 999 }, w)).toBe(false)
    expect(intersectsWindow({ start: 2001, end: 3000 }, w)).toBe(false)
  })

  it('零耗时行退化成「点落在区间内」', () => {
    expect(intersectsWindow({ start: 1000, end: 1000 }, w)).toBe(true)
    expect(intersectsWindow({ start: 1001, end: 1001 }, w)).toBe(true)
    expect(intersectsWindow({ start: 2000, end: 2000 }, w)).toBe(true)
    expect(intersectsWindow({ start: 999, end: 999 }, w)).toBe(false)
    expect(intersectsWindow({ start: 2001, end: 2001 }, w)).toBe(false)
  })

  it('没有选区时不滤任何东西', () => {
    expect(intersectsWindow({ start: 5, end: 5 }, null)).toBe(true)
  })

  it('边界是全部记录的起止时刻，升序去重', () => {
    const bs = logBoundaries(buildLogRows(session())).map((b) => b - BASE)
    expect(bs).toEqual([0, 1_000, 11_000, 111_000, 161_000, 200_000, 205_000])
  })
})

describe('时间选区 — 筛选', () => {
  const rows = (): LogRow[] => buildLogRows(session())
  const f = (patch: Partial<LogFilter>): LogFilter => ({ ...EMPTY_LOG_FILTER, ...patch })

  it('只留与选区相交的行', () => {
    // 15s~110s：Bash 那步（1s~11s）已经结束，Agent 那步（11s~111s）横跨进来
    const win = { start: BASE + 15_000, end: BASE + 110_000 }
    expect(filterLogRows(rows(), f({ window: win })).map((r) => r.id)).toEqual(['toolu_01Rt5N'])
  })

  it('端点上的相邻记录算在内：选中 [11s, 15s] 时 11s 收尾的 Bash 与 11s 起手的委派步都在', () => {
    const win = { start: BASE + 11_000, end: BASE + 15_000 }
    expect(filterLogRows(rows(), f({ window: win })).map((r) => r.id)).toEqual([
      'toolu_01Ab3x',
      'toolu_01Rt5N',
    ])
  })

  it('两端贴边的都算：161s 收尾的等用户、161s~200s 的间隙、200s 起手的问答行', () => {
    const win = { start: BASE + 161_000, end: BASE + 200_000 }
    expect(filterLogRows(rows(), f({ window: win })).map((r) => r.id)).toEqual([
      'toolu_01AskU',
      'gap#1',
      'a4',
    ])
  })

  it('空选区 = 不过滤；与其它条件叠加', () => {
    const all = { start: BASE - 1000, end: BASE + 999_999 }
    expect(filterLogRows(rows(), f({ window: null }))).toHaveLength(7)
    expect(filterLogRows(rows(), f({ window: all }))).toHaveLength(7)
    // 三条 llm 行都在：两条开场那一对 + a3 这条未合并的响应
    expect(filterLogRows(rows(), f({ window: all, kinds: ['llm'] }))).toHaveLength(3)
  })
})

describe('buildTimeline — 显式轴与选区', () => {
  it('显式轴：位置按传入的轴算，不按自己这批行的范围（筛完之后块仍停在真实时刻）', () => {
    const all = buildLogRows(session())
    const axis = timeAxisOf(all)
    const subset = all.filter((r) => r.id === 'gap#1') // 161s~200s
    const [block] = buildTimeline(subset, axis)
    expect(block.start).toBeCloseTo(161_000 / 205_000, 9)
    expect(block.width).toBeCloseTo(39_000 / 205_000, 9)
    // 按这批行自己的轴来算，它会被铺满整条轨道 —— 那正是「敲一个搜索字符整条时间栏横移」的原因
    const [own] = buildTimeline(subset)
    expect(own.start).toBe(0)
    expect(own.width).toBe(1)
  })

  it('强度分母锚在轴上（全部行）：筛到只剩短记录时高度仍可比', () => {
    const all = buildLogRows(session())
    const axis = timeAxisOf(all)
    const short = all.filter((r) => r.id === 'toolu_01Ab3x') // 11s，会话最长的是 100s
    expect(buildTimeline(short, axis)[0].intensity).toBeLessThan(1)
    // 按这批行自己算分母时，它就成了「最长的那条」= 满高
    expect(buildTimeline(short)[0].intensity).toBe(1)
  })

  it('选区外的块标 dimmed，位置一格不动（变暗不是位移）', () => {
    const all = buildLogRows(session())
    const axis = timeAxisOf(all)
    const win = { start: BASE + 15_000, end: BASE + 110_000 }
    const blocks = buildTimeline(all, axis, win)
    // 只有横跨这个区间的委派那步留在选区里
    expect(blocks.map((b) => b.dimmed)).toEqual([true, true, false, true, true, true, true])
    expect(blocks.map((b) => [b.start, b.width])).toEqual(buildTimeline(all, axis).map((b) => [b.start, b.width]))
  })
})

describe('类型列文案 — 一个文案只对应一个颜色', () => {
  it('文案与操作列的用词集中一处（徽章、筛选 chip、交给 claude 的记录表、悬停都读它）', () => {
    expect(USER_LLM_KIND_LABEL).toBe('用户+LLM')
    expect(USER_ASK_LABEL).toBe('提问')
    expect(USER_INTERRUPT_LABEL).toBe('用户打断')
  })

  it('问答行写「用户+LLM」，其余行写自己类别的文案', () => {
    const rows = buildLogRows(session())
    expect(rows[0].mergedWith).toBe('user')
    expect(kindLabelOf(rows[0])).toBe(USER_LLM_KIND_LABEL)
    // 同一个 kind 的两个文案各自只对一个颜色：未合并的模型行仍是 LLM（rows[3] 是 a3）
    expect(kindLabelOf(rows[3])).toBe('LLM')
    expect(kindLabelOf(rowOf({ kind: 'subagent' }))).toBe('Agent')
    expect(kindLabelOf(rowOf({ kind: 'wait' }))).toBe('等用户')
    expect(kindLabelOf(rowOf({ kind: 'user' }))).toBe('用户')
  })

  it('全部行按文案聚色，每个文案只有一个颜色', () => {
    // 颜色取自 LOG_KIND_STYLE[row.kind]（徽章、筛选 chip、占比条、时间栏块、waterfall 条都是它）——
    // 若某个文案落到两个颜色上，界面上就会出现「同一个类型忽蓝忽橙」，看着像按耗时变色
    const byLabel = new Map<string, Set<string>>()
    for (const r of buildLogRows(session())) {
      const label = kindLabelOf(r)
      const colors = byLabel.get(label) ?? new Set<string>()
      colors.add(LOG_KIND_STYLE[r.kind].color)
      byLabel.set(label, colors)
    }
    // 这一轮 fixture 的五类文案：四条 llm 行里两条是合并行（用户+LLM），两条是未合并的响应（LLM）
    expect([...byLabel.keys()]).toHaveLength(5)
    for (const label of [USER_LLM_KIND_LABEL, 'LLM', '工具', 'Agent', '等用户']) {
      expect(`${label}:${byLabel.has(label)}`).toBe(`${label}:true`)
    }
    for (const [label, colors] of byLabel) expect(`${label}:${colors.size}`).toBe(`${label}:1`)
    // 委派行仍是委派色（没有被改去和直连工具撞色）
    expect(LOG_KIND_STYLE.subagent.color).toBe('var(--cat-delegated)')
  })
})

describe('委派行 — 面板与子会话', () => {
  it('只留两块输入输出：运行情况与模型那半的思考/输出都不给', () => {
    const rows = buildLogRows(session())
    const delegated = rows.find((r) => r.kind === 'subagent') as LogRow
    expect(delegated.mergedWith).toBe('tool') // 模型那半 + Agent 并成「想 + 做」一行
    expect(delegated.panels.map((p) => p.label)).toEqual(['请求 · tool_use', '响应 · tool_result'])
    // 只剩一组就不分组：视图按 group 画分组标题，一个组名只会多占一行
    expect(delegated.panels.every((p) => p.group === undefined)).toBe(true)
    // cc 自报的那几个数（耗时/token/工具次数）在子 agent 的记录里，这里不再抄一遍
    expect(delegated.panels.some((p) => p.label === '运行情况')).toBe(false)
    // 发起它的模型那半留在上面那条问答行上（分组名一处定义：GROUP_LLM）
    expect(rows[0].panels.some((p) => p.group === GROUP_LLM)).toBe(true)
  })

  it('委派行带上子会话引用（视图展开时据此钻进去），其余行不带', () => {
    const s = session()
    const agentCall = s.turns[0].toolCalls.find((tc) => tc.name === 'Agent')
    expect(agentCall).toBeDefined()
    const child = parseLines(
      ['{"type":"user","uuid":"c1","timestamp":"2026-04-24T12:00:11.000Z","sessionId":"child","message":{"role":"user","content":"干点活"}}'],
      'child',
    )
    agentCall!.childSession = child
    const rows = buildLogRows(s)
    const delegated = rows.find((r) => r.fullId === agentCall!.toolUseId)
    // 带上的是同一个对象（只带引用、不在 core 里摊开它的记录）
    expect(delegated?.childSession).toBe(child)
    expect(rows.filter((r) => r.kind !== 'subagent').every((r) => r.childSession === undefined)).toBe(true)
  })
})

/**
 * 打断标记：用户按 Esc 时 cc 落的那条记录，正文就是标记本身（见 `UserMsg.isInterrupt`）。
 * 它不是用户说的话，因此操作列不能说「提问」——那是把标记当成了一次真提问。
 */
describe('打断标记 — 用户打断', () => {
  const userLine = '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"开始"}}'
  const replyLine = '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"text","text":"正在看"}],"usage":{}}}'
  /** 提问 → 回复 →（标记正文的）user 记录 */
  const withMarker = (text: string): string[] => [
    userLine,
    replyLine,
    `{"type":"user","uuid":"u2","timestamp":"2026-04-24T12:00:05.000Z","sessionId":"m","message":{"role":"user","content":${JSON.stringify(text)}}}`,
  ]

  it('整条正文就是标记 → 操作列写「用户打断」，摘要仍是标记原文', () => {
    for (const marker of ['[Request interrupted by user]', '[Request interrupted by user for tool use]']) {
      const rows = buildLogRows(parseLines(withMarker(marker), 'm'))
      const row = rows[rows.length - 1]
      expect(row.kind).toBe('user') // 类别不变：配色、筛选 chip 都不动
      expect(row.action).toBe(USER_INTERRUPT_LABEL)
      expect(row.panels.map((p) => p.label)).toEqual([USER_INTERRUPT_LABEL])
      expect(row.summary).toBe(marker)
      expect(row.durationMs).toBe(0) // 提问不占时间，打断标记同样不占
    }
  })

  it('标记那一轮没有响应 → 不与上一条响应合并，它自己一行', () => {
    const rows = buildLogRows(parseLines(withMarker('[Request interrupted by user]'), 'm'))
    // 问答行、轮间间隙、打断行
    expect(rows.map((r) => r.id)).toEqual(['a1', 'gap#1', 'u2'])
    expect(rows[0].mergedWith).toBe('user')
    expect(rows[2].mergedWith).toBeNull()
    expect(kindLabelOf(rows[2])).toBe('用户')
  })

  it('正文里夹着标记的长消息仍是提问（cc 会把标记拼进用户的下一条消息）', () => {
    // 本工具开发过程中的真实形态：标记只是这条消息里的一段，用户的话在它前后
    const text = '1、[Request interrupted by user]操作是 用户打断\n\n2、下一件事'
    const rows = buildLogRows(parseLines(withMarker(text), 'm'))
    const row = rows[rows.length - 1]
    expect(row.action).toBe(USER_ASK_LABEL)
    expect(row.panels[0].body).toContain('2、下一件事')
  })

  it('标记那一轮若真有响应（cc 用 synthetic 回一句），问答行的操作列跟着标记走', () => {
    const lines = [
      ...withMarker('[Request interrupted by user]'),
      '{"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"2026-04-24T12:00:06.000Z","sessionId":"m","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"No response requested."}],"usage":{}}}',
    ]
    const rows = buildLogRows(parseLines(lines, 'm'))
    const merged = rows[rows.length - 1]
    expect(merged.mergedWith).toBe('user')
    expect(merged.action).toBe(`${USER_INTERRUPT_LABEL} + <synthetic>`)
    expect(merged.panels.map((p) => p.group).slice(0, 1)).toEqual([USER_INTERRUPT_LABEL])
    expect(merged.durationMs).toBe(1_000)
  })
})

/**
 * 本地命令记录（`/compact`、`/clear`…）也不是用户说的话：操作列写命令名。
 * 判据（哪些记录算命令壳）在 `parse.ts::commandNameOf`，这里钉它对**行**的影响。
 */
describe('本地命令记录 — 操作列写命令名', () => {
  const cmdLine = (uuid: string, text: string, sec: number) =>
    `{"type":"user","uuid":"${uuid}","message":{"role":"user","content":${JSON.stringify(text)}},"timestamp":"2026-04-24T12:00:${String(sec).padStart(2, '0')}.000Z","sessionId":"m"}`
  const lines = [
    cmdLine('u1', '/compact', 0),
    cmdLine('u2', '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>', 1),
    cmdLine('u3', '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>', 2),
  ]

  it('三种壳都写命令名，摘要仍是原文，类型仍是「用户」', () => {
    const rows = buildLogRows(parseLines(lines, 'm'))
    expect(rows.map((r) => r.action)).toEqual(['compact', 'compact', 'compact'])
    expect(rows.map((r) => r.kind)).toEqual(['user', 'user', 'user'])
    expect(rows.map((r) => r.panels[0].label)).toEqual(['compact', 'compact', 'compact'])
    // 摘要照旧是记录原文（与打断标记同一套：不加工正文）
    expect(rows[0].summary).toBe('/compact')
    expect(rows[2].summary).toContain('Compacted')
    expect(rows.every((r) => r.durationMs === 0)).toBe(true)
  })

  it('带 args 的技能调用仍是提问（用户真的说了话）', () => {
    const rows = buildLogRows(
      parseLines(
        [cmdLine('u1', '<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>30m 检测整个工程</command-args>', 0)],
        'm',
      ),
    )
    expect(rows[0].action).toBe(USER_ASK_LABEL)
  })

  it('命令那一轮有响应时，问答行的操作列是「命令名 + 模型」', () => {
    const rows = buildLogRows(
      parseLines(
        [
          cmdLine('u1', '/compact', 0),
          '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:02.000Z","sessionId":"m","message":{"model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"text","text":"继续"}],"usage":{}}}',
        ],
        'm',
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].mergedWith).toBe('user')
    expect(rows[0].action).toBe('compact + claude-sonnet-4-5')
    expect(rows[0].panels.map((p) => p.group)).toEqual(['compact', GROUP_LLM])
  })
})

describe('workflow 行（Workflow）', () => {
  // 一轮两条响应：a1 是开场那一对（发起了 workflow？不是 —— 它只是正文），a2 发起 workflow。
  // 于是 a2 与 workflow 那条并成「想 + 做」，而 workflow 真跑了 90s（run 记录），调用自己只有 337ms。
  const wfLines = [
    '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"跑一遍评审"}}',
    '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"id":"M1","model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"text","text":"先看看再跑"}],"usage":{}}}',
    '{"type":"assistant","uuid":"a2","parentUuid":"a1","timestamp":"2026-04-24T12:00:03.000Z","sessionId":"m","message":{"id":"M2","model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"tool_use","id":"wf","name":"Workflow","input":{"scriptPath":"D:/wf/parallel-review.js","args":"{}"}}],"usage":{}}}',
    '{"type":"user","uuid":"u2","parentUuid":"a2","timestamp":"2026-04-24T12:00:03.337Z","sessionId":"m","toolUseResult":{"status":"async_launched","taskId":"walvv479d","taskType":"local_workflow","workflowName":"parallel-review","runId":"wf_1","summary":"多专家并行评审（单轮）","scriptPath":"D:/wf/parallel-review.js"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"wf","content":"Workflow launched in background. Task ID: walvv479d"}]}}',
    '{"type":"assistant","uuid":"a3","parentUuid":"u2","timestamp":"2026-04-24T12:02:00.000Z","sessionId":"m","message":{"id":"M3","model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"text","text":"收尾"}],"usage":{}}}',
  ]

  const withWorkflow = (): ReturnType<typeof parseLines> => {
    const s = parseLines(wfLines, 'm')
    const tc = s.turns.flatMap((t) => t.toolCalls).find((c) => c.name === 'Workflow')!
    tc.workflowRun = {
      runId: 'wf_1',
      workflowName: 'parallel-review',
      summary: '多专家并行评审（单轮）',
      status: 'completed',
      startTs: Date.parse('2026-04-24T12:00:03.000Z'),
      durationMs: 90_000,
      agentCount: 2,
      totalTokens: 12_345,
      totalToolCalls: 42,
      phases: ['Review'],
      resultText: '{\n  "passed": true\n}',
      resultTruncated: false,
      logs: ['Review: status=failed score=79.5/90'],
    }
    tc.childSessions = [
      parseLines(
        [
          '{"type":"user","uuid":"c1u","timestamp":"2026-04-24T12:00:04.000Z","sessionId":"c1","isSidechain":true,"message":{"role":"user","content":"你是准确性与一致性专家"}}',
          '{"type":"assistant","uuid":"c1a","parentUuid":"c1u","timestamp":"2026-04-24T12:00:40.000Z","sessionId":"c1","isSidechain":true,"message":{"model":"x","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{}}}',
        ],
        'c1',
      ),
    ]
    return s
  }

  it('与响应并成「想 + 做」：耗时取 run 记录，操作列带流程名，摘要用流程自己的说明', () => {
    const rows = buildLogRows(withWorkflow())
    const wf = rows.find((r) => r.kind === 'workflow')!
    expect(wf.mergedWith).toBe('tool')
    expect(wf.action).toBe('tool_use + Workflow · parallel-review')
    // 这一步 = 想（12:00:01 → 12:00:03）∪ 做（12:00:03 → 12:01:33）= 92s。
    // 关键是不再是那 337ms（发起→返回）—— 那只是「做」那半的开头一瞬。
    expect(wf.durationMs).toBe(92_000)
    expect(wf.summary).toContain('多专家并行评审')
    // 区间与甘特/树同源：起点是模型那半的开始，终点是 run 记录的结束
    expect(rowSpan(wf)).toEqual({
      start: Date.parse('2026-04-24T12:00:01.000Z'),
      end: Date.parse('2026-04-24T12:01:33.000Z'),
    })
    // 类型列写「workflow」而不是通用的「LLM+工具」：一个文案只对应一个颜色
    expect(kindLabelOf(wf)).toBe('workflow')
    expect(LOG_KIND_STYLE.workflow.color).toBe('var(--cat-workflow)')
  })

  it('展开面板：入参 + 运行情况 + workflow 结果（不给「launched in background」那块回执噪音）', () => {
    const rows = buildLogRows(withWorkflow())
    const wf = rows.find((r) => r.kind === 'workflow')!
    // a2 只有 tool_use 块（没思考也没正文）→ 模型那半没有面板；
    // workflow 那一组自带入参 / 运行情况 / 结果三块
    expect(wf.panels.map((p) => p.label)).toEqual(['请求 · tool_use', '运行情况', 'workflow 结果'])
    const run = wf.panels.find((p) => p.label === '运行情况')!
    expect(run.meta).toBe('parallel-review')
    expect(run.body).toContain('状态 completed')
    expect(run.body).toContain('子 agent 2 个')
    expect(run.body).toContain('运行时长 1m30s')
    expect(run.body).toContain('token 12.3k')
    expect(run.body).toContain('阶段 Review')
    expect(run.body).toContain('Review: status=failed') // 脚本写的日志逐条列出来
    const result = wf.panels.find((p) => p.label === 'workflow 结果')!
    expect(result.format).toBe('code')
    expect(result.body).toContain('"passed": true')
  })

  it('没有 run 记录：耗时退回发起那一段，面板回落到「请求 + 响应」两块', () => {
    // 这一版把 workflow 放在**开场那条响应**里：它发起的工具单独成行（不吃「想 + 做」合并），
    // 于是一行就是这一条工具自己的账，不被模型那半的区间并进去
    const openingWf = [
      '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"跑一遍评审"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-04-24T12:00:01.000Z","sessionId":"m","message":{"id":"M1","model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"tool_use","id":"wf","name":"Workflow","input":{"scriptPath":"D:/wf/parallel-review.js"}}],"usage":{}}}',
      '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-04-24T12:00:01.337Z","sessionId":"m","toolUseResult":{"status":"async_launched","workflowName":"parallel-review","runId":"wf_1"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"wf","content":"Workflow launched in background."}]}}',
      '{"type":"assistant","uuid":"a3","parentUuid":"u2","timestamp":"2026-04-24T12:02:00.000Z","sessionId":"m","message":{"id":"M2","model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"text","text":"收尾"}],"usage":{}}}',
    ]
    const rows = buildLogRows(parseLines(openingWf, 'm'))
    const wf = rows.find((r) => r.kind === 'workflow')!
    expect(wf.mergedWith).toBeNull() // 开场那一步的工具单独一行
    expect(wf.durationMs).toBe(337) // 「发起 → 返回」那一段，明摆着不是运行时长
    expect(wf.summary).toContain('D:/wf/parallel-review.js') // 摘要退回脚本路径
    expect(wf.panels.map((p) => p.label)).toEqual(['请求 · tool_use', '响应 · tool_result'])
    expect(wf.workflowRun).toBeUndefined()
  })

  it('展开后逐个列出这一跑的子 agent（每个一张子表，标题是它收到的第一行 prompt）', () => {
    const rows = buildLogRows(withWorkflow())
    const wf = rows.find((r) => r.kind === 'workflow')!
    expect(wf.childSessions).toHaveLength(1)
    expect(wf.childSessions?.[0].sessionId).toBe('c1')
    // 子表标题用 subagentLabel（树与日志共用一份取名规则）
    expect(subagentLabel(wf.childSessions![0], 0)).toBe('#1 你是准确性与一致性专家')
  })

  it('类型筛选里「workflow」是一类，且只对应一个颜色', () => {
    expect(LOG_KINDS).toContain('workflow')
    expect(LOG_KIND_STYLE.workflow.label).toBe('workflow')
    expect(LOG_KIND_STYLE.workflow.soft).toBe('var(--cat-workflow-soft)')
  })

  it('汇总条读的是分解模型（workflow 那一项与 breakdownOf 同源）', () => {
    const s = withWorkflow()
    const b = breakdownOf(s)
    expect(logSummary(s).workflowMs).toBe(b.workflowMs)
    expect(b.workflowMs).toBe(90_000)
    expect(b.waitUserMs + b.localToolMs + b.computeMs).toBe(b.wallMs)
  })
})

describe('上游 API 错误：标红并把归类写进摘要', () => {
  const USER_LINE =
    '{"type":"user","uuid":"u1","timestamp":"2026-04-24T12:00:00.000Z","sessionId":"m","message":{"role":"user","content":"开始"}}'

  /** 与真样本同形（本机 86 条，其中 7 条是子 agent 响应超限被截断）。 */
  const errLine = (extra: string, text: string): string =>
    `{"type":"assistant","uuid":"e1","parentUuid":"u1","timestamp":"2026-04-24T12:00:02.000Z","sessionId":"m","isApiErrorMessage":true,${extra}"message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"${text}"}]}}`

  // 一轮首条响应会与提问行并成一行，状态取模型那半 —— 这里断言的正是合并之后用户看到的那行
  const rows = (extra: string, text: string): LogRow[] =>
    buildLogRows(parseLines([USER_LINE, errLine(extra, text)], 'm'))
  const f = (patch: Partial<LogFilter>): LogFilter => ({ ...EMPTY_LOG_FILTER, ...patch })

  it('状态是 error 而不是「未跑完」，抬头写归类与 HTTP 码', () => {
    const row = rows('"error":"max_output_tokens","apiErrorStatus":400,', 'API Error: 上游返回超限')[0]
    expect(row.status).toBe('error')
    expect(row.summary).toBe('API Error (max_output_tokens 400) · 上游返回超限')
  })

  it('正文自带的 `API Error: ` 抬头被剥掉，摘要里只念一遍', () => {
    const row = rows('"error":"rate_limit","apiErrorStatus":429,', 'API Error: Request rejected · 已达到用量上限')[0]
    expect(row.summary.match(/API Error/g)).toHaveLength(1)
  })

  it('抬头写了码时，正文开头那份重复的码也剥掉；抬头没写码时，正文里那个码是唯一一份，留着', () => {
    const both = rows('"error":"unknown","apiErrorStatus":400,', 'API Error: 400 Model do not support image input')[0]
    expect(both.summary).toBe('API Error (unknown 400) · Model do not support image input')
    const onlyBody = rows('', 'API Error: 400 上游没给出归类与状态码')[0]
    expect(onlyBody.summary).toBe('API Error (未知) · 400 上游没给出归类与状态码')
  })

  it('缺归类与状态码时回退「未知」，不写 0 / unknown 这类像读数的占位', () => {
    const row = rows('', "API Error: Can't reach the API server")[0]
    expect(row.summary).toBe("API Error (未知) · Can't reach the API server")
  })

  it('归类长到不像归类名（cc 若把堆栈写进 error）回退「未知」，不把抬头撑爆', () => {
    const row = rows(`"error":"${'boom '.repeat(40)}",`, 'API Error: 炸了')[0]
    expect(row.summary.startsWith('API Error (未知)')).toBe(true)
    expect(row.summary.length).toBeLessThan(120)
  })

  it('筛选「失败」能捞出上游报错行', () => {
    const r = rows('"error":"server_error","apiErrorStatus":500,', 'API Error: 上游 500')
    expect(filterLogRows(r, f({ statuses: ['error'] })).map((x) => x.id)).toEqual(r.map((x) => x.id))
  })

  it('反例：/compact 的摘要是普通消息 —— 同样 <synthetic>，既不变红也进不了「失败」', () => {
    const summary =
      '{"type":"assistant","uuid":"c1","parentUuid":"u1","timestamp":"2026-04-24T12:00:02.000Z","sessionId":"m","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"本次对话摘要"}]}}'
    const r = buildLogRows(parseLines([USER_LINE, summary], 'm'))
    expect(r[0].status).toBe('na')
    expect(filterLogRows(r, f({ statuses: ['error'] }))).toHaveLength(0)
  })
})
