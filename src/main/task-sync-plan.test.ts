import { describe, expect, it } from 'vitest'
import { planSyncUpdate, type SyncExisting, type SyncIncoming } from './task-sync-plan'

/**
 * 外部任务同步：一次同步到底该改哪些字段。
 *
 * 缺陷背景：按标题去重时会把**用户自己写的同名任务**「认领」过来（只写 external_source/id），
 * 源码注释白纸黑字写着「只建立映射、不改它的内容」。但认领之后那条任务就带上了外部身份，
 * **下一次同步立刻走「已存在」分支，无条件覆盖 title / notes_md / due_date / priority** ——
 * 承诺只管了一个周期。
 *
 * 所以这里的关键区分是 linked：认领来的任务只**补空**，不覆盖用户已经写下的东西。
 */
const ext = (over: Partial<SyncExisting> = {}): SyncExisting => ({
  title: '写周报',
  notes_md: '我自己写的备注',
  due_date: '2026-09-30',
  priority: 5,
  status: 'todo',
  linked: false,
  ...over,
})
const inc = (over: Partial<SyncIncoming> = {}): SyncIncoming => ({
  title: '写周报（来自 Jira）',
  notes: '外部描述',
  due: '2026-10-15',
  priority: 8,
  done: false,
  ...over,
})

describe('planSyncUpdate —— 外部自建的任务（linked=false）', () => {
  it('外部说了算：四个字段都可以被更新', () => {
    const p = planSyncUpdate(ext(), inc())
    expect(p).toEqual({
      title: '写周报（来自 Jira）',
      notes_md: '外部描述',
      due_date: '2026-10-15',
      priority: 8,
      markDone: false,
    })
  })

  it('完全相同就没有可改的', () => {
    const e = ext({ title: 'T', notes_md: 'N', due_date: '2026-10-15', priority: 8 })
    expect(planSyncUpdate(e, inc({ title: 'T', notes: 'N' }))).toEqual({ markDone: false })
  })
})

describe('planSyncUpdate —— 认领过来的任务（linked=true）', () => {
  it('不覆盖用户已经写下的标题 / 备注 / 截止 / 优先级', () => {
    const p = planSyncUpdate(ext({ linked: true }), inc())
    expect(p).toEqual({ markDone: false })
  })

  it('只补空字段：本地为空的才填外部值', () => {
    const p = planSyncUpdate(
      ext({ linked: true, title: '', notes_md: null, due_date: null, priority: null }),
      inc()
    )
    expect(p.title, '认领来的标题一律不动').toBeUndefined()
    expect(p.notes_md).toBe('外部描述')
    expect(p.due_date).toBe('2026-10-15')
    expect(p.priority).toBe(8)
  })

  it('标题是必填列，认领来的任务标题一律不动（它就是靠标题匹配上的）', () => {
    const p = planSyncUpdate(ext({ linked: true, title: '写周报' }), inc())
    expect(p.title).toBeUndefined()
  })

  it('完成状态仍然同步 —— 只进不退（外部说完成就标完成）', () => {
    expect(planSyncUpdate(ext({ linked: true }), inc({ done: true })).markDone).toBe(true)
  })

  it('本地已经是完成就不再重复标', () => {
    expect(planSyncUpdate(ext({ linked: true, status: 'done' }), inc({ done: true })).markDone).toBe(false)
  })
})
