/** 任务状态与终态语义，对齐 zhixing/model/domain/entities.py。 */

import type { Task, TaskStatus } from './types'

/** 编辑页下拉与看板列的顺序（与 entities.TaskStatus 一致） */
export const STATUS_CHOICES: readonly { value: TaskStatus; label: string }[] = [
  { value: 'todo', label: '待办' },
  { value: 'doing', label: '进行中' },
  { value: 'waiting', label: '等待中' },
  { value: 'done', label: '已完成' },
  { value: 'abandoned', label: '已放弃' },
]

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  waiting: '等待中',
  done: '已完成',
  abandoned: '已放弃',
}

/**
 * 状态胶囊的色阶名，对应 tasks.css 里的 .chip--status-*。
 *
 * 中性留给默认的「待办」：满屏任务里绝大多数都是它，最淡才不会喧宾夺主。
 * 五种状态五种颜色 —— 有单测盯着它们两两不同，否则「用颜色区分」就落空了。
 */
export const STATUS_TONES: Record<TaskStatus, 'neutral' | 'active' | 'warm' | 'success' | 'danger'> = {
  todo: 'neutral',
  doing: 'active',
  waiting: 'warm',
  done: 'success',
  abandoned: 'danger',
}

/** 终态：完成与放弃都算（与 entities.Task.is_done 一致） */
export function isTerminal(status: TaskStatus): boolean {
  return status === 'done' || status === 'abandoned'
}

/**
 * 有效完成 roll-up，逐行对齐 task_rules.effective_done_map：
 * 叶子看自身是否终态；父任务看**所有**后代是否都有效完成。
 * 纯派生值，不落库。
 */
export function effectiveDoneMap(tasks: Task[]): Map<number, boolean> {
  const byParent = new Map<number | null, Task[]>()
  for (const t of tasks) {
    const list = byParent.get(t.parent_id) ?? []
    list.push(t)
    byParent.set(t.parent_id, list)
  }

  const memo = new Map<number, boolean>()
  const visiting = new Set<number>()

  const rec = (task: Task): boolean => {
    const cached = memo.get(task.id)
    if (cached !== undefined) return cached
    if (visiting.has(task.id)) return false // 防成环：数据异常时不递归爆栈
    visiting.add(task.id)

    const kids = byParent.get(task.id) ?? []
    const result = kids.length === 0 ? isTerminal(task.status) : kids.every(rec)

    visiting.delete(task.id)
    memo.set(task.id, result)
    return result
  }

  for (const t of tasks) rec(t)
  return memo
}

/** 合并任务与有效完成态，供列表勾选显示 */
export interface TaskNode extends Task {
  children: TaskNode[]
  /** roll-up 后的完成态（父任务可能自身状态非终态但子任务全完成） */
  effectiveDone: boolean
  /** 关联笔记数量 */
  noteCount: number
  tags: { id: number; name: string; color: string }[]
}

/** 扁平列表 → 父子树，保持输入顺序（输入端已按 sort_key 排序） */
export function buildTaskTree(
  tasks: Task[],
  effective: Map<number, boolean>,
  noteCounts: Map<number, number>,
  tagMap: Map<number, { id: number; name: string; color: string }[]>
): TaskNode[] {
  const nodes = new Map<number, TaskNode>()
  for (const t of tasks) {
    nodes.set(t.id, {
      ...t,
      children: [],
      effectiveDone: effective.get(t.id) ?? isTerminal(t.status),
      noteCount: noteCounts.get(t.id) ?? 0,
      tags: tagMap.get(t.id) ?? [],
    })
  }

  const roots: TaskNode[] = []
  for (const t of tasks) {
    const node = nodes.get(t.id)
    if (!node) continue
    const parent = t.parent_id != null ? nodes.get(t.parent_id) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}
