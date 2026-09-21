import { describe, expect, it } from 'vitest'
import { decideReminder, reminderBaseAt, type ReminderPolicy, type ReminderTask } from './reminder'

/**
 * 提醒策略：提前量 / 自动提醒规则 / 重复次数。
 *
 * 三条语义（设置页可配）：
 *   ① 提前量只对「没手动设提醒时刻」的任务生效 —— 手动设过的以手动为准；
 *   ② 规则决定哪些任务会自动生成提醒（有截止时刻的 / 只有截止日期的当天某点 / 优先级下限）；
 *   ③ 次数 + 间隔：同一条任务最多提醒几次、每次隔多久。
 */
const policy = (o: Partial<ReminderPolicy> = {}): ReminderPolicy => ({
  leadMinutes: 0,
  forTimed: true,
  forUntimed: true,
  dayClock: '09:00',
  priorityMin: 0,
  repeatCount: 1,
  repeatIntervalMinutes: 10,
  ...o
})
const task = (o: Partial<ReminderTask> = {}): ReminderTask => ({
  status: 'todo',
  priority: 0,
  due_date: null,
  due_time: null,
  reminder_at: null,
  reminder_fired: 0,
  reminder_base: null,
  ...o
})
const at = (s: string): Date => new Date(s)

describe('reminderBaseAt —— 基准时刻', () => {
  it('手动设了提醒时刻就以它为准，提前量不参与', () => {
    const t = task({ due_date: '2026-09-20', due_time: '18:00', reminder_at: '2026-09-20 17:30:00.000000' })
    expect(reminderBaseAt(t, policy({ leadMinutes: 60 }))).toBe('2026-09-20 17:30:00')
  })

  it('有截止时刻且规则开着 → 基准就是截止时刻', () => {
    expect(reminderBaseAt(task({ due_date: '2026-09-20', due_time: '18:00' }), policy())).toBe(
      '2026-09-20 18:00:00'
    )
  })

  it('规则关掉就不自动提醒', () => {
    const t = task({ due_date: '2026-09-20', due_time: '18:00' })
    expect(reminderBaseAt(t, policy({ forTimed: false }))).toBe('')
  })

  it('只有截止日期 → 用当天设定时刻（默认 09:00）', () => {
    expect(reminderBaseAt(task({ due_date: '2026-09-20' }), policy())).toBe('2026-09-20 09:00:00')
    expect(reminderBaseAt(task({ due_date: '2026-09-20' }), policy({ dayClock: '20:30' }))).toBe(
      '2026-09-20 20:30:00'
    )
  })

  it('只有截止日期、但日期规则关掉 → 不提醒', () => {
    expect(reminderBaseAt(task({ due_date: '2026-09-20' }), policy({ forUntimed: false }))).toBe('')
  })

  it('没有截止也没有提醒时刻 → 不提醒', () => {
    expect(reminderBaseAt(task(), policy())).toBe('')
  })

  it('优先级下限只筛自动提醒，不管手动设的', () => {
    const low = task({ due_date: '2026-09-20', due_time: '18:00', priority: 2 })
    expect(reminderBaseAt(low, policy({ priorityMin: 5 }))).toBe('')
    expect(reminderBaseAt(low, policy({ priorityMin: 0 }))).toBe('2026-09-20 18:00:00')
    // 手动设的提醒不受优先级下限影响 —— 那是用户显式要求的
    const manual = task({ due_date: '2026-09-20', due_time: '18:00', priority: 2, reminder_at: '2026-09-20 17:00:00.000000' })
    expect(reminderBaseAt(manual, policy({ priorityMin: 5 }))).toBe('2026-09-20 17:00:00')
  })
})

describe('decideReminder —— 该不该提醒、算到第几次', () => {
  it('提前量把触发时刻提前', () => {
    const t = task({ due_date: '2026-09-20', due_time: '18:00' })
    const p = policy({ leadMinutes: 30 })
    expect(decideReminder(t, p, at('2026-09-20T17:29:00')).fire).toBe(false)
    expect(decideReminder(t, p, at('2026-09-20T17:30:00')).fire).toBe(true)
  })

  it('提前量为 0 时就按基准时刻触发', () => {
    const t = task({ due_date: '2026-09-20', due_time: '18:00' })
    expect(decideReminder(t, policy(), at('2026-09-20T17:59:00')).fire).toBe(false)
    expect(decideReminder(t, policy(), at('2026-09-20T18:00:00')).fire).toBe(true)
  })

  it('只提醒一次：第一次触发时就要判定为「已用完」（否则 reminder_at 永不清空）', () => {
    const t = task({ due_date: '2026-09-20', due_time: '18:00' })
    const d = decideReminder(t, policy(), at('2026-09-20T18:00:00'))
    expect(d.fire).toBe(true)
    expect(d.fired).toBe(1)
    expect(d.done, '第一次就是最后一次').toBe(true)
  })

  it('只提醒一次时，提醒过就不再提醒', () => {
    const t = task({ due_date: '2026-09-20', due_time: '18:00', reminder_fired: 1, reminder_base: '2026-09-20 18:00:00' })
    const d = decideReminder(t, policy(), at('2026-09-20T18:05:00'))
    expect(d.fire).toBe(false)
    expect(d.done).toBe(true)
  })

  it('配了 3 次 / 间隔 10 分钟：第 1、2、3 次分别在 0、10、20 分钟触发', () => {
    const p = policy({ repeatCount: 3, repeatIntervalMinutes: 10 })
    const base = '2026-09-20 18:00:00'
    const mk = (fired: number): ReminderTask =>
      task({ due_date: '2026-09-20', due_time: '18:00', reminder_fired: fired, reminder_base: base })
    expect(decideReminder(mk(0), p, at('2026-09-20T17:59:00')).fire).toBe(false)
    expect(decideReminder(mk(0), p, at('2026-09-20T18:00:00')).fire).toBe(true)
    expect(decideReminder(mk(1), p, at('2026-09-20T18:09:00')).fire).toBe(false)
    expect(decideReminder(mk(1), p, at('2026-09-20T18:10:00')).fire).toBe(true)
    expect(decideReminder(mk(2), p, at('2026-09-20T18:20:00')).fire).toBe(true)
    const last = decideReminder(mk(3), p, at('2026-09-20T18:30:00'))
    expect(last.fire).toBe(false)
    expect(last.done).toBe(true)
  })

  it('提醒后写回的是「这一次」的次数', () => {
    const p = policy({ repeatCount: 3 })
    const t = task({ due_date: '2026-09-20', due_time: '18:00', reminder_fired: 1, reminder_base: '2026-09-20 18:00:00' })
    // 第 2 次在「基准 + 间隔」；基准那一刻是第一轮的事
    const d = decideReminder(t, p, at('2026-09-20T18:10:00'))
    expect(d.fire).toBe(true)
    expect(d.fired).toBe(2)
    expect(d.done).toBe(false)
  })

  it('基准变了就重新计数（改了截止日期不该被旧计数卡住）', () => {
    const t = task({
      due_date: '2026-09-21',
      due_time: '18:00',
      reminder_fired: 5,
      reminder_base: '2026-09-20 18:00:00'
    })
    const d = decideReminder(t, policy({ repeatCount: 3 }), at('2026-09-21T18:00:00'))
    expect(d.base).toBe('2026-09-21 18:00:00')
    expect(d.fired).toBe(1)
    expect(d.fire).toBe(true)
  })

  it('终态任务不提醒', () => {
    const t = task({ status: 'done', due_date: '2026-09-20', due_time: '18:00' })
    expect(decideReminder(t, policy(), at('2026-09-20T18:30:00')).fire).toBe(false)
  })
})
