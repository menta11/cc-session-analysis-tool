/**
 * C15：token 计数一致性 —— Rust `tiktoken-rs`(o200k_base) 必须与现状 Node
 * `gpt-tokenizer`(o200k_base) 对同一文本给出**完全相同的 token 数**。
 *
 * 为什么单独立一条：token 数是用户可见数值（TPS、输出 token 统计）。迁移后如果换了分词器
 * 或版本，数字会静默漂移，而且很难被功能测试发现——只能这样逐例比对。
 *
 * 注：Node 侧用 `gpt-tokenizer` 的 `encode`（会把 special token 当特殊标记），Rust 侧用
 * `tiktoken_rs` 的 `encode_ordinary`（总当普通文本）。两者仅在对 `"<|...|>"` 这类
 * **special token 字面量**上可能不同，而本应用统计的是模型输出文本，语料不含这类串。
 */
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  httpRequest,
  rustSut,
  startFakeUpstream,
  type FakeUpstream,
  type SutHandle,
} from './harness'

const require_ = createRequire(import.meta.url)
const { encode } = require_('gpt-tokenizer/cjs/encoding/o200k_base') as {
  encode: (text: string) => number[]
}

/** 覆盖 ASCII / 中文 / emoji / 组合 emoji / 代码 / 空白 / 长文本 / 边界 */
const CORPUS: Array<[name: string, text: string]> = [
  ['空串', ''],
  ['单空格', ' '],
  ['ASCII 短句', 'hello world'],
  ['英文句子', 'The quick brown fox jumps over the lazy dog.'],
  ['中文短语', '你好，世界'],
  ['中文长句', '这是一个用于验证 token 计数一致性的中文句子，包含标点、数字 12345 与 English mix。'],
  ['emoji（4 字节）', '🌏🤔✓'],
  ['组合 emoji（ZWJ + 旗）', '👨‍👩‍👧‍👦 🇨🇳'],
  ['中英混排 + 破折号', 'Claude Code 会话分析工具 v0.1.4 — TPS 统计…'],
  ['代码块', 'function f(x) {\n  return x?.map((i) => i + 1) ?? []\n}\n'],
  ['空白与换行', '   \n\t  \r\n \n'],
  ['JSON 片段', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}'],
  ['长文本（重复）', '你好，世界 🌏 '.repeat(200)],
  ['长文本（混合）', ('The quick brown fox 你好 🌏 '.repeat(50) + '\n').repeat(5)],
]

describe.skipIf(!rustSut.available())(
  `${rustSut.name} · token 计数一致性 C15`,
  () => {
    let upstream: FakeUpstream
    let sut: SutHandle

    beforeAll(async () => {
      upstream = await startFakeUpstream()
      sut = await rustSut.start({ upstream: upstream.origin })
    }, 40_000)

    afterAll(async () => {
      await sut?.stop()
      await upstream?.close()
    })

    // 先自证参照实现可用：如果 gpt-tokenizer 换了导出形态，这里要立刻显形，
    // 而不是让 14 条用例以「expected undefined」这种噪音方式失败。
    it('参照实现 gpt-tokenizer(o200k_base) 可用', () => {
      expect(typeof encode).toBe('function')
      expect(encode('hello world')).toHaveLength(2)
    })

    for (const [name, text] of CORPUS) {
      it(
        `${name} — ${Buffer.from(text, 'utf8').length} B / ${text.length} code units`,
        async () => {
          const expected = encode(text).length
          const r = await httpRequest(`${sut.origin}/tokencount`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
            timeoutMs: 10_000,
          })
          expect(r.status, `HTTP ${r.status}: ${r.body.toString('utf8').slice(0, 200)}`).toBe(200)
          const j = JSON.parse(r.body.toString('utf8')) as { tokens: number }
          expect(
            j.tokens,
            `token 数不一致：tiktoken-rs(o200k_base)=${j.tokens}，gpt-tokenizer(o200k_base)=${expected}`,
          ).toBe(expected)
        },
        20_000,
      )
    }

    it('长文本在 1 MB 级别也不漂移（TPS 统计的分母）', async () => {
      const text = 'analyze 中文 🌏 '.repeat(60_000) // ≈ 1 MB UTF-8
      expect(Buffer.from(text, 'utf8').length).toBeGreaterThan(900_000)
      const expected = encode(text).length
      const r = await httpRequest(`${sut.origin}/tokencount`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        timeoutMs: 30_000,
      })
      expect(r.status).toBe(200)
      expect((JSON.parse(r.body.toString('utf8')) as { tokens: number }).tokens).toBe(expected)
    }, 60_000)
  },
)
