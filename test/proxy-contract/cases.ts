/**
 * Stage 1.1 / 1.3 共用的透传契约用例（C1–C11）。
 *
 * 每个用例只依赖 `ContractCtx`（SUT + 假上游 + 驱动器），不关心被测实现是 Node 还是 Rust。
 * 断言里刻意保留「可诊断性」：字节不一致时报出首个差异偏移、双方 utf8 预览，
 * 并在出现 U+FFFD 时直指根因（分帧时做了有损 utf-8 解码）。
 */
import { expect } from 'vitest'
import {
  getFreePort,
  httpRequest,
  requestStreaming,
  sleep,
  waitFor,
  type FakeUpstream,
  type SutDriver,
  type SutHandle,
  type SutOptions,
} from './harness'

export interface ContractCtx {
  driver: SutDriver
  sut: SutHandle
  upstream: FakeUpstream
  /** 用同一个 driver 另起一个 SUT（调用方负责 stop） */
  spawn(opts: SutOptions): Promise<SutHandle>
}

export interface ContractCase {
  id: string
  title: string
  run(ctx: ContractCtx): Promise<void>
}

// ---------------------------------------------------------------- 断言工具

function firstDiff(a: Buffer, b: Buffer): string {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return `首个差异在第 ${i} 字节：实际 0x${a[i].toString(16).padStart(2, '0')}，期望 0x${b[i]
        .toString(16)
        .padStart(2, '0')}`
    }
  }
  if (a.length !== b.length) return `长度不同：实际 ${a.length}，期望 ${b.length}`
  return '内容相同'
}

/** 字节级断言。失败时给出定位信息，而不是一句「不相等」。 */
export function expectBytes(actual: Buffer, expected: Buffer, label: string): void {
  if (actual.equals(expected)) return
  const hints: string[] = [firstDiff(actual, expected)]
  if (actual.toString('utf8').includes('\ufffd')) {
    hints.push(
      '注意：实际响应里出现了 U+FFFD 替换字符 ——这是「累积时对 Buffer 做了 toString("utf8")」的典型特征：' +
        '跨 chunk 的多字节字符被有损解码，字节已永久丢失。分帧必须像现状一样在 latin1/字节层定位 \\n\\n 边界。',
    )
  }
  throw new Error(
    `${label} 字节不一致：\n  ${hints.join('\n  ')}\n` +
      `  实际(${actual.length}B, utf8) : ${JSON.stringify(actual.toString('utf8').slice(0, 300))}\n` +
      `  期望(${expected.length}B, utf8) : ${JSON.stringify(expected.toString('utf8').slice(0, 300))}`,
  )
}

// ---------------------------------------------------------------- SSE 素材

/**
 * 贴近真实 Anthropic 流的 golden 素材。
 *
 * 事件词表来自**真实录制报文**（cc-monitor 的 SSE debug dump，本机 /tmp/cc-monitor-debug；
 * 因含用户真实对话内容，**不入库**）：实测 thinking_delta 503 / input_json_delta 338 /
 * text_delta 160。此处按同一词表 + 官方协议合成，payload 全部为假数据，覆盖 proxy 的
 * KNOWN_SSE_TYPES 全 8 种（error 由 C8 的 HTTP 错误路径单独覆盖）。CRLF 与 LF 混用；
 * 含中文 / emoji / 长破折号 / 省略号；结尾 [DONE]。
 * 用 JSON.stringify 构造 payload，保证转义（尤其 input_json_delta 的 partial_json）一定合法。
 */
function sseEvent(event: string, payload: unknown, eol: '\n' | '\r\n' = '\n'): string {
  return `event: ${event}${eol}data: ${JSON.stringify(payload)}${eol}${eol}`
}

export const SSE_FULL: Buffer = Buffer.from(
  [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_01ContractFixture',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 42,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('ping', { type: 'ping' }),
    // 上游同时用 CRLF 与 LF 两种分隔（实测两种都存在）
    sseEvent(
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好，世界 🌏 — 中文测试 ✓' } },
      '\r\n',
    ),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'pondering… 🤔' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pki' },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_01ContractFixture', name: 'Bash', input: {} },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"command":"ls -la 中文目录 🌏"}' },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 1 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 123 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
    'data: [DONE]\n\n',
  ].join(''),
  'utf8',
)

/** 极短 SSE：一个 CRLF event + 一个 emoji delta + [DONE]，用于逐字节喂。 */
export const SSE_TINY: Buffer = Buffer.from(
  'event: content_block_delta\r\ndata: {"delta":{"text":"🌏"}}\r\n\r\ndata: [DONE]\n\n',
  'utf8',
)

/**
 * 只切在「危险」位置：多字节 utf-8 序列内部、CRLF / \n\n 之间。
 * 每个危险位置都成为一次 write 的边界 → 上游必然会把这些边界暴露给代理。
 */
export function dangerousFragments(buf: Buffer): Buffer[] {
  const cuts = new Set<number>()
  for (let i = 1; i < buf.length; i++) {
    if ((buf[i] & 0xc0) === 0x80) cuts.add(i) // 落在多字节序列内部（续字节）
    const p = buf[i - 1]
    const c = buf[i]
    if ((p === 0x0a || p === 0x0d) && (c === 0x0a || c === 0x0d)) cuts.add(i) // CRLF / \n\n 中间
  }
  const sorted = [...cuts].sort((a, b) => a - b)
  const frags: Buffer[] = []
  let prev = 0
  for (const c of sorted) {
    frags.push(buf.subarray(prev, c))
    prev = c
  }
  frags.push(buf.subarray(prev))
  return frags.filter((f) => f.length > 0)
}

/** 上游按给定分片写 SSE，片间留 1ms 让 TCP 真的分段（避免内核把 write 合并成一次大 chunk）。 */
function serveSse(upstream: FakeUpstream, fragments: Buffer[], delayMs = 1): void {
  upstream.on(async (_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    })
    res.socket?.setNoDelay(true)
    for (const f of fragments) {
      res.write(f)
      if (delayMs > 0) await sleep(delayMs)
    }
    res.end()
  })
}

// ---------------------------------------------------------------- 用例

export const CONTRACT_CASES: ContractCase[] = [
  {
    id: 'C1',
    title: '方法 + path 透传（含 query 与上游 path 前缀）',
    async run({ sut, upstream, spawn }) {
      upstream.on((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
      })

      await httpRequest(`${sut.origin}/v1/messages`, { method: 'POST', body: '{}' })
      expect(upstream.last().method).toBe('POST')
      expect(upstream.last().url).toBe('/v1/messages')

      await httpRequest(`${sut.origin}/v1/messages?beta=1&tag=%E4%B8%AD%E6%96%87`, {
        method: 'POST',
        body: '{}',
      })
      expect(upstream.last().url).toBe('/v1/messages?beta=1&tag=%E4%B8%AD%E6%96%87')

      await httpRequest(`${sut.origin}/chat/completions`, { method: 'POST', body: '{}' })
      expect(upstream.last().url).toBe('/chat/completions')

      // 非 POST（非 LLM 请求）也必须透传，不得只放行 POST
      await httpRequest(`${sut.origin}/v1/models`, { method: 'GET' })
      expect(upstream.last().method).toBe('GET')
      expect(upstream.last().url).toBe('/v1/models')

      // 上游 base URL 带 path 前缀 → 前缀必须拼在请求 path 前面
      const prefixed = await spawn({ upstream: `${upstream.origin}/api` })
      try {
        await httpRequest(`${prefixed.origin}/v1/messages?x=1`, { method: 'POST', body: '{}' })
        expect(upstream.last().url).toBe('/api/v1/messages?x=1')
      } finally {
        await prefixed.stop()
      }
    },
  },

  {
    id: 'C2',
    title: '请求头透传；仅 host 改写为上游主机名',
    async run({ sut, upstream }) {
      upstream.on((_req, res) => {
        res.writeHead(200)
        res.end('ok')
      })
      const headers = {
        'content-type': 'application/json',
        'x-api-key': 'sk-ant-contract-123',
        authorization: 'Bearer contract-token',
        'anthropic-version': '2023-06-01',
        accept: 'text/event-stream',
        'x-agent-id': 'agent-alpha',
        'x-custom-weird': 'v1, v2',
        'user-agent': 'cc-contract-test/1.0',
      }
      await httpRequest(`${sut.origin}/v1/messages`, { method: 'POST', headers, body: '{}' })

      const got = upstream.last().headers
      expect(got['x-api-key']).toBe('sk-ant-contract-123')
      expect(got.authorization).toBe('Bearer contract-token')
      expect(got['anthropic-version']).toBe('2023-06-01')
      expect(got.accept).toBe('text/event-stream')
      expect(got['x-agent-id']).toBe('agent-alpha')
      expect(got['x-custom-weird']).toBe('v1, v2')
      expect(got['user-agent']).toBe('cc-contract-test/1.0')
      expect(got['content-type']).toBe('application/json')
      // host 必须指向真正上游，且不带端口
      expect(got.host).toBe('127.0.0.1')
    },
  },

  {
    id: 'C3',
    title: '请求体字节级透传（256 KiB 全字节序列，非法 utf-8）',
    async run({ sut, upstream }) {
      upstream.on((_req, res) => {
        res.writeHead(200)
        res.end('ok')
      })
      const unit = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
      const big = Buffer.concat([...Array(1024).fill(unit), Buffer.from('中文🌏 tail', 'utf8')])
      expect(big.length).toBeGreaterThanOrEqual(256 * 1024)

      const r = await httpRequest(`${sut.origin}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(big.length) },
        body: big,
        timeoutMs: 15000,
      })
      expect(r.status).toBe(200)
      const got = upstream.last()
      expect(got.body.length).toBe(big.length)
      expect(got.body).toEqual(big)
      expect(got.headers['content-length']).toBe(String(big.length))
    },
  },

  {
    id: 'C4',
    title: '状态码原样透传（201/404/429/500/529）',
    async run({ sut, upstream }) {
      for (const code of [201, 404, 429, 500, 529]) {
        const payload = JSON.stringify({ code })
        upstream.on((_req, res) => {
          res.writeHead(code, { 'content-type': 'application/json' })
          res.end(payload)
        })
        const r = await httpRequest(`${sut.origin}/v1/messages`, { method: 'POST', body: '{}' })
        expect(r.status, `状态码 ${code} 未被原样透传`).toBe(code)
        expect(r.body.toString('utf8')).toBe(payload)
      }
    },
  },

  {
    id: 'C5',
    title: '响应头透传（content-type / 自定义头 / retry-after）',
    async run({ sut, upstream }) {
      upstream.on((_req, res) => {
        res.writeHead(203, {
          'content-type': 'application/json; charset=utf-8',
          'x-upstream': 'fake-upstream-1',
          'retry-after': '17',
        })
        res.end('{"ok":true}')
      })
      const r = await httpRequest(`${sut.origin}/v1/messages`, { method: 'POST', body: '{}' })
      expect(r.status).toBe(203)
      expect(r.headers['content-type']).toBe('application/json; charset=utf-8')
      expect(r.headers['x-upstream']).toBe('fake-upstream-1')
      expect(r.headers['retry-after']).toBe('17')
      expect(r.body.toString('utf8')).toBe('{"ok":true}')
    },
  },

  {
    id: 'C6',
    title: '非 SSE 真流式转发 + 字节保真（第 1 片到手后才放行第 2 片）',
    async run({ sut, upstream }) {
      const part1 = Buffer.from('第一段-'.repeat(200), 'utf8')
      const part2 = Buffer.from('第二段🌏'.repeat(200), 'utf8')
      const part3 = Buffer.alloc(64 * 1024, 0xab)
      const full = Buffer.concat([part1, part2, part3])

      let release2: () => void = () => {}
      const firstSeenByClient = new Promise<void>((r) => {
        release2 = r
      })
      upstream.on(async (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.socket?.setNoDelay(true)
        res.write(part1)
        await firstSeenByClient // 客户端没收到 part1 就绝不放行 part2
        res.write(part2)
        res.write(part3)
        res.end()
      })

      const s = await requestStreaming(`${sut.origin}/v1/messages`, {
        method: 'POST',
        body: '{}',
        timeoutMs: 15000,
      })
      await waitFor(
        () => Buffer.concat(s.chunks).length >= part1.length,
        4000,
        '上游写完第 1 段已 4s，客户端仍未收到 —— 响应被攒齐后才发，不是流式透传',
      )
      release2()
      const out = await s.settled
      expect(out.error?.message).toBeUndefined()
      expect(out.ended).toBe(true)
      expectBytes(Buffer.concat(s.chunks), full, '非 SSE 响应体')
    },
  },

  {
    id: 'C7a',
    title: 'SSE 字节保真 · 危险边界分片（拒绝 U+FFFD）',
    async run({ sut, upstream }) {
      const frags = dangerousFragments(SSE_FULL)
      expect(frags.length, '危险切片数量太少，用例失去对抗性').toBeGreaterThan(20)
      serveSse(upstream, frags)

      const s = await requestStreaming(`${sut.origin}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-id': 'sse-contract-a' },
        body: '{}',
        timeoutMs: 15000,
      })
      const out = await s.settled
      expect(out.error?.message).toBeUndefined()
      expect(out.ended).toBe(true)
      expect(s.headers['content-type']).toContain('text/event-stream')
      expectBytes(Buffer.concat(s.chunks), SSE_FULL, 'SSE 响应体')
    },
  },

  {
    id: 'C7b',
    title: 'SSE 字节保真 · 逐字节喂（emoji 被切在 4 字节中间）',
    async run({ sut, upstream }) {
      const frags = Array.from({ length: SSE_TINY.length }, (_, i) => SSE_TINY.subarray(i, i + 1))
      expect(frags.length).toBeGreaterThan(50)
      serveSse(upstream, frags)

      const s = await requestStreaming(`${sut.origin}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-id': 'sse-contract-b' },
        body: '{}',
        timeoutMs: 15000,
      })
      const out = await s.settled
      expect(out.error?.message).toBeUndefined()
      expect(out.ended).toBe(true)
      const got = Buffer.concat(s.chunks)
      expectBytes(got, SSE_TINY, 'SSE 响应体（逐字节）')
      expect(got.toString('utf8')).toContain('🌏')
    },
  },

  {
    id: 'C8',
    title: '上游 4xx/5xx 错误体原样透传（不得吞掉或改写）',
    async run({ sut, upstream }) {
      for (const code of [400, 529]) {
        const errBody = JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: `上游 ${code} 原文` },
        })
        upstream.on((_req, res) => {
          res.writeHead(code, { 'content-type': 'application/json', 'request-id': 'req_contract' })
          res.end(errBody)
        })
        const r = await httpRequest(`${sut.origin}/v1/messages`, { method: 'POST', body: '{}' })
        expect(r.status).toBe(code)
        expect(r.body.toString('utf8')).toBe(errBody)
        expect(r.headers['request-id']).toBe('req_contract')
      }
    },
  },

  {
    id: 'C9',
    title: '上游不可达 → 502 + proxy_error JSON',
    async run({ upstream, spawn }) {
      const deadPort = await getFreePort() // 立刻关闭，保证无人监听
      const sut2 = await spawn({ upstream: `http://127.0.0.1:${deadPort}` })
      try {
        const r = await httpRequest(`${sut2.origin}/v1/messages`, {
          method: 'POST',
          body: '{}',
          timeoutMs: 5000,
        })
        expect(r.status).toBe(502)
        const j = JSON.parse(r.body.toString('utf8'))
        expect(j.error).toBe('proxy_error')
        expect(typeof j.message).toBe('string')
      } finally {
        await sut2.stop()
      }
      void upstream
    },
  },

  {
    id: 'C10a',
    title: '上游 SSE 中途断开 → 客户端请求必须收敛（不得挂死），且不凭空造字节',
    async run({ sut, upstream }) {
      const head = Buffer.from('event: message_start\ndata: {"type":"message_start"}\n\n', 'utf8')
      upstream.on(async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(head)
        await sleep(50)
        res.destroy() // 强制断开，模拟上游崩溃 / 中转站掐流
      })

      const s = await requestStreaming(`${sut.origin}/v1/messages`, {
        method: 'POST',
        body: '{}',
        timeoutMs: 5000,
      })
      const out = await Promise.race([
        s.settled,
        sleep(3000).then(() => {
          throw new Error('上游断开后客户端请求 3s 内未收敛（挂死）')
        }),
      ])
      expect(out.ended || out.error, '请求既没正常结束也没报错').toBeTruthy()

      // 已收到的字节必须是上游所发内容的前缀 —— 不得凭空补出后半截 event
      const got = Buffer.concat(s.chunks)
      expect(got.length).toBeLessThanOrEqual(head.length)
      expect(head.subarray(0, got.length).equals(got), '响应里出现了上游从未发送的字节').toBe(true)
    },
  },

  {
    id: 'C10b',
    title: '上游非 SSE 响应中途断开 → 同样必须收敛',
    async run({ sut, upstream }) {
      const head = Buffer.from('前半截 body '.repeat(20), 'utf8')
      upstream.on(async (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.write(head)
        await sleep(50)
        res.destroy()
      })

      const s = await requestStreaming(`${sut.origin}/v1/messages`, {
        method: 'POST',
        body: '{}',
        timeoutMs: 5000,
      })
      const out = await Promise.race([
        s.settled,
        sleep(3000).then(() => {
          throw new Error('非 SSE 上游断开后客户端请求 3s 内未收敛（挂死）')
        }),
      ])
      expect(out.ended || out.error, '请求既没正常结束也没报错').toBeTruthy()

      const got = Buffer.concat(s.chunks)
      expect(got.length).toBeLessThanOrEqual(head.length)
      expect(head.subarray(0, got.length).equals(got), '响应里出现了上游从未发送的字节').toBe(true)
    },
  },

  {
    id: 'C11',
    title: '并发隔离：8 路并发不得串流（历史 bug：模块级 cid 互覆）',
    async run({ sut, upstream }) {
      upstream.on(async (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ echo: req.body.toString('utf8'), agent: req.headers['x-agent-id'] }))
      })

      const jobs = Array.from({ length: 8 }, (_, i) => {
        const agent = `agent-${i % 4}`
        const payload = JSON.stringify({ n: i, pad: 'x'.repeat(i * 128) })
        return httpRequest(`${sut.origin}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-agent-id': agent },
          body: payload,
        }).then((r) => ({ i, agent, payload, r }))
      })

      for (const { i, agent, payload, r } of await Promise.all(jobs)) {
        expect(r.status, `第 ${i} 路状态码异常`).toBe(200)
        const j = JSON.parse(r.body.toString('utf8'))
        expect(j.echo, `第 ${i} 路响应体串了`).toBe(payload)
        expect(j.agent, `第 ${i} 路 agent 串了`).toBe(agent)
      }
    },
  },
]
