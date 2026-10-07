import { describe, expect, it } from 'vitest'
import { addDays, groupTasksByDate, weekdayLabels } from './calendar'
import type { Task } from './types'

/** 造一个只带口径相关字段的任务（其余给默认值，测试只关心落格）。 */
const task = (over: Partial<Task>): Task =>
  ({
    id: 1,
    title: 't',
    status: 'todo',
    priority: 0,
    sort_key: 1,
    start_date: null,
    due_date: null,
    ...over,
  }) as Task

const days = (m: Map<string, Task[]>): string[] => [...m.keys()].sort()

describe('groupTasksByDate · 口径', () => {
  const span = task({ id: 1, start_date: '2026-03-02', due_date: '2026-03-04' })

  it('range：开始～截止之间每一天都出现（含两端）', () => {
    const m = groupTasksByDate([span], '2026-03-10', { spanMode: 'range', noDate: 'today' })
    expect(days(m)).toEqual(['2026-03-02', '2026-03-03', '2026-03-04'])
  })

  it('due：只落截止日', () => {
    const m = groupTasksByDate([span], '2026-03-10', { spanMode: 'due', noDate: 'today' })
    expect(days(m)).toEqual(['2026-03-04'])
  })

  it('start：只落开始日', () => {
    const m = groupTasksByDate([span], '2026-03-10', { spanMode: 'start', noDate: 'today' })
    expect(days(m)).toEqual(['2026-03-02'])
  })

  it('只有一端时各口径都落那一端', () => {
    const onlyDue = task({ id: 2, due_date: '2026-03-05' })
    const onlyStart = task({ id: 3, start_date: '2026-03-06' })
    for (const spanMode of ['range', 'due', 'start'] as const) {
      const m = groupTasksByDate([onlyDue, onlyStart], '2026-03-10', { spanMode, noDate: 'today' })
      expect(days(m)).toEqual(['2026-03-05', '2026-03-06'])
    }
  })

  it('开始晚于截止时按区间处理，不会一个格子都不落', () => {
    const reversed = task({ id: 4, start_date: '2026-03-08', due_date: '2026-03-06' })
    const m = groupTasksByDate([reversed], '2026-03-10', { spanMode: 'range', noDate: 'today' })
    expect(days(m)).toEqual(['2026-03-06', '2026-03-07', '2026-03-08'])
  })

  it('区间过长时截断到上限，不会一直铺下去', () => {
    const huge = task({ id: 5, start_date: '2000-01-01', due_date: '2099-12-31' })
    const m = groupTasksByDate([huge], '2026-03-10', { spanMode: 'range', noDate: 'today' })
    expect(m.size).toBe(3661)
    expect(m.has('2000-01-01')).toBe(true)
  })
})

describe('groupTasksByDate · 无日期', () => {
  const noDate = task({ id: 9 })

  it('today：归入今日', () => {
    const m = groupTasksByDate([noDate], '2026-03-10', { spanMode: 'range', noDate: 'today' })
    expect([...m.keys()]).toEqual(['2026-03-10'])
  })

  it('hide：不出现', () => {
    const m = groupTasksByDate([noDate], '2026-03-10', { spanMode: 'range', noDate: 'hide' })
    expect(m.size).toBe(0)
  })
})

describe('groupTasksByDate · 同一天内的排序', () => {
  it('按 (-priority, sort_key, id) 升序', () => {
    const a = task({ id: 1, due_date: '2026-03-02', priority: 0, sort_key: 5 })
    const b = task({ id: 2, due_date: '2026-03-02', priority: 2, sort_key: 9 })
    const c = task({ id: 3, due_date: '2026-03-02', priority: 0, sort_key: 1 })
    const m = groupTasksByDate([a, b, c], '2026-03-10')
    expect(m.get('2026-03-02')!.map((t) => t.id)).toEqual([2, 3, 1])
  })
})

describe('addDays / weekdayLabels', () => {
  it('跨月与跨年都算对', () => {
    expect(addDays('2026-03-31', 1)).toBe('2026-04-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
  })
  it('表头跟着周起始轮转', () => {
    expect(weekdayLabels('mon')).toEqual(['一', '二', '三', '四', '五', '六', '日'])
    expect(weekdayLabels('sun')).toEqual(['日', '一', '二', '三', '四', '五', '六'])
  })
})
