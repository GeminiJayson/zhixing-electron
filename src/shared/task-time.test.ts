import { describe, expect, it } from 'vitest'
import { formatDuration, summarizeTaskTime, type PomodoroRow } from './task-time'

const row = (o: Partial<PomodoroRow>): PomodoroRow => ({
  task_id: 1,
  title: '任务',
  minutes: 25,
  started_at: '2026-10-01 09:00:00',
  ...o,
})

describe('formatDuration', () => {
  it('不到一小时只说分钟', () => {
    expect(formatDuration(0)).toBe('0 分')
    expect(formatDuration(45)).toBe('45 分')
    expect(formatDuration(59)).toBe('59 分')
  })

  it('整小时不带零头', () => {
    expect(formatDuration(60)).toBe('1 小时')
    expect(formatDuration(120)).toBe('2 小时')
  })

  it('小时 + 分钟', () => {
    expect(formatDuration(90)).toBe('1 小时 30 分')
  })

  it('坏输入当 0，不抛', () => {
    expect(formatDuration(Number.NaN)).toBe('0 分')
    expect(formatDuration(-30)).toBe('0 分')
  })
})

describe('summarizeTaskTime', () => {
  it('按任务合并分钟与次数', () => {
    const s = summarizeTaskTime([
      row({ task_id: 1, minutes: 25 }),
      row({ task_id: 1, minutes: 30, started_at: '2026-10-02 10:00:00' }),
      row({ task_id: 2, title: '另一件', minutes: 15 }),
    ])
    expect(s.total).toBe(70)
    expect(s.items.map((i) => [i.taskId, i.minutes, i.sessions])).toEqual([
      [1, 55, 2],
      [2, 15, 1],
    ])
    expect(s.items[0].lastAt).toBe('2026-10-02 10:00:00')
  })

  it('用时降序；同用时按最近排前', () => {
    const s = summarizeTaskTime([
      row({ task_id: 1, minutes: 25, started_at: '2026-10-01 09:00:00' }),
      row({ task_id: 2, title: 'B', minutes: 25, started_at: '2026-10-03 09:00:00' }),
      row({ task_id: 3, title: 'C', minutes: 50 }),
    ])
    expect(s.items.map((i) => i.taskId)).toEqual([3, 2, 1])
  })

  it('没挂任务的分钟单列出来，但仍然计入合计', () => {
    const s = summarizeTaskTime([row({ task_id: null, title: null, minutes: 25 })])
    expect(s.total).toBe(25)
    expect(s.unassigned).toBe(25)
    expect(s.items[0].title).toBe('（未挂任务）')
  })

  it('任务已删（task_id 还在但标题为 null）也有个可读名字', () => {
    const s = summarizeTaskTime([row({ task_id: 9, title: null, minutes: 25 })])
    expect(s.items[0].title).toContain('#9')
  })

  it('分钟为 0 或脏数据的行直接跳过', () => {
    const s = summarizeTaskTime([row({ minutes: 0 }), row({ minutes: null }), row({ minutes: 25 })])
    expect(s.total).toBe(25)
    expect(s.items).toHaveLength(1)
  })

  it('limit 只截断展示，合计仍是全量', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row({ task_id: i + 1, title: `T${i}`, minutes: 10 }))
    const s = summarizeTaskTime(rows, 3)
    expect(s.items).toHaveLength(3)
    expect(s.total).toBe(120)
  })

  it('空输入', () => {
    expect(summarizeTaskTime([])).toEqual({ total: 0, unassigned: 0, items: [] })
  })
})
