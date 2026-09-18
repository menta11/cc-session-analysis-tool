#!/usr/bin/env node
// 生成 SSE 分帧的差分 golden 文件。
//
// 为什么需要这个文件（重要）：
//   Rust spike 的字节保真是靠「原样转发上游 chunk」实现的，`split_sse_events()` **不在透传热路径上**
//   （Node 版也是这样：proxy.js 的数据回调只把原始 chunk 写给 client，splitSseEvents 仅服务
//   dashboard/capture 旁路）。所以端到端契约用例 C7 其实**测不到分帧器**——一个分帧器写坏的 Rust
//   实现照样能让 C7 全绿。而分帧器在 Stage 2 一旦为 dashboard 上热路径，就是风险最高的组件。
//
//   这里用方案里说的「录制的 golden file」思路补上这块证据：拿**真实** Node splitSseEvents
//   （从 proxy.js 正则抠出原文，不是手抄）跑一批对抗性输入，把「原始分片」与「有损解码结果」
//   全部落盘，交给 Rust 侧逐例比对。
//
// 用法: node test/proxy-contract/tools/gen-sse-golden.mjs
// 输出: test/proxy-contract/fixtures/sse-framing-golden.json   （入库，可复跑；生成是确定性的）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const PROXY = join(REPO, 'vendor/cc-monitor/proxy.js')
const OUT = join(REPO, 'test/proxy-contract/fixtures/sse-framing-golden.json')

// ── 1) 抠出真实的 splitSseEvents ─────────────────────────────────────
const src = readFileSync(PROXY, 'utf8')
const m = src.match(/function splitSseEvents\(buf\) \{[\s\S]*?\n\}/)
if (!m) throw new Error('无法从 proxy.js 抠出 splitSseEvents —— 实现变了？请同步更新本脚本')
const splitSseEvents = eval(`(${m[0]})`)

// ── 2) 分帧的「原始字节」版本（同一算法的可观测化）──────────────────
// 真实函数返回的是**有损解码后的字符串**，拿不回原始字节（非法字节已被 U+FFFD 顶掉）。
// 所以这里按同一算法独立算一份原始分片，并用交叉校验保证没漂移。
function frameRaw(buf) {
  const s = buf.toString('latin1')
  const parts = s.split(/\r?\n\r?\n/)
  const tail = parts.pop() || ''
  return { events: parts.map((p) => Buffer.from(p, 'latin1')), rest: Buffer.from(tail, 'latin1') }
}

const utf8Lossy = (b) => b.toString('utf8')
const isRoundTrippable = (b) => Buffer.from(utf8Lossy(b), 'utf8').equals(b)
const hex = (b) => b.toString('hex')

function record(name, buf) {
  const real = splitSseEvents(buf)
  const raw = frameRaw(buf)
  if (real.events.length !== raw.events.length) {
    throw new Error(`${name}: 分片数不一致（${real.events.length} vs ${raw.events.length}）—— 复制逻辑已漂移`)
  }
  real.events.forEach((decoded, i) => {
    const slice = raw.events[i]
    // 交叉校验：分片本身是合法 UTF-8 时，真实函数的解码结果必须能还原回该分片
    if (isRoundTrippable(slice) && !Buffer.from(decoded, 'utf8').equals(slice)) {
      throw new Error(`${name}: 第 ${i} 片是合法 UTF-8，但真实解码往返不一致`)
    }
  })
  return {
    name,
    input: hex(buf),
    events_raw: raw.events.map(hex),
    events_decoded: real.events.map((d) => hex(Buffer.from(d, 'utf8'))),
    rest_raw: hex(raw.rest),
  }
}

// ── 3) 确定性 PRNG + 对抗性语料 ──────────────────────────────────────
function lcg(seed) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
}
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)]

/** 真实上游用 \n\n；Node 实现显式兼容 \r\n。这里把所有变体都喂进去。 */
const SEPS = ['\n\n', '\r\n\r\n', '\n\r\n', '\r\n\n', '\r\r\n', '\r\n\r', '\r\r', '\n\n\n']
const TEXTS = ['你好🌏', '{"a":1}', 'plain', 'emoji🙂🚀', '—…✓', 'x'.repeat(40), '']

function structured(rnd, n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const eol = rnd() < 0.5 ? '\n' : '\r\n'
    out.push(`event: ev${i}${eol}data: {"i":${i},"t":"${pick(rnd, TEXTS)}"}`)
    out.push(pick(rnd, SEPS))
  }
  // 一半的用例故意以「不完整的分隔符或尾巴」结尾
  if (rnd() < 0.5) out.push(pick(rnd, ['\r', '\n', '\r\n', '\n\r', 'data: partial']))
  return Buffer.from(out.join(''), 'utf8')
}

function soup(rnd, len) {
  const parts = []
  let left = len
  while (left > 0) {
    if (rnd() < 0.18) {
      const s = Buffer.from(pick(rnd, SEPS), 'latin1')
      parts.push(s)
      left -= s.length
    } else {
      const b = Buffer.alloc(Math.min(1 + Math.floor(rnd() * 20), Math.max(1, left)))
      for (let i = 0; i < b.length; i++) b[i] = Math.floor(rnd() * 256)
      parts.push(b)
      left -= b.length
    }
  }
  return Buffer.concat(parts)
}

/** 把多字节字符切碎 + 混入分隔符：最容易暴露「累积时做 utf-8 解码」的写法 */
function slicedMultibyte(rnd) {
  const base = Buffer.from('你好🌏世界—…✓abc\ndata: ' + pick(rnd, TEXTS), 'utf8')
  const parts = []
  let i = 0
  while (i < base.length) {
    if (rnd() < 0.2) {
      parts.push(Buffer.from(pick(rnd, SEPS), 'latin1'))
    } else {
      const n = 1 + Math.floor(rnd() * 5)
      parts.push(base.subarray(i, Math.min(i + n, base.length)))
      i += n
    }
  }
  return Buffer.concat(parts)
}

const cases = []

// 3a) 固定边界用例
for (const [n, s] of [
  ['empty', ''],
  ['lf', '\n'],
  ['lf2', '\n\n'],
  ['crlf', '\r\n'],
  ['crlf2', '\r\n\r\n'],
  ['cr', '\r'],
  ['cr2', '\r\r'],
  ['a', 'a'],
  ['a-cr', 'a\r'],
  ['a-lf', 'a\n'],
  ['a-crlf', 'a\r\n'],
  ['lf-crlf', '\n\r\n'],
  ['crlf-lf', '\r\n\n'],
  ['lf2-crlf2', '\n\n\r\n\r\n'],
  ['sep-only-triple', '\n\n\n'],
  ['bare-event', 'event: ping'],
  ['bare-data', 'data: {"ok":true}'],
  ['data-then-cr', 'data: {"ok":true}\r'],
  ['data-then-lf', 'data: {"ok":true}\n'],
  ['done-nosep', 'data: [DONE]'],
]) {
  cases.push(record(`edge:${n}`, Buffer.from(s, 'utf8')))
}

// 3b) 结构化 SSE（随机分隔符 + 可选不完整尾巴）
{
  const rnd = lcg(0xc0ffee)
  for (let i = 0; i < 40; i++) cases.push(record(`structured:${i}`, structured(rnd, 1 + Math.floor(rnd() * 5))))
}

// 3c) 随机字节汤（注入分隔符，含非法 UTF-8）
{
  const rnd = lcg(0xdeadbeef)
  for (let i = 0; i < 60; i++) cases.push(record(`soup:${i}`, soup(rnd, 1 + Math.floor(rnd() * 180))))
}

// 3d) 多字节被切碎
{
  const rnd = lcg(0x1234abcd)
  for (let i = 0; i < 40; i++) cases.push(record(`multibyte:${i}`, slicedMultibyte(rnd)))
}

// ── 4) 落盘 ─────────────────────────────────────────────────────────
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify({ generated_by: 'test/proxy-contract/tools/gen-sse-golden.mjs', cases }, null, 1) + '\n')
const bytes = readFileSync(OUT).length
console.log(`[gen-sse-golden] ${cases.length} 个用例 → ${OUT.replace(REPO + '/', '')} (${(bytes / 1024).toFixed(0)} KB)`)
console.log('[gen-sse-golden] 其中含非法 UTF-8 的用例:', cases.filter((c) => c.events_decoded.some((h) => h.includes('efbfbd'))).length)
