import { todayRoots } from './review'
import { effectiveDoneMap as effectiveDoneMapMain } from '../../shared/task'
import { join } from 'node:path'
import { clampPriority } from '../../shared/priority'
import { reindexTask, removeFromIndex } from './fts'
import { extractLinks } from '../../shared/wiki'
import { resolveNoteTitle } from './notes'
import { nextRecurrence } from '../../shared/recurrence'
import type {
  Note,
  Overview,
  Task,
  TaskStatus,
  TodayTasks,
} from '../../shared/types'
import { conn, nowStamp, today, getTask, TASK_COLUMNS } from './connection'

// ---------------------------------------------------------------- 只读查询

export function listTasks(limit = 500): Task[] {
  return conn()
    .prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE deleted_at IS NULL
              ORDER BY sort_key ASC, id ASC LIMIT ?`)
    .all(limit) as Task[]
}

/**
 * 今日待办，逐条对齐 task_service.today_tree：
 * 根 = 顶层 + roll-up 有效未完成 + 未逾期（无截止 或 截止 >= 今天）；
 * 逾期根不进今日；每个根带**完整子树**（子任务条件不同也随父展示）。
 */
export function listTodayTasks(): TodayTasks {
  const c = conn()
  const all = c
    .prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE deleted_at IS NULL ORDER BY sort_key ASC, id ASC`)
    .all() as Task[]
  const effective = effectiveDoneMapMain(all)
  const day = today()
  const roots = todayRoots(all, effective, day)

  const byParent = new Map<number | null, Task[]>()
  for (const t of all) {
    const list = byParent.get(t.parent_id) ?? []
    list.push(t)
    byParent.set(t.parent_id, list)
  }
  const keep = new Set<number>()
  const collect = (t: Task): void => {
    keep.add(t.id)
    for (const k of byParent.get(t.id) ?? []) collect(k)
  }
  for (const r of roots) collect(r)

  return { roots: roots.map((t) => t.id), subtree: all.filter((t) => keep.has(t.id)) }
}

/** 最近更新的笔记（今日页「最近笔记」卡）。 */
export function recentNotes(limit = 5): Note[] {
  return conn()
    .prepare(`SELECT id, folder_id, title, content_md, format, pinned, word_count, created_at, updated_at
                FROM note WHERE deleted_at IS NULL
            ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as Note[]
}

/**
 * 任务 notes_md 里的 [[笔记标题]] 落成 task_note_link
 * （对齐 task_service._sync_wiki_links）。
 *
 * 这张表此前只有读取与删除路径、没有任何写入 —— 于是编辑器承诺的 [[标题]]、
 * 任务行的 ⇄N 计数、图谱的任务-笔记边全部恒为空。
 */
export function syncTaskNoteLinks(taskId: number, notesMd: string): number {
  const ins = conn().prepare(
    'INSERT OR IGNORE INTO task_note_link (task_id, note_id) VALUES (?, ?)'
  )
  let added = 0
  for (const title of extractLinks(notesMd ?? '')) {
    const noteId = resolveNoteTitle(title)
    if (noteId != null) added += ins.run(taskId, noteId).changes
  }
  return added
}

/** 手动建立任务↔笔记关联（笔记页「归属任务」用）。 */
export function attachTaskNote(taskId: number, noteId: number): number {
  return conn()
    .prepare('INSERT OR IGNORE INTO task_note_link (task_id, note_id) VALUES (?, ?)')
    .run(taskId, noteId).changes
}

/** 解除任务↔笔记关联。 */
export function detachTaskNote(taskId: number, noteId: number): number {
  return conn()
    .prepare('DELETE FROM task_note_link WHERE task_id = ? AND note_id = ?')
    .run(taskId, noteId).changes
}

/** 某任务关联的笔记（对齐 linked_notes，排除已删笔记）。 */
export function listLinkedNotes(taskId: number): Note[] {
  return conn()
    .prepare(
      'SELECT n.* FROM note n JOIN task_note_link l ON l.note_id = n.id ' +
        'WHERE l.task_id = ? AND n.deleted_at IS NULL ORDER BY n.id'
    )
    .all(taskId) as Note[]
}

export function noteCountMap(): { task_id: number; c: number }[] {
  return conn().prepare('SELECT task_id, COUNT(*) c FROM task_note_link GROUP BY task_id').all() as {
    task_id: number
    c: number
  }[]
}

export function tagMap(): { task_id: number; id: number; name: string; color: string }[] {
  return conn()
    .prepare(
      `SELECT tt.task_id, t.id, t.name, t.color
         FROM task_tag tt JOIN tag t ON t.id = tt.tag_id
        ORDER BY t.name ASC`
    )
    .all() as { task_id: number; id: number; name: string; color: string }[]
}

export function listNotes(limit = 300): Note[] {
  return conn()
    .prepare(`SELECT id, folder_id, title, content_md, format, pinned, word_count, created_at, updated_at
                FROM note WHERE deleted_at IS NULL
            ORDER BY pinned DESC, updated_at DESC LIMIT ?`)
    .all(limit) as Note[]
}



/**
 * 概览四卡，对齐 review_service.today_counts：
 * 今日待办只数**顶层有效未完成且未逾期**的根；逾期与今日完成都按 roll-up 判定。
 */
export function overview(): Overview {
  const c = conn()
  const day = today()
  const all = c
    .prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE deleted_at IS NULL`)
    .all() as Task[]
  const effective = effectiveDoneMapMain(all)
  const isDone = (t: Task): boolean =>
    effective.get(t.id) ?? (t.status === 'done' || t.status === 'abandoned')
  const one = (sql: string): number => (c.prepare(sql).get() as { c: number }).c
  return {
    today: todayRoots(all, effective, day).length,
    overdue: all.filter((t) => t.due_date !== null && t.due_date < day && !isDone(t)).length,
    doneToday: all.filter((t) => isDone(t) && (t.completed_at ?? '').slice(0, 10) === day).length,
    notes: one('SELECT COUNT(*) c FROM note WHERE deleted_at IS NULL'),
    inbox: one("SELECT COUNT(*) c FROM flash WHERE deleted_at IS NULL AND status = 'inbox'"),
  }
}

// ---------------------------------------------------------------- 写入
// 全部走参数化 SQL + 字段白名单；不接受来自渲染进程的任意列名或任意 SQL。

/** 与 task_service.toggle_complete 一致：终态→待办并清 completed_at，否则→完成。 */
export function toggleTask(id: number): Task | null {
  const c = conn()
  const row = c.prepare('SELECT status FROM task WHERE id = ?').get(id) as
    | { status: TaskStatus }
    | undefined
  if (!row) return null
  const wasDone = row.status === 'done' || row.status === 'abandoned'
  const stamp = nowStamp()
  c.prepare('UPDATE task SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(
    wasDone ? 'todo' : 'done',
    wasDone ? null : stamp,
    stamp,
    id
  )
  const updated = getTask(id)

  // 对齐 task_service.toggle_complete：循环任务（顶层）完成后克隆整棵子树并推进截止日。
  // 子任务自身的循环不触发克隆（parent_id 非空）。
  if (!wasDone && updated && updated.parent_id === null && updated.repeat_period !== 'none') {
    const [nextDueDate, nextRule] = nextRecurrence(updated, today())
    if (nextDueDate !== null) cloneTaskTree(updated, null, nextDueDate, nextRule)
  }
  return updated
}

/**
 * 克隆任务及其子树，对齐 task_service._clone_task_tree：
 * 补全 start_date / reminder_at / 标签 / 循环规则 / 子任务；克隆体状态一律回到 todo。
 */
export function cloneTaskTree(
  src: Task,
  parentId: number | null,
  newDue: string | null,
  rule: string | null
): number {
  const c = conn()
  const stamp = nowStamp()
  const tagIds = c.prepare('SELECT tag_id FROM task_tag WHERE task_id = ?').all(src.id) as {
    tag_id: number
  }[]
  const children = c
    .prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE parent_id = ? AND deleted_at IS NULL`)
    .all(src.id) as Task[]

  const info = c
    .prepare(
      `INSERT INTO task (title, notes_md, status, priority, due_date, start_date, reminder_at,
                         list_id, parent_id, repeat_period, repeat_rule, streak, sort_key,
                         created_at, updated_at)
       VALUES (?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    )
    .run(
      src.title,
      src.notes_md ?? '',
      src.priority,
      newDue ?? src.due_date,
      src.start_date,
      src.reminder_at,
      src.list_id,
      parentId,
      src.repeat_period,
      rule ?? src.repeat_rule,
      nextSortKey(parentId),
      stamp,
      stamp
    )
  const cloneId = Number(info.lastInsertRowid)
  reindexTask(cloneId)

  const insTag = c.prepare('INSERT OR IGNORE INTO task_tag (task_id, tag_id) VALUES (?, ?)')
  for (const t of tagIds) insTag.run(cloneId, t.tag_id)

  for (const child of children) cloneTaskTree(child, cloneId, null, null)
  return cloneId
}

export function setPriority(id: number, priority: number): Task | null {
  const stamp = nowStamp()
  conn()
    .prepare('UPDATE task SET priority = ?, updated_at = ? WHERE id = ?')
    .run(clampPriority(priority), stamp, id)
  return getTask(id)
}

export function setTitle(id: number, title: string): Task | null {
  const clean = title.trim()
  if (!clean) return getTask(id)
  const stamp = nowStamp()
  conn().prepare('UPDATE task SET title = ?, updated_at = ? WHERE id = ?').run(clean, stamp, id)
  reindexTask(id)
  return getTask(id)
}

/** 与 task_service.update 的等待中规则一致：离开 waiting 时清 resume_at。 */
export function setStatus(id: number, status: TaskStatus): Task | null {
  const allowed: TaskStatus[] = ['todo', 'doing', 'waiting', 'done', 'abandoned']
  if (!allowed.includes(status)) throw new Error('非法状态: ' + status)
  const c = conn()
  const stamp = nowStamp()
  const completedAt = status === 'done' ? stamp : null
  c.prepare('UPDATE task SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(
    status,
    completedAt,
    stamp,
    id
  )
  if (status !== 'waiting') {
    c.prepare('UPDATE task SET resume_at = NULL WHERE id = ?').run(id)
  }
  return getTask(id)
}

export function setDueDate(id: number, due: string | null): Task | null {
  const stamp = nowStamp()
  conn()
    .prepare('UPDATE task SET due_date = ?, updated_at = ? WHERE id = ?')
    .run(due, stamp, id)
  return getTask(id)
}

export function nextSortKey(parentId: number | null): number {
  const row = conn()
    .prepare(
      `SELECT MAX(sort_key) m FROM task
        WHERE (parent_id IS ? OR parent_id = ?) AND deleted_at IS NULL`
    )
    .get(parentId, parentId) as { m: number | null } | undefined
  return (row?.m ?? 0) + 1
}

export function createTask(title: string, parentId: number | null, listId: number | null): Task | null {
  const clean = title.trim()
  if (!clean) return null
  const stamp = nowStamp()
  const info = conn()
    .prepare(
      `INSERT INTO task (title, notes_md, status, priority, repeat_period, streak, sort_key,
                         parent_id, list_id, created_at, updated_at)
       VALUES (?, '', 'todo', 0, 'none', 0, ?, ?, ?, ?, ?)`
    )
    .run(clean, nextSortKey(parentId), parentId, listId, stamp, stamp)
  const created = Number(info.lastInsertRowid)
  reindexTask(created)
  return getTask(created)
}

/** 编辑面板用：按白名单更新多个字段，未知字段直接拒绝。 */
export const EDITABLE_FIELDS = [
  'title',
  'notes_md',
  'status',
  'priority',
  'due_date',
  'start_date',
  'repeat_period',
  'repeat_rule',
  'last_reset_date',
] as const
export type EditableField = (typeof EDITABLE_FIELDS)[number]

export function updateTask(id: number, fields: Partial<Record<EditableField, string | number | null>>): Task | null {
  const sets: string[] = []
  const args: unknown[] = []
  for (const key of EDITABLE_FIELDS) {
    if (!(key in fields)) continue
    let value = fields[key] ?? null
    if (key === 'priority') value = clampPriority(Number(value ?? 0))
    if (key === 'title') {
      const clean = String(value ?? '').trim()
      if (!clean) continue // 标题不允许清空
      value = clean
    }
    sets.push(`${key} = ?`)
    args.push(value)
  }
  if (!sets.length) return getTask(id)

  const stamp = nowStamp()
  if ('status' in fields) {
    sets.push('completed_at = ?')
    args.push(fields.status === 'done' ? stamp : null)
  }
  sets.push('updated_at = ?')
  args.push(stamp, id)
  conn().prepare(`UPDATE task SET ${sets.join(', ')} WHERE id = ?`).run(...args)

  // 与 setStatus 同一规则：离开「等待中」时清掉恢复日期
  if ('status' in fields && fields.status !== 'waiting') {
    conn().prepare('UPDATE task SET resume_at = NULL WHERE id = ?').run(id)
  }
  reindexTask(id)
  // notes_md 变更后重新解析 [[笔记标题]]（对齐 task_service.update → _sync_wiki_links）
  if ('notes_md' in fields) syncTaskNoteLinks(id, String(fields.notes_md ?? ''))
  return getTask(id)
}

/** 软删除，级联子树（与 TaskRepository.soft_delete(cascade=True) 一致）。 */
export function softDelete(id: number): number {
  const c = conn()
  const stamp = nowStamp()
  const ids: number[] = []
  const collect = (taskId: number): void => {
    ids.push(taskId)
    const kids = c.prepare('SELECT id FROM task WHERE parent_id = ? AND deleted_at IS NULL').all(taskId) as {
      id: number
    }[]
    for (const k of kids) collect(k.id)
  }
  collect(id)
  const stmt = c.prepare('UPDATE task SET deleted_at = ?, updated_at = ? WHERE id = ?')
  const tx = c.transaction((rows: number[]) => {
    for (const r of rows) {
      stmt.run(stamp, stamp, r)
      // 软删即从全文索引移除；从回收站恢复时再重建
      removeFromIndex('task', r)
    }
  })
  tx(ids)
  return ids.length
}
