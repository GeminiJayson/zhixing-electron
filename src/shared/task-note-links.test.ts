import { describe, expect, it } from 'vitest'
import { planTaskNoteLinks, type LinkRow } from './task-note-links'

/**
 * 任务↔笔记关联的对账：删 [[标题]] 要真的掉链，手动关联不许被顺带清掉。
 */
const row = (o: Partial<LinkRow> & { note_id: number }): LinkRow => ({
  title: null,
  source: 'wiki',
  ...o
})
const table: Record<string, number> = { 甲: 1, 乙: 2, 丙: 3 }
const resolve = (t: string): number | null => table[t] ?? null

describe('任务↔笔记关联对账', () => {
  it('从正文删掉 [[标题]] 后，派生的关联要删掉', () => {
    const plan = planTaskNoteLinks(
      ['甲'],
      [row({ note_id: 1, title: '甲' }), row({ note_id: 2, title: '乙' })],
      resolve
    )
    expect(plan.remove).toEqual([2])
    expect(plan.add).toEqual([])
  })

  it('手动关联不在正文里也不许被删', () => {
    const plan = planTaskNoteLinks([], [row({ note_id: 2, title: '乙', source: 'manual' })], resolve)
    expect(plan.remove).toEqual([])
  })

  it('手动关联与派生关联指向同一篇笔记时，只留一行', () => {
    const plan = planTaskNoteLinks(['甲'], [row({ note_id: 1, title: '甲', source: 'manual' })], resolve)
    expect(plan.remove).toEqual([])
    expect(plan.add).toEqual([])
  })

  it('正文里新增的标题要落链', () => {
    const plan = planTaskNoteLinks(['甲', '丙'], [row({ note_id: 1, title: '甲' })], resolve)
    expect(plan.add).toEqual([3])
    expect(plan.remove).toEqual([])
  })

  it('解析不到的悬空标题不落链', () => {
    const plan = planTaskNoteLinks(['不存在的笔记'], [], resolve)
    expect(plan.add).toEqual([])
    expect(plan.remove).toEqual([])
  })

  it('来源不明的历史行：笔记被改名时按标题判定，标题还在就保留', () => {
    // 行里记的是旧 note_id（9），标题仍是「甲」，正文也还写着 [[甲]] —— 不删，只补一行新的
    const plan = planTaskNoteLinks(['甲'], [row({ note_id: 9, title: '甲', source: null })], resolve)
    expect(plan.remove).toEqual([])
    expect(plan.add).toEqual([1])
  })

  it('来源不明的历史行：标题从正文消失则清掉（这正是原先漏掉的泄漏）', () => {
    const plan = planTaskNoteLinks([], [row({ note_id: 2, title: '乙', source: null })], resolve)
    expect(plan.remove).toEqual([2])
  })

  it('笔记进了回收站（解析不到）但正文还写着标题，链接要留着', () => {
    // resolve 对已删除笔记返回 null —— 正文没改，不该因为回收站而掉链
    const dead = (): number | null => null
    const plan = planTaskNoteLinks(['甲'], [row({ note_id: 1, title: '甲' })], dead)
    expect(plan.remove).toEqual([])
    expect(plan.add).toEqual([])
  })

  it('目标笔记已不存在（title 为 null）时派生的关联要清掉', () => {
    const plan = planTaskNoteLinks([], [row({ note_id: 7, title: null, source: 'wiki' })], resolve)
    expect(plan.remove).toEqual([7])
  })

  it('重复执行应为幂等：第二次没有可删也没有可加', () => {
    const existing = [
      row({ note_id: 1, title: '甲' }),
      row({ note_id: 2, title: '乙', source: 'manual' })
    ]
    const first = planTaskNoteLinks(['甲'], existing, resolve)
    expect(first.remove).toEqual([])
    const after = existing.filter((r) => !first.remove.includes(r.note_id))
    const second = planTaskNoteLinks(['甲'], after, resolve)
    expect(second.remove).toEqual([])
    expect(second.add).toEqual([])
  })

  it('同一篇笔记在正文里被链接两次也只加一行', () => {
    const plan = planTaskNoteLinks(['甲', '甲'], [], resolve)
    expect(plan.add).toEqual([1])
  })
})
