/** 任务状态与终态语义。 */

import type { ListFolder, Task, TaskStatus } from './types'

/** 编辑页下拉与看板列的顺序。 */
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
 * 有效完成 roll-up：
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

/**
 * 某个清单范围里的任务：根 + 后代闭包。
 *
 * 与主进程 lists.listTasksByList 的递归 CTE 是同一套语义的两种实现 —— 那边在库里筛，
 * 这边在已经取回的全量任务上筛（清单栏要给每个清单显示计数，只能一次取全量）。
 * 三条规则两边必须一致：
 *   - 根 = 该清单下的**顶层**任务；
 *   - 该清单没有任何顶层任务时，回退为它的全部任务；
 *   - 子任务的 list_id 可能与父不同，闭包保证它们不会因为「根判定」被漏掉。
 */
export function tasksInListScope(tasks: Task[], listId: number | null): Task[] {
  const hit = (t: Task): boolean => (t.list_id ?? null) === listId
  const roots = tasks.filter((t) => t.parent_id === null && hit(t))
  const seed = roots.length > 0 ? roots : tasks.filter(hit)
  if (seed.length === 0) return []

  const byParent = new Map<number, Task[]>()
  for (const t of tasks) {
    if (t.parent_id === null) continue
    const arr = byParent.get(t.parent_id) ?? []
    arr.push(t)
    byParent.set(t.parent_id, arr)
  }
  const keep = new Set<number>()
  const walk = (t: Task): void => {
    keep.add(t.id)
    for (const c of byParent.get(t.id) ?? []) walk(c)
  }
  for (const r of seed) walk(r)
  return tasks.filter((t) => keep.has(t.id))
}

/**
 * 某个分组（含子分组）下所有清单的 id。
 *
 * 分组自身**不装任务**（见 TaskLists 的 groupTotal），所以「选中分组」在语义上
 * 就是「选中它下面所有清单」：这里只展开出清单 id，任务闭包仍交给
 * tasksInListScope 逐个算 —— 一套判定只写一次。
 * seen 兜住数据异常里的环，避免无限递归。
 */
export function listIdsInFolder(folders: ListFolder[], groupId: number): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  const walk = (parentId: number): void => {
    if (seen.has(parentId)) return
    seen.add(parentId)
    for (const f of folders) {
      if ((f.parent_id ?? null) !== parentId) continue
      if (f.kind === 'list') out.push(f.id)
      else walk(f.id)
    }
  }
  walk(groupId)
  return out
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
