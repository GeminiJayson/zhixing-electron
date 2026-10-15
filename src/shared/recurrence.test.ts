import { describe, expect, it } from 'vitest'
import {
  describeRRule,
  formatEndRule,
  formatRRule,
  nextRecurrence,
  parseRRule,
  rollRecurrence,
  saveRule,
  type RecurrenceSource,
} from './recurrence'

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

describe('循环推进 · 结束条件对每个档位都生效', () => {
  const task = (over: Partial<RecurrenceSource> = {}): RecurrenceSource => ({
    repeat_period: 'daily',
    repeat_rule: null,
    due_date: '2026-10-16',
    ...over,
  })

  it('每日 + 到某天为止：终点当天还能生成一期，越过就停', () => {
    expect(nextRecurrence(task({ repeat_rule: 'UNTIL=20261018' }), '2026-10-16')).toEqual([
      '2026-10-17',
      'UNTIL=20261018',
    ])
    // 这一期就落在终点当天：不再往下生成
    expect(nextRecurrence(task({ due_date: '2026-10-18', repeat_rule: 'UNTIL=20261018' }), '2026-10-18')).toEqual([
      null,
      null,
    ])
  })

  it('每周 / 每月也认结束条件（早先只有「自定义」会读规则串）', () => {
    const week = task({ repeat_period: 'weekly', due_date: '2026-10-14', repeat_rule: 'UNTIL=20261020' })
    expect(nextRecurrence(week, '2026-10-14')).toEqual([null, null])
    const month = task({ repeat_period: 'monthly', due_date: '2026-10-01', repeat_rule: 'COUNT=2' })
    expect(nextRecurrence(month, '2026-10-01')).toEqual(['2026-11-01', 'COUNT=1'])
  })

  it('COUNT 逐次递减，减到 1 之后不再生成', () => {
    const t = task({ repeat_rule: 'COUNT=3' })
    expect(nextRecurrence(t, '2026-10-16')).toEqual(['2026-10-17', 'COUNT=2'])
    const second = task({ due_date: '2026-10-17', repeat_rule: 'COUNT=2' })
    expect(nextRecurrence(second, '2026-10-17')).toEqual(['2026-10-18', 'COUNT=1'])
    const last = task({ due_date: '2026-10-18', repeat_rule: 'COUNT=1' })
    expect(nextRecurrence(last, '2026-10-18')).toEqual([null, null])
  })

  it('没写结束条件就还是「一直重复」', () => {
    expect(nextRecurrence(task(), '2026-10-16')).toEqual(['2026-10-17', null])
  })

  it('基准是完成日：拖了几天才勾，只生成一条，不追补一串逾期', () => {
    // 10-13 的每日任务拖到 10-16 才完成 → 下一期是 10-17，而不是 10-14
    expect(nextRecurrence(task({ due_date: '2026-10-13' }), '2026-10-16')).toEqual(['2026-10-17', null])
    // 每周任务同理：相位从完成日往后算
    const week = task({ repeat_period: 'weekly', due_date: '2026-10-07' })
    expect(nextRecurrence(week, '2026-10-16')).toEqual(['2026-10-23', null])
  })

  it('保存规则：截止日顺带当循环终点（没显式设结束条件时）', () => {
    // 选「每日」+ 截止日 10-20 → 存成 UNTIL，于是"到了那天就别再生成"
    expect(saveRule({ period: 'daily', rule: '', due: '2026-10-20' })).toBe('UNTIL=20261020')
    expect(saveRule({ period: 'weekly', rule: '', due: '2026-12-31' })).toBe('UNTIL=20261231')
    // 截止日留空 = 不设终点，一直重复
    expect(saveRule({ period: 'daily', rule: '', due: null })).toBeNull()
    // 用户显式设了结束条件就以它为准，不用截止日覆盖
    expect(saveRule({ period: 'daily', rule: 'COUNT=5', due: '2026-10-20' })).toBe('COUNT=5')
    expect(saveRule({ period: 'daily', rule: 'UNTIL=20261130', due: '2026-10-20' })).toBe('UNTIL=20261130')
    // 自定义档位保留频率/间隔
    expect(saveRule({ period: 'custom', rule: 'FREQ=WEEKLY;INTERVAL=2', due: '2026-10-20' })).toBe(
      'FREQ=WEEKLY;INTERVAL=2;UNTIL=20261020'
    )
    expect(saveRule({ period: 'none', rule: '', due: '2026-10-20' })).toBeNull()
  })

  it('只写结束条件的规则串（非自定义档位存的就是这种）', () => {
    expect(formatEndRule({ count: 5, until: null })).toBe('COUNT=5')
    expect(formatEndRule({ count: null, until: '2026-12-31' })).toBe('UNTIL=20261231')
    expect(formatEndRule({ count: null, until: null })).toBe('')
  })
})

describe('循环子任务 · 跨天重置', () => {
  const sub = (over: Record<string, unknown> = {}): RecurrenceSource & { last_reset_date?: string | null } => ({
    repeat_period: 'daily',
    repeat_rule: null,
    due_date: '2026-10-15',
    last_reset_date: null,
    ...over,
  })

  it('这一期到期了 → 重置到今天（今天就该做）', () => {
    expect(rollRecurrence(sub(), '2026-10-16')).toEqual({ due: '2026-10-16', rule: null })
  })

  it('还没到下一期就不动它（相位以上一期为准，不用今天重算）', () => {
    const weekly = sub({ repeat_period: 'weekly', due_date: '2026-10-14' })
    expect(rollRecurrence(weekly, '2026-10-16')).toBeNull()
  })

  it('COUNT 用完就停（早先子任务的 COUNT 从不递减，永远滚回待办）', () => {
    expect(rollRecurrence(sub({ repeat_rule: 'COUNT=2' }), '2026-10-16')).toEqual({
      due: '2026-10-16',
      rule: 'COUNT=1',
    })
    expect(rollRecurrence(sub({ repeat_rule: 'COUNT=1' }), '2026-10-16')).toBeNull()
  })

  it('UNTIL 已过就停', () => {
    expect(rollRecurrence(sub({ repeat_rule: 'UNTIL=20261015' }), '2026-10-16')).toBeNull()
    expect(rollRecurrence(sub({ repeat_rule: 'UNTIL=20261020' }), '2026-10-16')).toEqual({
      due: '2026-10-16',
      rule: 'UNTIL=20261020',
    })
  })

  it('非循环任务不参与', () => {
    expect(rollRecurrence(sub({ repeat_period: 'none' }), '2026-10-16')).toBeNull()
  })
})
