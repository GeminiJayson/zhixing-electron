import { nextSortKey } from './tasks'
import { parseCapture } from '../../shared/capture'
import type {
  Task,
} from '../../shared/types'
import { conn, nowStamp, today, getTask, TASK_COLUMNS } from './connection'
import { reindexTask } from './fts'

// ---------------------------------------------------------------- 任务排序 / 移动 / 批量 / 标签

export const siblingsOf = (parentId: number | null, excludeId?: number): Task[] =>
  (conn()
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM task
        WHERE deleted_at IS NULL AND (parent_id IS ? OR parent_id = ?)
          AND (? IS NULL OR id != ?)
     ORDER BY sort_key ASC, id ASC`
    )
    .all(parentId, parentId, excludeId ?? null, excludeId ?? null) as Task[])

/** 某节点是否在 ancestor 的子树内（用于拖拽防成环）。 */
export function isDescendantOf(ancestorId: number, nodeId: number): boolean {
  const c = conn()
  let cur: number | null = nodeId
  const guard = new Set<number>()
  while (cur !== null && !guard.has(cur)) {
    guard.add(cur)
    const row = c.prepare('SELECT parent_id FROM task WHERE id = ?').get(cur) as
      | { parent_id: number | null }
      | undefined
    if (!row) return false
    if (row.parent_id === ancestorId) return true
    cur = row.parent_id
  }
  return false
}

/**
 * 拖拽排序：放到 anchor 上/下，取相邻 sort_key 的中间值。
 * 与 task_service.reorder 的中间值算法一致。
 */
export function reorderTask(taskId: number, anchorId: number, below = true): Task | null {
  const anchor = getTask(anchorId)
  const me = getTask(taskId)
  if (!anchor || !me || taskId === anchorId) return me
  const sib = siblingsOf(anchor.parent_id, taskId)
  const idxBase = sib.findIndex((x) => x.id === anchor.id)
  const idx = (idxBase < 0 ? sib.length : idxBase) + (below ? 1 : 0)
  const prevKey = idx > 0 ? sib[idx - 1].sort_key : sib.length ? sib[0].sort_key - 2 : 0
  const nextKey =
    idx < sib.length ? sib[idx].sort_key : sib.length ? sib[sib.length - 1].sort_key + 2 : 2
  const key = (prevKey + nextKey) / 2
  // 对齐 TaskService.reorder：只改 sort_key，**不**动 parent_id（T12）。
  // 跨级拖拽由调用方先显式改挂，与 Python task_page._on_tree_drop 的分工一致。
  conn()
    .prepare('UPDATE task SET sort_key = ?, updated_at = ? WHERE id = ?')
    .run(key, nowStamp(), taskId)
  return getTask(taskId)
}

/** 同级上移(-1)/下移(+1)，对齐 task_service.move_relative。 */
export function moveTaskRelative(taskId: number, delta: number): boolean {
  const me = getTask(taskId)
  if (!me) return false
  const sib = siblingsOf(me.parent_id)
  const idx = sib.findIndex((x) => x.id === taskId)
  if (idx < 0) return false
  let anchor: Task | null = null
  let below = true
  if (delta < 0 && idx > 0) {
    anchor = sib[idx - 1]
    below = false
  } else if (delta > 0 && idx < sib.length - 1) {
    anchor = sib[idx + 1]
    below = true
  } else {
    return false
  }
  reorderTask(taskId, anchor.id, below)
  return true
}

/** 改挂父级；拒绝挂到自己或自己的后代（防成环）。 */
export function reparentTask(taskId: number, parentId: number | null): Task | null {
  const me = getTask(taskId)
  if (!me) return null
  if (parentId !== null) {
    if (parentId === taskId) return me
    if (isDescendantOf(taskId, parentId)) return me
    const parent = getTask(parentId)
    if (!parent) return me
  }
  const stamp = nowStamp()
  // 对齐 TaskService.reparent：只改 parent_id，**保留原 sort_key**（T12）。
  // 成环校验保留：Python 侧在 view 层（task_page._is_descendant）做同样的事，
  // 渲染层无法自行回溯时由这里兜底，避免拖出环导致渲染/roll-up 递归。
  conn()
    .prepare('UPDATE task SET parent_id = ?, updated_at = ? WHERE id = ?')
    .run(parentId, stamp, taskId)
  return getTask(taskId)
}

/** 批量完成：只处理未完成的（对齐 batch_complete）。 */
export function batchComplete(ids: number[]): number {
  const c = conn()
  const stamp = nowStamp()
  const stmt = c.prepare(
    "UPDATE task SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('done','abandoned')"
  )
  const tx = c.transaction((list: number[]) => {
    let n = 0
    for (const id of list) n += stmt.run(stamp, stamp, id).changes
    return n
  })
  return tx(ids)
}

export function batchMove(ids: number[], listId: number | null): number {
  const c = conn()
  const stamp = nowStamp()
  const stmt = c.prepare('UPDATE task SET list_id = ?, updated_at = ? WHERE id = ?')
  const tx = c.transaction((list: number[]) => {
    let n = 0
    for (const id of list) n += stmt.run(listId, stamp, id).changes
    return n
  })
  return tx(ids)
}

export function batchSetDue(ids: number[], due: string | null): number {
  const c = conn()
  const stamp = nowStamp()
  const stmt = c.prepare('UPDATE task SET due_date = ?, updated_at = ? WHERE id = ?')
  const tx = c.transaction((list: number[]) => {
    let n = 0
    for (const id of list) n += stmt.run(due, stamp, id).changes
    return n
  })
  return tx(ids)
}

export function listTags(): { id: number; name: string; color: string }[] {
  return conn().prepare('SELECT id, name, color FROM tag ORDER BY name ASC').all() as {
    id: number
    name: string
    color: string
  }[]
}

/**
 * 覆盖式设置任务标签（对齐 TagRepository.set_tags 的清空后重插）；
 * 标签不存在时按名新建，与任务/笔记共用一套标签。
 */
export function setTaskTags(taskId: number, names: string[]): void {
  const c = conn()
  c.prepare('DELETE FROM task_tag WHERE task_id = ?').run(taskId)
  const find = c.prepare('SELECT id FROM tag WHERE name = ?')
  const add = c.prepare('INSERT INTO tag (name, color) VALUES (?, ?)')
  const link = c.prepare('INSERT OR IGNORE INTO task_tag (task_id, tag_id) VALUES (?, ?)')
  for (const raw of names) {
    const name = raw.trim()
    if (!name) continue
    let row = find.get(name) as { id: number } | undefined
    if (!row) {
      const info = add.run(name, '#0D9488')
      row = { id: Number(info.lastInsertRowid) }
    }
    link.run(taskId, row.id)
  }
}

// ---------------------------------------------------------------- 快速添加

/** 按名查找 list 类型的清单 id；未命中返回 null（对齐 folders.find_by_name，不新建）。 */
function findListIdByName(name: string): number | null {
  const clean = (name ?? '').trim()
  if (!clean) return null
  const row = conn()
    .prepare("SELECT id FROM list_folder WHERE name = ? AND kind = 'list' ORDER BY id LIMIT 1")
    .get(clean) as { id: number } | undefined
  return row?.id ?? null
}

/** @列表：按名查找 list 类型的列表，没有就建一个（保留给需要「就地建清单」的入口）。 */
export function ensureListId(name: string): number | null {
  const clean = name.trim()
  if (!clean) return null
  const c = conn()
  const row = c
    .prepare("SELECT id FROM list_folder WHERE name = ? AND kind = 'list' ORDER BY id LIMIT 1")
    .get(clean) as { id: number } | undefined
  if (row) return row.id
  const info = c
    .prepare(
      "INSERT INTO list_folder (parent_id, kind, name, icon, collapsed, sort, created_at) VALUES (NULL, 'list', ?, 'folder', 0, ?, ?)"
    )
    .run(clean, Date.now() / 1000, nowStamp())
  return Number(info.lastInsertRowid)
}

/**
 * 快速添加：解析 !优先级 @列表 #标签 日期词 后建任务。
 * 与手册 §4.1 一致——未写日期词时截止日自动设为**今天**。
 */
export function quickAdd(text: string, defaultListId: number | null = null): Task | null {
  const c = conn()
  const day = today()
  const parsed = parseCapture(text, day)
  if (!parsed.title) return null

  // 对齐 TaskService.quick_create：@列表 命中用该清单，未命中**回退** default_list_id；
  // 无 @列表 也用 default_list_id。此前未命中即新建 list_folder，凭空造清单（T7/I39）。
  const listId = parsed.listName
    ? (findListIdByName(parsed.listName) ?? defaultListId)
    : defaultListId
  const due = parsed.dueDate ?? day
  let reminderAt: string | null = null
  if (parsed.dueClock) {
    const [h, m] = parsed.dueClock
    reminderAt = `${due} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000000`
  }

  const stamp = nowStamp()
  const info = c
    .prepare(
      `INSERT INTO task (title, notes_md, status, priority, due_date, reminder_at, list_id, parent_id,
                         repeat_period, streak, sort_key, created_at, updated_at)
       VALUES (?, '', 'todo', ?, ?, ?, ?, NULL, 'none', 0, ?, ?, ?)`
    )
    .run(parsed.title, parsed.priority, due, reminderAt, listId, nextSortKey(null), stamp, stamp)
  const taskId = Number(info.lastInsertRowid)
  if (parsed.tags.length) setTaskTags(taskId, parsed.tags)
  reindexTask(taskId)
  return getTask(taskId)
}
