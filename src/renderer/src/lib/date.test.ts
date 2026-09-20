import { describe, expect, it } from 'vitest'
import { monthGrid, pad2, rangeLabel, taskProgress } from './date'

/** 造一个本地时刻，避免测试受时区影响。 */
const at = (s: string): Date => new Date(s)

describe('monthGrid —— 月历网格', () => {
  it('固定 6×7 = 42 格', () => {
    for (const [y, m] of [
      [2026, 8],
      [2024, 1],
      [2026, 0],
    ] as const) {
      expect(monthGrid(y, m)).toHaveLength(42)
    }
  })

  it('周一永远是第一列', () => {
    for (const [y, m] of [
      [2026, 8],
      [2024, 1],
      [2025, 11],
    ] as const) {
      const first = monthGrid(y, m)[0].day
      expect(new Date(first + 'T00:00:00Z').getUTCDay()).toBe(1) // 1 = 周一
    }
  })

  it('目标月的天数正确（含闰年 2 月）', () => {
    expect(monthGrid(2024, 1).filter((c) => c.inMonth)).toHaveLength(29)
    expect(monthGrid(2025, 1).filter((c) => c.inMonth)).toHaveLength(28)
    expect(monthGrid(2026, 8).filter((c) => c.inMonth)).toHaveLength(30)
  })

  it('只有首尾两段是补位的上下月', () => {
    const cells = monthGrid(2026, 8)
    const firstIn = cells.findIndex((c) => c.inMonth)
    const lastIn = cells.map((c) => c.inMonth).lastIndexOf(true)
    expect(firstIn).toBeGreaterThanOrEqual(0)
    expect(cells.slice(0, firstIn).every((c) => !c.inMonth)).toBe(true)
    expect(cells.slice(lastIn + 1).every((c) => !c.inMonth)).toBe(true)
    expect(cells.some((c) => c.day === '2026-09-01' && c.inMonth)).toBe(true)
  })

  it('跨年翻月不炸', () => {
    expect(monthGrid(2026, 11).some((c) => c.day === '2027-01-01')).toBe(true)
    expect(monthGrid(2027, 0).some((c) => c.day === '2026-12-31')).toBe(true)
  })

  it('pad2 补零', () => {
    expect(pad2(7)).toBe('07')
    expect(pad2(12)).toBe('12')
  })
})

describe('taskProgress —— 进度与色阶', () => {
  it('缺一头就没有进度（不硬算假数字）', () => {
    expect(taskProgress(null, null, '2026-09-30', null)).toBeNull()
    expect(taskProgress('2026-09-01', null, null, null)).toBeNull()
  })

  it('刚开始是 idle，过半后转 calm，最后三成转 soon', () => {
    // 09-01 00:00 ~ 09-11 00:00，共 10 天
    const args = ['2026-09-01', null, '2026-09-11', null] as const
    expect(taskProgress(...args, false, at('2026-08-31T12:00:00'))?.tone).toBe('idle')
    expect(taskProgress(...args, false, at('2026-09-02T00:00:00'))?.tone).toBe('calm')
    expect(taskProgress(...args, false, at('2026-09-09T00:00:00'))?.tone).toBe('soon')
  })

  it('过点之后是 overdue，ratio 大于 1', () => {
    const p = taskProgress('2026-09-01', null, '2026-09-11', null, false, at('2026-09-13T00:00:00'))
    expect(p?.tone).toBe('overdue')
    expect(p!.ratio).toBeGreaterThan(1)
    expect(p?.label).toContain('已超时')
  })

  it('截止时刻留空 = 当天结束前都算没到期', () => {
    // 当天 23:00 时仍应「没到期」，而不是 00:00 就过期
    const p = taskProgress('2026-09-01', '00:00', '2026-09-10', null, false, at('2026-09-10T23:00:00'))
    expect(p?.tone).not.toBe('overdue')
  })

  it('分钟真的参与计算（不是按天取整）', () => {
    // 09-10 09:00 ~ 09-10 11:00，10:30 时应当过半
    const p = taskProgress('2026-09-10', '09:00', '2026-09-10', '11:00', false, at('2026-09-10T10:30:00'))
    expect(p).not.toBeNull()
    expect(p!.ratio).toBeCloseTo(0.75, 5)
    expect(p?.tone).toBe('soon')
  })

  it('已完成一律是 done，且进度按满算', () => {
    const p = taskProgress('2026-09-01', null, '2026-09-02', null, true, at('2026-09-05T00:00:00'))
    expect(p).toEqual({ ratio: 1, tone: 'done', label: '已完成' })
  })

  it('起点晚于终点时不猜，返回 null', () => {
    expect(taskProgress('2026-09-10', null, '2026-09-01', null)).toBeNull()
  })

  it('坏日期不炸', () => {
    expect(taskProgress('不是日期', null, '2026-09-01', null)).toBeNull()
  })
})

describe('rangeLabel', () => {
  it('两端都有时用 ~ 连接，相同时只写一个', () => {
    expect(rangeLabel('2026-09-01', '2026-09-05')).toBe('2026-09-01 ~ 2026-09-05')
    expect(rangeLabel('2026-09-01', '2026-09-01')).toBe('2026-09-01')
  })

  it('只有一头时给对应说法', () => {
    expect(rangeLabel(null, '2026-09-05')).toBe('2026-09-05')
    expect(rangeLabel('2026-09-01', null)).toBe('2026-09-01 起')
    expect(rangeLabel(null, null)).toBe('')
  })
})
