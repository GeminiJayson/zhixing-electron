import { describe, expect, it } from 'vitest'
import { ganttBar, ganttPct, ganttWindow, dayNo, GANTT_COLUMNS } from './gantt'

/** 造一个只带口径相关字段的任务（其余给默认值，测试只关心条的位置）。 */
const task = (over: { start_date?: string | null; due_date?: string | null }) => ({
  start_date: null,
  due_date: null,
  ...over,
})

const TODAY = '2026-10-16'

describe('ganttWindow · 视窗与刻度', () => {
  it('日档：每列一天，从 anchor 当天起铺 14 列', () => {
    const win = ganttWindow('day', '2026-10-15', TODAY)
    expect(win.start).toBe('2026-10-15')
    expect(win.end).toBe('2026-10-28')
    expect(win.days).toBe(14)
    expect(win.cells).toHaveLength(GANTT_COLUMNS.day)
    expect(win.cells[0]).toMatchObject({ start: '2026-10-15', end: '2026-10-15', label: '15', sub: '四' })
    // 表头副标签是周几：10-16 是周五
    expect(win.cells[1]).toMatchObject({ start: '2026-10-16', label: '16', sub: '五' })
  })

  it('日档：今天落在哪一列有标记，且只有一列', () => {
    const win = ganttWindow('day', '2026-10-15', TODAY)
    expect(win.cells.filter((c) => c.today).map((c) => c.start)).toEqual(['2026-10-16'])
  })

  it('周档：锚点对齐到该周首日，每列七天', () => {
    // 2026-10-15 是周四 → 周一 10-12
    const win = ganttWindow('week', '2026-10-15', TODAY)
    expect(win.start).toBe('2026-10-12')
    expect(win.cells[0]).toMatchObject({ start: '2026-10-12', end: '2026-10-18', label: '10/12' })
    expect(win.end).toBe('2027-01-03')
    expect(win.days).toBe(12 * 7)
    expect(win.cells.every((c) => c.sub === '')).toBe(true)
  })

  it('周档：周起始是周日时窗口跟着挪一天（与日历列序同一份设置）', () => {
    const win = ganttWindow('week', '2026-10-15', TODAY, 'sun')
    expect(win.start).toBe('2026-10-11')
  })

  it('月档：锚点对齐到当月 1 号，每列一个月，跨年那一列带年份', () => {
    const win = ganttWindow('month', '2026-10-15', TODAY)
    expect(win.start).toBe('2026-10-01')
    expect(win.end).toBe('2027-09-30')
    expect(win.days).toBe(365)
    expect(win.cells[0]).toMatchObject({ start: '2026-10-01', end: '2026-10-31', label: '10月' })
    // 第 4 列是 2027 年 1 月：光写「1月」在跨年视窗里会读成上一年
    expect(win.cells[3]).toMatchObject({ start: '2027-01-01', end: '2027-01-31', label: '27年1月' })
    expect(win.cells.filter((c) => c.today).map((c) => c.start)).toEqual(['2026-10-01'])
  })

  it('月档天数不等于 30×12（2 月与大小月都要算准）', () => {
    const win = ganttWindow('month', '2027-02-10', '2027-02-10')
    expect(win.start).toBe('2027-02-01')
    expect(win.cells[0]).toMatchObject({ end: '2027-02-28' })
    // 2027-02-01 ~ 2028-01-31 共 365 天
    expect(win.days).toBe(365)
  })

  it('anchor 非法时退回今天', () => {
    const win = ganttWindow('day', 'not-a-date', TODAY)
    expect(win.start).toBe(TODAY)
  })
})

describe('ganttBar · 任务条几何', () => {
  const win = ganttWindow('day', '2026-10-15', TODAY) // 10-15 ~ 10-28，共 14 天

  it('两端都有：从开始日铺到截止日当天结束（含两端）', () => {
    const bar = ganttBar(task({ start_date: '2026-10-16', due_date: '2026-10-18' }), win)
    // 10-16 起偏移 1 天，10-18 结束 → 到偏移 4 天（3 天宽）
    expect(bar).toMatchObject({ left: (1 / 14) * 100, width: (3 / 14) * 100, kind: 'range' })
    expect(bar?.clipStart).toBe(false)
    expect(bar?.clipEnd).toBe(false)
  })

  it('同一天开始与截止 = 一格', () => {
    const bar = ganttBar(task({ start_date: '2026-10-20', due_date: '2026-10-20' }), win)
    expect(bar).toMatchObject({ left: (5 / 14) * 100, width: (1 / 14) * 100 })
  })

  it('只有截止 / 只有开始：一格标记，kind 分得开', () => {
    const due = ganttBar(task({ due_date: '2026-10-20' }), win)
    expect(due).toMatchObject({ left: (5 / 14) * 100, width: (1 / 14) * 100, kind: 'due' })
    const start = ganttBar(task({ start_date: '2026-10-15' }), win)
    expect(start).toMatchObject({ left: 0, width: (1 / 14) * 100, kind: 'start' })
  })

  it('起止写反了也按区间画（与日历的防御同一条）', () => {
    const bar = ganttBar(task({ start_date: '2026-10-20', due_date: '2026-10-16' }), win)
    expect(bar).toMatchObject({ left: (1 / 14) * 100, width: (5 / 14) * 100 })
  })

  it('越过视窗两端：裁到边界并标出被切的那一头', () => {
    const left = ganttBar(task({ start_date: '2026-10-01', due_date: '2026-10-16' }), win)
    expect(left).toMatchObject({ left: 0, kind: 'range' })
    expect(left?.clipStart).toBe(true)
    expect(left?.clipEnd).toBe(false)
    expect(left?.width).toBe((2 / 14) * 100)

    const right = ganttBar(task({ start_date: '2026-10-27', due_date: '2026-12-01' }), win)
    expect(right?.clipStart).toBe(false)
    expect(right?.clipEnd).toBe(true)
    expect(right?.left).toBe((12 / 14) * 100)
    expect(right?.width).toBe((2 / 14) * 100)
  })

  it('整条都在视窗外就不画', () => {
    expect(ganttBar(task({ due_date: '2026-11-20' }), win)).toBeNull()
    expect(ganttBar(task({ start_date: '2026-09-01', due_date: '2026-10-01' }), win)).toBeNull()
  })

  it('没有日期、或日期是哨兵/垃圾值都不画', () => {
    expect(ganttBar(task({}), win)).toBeNull()
    expect(ganttBar(task({ due_date: '0000-00-00' }), win)).toBeNull()
  })

  it('远在过去的哨兵日期不会伪造出一条顶到左边界的长条', () => {
    // 1753-09-14 是库里出现过的哨兵值；它与今天的视窗毫无交集
    expect(ganttBar(task({ due_date: '1753-09-14' }), win)).toBeNull()
  })
})

describe('dayNo / ganttPct', () => {
  it('日期串 → 天数，非法返回 null', () => {
    expect(dayNo('2026-10-15')).toBe(Math.round(Date.parse('2026-10-15T00:00:00Z') / 86400000))
    expect(dayNo('2026-13-01')).toBeNull()
    expect(dayNo('')).toBeNull()
    expect(dayNo(null)).toBeNull()
  })

  it('百分比：起点 0、终点 1', () => {
    const win = ganttWindow('day', '2026-10-15', TODAY)
    expect(ganttPct(win, '2026-10-15')).toBe(0)
    expect(ganttPct(win, '2026-10-29')).toBe(1)
    expect(ganttPct(win, 'bad')).toBeNull()
  })
})
