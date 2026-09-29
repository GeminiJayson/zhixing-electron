import { describe, expect, it } from 'vitest'
import { describeRRule, formatRRule, parseRRule } from './recurrence'

describe('循环规则 · 序列化与解析成对', () => {
  it('format → parse 往返一致', () => {
    const cases = [
      { freq: 'daily' as const, interval: 1, count: null, until: null },
      { freq: 'weekly' as const, interval: 2, count: 5, until: null },
      { freq: 'monthly' as const, interval: 3, count: null, until: '2026-12-31' },
    ]
    for (const c of cases) expect(parseRRule(formatRRule(c))).toEqual(c)
  })

  it('interval 至少是 1（0 或负数会让 step 原地打转）', () => {
    expect(formatRRule({ freq: 'daily', interval: 0, count: null, until: null })).toContain('INTERVAL=1')
    expect(formatRRule({ freq: 'daily', interval: -3, count: null, until: null })).toContain('INTERVAL=1')
  })

  it('until 写成 RRULE 惯用的 YYYYMMDD（parseRRule 两种都认）', () => {
    const rule = formatRRule({ freq: 'daily', interval: 1, count: null, until: '2026-12-31' })
    expect(rule).toContain('UNTIL=20261231')
    expect(parseRRule(rule)?.until).toBe('2026-12-31')
  })

  it('没有 count / until 时不写这两个字段', () => {
    const rule = formatRRule({ freq: 'daily', interval: 1, count: null, until: null })
    expect(rule).toBe('FREQ=DAILY;INTERVAL=1')
  })

  it('COUNT=0 会被 parse 读成 0（立刻结束），所以界面不允许填 0', () => {
    // 这条守的是"界面别生成 0"：sequence 上 format 会 max(0)，0 是合法的但没意义
    expect(parseRRule('FREQ=DAILY;COUNT=0')?.count).toBe(0)
  })
})

describe('循环规则 · 人话描述', () => {
  it('间隔为 1 时不说「每 1 天」', () => {
    expect(describeRRule({ freq: 'daily', interval: 1, count: null, until: null })).toBe('每天，一直重复')
    expect(describeRRule({ freq: 'weekly', interval: 1, count: null, until: null })).toBe('每周，一直重复')
    expect(describeRRule({ freq: 'monthly', interval: 1, count: null, until: null })).toBe('每个月，一直重复')
  })

  it('带间隔时用中文量词', () => {
    expect(describeRRule({ freq: 'daily', interval: 3, count: null, until: null })).toContain('每 3 天')
    expect(describeRRule({ freq: 'weekly', interval: 2, count: null, until: null })).toContain('每 2 周')
    expect(describeRRule({ freq: 'monthly', interval: 2, count: null, until: null })).toContain('每 2 个月')
  })

  it('结束条件体现在描述里', () => {
    expect(describeRRule({ freq: 'daily', interval: 1, count: 5, until: null })).toBe('每天，共 5 次')
    expect(describeRRule({ freq: 'daily', interval: 1, count: null, until: '2026-01-01' })).toBe(
      '每天，直到 2026-01-01'
    )
  })
})
