import { describe, expect, it } from 'vitest'
import { rangeLabel, taskProgress } from './date'

/** 造一个本地时刻，避免测试受时区影响。 */
const at = (s: string): Date => new Date(s)

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
