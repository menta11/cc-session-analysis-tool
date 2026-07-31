import { describe, it, expect } from 'vitest'
import { extractStructuredResult } from '../core/parser/toolResult'

describe('extractStructuredResult', () => {
  it('extracts Bash stdout/stderr/interrupted', () => {
    const r = extractStructuredResult('Bash', { stdout: 'ok\n', stderr: 'warn', interrupted: false })
    expect(r).toMatchObject({ toolName: 'Bash', stdout: 'ok\n', stderr: 'warn', interrupted: false })
  })

  it('extracts Edit diff fields', () => {
    const r = extractStructuredResult('Edit', {
      filePath: '/a.txt',
      oldString: 'x',
      newString: 'y',
      replaceAll: true,
      structuredPatch: [{ oldStart: 1 }],
    })
    expect(r).toMatchObject({
      toolName: 'Edit',
      filePath: '/a.txt',
      oldString: 'x',
      newString: 'y',
      replaceAll: true,
    })
  })

  it('extracts Agent aggregation (agentId/type/durations/tokens/isAsync)', () => {
    const r = extractStructuredResult('Agent', {
      agentId: 'abc',
      agentType: 'general-purpose',
      totalDurationMs: 12345,
      totalTokens: 1000,
      totalToolUseCount: 5,
      isAsync: false,
      description: 'do thing',
      resolvedModel: 'claude-x',
    })
    expect(r).toMatchObject({
      toolName: 'Agent',
      agentId: 'abc',
      agentType: 'general-purpose',
      totalDurationMs: 12345,
      totalTokens: 1000,
      totalToolUseCount: 5,
      isAsync: false,
    })
  })

  it('extracts Glob counts and durationMs', () => {
    const r = extractStructuredResult('Glob', { numFiles: 5, totalMatches: 5, durationMs: 305 })
    expect(r).toMatchObject({ toolName: 'Glob', numFiles: 5, totalMatches: 5, durationMs: 305 })
  })

  it('returns null for non-object toolUseResult (array/string/null)', () => {
    expect(extractStructuredResult('Bash', 'not an object')).toBeNull()
    expect(extractStructuredResult('Bash', [1, 2, 3])).toBeNull()
    expect(extractStructuredResult('Bash', null)).toBeNull()
  })

  it('returns null for tools without a specialized extractor', () => {
    expect(extractStructuredResult('WebFetch', { foo: 1 })).toBeNull()
  })
})
