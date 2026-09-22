import { describe, expect, it } from 'vitest'
import {
  STATUS_CHOICES,
  STATUS_LABELS,
  STATUS_TONES,
  buildTaskTree,
  effectiveDoneMap,
  isTerminal,
  tasksInListScope,
} from '@shared/task'
import type { Task } from '@shared/types'

const mk = (id: number, parent: number | null, status: Task['status'], extra: Partial<Task> = {}): Task =>
  ({
    id,
    title: `t${id}`,
    notes_md: '',
    status,
    priority: 0,
    due_date: null,
    start_date: null,
    start_time: null,
    due_time: null,
    reminder_at: null,
    reminder_fired: null,
    reminder_base: null,
    list_id: null,
    parent_id: parent,
    repeat_period: 'none',
    repeat_rule: null,
    streak: 0,
    sort_key: id,
    resume_at: null,
    last_reset_date: null,
    completed_at: null,
    created_at: '2026-01-01 00:00:00.000000',
    updated_at: '2026-01-01 00:00:00.000000',
    ...extra,
  })

describe('状态胶囊：标签与色阶', () => {
  it('每个状态都有中文标签', () => {
    for (const s of STATUS_CHOICES) expect(STATUS_LABELS[s.value]).toBeTruthy()
  })

  it('色阶表覆盖全部状态，一个不多一个不少', () => {
    expect(Object.keys(STATUS_TONES).sort()).toEqual(STATUS_CHOICES.map((s) => s.value).sort())
  })

  it('五种状态的色阶两两不同 —— 否则「用颜色区分」就落空了', () => {
    const tones = STATUS_CHOICES.map((s) => STATUS_TONES[s.value])
    expect(new Set(tones).size).toBe(tones.length)
  })
})

describe('有效完成 roll-up', () => {
  it('叶子看自身状态', () => {
    const m = effectiveDoneMap([mk(1, null, 'done'), mk(2, null, 'todo')])
    expect(m.get(1)).toBe(true)
    expect(m.get(2)).toBe(false)
  })

  it('父任务看全部后代：子未完成则父不算完成', () => {
    const tasks = [mk(1, null, 'done'), mk(2, 1, 'done'), mk(3, 1, 'todo')]
    const m = effectiveDoneMap(tasks)
    expect(m.get(3)).toBe(false)
    expect(m.get(1)).toBe(false)
  })

  it('全部后代完成时父也算完成', () => {
    const m = effectiveDoneMap([mk(1, null, 'done'), mk(2, 1, 'done')])
    expect(m.get(1)).toBe(true)
  })

  it('放弃（abandoned）视为已终结', () => {
    expect(isTerminal('abandoned')).toBe(true)
    expect(isTerminal('done')).toBe(true)
    expect(isTerminal('todo')).toBe(false)
    expect(isTerminal('doing')).toBe(false)
  })
})

describe('任务树', () => {
  it('按 parent_id 组装并带出 children', () => {
    const tasks = [mk(1, null, 'todo'), mk(2, 1, 'todo'), mk(3, 1, 'todo')]
    const tree = buildTaskTree(tasks, effectiveDoneMap(tasks), new Map(), new Map())
    expect(tree).toHaveLength(1)
    expect(tree[0].children.map((c) => c.id)).toEqual([2, 3])
  })

  it('保持输入的相对顺序（排序由数据层按 sort_key 保证）', () => {
    const tasks = [mk(2, null, 'todo', { sort_key: 10 }), mk(1, null, 'todo', { sort_key: 20 })]
    const tree = buildTaskTree(tasks, effectiveDoneMap(tasks), new Map(), new Map())
    expect(tree.map((n) => n.id)).toEqual([2, 1])
  })
})

describe('清单范围：根 + 后代闭包', () => {
  it('只收该清单的顶层任务及其后代', () => {
    const tasks = [
      mk(1, null, 'todo', { list_id: 7 }),
      mk(2, 1, 'todo', { list_id: 7 }),
      mk(3, null, 'todo', { list_id: 8 }),
    ]
    expect(tasksInListScope(tasks, 7).map((t) => t.id)).toEqual([1, 2])
  })

  it('子任务的 list_id 与父不同也照样跟着父出现（否则它会凭空消失）', () => {
    const tasks = [mk(1, null, 'todo', { list_id: 7 }), mk(2, 1, 'todo', { list_id: null })]
    expect(tasksInListScope(tasks, 7).map((t) => t.id)).toEqual([1, 2])
  })

  it('收件箱（list_id 为空）同样按闭包取', () => {
    const tasks = [mk(1, null, 'todo'), mk(2, 1, 'todo', { list_id: 7 }), mk(3, null, 'todo', { list_id: 7 })]
    expect(tasksInListScope(tasks, null).map((t) => t.id)).toEqual([1, 2])
  })

  it('没有顶层根时回退为该清单的全部任务（兼容分支）', () => {
    // 3 是 2 的子任务，2 却挂在别的清单下：7 没有自己的顶层任务
    const tasks = [mk(2, null, 'todo', { list_id: 8 }), mk(3, 2, 'todo', { list_id: 7 })]
    expect(tasksInListScope(tasks, 7).map((t) => t.id)).toEqual([3])
  })

  it('空清单返回空数组', () => {
    expect(tasksInListScope([mk(1, null, 'todo', { list_id: 8 })], 7)).toEqual([])
  })
})
