import { describe, expect, it } from 'vitest'
import { buildTaskTree, effectiveDoneMap, isTerminal } from '@shared/task'
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
