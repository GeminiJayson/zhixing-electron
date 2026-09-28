import { describe, expect, it } from 'vitest'
import { dueTargets, type ScheduleTarget } from './workflow-scheduler'

const at = (iso: string): Date => new Date(iso)
const t = (over: Partial<ScheduleTarget> = {}): ScheduleTarget => ({
  id: 1,
  name: '流程',
  schedule: '',
  lastFiredAt: null,
  ...over,
})

describe('工作流调度 · 间隔计划', () => {
  it('手动计划永远不触发', () => {
    expect(dueTargets([t({ schedule: '' })], at('2026-01-01T09:00:00'))).toEqual([])
    expect(dueTargets([t({ schedule: '{"kind":"manual"}' })], at('2026-01-01T09:00:00'))).toEqual([])
  })

  it('从没跑过时立即触发（新建的计划不该等一个周期）', () => {
    const hits = dueTargets([t({ schedule: '{"kind":"interval","everyMin":30}' })], at('2026-01-01T09:00:00'))
    expect(hits).toHaveLength(1)
    expect(hits[0].label).toContain('30 分钟')
  })

  it('没够间隔不触发，够了才触发', () => {
    const s = '{"kind":"interval","everyMin":30}'
    const now = at('2026-01-01T09:00:00').getTime()
    expect(dueTargets([t({ schedule: s, lastFiredAt: now - 10 * 60_000 })], at('2026-01-01T09:00:00'))).toEqual([])
    expect(
      dueTargets([t({ schedule: s, lastFiredAt: now - 31 * 60_000 })], at('2026-01-01T09:00:00'))
    ).toHaveLength(1)
  })

  it('坏计划当手动处理，不会把调度器带崩', () => {
    expect(dueTargets([t({ schedule: '{坏' })], at('2026-01-01T09:00:00'))).toEqual([])
    expect(dueTargets([t({ schedule: '{"kind":"interval","everyMin":0}' })], at('2026-01-01T09:00:00'))).toEqual([])
  })
})

describe('工作流调度 · 每日计划', () => {
  const s = '{"kind":"daily","at":"09:00"}'

  it('只在到点那一分钟触发', () => {
    expect(dueTargets([t({ schedule: s })], at('2026-01-01T08:59:00'))).toEqual([])
    expect(dueTargets([t({ schedule: s })], at('2026-01-01T09:00:30'))).toHaveLength(1)
    expect(dueTargets([t({ schedule: s })], at('2026-01-01T09:01:00'))).toEqual([])
  })

  it('同一天跑过就不再跑', () => {
    const fired = at('2026-01-01T09:00:10').getTime()
    expect(dueTargets([t({ schedule: s, lastFiredAt: fired })], at('2026-01-01T09:00:40'))).toEqual([])
  })

  it('换了一天就重新触发', () => {
    const fired = at('2026-01-01T09:00:10').getTime()
    expect(dueTargets([t({ schedule: s, lastFiredAt: fired })], at('2026-01-02T09:00:05'))).toHaveLength(1)
  })

  it('同一个模板不会在一次调用里被排两次', () => {
    const hits = dueTargets([t({ schedule: s })], at('2026-01-01T09:00:00'))
    expect(hits.filter((h) => h.id === 1)).toHaveLength(1)
  })
})

describe('工作流调度 · 多个模板', () => {
  it('各算各的，只返回到点的那些', () => {
    const hits = dueTargets(
      [
        t({ id: 1, schedule: '{"kind":"interval","everyMin":5}' }),
        t({ id: 2, schedule: '{"kind":"interval","everyMin":60}', lastFiredAt: at('2026-01-01T08:30:00').getTime() }),
        t({ id: 3, schedule: '{"kind":"daily","at":"09:00"}' }),
      ],
      at('2026-01-01T09:00:00')
    )
    expect(hits.map((h) => h.id).sort()).toEqual([1, 3])
  })
})
