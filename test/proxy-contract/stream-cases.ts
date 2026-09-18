/**
 * C16–C23：SSE 推送流契约（`/requests/stream`、`/events/stream`、`/event/detail/stream`
 * 与两个 clear 控制帧、心跳）。
 *
 * 为什么这批用例必须入库：三条推送流是 `proxy.js` 最新的旁路，Node 与 Rust 两个实现都靠
 * 「同一个广播器 + 同一套『回放 → 实时 → 心跳』状态机」在跑，而此前**没有任何入库的契约测试**
 * （只有 `broadcast.rs` 的 Rust 单测与一次性的 `/tmp` 探针）。黑盒差分是唯一能同时钉住
 * 「帧格式」「回放顺序」「clear 语义」三件事的手段。
 *
 * 断言口径：帧一律 `JSON.parse` 后按**语义**比，绝不比原始字符串 —— 键序是已记录的刻意偏差
 * （Node 是字面量序，Rust 的 serde_json 是字典序），dashboard 按名读取。
 */
import { expect } from 'vitest'
import {
  httpGetJson,
  httpRequest,
  openSse,
  sleep,
  type FakeUpstream,
  type SseConnection,
  type SseFrame,
  type SutHandle,
} from './harness'

export interface StreamCtx {
  sut: SutHandle
  upstream: FakeUpstream
}

export interface StreamCase {
  id: string
  title: string
  /**
   * true = 只在显式开启（`CC_CONTRACT_HEARTBEAT=1`）时注册。
   * 见 CONTRACT.md §9：心跳间隔是硬编码的 15s，跑一次要真等 15s，不能默认拖慢整个套件。
   */
  slow?: boolean
  run(ctx: StreamCtx): Promise<void>
}

/** 四条 SSE 响应头（Node 与 Rust 实测逐字相同，见 CONTRACT.md §9）。 */
const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/** `_captureSummary` 的键集（两个实现一致；键序不比）。 */
const SUMMARY_KEYS = [
  'agentId',
  'cid',
  'ended',
  'firstByteMs',
  'isSSE',
  'method',
  'phase',
  'reqBodySize',
  'respBodySize',
  'sseBytesSize',
  'statusCode',
  'totalMs',
  'ts',
  'url',
].sort()

/** `recordEvent` 事件的键集（两个实现一致）。 */
const EVENT_KEYS = ['agentId', 'count', 'detail', 'message', 'severity', 'ts', 'type'].sort()

/** data 帧 → JSON；注释帧（`: ping`，无 data）→ null。 */
function frameJson(f: SseFrame): any | null {
  if (f.data === null) return null
  try {
    return JSON.parse(f.data)
  } catch {
    return null
  }
}

function clearRequests(sut: SutHandle) {
  return httpRequest(`${sut.origin}/requests/clear`, { method: 'POST' })
}

function clearEvents(sut: SutHandle) {
  return httpRequest(`${sut.origin}/events/clear`, { method: 'POST' })
}

/** 走 SUT 发一个「会被捕获」的 LLM 请求（POST /v1/messages + 显式 agent）。 */
function postMessage(sut: SutHandle, query: string, agentId: string) {
  return httpRequest(`${sut.origin}/v1/messages${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-id': agentId },
    body: '{}',
  })
}

/** 换掉假上游对**后续**请求的应答（状态码 + 固定 JSON 体）。 */
function serveStatus(upstream: FakeUpstream, status: number, body = '{"ok":true}') {
  upstream.on((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body)
  })
}

/** 假上游把一段固定 SSE 字节一次性写完（C23 的详情流回放用）。 */
function serveSse(upstream: FakeUpstream, bytes: Buffer) {
  upstream.on((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(bytes)
  })
}

/** 最小 SSE：一个 text delta + end_turn 收尾；只有 content_block_delta 会进详情流回放。 */
const DETAIL_SSE = Buffer.from(
  [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi 中"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    'data: [DONE]\n\n',
  ].join(''),
  'utf8',
)

function expectSseHeaders(conn: SseConnection) {
  expect(conn.status).toBe(200)
  expect(conn.headers?.['content-type']).toBe(SSE_HEADERS['content-type'])
  expect(conn.headers?.['cache-control']).toBe(SSE_HEADERS['cache-control'])
  expect(conn.headers?.connection).toBe(SSE_HEADERS.connection)
  expect(conn.headers?.['x-accel-buffering']).toBe(SSE_HEADERS['x-accel-buffering'])
}

export const STREAM_CASES: StreamCase[] = [
  {
    id: 'C16',
    title: '/requests/stream：四条 SSE 响应头 + 回放帧是**单条 summary 对象**（不是数组）',
    async run({ sut, upstream }) {
      serveStatus(upstream, 200)
      await clearRequests(sut)
      await postMessage(sut, '?c16=1', 'agent-c16')
      await sleep(40)

      const conn = openSse(`${sut.origin}/requests/stream`)
      try {
        const f = await conn.waitForFrame(
          (x) => frameJson(x)?.url === '/v1/messages?c16=1',
          4000,
          'C16 未回放到刚捕获的请求',
        )
        expectSseHeaders(conn)

        const j = frameJson(f)!
        expect(Array.isArray(j), '帧必须是单条 summary 对象，不是数组').toBe(false)
        expect(Object.keys(j).sort(), 'summary 键集必须与 Node 一致').toEqual(SUMMARY_KEYS)
        expect(j.method).toBe('POST')
        expect(j.url).toBe('/v1/messages?c16=1')
        expect(j.agentId).toBe('agent-c16')
        expect(j.statusCode).toBe(200)
        expect(j.isSSE).toBe(false)
        expect(j.ended).toBe(true)
        expect(typeof j.ts).toBe('number')
        // cid 必须能被 /event/detail 的 `/^[a-f0-9-]{8,64}$/i` 收下（dashboard 靠它拉详情）
        expect(j.cid).toMatch(/^[a-f0-9-]{8,64}$/i)
      } finally {
        conn.close()
      }
    },
  },

  {
    id: 'C17',
    title: '/requests/stream：积压回放**旧→新**（升序），实时帧接在其后',
    async run({ sut, upstream }) {
      serveStatus(upstream, 200)
      await clearRequests(sut)
      // ts 要有区分度，否则「按 ts 排序」在毫秒内不可判
      await postMessage(sut, '?c17=1', 'agent-c17a')
      await sleep(40)
      await postMessage(sut, '?c17=2', 'agent-c17b')
      await sleep(40)

      const conn = openSse(`${sut.origin}/requests/stream`)
      try {
        await conn.waitForFrames(2, 4000, 'C17 两条积压未回放')

        // 连上之后再捕获一条 → 它必须排在回放**之后**（实时 append 方向与回放一致）
        await postMessage(sut, '?c17=3', 'agent-c17c')
        await conn.waitForFrames(3, 4000, 'C17 实时第 3 帧未到达')

        const mine = conn.frames
          .map(frameJson)
          .filter((j) => j && typeof j.url === 'string' && j.url.startsWith('/v1/messages?c17='))
        // 同一请求可能有「起始帧 + 结束帧」多帧（Node 还多一帧 agentId 补齐），
        // 顺序看的是每个 url 的**首次**出现 —— 那才是 dashboard 把行 push 进列表的顺序。
        const firstSeen: string[] = []
        for (const j of mine) {
          if (!firstSeen.includes(j.url)) firstSeen.push(j.url)
        }
        expect(
          firstSeen,
          '回放顺序必须旧→新（降序回放是历史 bug：列表与实时 append 方向矛盾）',
        ).toEqual(['/v1/messages?c17=1', '/v1/messages?c17=2', '/v1/messages?c17=3'])
        for (let i = 1; i < mine.length; i++) {
          expect(mine[i].ts, '回放/实时帧的 ts 必须非降').toBeGreaterThanOrEqual(mine[i - 1].ts)
        }
      } finally {
        conn.close()
      }
    },
  },

  {
    id: 'C18',
    title: '/requests/stream：实时帧 —— 请求被捕获时推 summary（先 ended:false 再 ended:true），单条对象',
    async run({ sut, upstream }) {
      serveStatus(upstream, 200)
      await clearRequests(sut)
      // 先放一条「种子」积压：它的帧到达 = 服务端已把本连接登记为订阅者
      // （Node 是写完积压才 requestClients.add；Rust 是取快照后同步 subscribe）。
      // 空积压时 Node 连响应头都不 flush，客户端无从判断订阅是否建立，会有竞态。
      await postMessage(sut, '?c18seed=1', 'agent-c18seed')
      await sleep(40)

      const conn = openSse(`${sut.origin}/requests/stream`)
      try {
        await conn.waitForFrame(
          (x) => frameJson(x)?.url === '/v1/messages?c18seed=1',
          4000,
          'C18 种子积压未回放，订阅尚未建立',
        )

        await postMessage(sut, '?c18=live', 'agent-c18')
        await conn.waitForFrame(
          (x) => {
            const j = frameJson(x)
            return j?.url === '/v1/messages?c18=live' && j.ended === true
          },
          4000,
          'C18 未收到实时 ended:true 帧',
        )

        const live = conn.frames.filter((x) => frameJson(x)?.url === '/v1/messages?c18=live')
        expect(live.length, '实时至少要「未结束 + 已结束」两帧').toBeGreaterThanOrEqual(2)
        for (const f of live) {
          expect(Array.isArray(frameJson(f)), '实时帧同样必须是单条对象').toBe(false)
        }
        expect(
          live.some((x) => frameJson(x)?.ended === false),
          '缺少 ended:false 的起始帧（请求刚被捕获那一帧）',
        ).toBe(true)

        const last = frameJson(live[live.length - 1])!
        expect(last.ended).toBe(true)
        expect(last.statusCode).toBe(200)
        expect(last.isSSE).toBe(false)
        expect(last.method).toBe('POST')
        expect(last.respBodySize).toBe(11) // '{"ok":true}'
        expect(new Set(live.map((x) => frameJson(x)?.cid)).size, '同一请求的帧必须共享一个 cid').toBe(1)
      } finally {
        conn.close()
      }
    },
  },

  {
    id: 'C19',
    title: '/requests/clear：订阅者收 `event: clear` + `data: {}`；响应体 cleared 是**真实条数**',
    async run({ sut, upstream }) {
      serveStatus(upstream, 200)
      await clearRequests(sut) // 清掉前序用例的条目，保证下面的 2 是真数
      await postMessage(sut, '?c19=1', 'agent-c19a')
      await postMessage(sut, '?c19=2', 'agent-c19b')
      await sleep(40)

      const before = await httpGetJson<{ requests: unknown[] }>(`${sut.origin}/requests/recent`)
      expect(before.requests.length, 'C19 前提不成立：清空后应恰有 2 条').toBe(2)

      const conn = openSse(`${sut.origin}/requests/stream`)
      try {
        await conn.waitForFrames(2, 4000, 'C19 两条积压未回放，订阅尚未建立')

        const r = await clearRequests(sut)
        expect(r.status).toBe(200)
        const body = JSON.parse(r.body.toString('utf8'))
        expect(body.ok).toBe(true)
        // 与 /events/clear 的字面量 0 刻意不同：这个端点必须回报真实条数
        expect(body.cleared, '/requests/clear 的 cleared 必须是真实条数（不是字面量 0）').toBe(2)

        const cf = await conn.waitForFrame((x) => x.event === 'clear', 3000, 'C19 未收到 clear 控制帧')
        expect(cf.raw, 'clear 控制帧必须逐字是 event: clear + data: {}').toBe('event: clear\ndata: {}')
        expect(cf.data).toBe('{}')

        const after = await httpGetJson<{ requests: unknown[] }>(`${sut.origin}/requests/recent`)
        expect(after.requests.length).toBe(0)
      } finally {
        conn.close()
      }
    },
  },

  {
    id: 'C20',
    title: '/events/stream：四条 SSE 响应头 + 事件积压回放**旧→新**',
    async run({ sut, upstream }) {
      await clearEvents(sut)
      try {
        serveStatus(upstream, 404)
        await postMessage(sut, '', 'agent-c20a')
        await sleep(40)
        serveStatus(upstream, 429)
        await postMessage(sut, '', 'agent-c20b')
        await sleep(40)

        const listed = await httpGetJson<{ count: number }>(`${sut.origin}/events`)
        expect(listed.count, 'C20 前提不成立：两次上游错误应产生 2 条事件').toBe(2)

        const conn = openSse(`${sut.origin}/events/stream`)
        try {
          await conn.waitForFrames(2, 4000, 'C20 事件积压未回放')
          expectSseHeaders(conn)

          const evs = conn.frames.map(frameJson).filter(Boolean)
          expect(
            evs.map((e) => e.type),
            '事件积压必须旧→新（降序回放是历史 bug）',
          ).toEqual(['upstream-404', 'upstream-429'])
          for (const e of evs) {
            expect(Object.keys(e).sort(), '事件键集必须与 Node 一致').toEqual(EVENT_KEYS)
          }
          expect(evs[0].agentId).toBe('agent-c20a')
          expect(evs[1].agentId).toBe('agent-c20b')
          expect(evs[0].severity).toBe('error')
          expect(evs[1].severity).toBe('warn')
          for (let i = 1; i < evs.length; i++) {
            expect(evs[i].ts, '事件回放的 ts 必须非降').toBeGreaterThanOrEqual(evs[i - 1].ts)
          }
        } finally {
          conn.close()
        }
      } finally {
        serveStatus(upstream, 200) // 还原，别把 404/429 漏给后续用例
      }
    },
  },

  {
    id: 'C21',
    title: '/events/clear：订阅者收 `event: clear` + `data: {}`；响应体是字面量 {ok:true,cleared:0}（Node 刻意 quirk）',
    async run({ sut, upstream }) {
      await clearEvents(sut)
      try {
        serveStatus(upstream, 404)
        await postMessage(sut, '', 'agent-c21')
        await sleep(60)

        const before = await httpGetJson<{ count: number }>(`${sut.origin}/events`)
        // 前提自检：环里**确实**有事件，否则「字面量 0」这条断言就是空转（绿得没有意义）
        expect(
          before.count,
          'C21 前提不成立：先要有一条事件，否则无法区分「字面量 0」与「真的 0」',
        ).toBeGreaterThanOrEqual(1)

        const conn = openSse(`${sut.origin}/events/stream`)
        try {
          await conn.waitForFrame(
            (x) => frameJson(x)?.type === 'upstream-404',
            4000,
            'C21 事件未回放，订阅尚未建立',
          )

          const r = await clearEvents(sut)
          expect(r.status).toBe(200)
          // 刻意照抄 Node：即使清掉了 1 条也是字面量 0（/requests/clear 才回报真数）
          expect(JSON.parse(r.body.toString('utf8'))).toEqual({ ok: true, cleared: 0 })

          const cf = await conn.waitForFrame((x) => x.event === 'clear', 3000, 'C21 未收到 clear 控制帧')
          expect(cf.raw).toBe('event: clear\ndata: {}')
          expect(cf.data).toBe('{}')

          const after = await httpGetJson<{ count: number }>(`${sut.origin}/events`)
          expect(after.count).toBe(0)
        } finally {
          conn.close()
        }
      } finally {
        serveStatus(upstream, 200) // 还原
      }
    },
  },

  {
    id: 'C23',
    title:
      '/event/detail/stream：已结束的 SSE 捕获先回放 delta（ts:0）再推 {done:true} 并关流；缺参/未知 cid → 400/404',
    async run({ sut, upstream }) {
      await clearRequests(sut)
      try {
        serveSse(upstream, DETAIL_SSE)
        const r = await postMessage(sut, '?c23=1', 'agent-c23')
        expect(r.status).toBe(200)

        const recent = await httpGetJson<{ requests: Array<{ url: string; cid: string }> }>(
          `${sut.origin}/requests/recent`,
        )
        const entry = recent.requests.find((e) => e.url === '/v1/messages?c23=1')
        expect(entry?.cid, 'C23 前提不成立：捕获环里没有该请求').toBeTruthy()
        const cid = entry!.cid

        // 参数守卫：两条实现必须同状态码同文案
        const noCid = await httpRequest(`${sut.origin}/event/detail/stream`)
        expect(noCid.status).toBe(400)
        expect(JSON.parse(noCid.body.toString('utf8'))).toEqual({ error: 'invalid or missing cid' })
        const unknown = await httpRequest(`${sut.origin}/event/detail/stream?cid=deadbeef-0000`)
        expect(unknown.status).toBe(404)
        expect(JSON.parse(unknown.body.toString('utf8'))).toEqual({ error: 'capture 已淘汰或不存在' })

        const conn = openSse(`${sut.origin}/event/detail/stream?cid=${cid}`)
        try {
          await conn.waitForFrame((x) => frameJson(x)?.done === true, 4000, 'C23 未收到 {done:true}')
          const frames = conn.frames.map(frameJson).filter(Boolean)
          // 已结束的流：回放历史 delta（ts:0）后立刻 done —— 不会再有增量
          expect(frames.map((f) => f.done === true), '帧序必须是「回放 delta → done」').toEqual([
            false,
            true,
          ])
          expect(frames[0]).toEqual({ kind: 'text', text: 'hi 中', ts: 0 })
          for (const f of frames) expect(Array.isArray(f)).toBe(false)
          // done 之后必须关流（否则 dashboard 的 EventSource 会一直挂着等增量）
          await conn.waitForClose(4000, 'C23 done 之后连接未关闭')
        } finally {
          conn.close()
        }
      } finally {
        serveStatus(upstream, 200) // 还原，别把 SSE 应答漏给后续用例
      }
    },
  },

  {
    id: 'C22',
    title: '/requests/stream：空闲连接按 15s 间隔发 `: ping` SSE 注释行（默认不跑，见 CONTRACT.md §9）',
    slow: true,
    async run({ sut, upstream }) {
      serveStatus(upstream, 200)
      await clearRequests(sut)

      const conn = openSse(`${sut.origin}/requests/stream`)
      try {
        // 间隔是硬编码 15s（Node `setInterval` / Rust `interval_at`），给 20s 余量
        const f = await conn.waitForFrame((x) => x.comment === 'ping', 20_000, 'C22 20s 内未收到心跳注释行')
        expect(f.raw, '心跳必须是 SSE 注释行 `: ping`，不是 data 帧').toBe(': ping')
        expect(f.data).toBeNull()
        expect(f.event).toBeNull()
      } finally {
        conn.close()
      }
    },
  },
]
