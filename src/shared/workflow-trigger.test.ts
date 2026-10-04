import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SCHEDULE,
  describeSchedule,
  describeTriggers,
  dueByDaily,
  dueByInterval,
  makeTriggerToken,
  parseSchedule,
  parseTriggers,
  serializeSchedule,
  serializeTriggers,
  type WorkflowSchedule,
} from './workflow-trigger'

const MANUAL: WorkflowSchedule = { kind: 'manual' }

describe('parseSchedule —— 坏输入一律退回手动，不抛异常', () => {
  it.each([null, undefined, ''])('空值（%s）', (raw) => {
    expect(parseSchedule(raw)).toEqual(MANUAL)
  })

  it.each(['{ 不是 JSON', '[]', '"文本"', '42', 'null'])('非对象或坏 JSON（%s）', (raw) => {
    expect(parseSchedule(raw)).toEqual(MANUAL)
  })

  it('未知的 kind 退回手动', () => {
    expect(parseSchedule(JSON.stringify({ kind: '每周' }))).toEqual(MANUAL)
  })

  it('interval 小于 1 分钟没有意义，还会让调度器忙等 —— 退回手动', () => {
    expect(parseSchedule(JSON.stringify({ kind: 'interval', everyMin: 0 }))).toEqual(MANUAL)
    expect(parseSchedule(JSON.stringify({ kind: 'interval', everyMin: -5 }))).toEqual(MANUAL)
    expect(parseSchedule(JSON.stringify({ kind: 'interval' }))).toEqual(MANUAL)
    expect(parseSchedule(JSON.stringify({ kind: 'interval', everyMin: 'abc' }))).toEqual(MANUAL)
  })

  it('interval 上限是一天（1440 分钟）', () => {
    expect(parseSchedule(JSON.stringify({ kind: 'interval', everyMin: 99999 }))).toEqual({ kind: 'interval', everyMin: 1440 })
  })

  it('interval 的小数向下取整', () => {
    expect(parseSchedule(JSON.stringify({ kind: 'interval', everyMin: 2.9 }))).toEqual({ kind: 'interval', everyMin: 2 })
  })

  it.each(['25:00', '09:60', '9', 'abc', '', '-1:00'])('daily 的时间不合法（%s）退回手动', (at) => {
    expect(parseSchedule(JSON.stringify({ kind: 'daily', at }))).toEqual(MANUAL)
  })

  it('daily 接受一位数小时（9:05）', () => {
    expect(parseSchedule(JSON.stringify({ kind: 'daily', at: '9:05' }))).toEqual({ kind: 'daily', at: '9:05' })
  })

  it('边界时刻 00:00 与 23:59 都合法', () => {
    expect(parseSchedule(JSON.stringify({ kind: 'daily', at: '00:00' }))).toEqual({ kind: 'daily', at: '00:00' })
    expect(parseSchedule(JSON.stringify({ kind: 'daily', at: '23:59' }))).toEqual({ kind: 'daily', at: '23:59' })
  })

  it('每次返回新对象 —— 调用方改它不会污染 DEFAULT_SCHEDULE', () => {
    const a = parseSchedule(null)
    a.kind = 'daily'
    expect(DEFAULT_SCHEDULE).toEqual(MANUAL)
    expect(parseSchedule(null)).toEqual(MANUAL)
  })
})

describe('serializeSchedule —— 非法的一律存空串（= 手动）', () => {
  it('手动存空串', () => {
    expect(serializeSchedule(MANUAL)).toBe('')
  })

  it('interval 不合法存空串，合法则存 JSON 且带上限', () => {
    expect(serializeSchedule({ kind: 'interval', everyMin: 0 })).toBe('')
    expect(serializeSchedule({ kind: 'interval', everyMin: 99999 })).toBe(JSON.stringify({ kind: 'interval', everyMin: 1440 }))
  })

  it('daily 时间不合法存空串', () => {
    expect(serializeSchedule({ kind: 'daily', at: '99:99' })).toBe('')
    expect(serializeSchedule({ kind: 'daily' })).toBe('')
  })

  it('往返一致', () => {
    for (const s of [{ kind: 'interval', everyMin: 30 } as const, { kind: 'daily', at: '09:00' } as const]) {
      expect(parseSchedule(serializeSchedule(s))).toEqual(s)
    }
  })
})

describe('describeSchedule', () => {
  it.each([
    [MANUAL, '手动'],
    [{ kind: 'interval', everyMin: 30 } as WorkflowSchedule, '每 30 分钟'],
    [{ kind: 'daily', at: '09:00' } as WorkflowSchedule, '每天 09:00'],
  ])('人话描述', (s, want) => {
    expect(describeSchedule(s)).toBe(want)
  })
})

describe('parseTriggers —— 没有令牌的 HTTP 触发等于谁都能启动流程', () => {
  it.each([null, undefined, '', '[]'])('空值（%s）返回空数组', (raw) => {
    expect(parseTriggers(raw)).toEqual([])
  })

  it('非数组或坏 JSON 返回空数组', () => {
    expect(parseTriggers('{"kind":"http"}')).toEqual([])
    expect(parseTriggers('{ 坏了')).toEqual([])
  })

  it('http 没有令牌就丢掉（安全）', () => {
    expect(parseTriggers(JSON.stringify([{ kind: 'http' }]))).toEqual([])
    expect(parseTriggers(JSON.stringify([{ kind: 'http', token: '   ' }]))).toEqual([])
  })

  it('http 有令牌则保留，并去掉首尾空白', () => {
    expect(parseTriggers(JSON.stringify([{ kind: 'http', token: ' ab12 ' }]))).toEqual([{ kind: 'http', token: 'ab12' }])
  })

  it('task_status 缺 taskId 就丢掉；status 默认 done', () => {
    expect(parseTriggers(JSON.stringify([{ kind: 'task_status' }]))).toEqual([])
    expect(parseTriggers(JSON.stringify([{ kind: 'task_status', taskId: 0 }]))).toEqual([])
    expect(parseTriggers(JSON.stringify([{ kind: 'task_status', taskId: 7 }]))).toEqual([
      { kind: 'task_status', taskId: 7, status: 'done' },
    ])
  })

  it('坏条目被丢掉，好的留下（不因为一条坏就全丢）', () => {
    const raw = JSON.stringify([{ kind: 'http' }, { kind: 'http', token: 'ok' }, null, 42, { kind: '未知' }])
    expect(parseTriggers(raw)).toEqual([{ kind: 'http', token: 'ok' }])
  })
})

describe('serializeTriggers / describeTriggers', () => {
  it('全被过滤掉时存空串', () => {
    expect(serializeTriggers([{ kind: 'http' }])).toBe('')
    expect(serializeTriggers([])).toBe('')
  })

  it('存下来的一定是清洗过的', () => {
    expect(serializeTriggers([{ kind: 'task_status', taskId: 3 }])).toBe(
      JSON.stringify([{ kind: 'task_status', taskId: 3, status: 'done' }]),
    )
  })

  it('人话描述：任务状态与外部调用', () => {
    expect(describeTriggers([])).toBe('')
    expect(describeTriggers([{ kind: 'task_status', taskId: 3, status: 'done' }])).toBe('任务 #3 变成「done」')
    expect(describeTriggers([{ kind: 'http', token: 'x' }])).toBe('外部 HTTP 调用')
    expect(
      describeTriggers([{ kind: 'task_status', taskId: 1, status: 'done' }, { kind: 'http', token: 'x' }]),
    ).toBe('任务 #1 变成「done」 · 外部 HTTP 调用')
  })
})

describe('dueByInterval', () => {
  const MIN = 60_000
  it('不是 interval 计划时不触发', () => {
    expect(dueByInterval(MANUAL, null, 0)).toBe(false)
    expect(dueByInterval({ kind: 'daily', at: '09:00' }, null, 0)).toBe(false)
  })

  it('从没跑过就立刻跑 —— 新建的计划不该等一个周期', () => {
    expect(dueByInterval({ kind: 'interval', everyMin: 30 }, null, 1_000_000)).toBe(true)
  })

  it('够久才触发，差一毫秒都不算', () => {
    const s: WorkflowSchedule = { kind: 'interval', everyMin: 30 }
    expect(dueByInterval(s, 0, 30 * MIN - 1)).toBe(false)
    expect(dueByInterval(s, 0, 30 * MIN)).toBe(true)
  })
})

describe('dueByDaily —— 只认「当前这一分钟正好到点」，错过不补跑', () => {
  const at9 = (h: number, m: number) => new Date(2026, 9, 4, h, m, 30) // 2026-10-04 本地时间

  it('不是 daily 计划时不触发', () => {
    expect(dueByDaily(MANUAL, null, at9(9, 0))).toBe(false)
    expect(dueByDaily({ kind: 'interval', everyMin: 5 }, null, at9(9, 0))).toBe(false)
  })

  it('没到点不触发；同一分钟内的秒数不影响', () => {
    const s: WorkflowSchedule = { kind: 'daily', at: '09:00' }
    expect(dueByDaily(s, null, at9(8, 59))).toBe(false)
    expect(dueByDaily(s, null, at9(9, 1))).toBe(false)
    expect(dueByDaily(s, null, new Date(2026, 9, 4, 9, 0, 59))).toBe(true)
  })

  it('从没跑过则到点就跑', () => {
    expect(dueByDaily({ kind: 'daily', at: '09:00' }, null, at9(9, 0))).toBe(true)
  })

  it('今天已经跑过就不再跑', () => {
    const s: WorkflowSchedule = { kind: 'daily', at: '09:00' }
    const lastToday = new Date(2026, 9, 4, 9, 0, 5).getTime()
    expect(dueByDaily(s, lastToday, at9(9, 0))).toBe(false)
  })

  it('昨天跑过、今天到点则跑', () => {
    const s: WorkflowSchedule = { kind: 'daily', at: '09:00' }
    const lastYesterday = new Date(2026, 9, 3, 9, 0, 0).getTime()
    expect(dueByDaily(s, lastYesterday, at9(9, 0))).toBe(true)
  })

  it('时间是坏的（不该出现，但库里的旧数据可能有）不触发', () => {
    expect(dueByDaily({ kind: 'daily', at: '99:99' }, null, at9(9, 0))).toBe(false)
    expect(dueByDaily({ kind: 'daily' }, null, at9(9, 0))).toBe(false)
  })
})

describe('makeTriggerToken', () => {
  it('32 位十六进制、URL 安全', () => {
    for (let i = 0; i < 20; i++) {
      const t = makeTriggerToken()
      expect(t).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  it('两次不同（随机）', () => {
    expect(makeTriggerToken()).not.toBe(makeTriggerToken())
  })
})
