import { describe, expect, it } from 'vitest'
import {
  buildHabitViews,
  computeStreak,
  dayDiff,
  shiftDay,
  todayKey,
  type Habit,
  type HabitLog,
} from './habit'

const habit = (o: Partial<Habit> = {}): Habit => ({
  id: 1,
  name: '喝水',
  icon: '',
  color: '',
  archived_at: null,
  sort_key: 0,
  created_at: '2026-01-01 09:00:00',
  ...o,
})

/** 造一串打卡记录：从 today 往回数 days 天各打一次 */
const recent = (id: number, today: string, days: number[]): HabitLog[] =>
  days.map((d) => ({ habit_id: id, day: shiftDay(today, -d) }))

describe('shiftDay —— 本地日历日加减', () => {
  it('跨月、跨年', () => {
    expect(shiftDay('2026-10-01', -1)).toBe('2026-09-30')
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftDay('2026-02-28', 1)).toBe('2026-03-01')
  })

  it('闰年 2 月', () => {
    expect(shiftDay('2024-02-28', 1)).toBe('2024-02-29')
    expect(shiftDay('2024-02-29', 1)).toBe('2024-03-01')
  })

  it('坏输入原样返回，不抛', () => {
    expect(shiftDay('不是日期', 1)).toBe('不是日期')
  })
})

describe('todayKey', () => {
  it('取本地日期（sv-SE 就是 YYYY-MM-DD）', () => {
    expect(todayKey(new Date(2026, 9, 4, 23, 30))).toBe('2026-10-04')
  })
})

describe('computeStreak', () => {
  const today = '2026-10-04'

  it('今天打过卡就从今天数', () => {
    const done = new Set([today, '2026-10-03', '2026-10-02'])
    expect(computeStreak(done, today)).toBe(3)
  })

  it('今天还没打不算断 —— 从昨天数', () => {
    const done = new Set(['2026-10-03', '2026-10-02'])
    expect(computeStreak(done, today)).toBe(2)
  })

  it('断一天就停', () => {
    const done = new Set([today, '2026-10-03', '2026-10-01'])
    expect(computeStreak(done, today)).toBe(2)
  })

  it('昨天和今天都没打就是 0', () => {
    expect(computeStreak(new Set(['2026-10-01']), today)).toBe(0)
    expect(computeStreak(new Set(), today)).toBe(0)
  })
})

describe('buildHabitViews', () => {
  const today = '2026-10-04'

  it('周条是「6 天前 → 今天」的顺序，长度为 7', () => {
    const logs = [{ habit_id: 1, day: today }, { habit_id: 1, day: '2026-10-02' }]
    const [v] = buildHabitViews([habit()], logs, today)
    expect(v.week).toHaveLength(7)
    expect(v.week[6]).toBe(true)
    // 10-02 是 2 天前 → index 4
    expect(v.week[4]).toBe(true)
    expect(v.week[5]).toBe(false)
  })

  it('doneToday 与连续天数', () => {
    const logs = recent(1, today, [0, 1, 2])
    const [v] = buildHabitViews([habit()], logs, today)
    expect(v.doneToday).toBe(true)
    expect(v.streak).toBe(3)
  })

  it('完成率的分母按「创建以来」算，不是永远 30 天', () => {
    // 昨天建的、今天打卡：分母 2 天、命中 1 次 → 0.5
    const h = habit({ created_at: '2026-10-03 10:00:00' })
    const [v] = buildHabitViews([h], [{ habit_id: 1, day: today }], today)
    expect(v.rate).toBeCloseTo(0.5)
  })

  it('创建当天打卡就是 100%', () => {
    const h = habit({ created_at: '2026-10-04 08:00:00' })
    const [v] = buildHabitViews([h], [{ habit_id: 1, day: today }], today)
    expect(v.rate).toBe(1)
  })

  it('超过窗口的旧记录不拉高完成率', () => {
    const logs = recent(1, today, Array.from({ length: 40 }, (_, i) => i))
    const [v] = buildHabitViews([habit()], logs, today)
    expect(v.rate).toBe(1)
  })

  it('归档的排在未归档之后，其余按 sort_key', () => {
    const list = [
      habit({ id: 1, name: 'A', sort_key: 2 }),
      habit({ id: 2, name: 'B', sort_key: 1 }),
      habit({ id: 3, name: 'C', sort_key: 0, archived_at: '2026-09-01 00:00:00' }),
    ]
    expect(buildHabitViews(list, [], today).map((v) => v.id)).toEqual([2, 1, 3])
  })

  it('没有任何打卡记录也能出视图（连续 0、完成率 0）', () => {
    const [v] = buildHabitViews([habit()], [], today)
    expect(v.streak).toBe(0)
    expect(v.rate).toBe(0)
    expect(v.week.every((x) => x === false)).toBe(true)
  })

  it('别的习惯的记录不会串台', () => {
    const list = [habit({ id: 1 }), habit({ id: 2 })]
    const views = buildHabitViews(list, recent(2, today, [0]), today)
    expect(views.find((v) => v.id === 1)?.doneToday).toBe(false)
    expect(views.find((v) => v.id === 2)?.doneToday).toBe(true)
  })
})

describe('dayDiff', () => {
  it('按日历日算差值', () => {
    expect(dayDiff('2026-10-01', '2026-10-04')).toBe(3)
    expect(dayDiff('2026-10-04', '2026-10-04')).toBe(0)
    expect(dayDiff('2026-10-04', '2026-10-01')).toBe(-3)
  })

  it('跨夏令时也按整天算（用本地零点差，再四舍五入）', () => {
    expect(dayDiff('2026-03-07', '2026-03-09')).toBe(2)
  })
})
