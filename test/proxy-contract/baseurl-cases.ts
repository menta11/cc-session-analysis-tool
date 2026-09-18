/**
 * C12：base URL 解析优先级矩阵。
 * 解析在 SUT 启动时一次性完成，所以每一例都必须**独立起一个进程**。
 */
import { expect } from 'vitest'
import { settingsJson, type SutOptions } from './harness'

export interface BaseUrlStatus {
  monitoring: boolean
  current: string | null
  previous: string | null
  originalUrl: string
  proxyUrl: string
  directUrl: string
  settingsPath: string
  settingsKey: string
  available: boolean
  availableReason: string | null
}

export interface BaseUrlCase {
  id: string
  title: string
  /**
   * 端口由 `launchSut` 分配（这样端口冲突能自动重试）。
   * 需要把端口写进 settings.json 的用例（C12f 自指）用 `settingsFor(port)`，不要预先分配。
   */
  build(upstreamOrigin: string): SutOptions
  assert(s: BaseUrlStatus, ctx: { port: number; upstreamOrigin: string }): void
}

const ENV_A = 'https://env-a.example.com/api'
const SETTINGS_C = 'https://settings-c.example.com/v1'
const STATE_D = 'https://state-d.example.com'

export const BASE_URL_CASES: BaseUrlCase[] = [
  {
    id: 'C12a',
    title: '优先级 4：仅 ANTHROPIC_BASE_URL 环境变量',
    build: () => ({ env: { ANTHROPIC_BASE_URL: ENV_A } }),
    assert(s) {
      expect(s.directUrl).toBe(ENV_A)
      expect(s.available).toBe(true)
      expect(s.availableReason).toBeNull()
    },
  },
  {
    id: 'C12b',
    title: '优先级 1：仅 CC_MONITOR_TARGET',
    build: (upstream) => ({ upstream }),
    assert(s, { upstreamOrigin }) {
      expect(s.directUrl).toBe(upstreamOrigin)
      expect(s.available).toBe(true)
    },
  },
  {
    id: 'C12c',
    title: '优先级 1 > 4：CC_MONITOR_TARGET 压过 ANTHROPIC_BASE_URL',
    build: (upstream) => ({ upstream, env: { ANTHROPIC_BASE_URL: ENV_A } }),
    assert(s, { upstreamOrigin }) {
      expect(s.directUrl).toBe(upstreamOrigin)
      expect(s.available).toBe(true)
    },
  },
  {
    id: 'C12d',
    title: '优先级 2 > 4：settings.json 压过 ANTHROPIC_BASE_URL 环境变量',
    build: () => ({
      env: { ANTHROPIC_BASE_URL: ENV_A },
      settings: settingsJson(SETTINGS_C),
    }),
    assert(s) {
      expect(s.directUrl).toBe(SETTINGS_C)
      expect(s.current).toBe(SETTINGS_C)
      expect(s.available).toBe(true)
    },
  },
  {
    id: 'C12e',
    title: '优先级 3：state.json 的 previousBaseUrl 兜底',
    build: () => ({
      upstream: undefined,
      state: JSON.stringify({ previousBaseUrl: STATE_D }),
    }),
    assert(s) {
      expect(s.directUrl).toBe(STATE_D)
      expect(s.previous).toBe(STATE_D)
      expect(s.available).toBe(true)
    },
  },
  {
    id: 'C12f',
    title: '自指跳过：settings 指向本代理自己时继续往下一个来源找',
    build: () => ({
      env: { ANTHROPIC_BASE_URL: ENV_A },
      // 端口不由用例预分配：交给 launchSut，端口冲突重试时能一起换
      settingsFor: (port) => settingsJson(`http://localhost:${port}`),
    }),
    assert(s, { port }) {
      // 若实现没有跳过自指，这里会是 http://localhost:<port>（转发给自己 = 死循环）
      expect(s.current).toBe(`http://localhost:${port}`)
      expect(s.directUrl).toBe(ENV_A)
      expect(s.available).toBe(true)
    },
  },
  {
    id: 'C12g',
    title: '全部来源缺失 → 占位常量 + available=false（文案说「压根没配」）',
    build: () => ({}),
    assert(s) {
      expect(s.directUrl).toBe('https://api.anthropic.com')
      expect(s.available).toBe(false)
      expect(typeof s.availableReason).toBe('string')
      expect((s.availableReason || '').length).toBeGreaterThan(0)
      expect(s.availableReason).toContain('未配置')
    },
  },
  {
    id: 'C12h',
    title: 'URL 非法 → 跳过；available=false 且文案区分于「没配」',
    build: () => ({ env: { ANTHROPIC_BASE_URL: 'not a url' } }),
    assert(s) {
      expect(s.directUrl).toBe('https://api.anthropic.com')
      expect(s.available).toBe(false)
      expect(s.availableReason).toContain('非法')
      // 与 C12g 的「压根没配」必须是两种不同文案，否则用户照着改不好
      expect(s.availableReason).not.toContain('未配置上游 API 地址')
    },
  },
]
