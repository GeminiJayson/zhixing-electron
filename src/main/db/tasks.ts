import { todayRoots } from './review'
import { effectiveDoneMap as effectiveDoneMapMain } from '../../shared/task'
import { join } from 'node:path'
import { clampPriority } from '../../shared/priority'
import { reindexTask, removeFromIndex } from './fts'
import { extractLinks } from '../../shared/wiki'
import { syncTaskNoteLinks } from './task-note-links'
import { appendNote, createNote, getNote, resolveNoteTitle } from './notes'
// 撤销「删除」需要从回收站恢复：trash.ts 只依赖 connection/fts，不会成环
import { restoreTrash } from './trash'
import { nextRecurrence } from '../../shared/recurrence'
import type {
  Note,
  Overview,
  Task,
  TaskNoteContext,
  TaskStatus,
  TodayTasks,
} from '../../shared/types'
import { conn, nowClock, nowStamp, today, getTask, TASK_COLUMNS } from './connection'

// ---------------------------------------------------------------- 只读查询

/**
 * 全部任务，对齐 TaskRepository.list_all：默认**无上限**（T15）。
 * 调用方显式传 limit 时才截断（此前默认 500，渲染层不传参即被静默截断）。
 */
export function listTasks(limit?: number): Task[] {
  const sql = `SELECT ${TASK_COLUMNS} FROM task WHERE deleted_at IS NULL
              ORDER BY sort_key ASC, id ASC`
  return (
    limit === undefined ? conn().prepare(sql).all() : conn().prepare(sql + ' LIMIT ?').all(limit)
  ) as Task[]
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


/** 手动建立任务↔笔记关联（笔记页「归属任务」、图谱里拉边用）。 */
export function attachTaskNote(taskId: number, noteId: number): number {
  return conn()
    .prepare(
      "INSERT OR IGNORE INTO task_note_link (task_id, note_id, source) VALUES (?, ?, 'manual')"
    )
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
      `INSERT INTO task (title, notes_md, status, priority, due_date, start_date, start_time,
                         reminder_at, due_time, list_id, parent_id, repeat_period, repeat_rule,
                         streak, sort_key, created_at, updated_at)
       VALUES (?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    )
    .run(
      src.title,
      src.notes_md ?? '',
      src.priority,
      newDue ?? src.due_date,
      src.start_date,
      src.start_time,
      src.reminder_at,
      src.due_time,
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
/**
 * 把已完成的任务释放回「待执行」。
 *
 * 两点值得注意：
 * 1. **不动 parent_id** —— 任务在完成期间一直保留着层级，所以释放后父子关系天然还在。
 * 2. **连带恢复仍是终态的祖先**：父任务若还是「已完成」，它在当前清单里不会显示，
 *    子任务就会变成一个找不到父亲的孤儿。所以一路向上，把仍是终态的祖先也一并恢复。
 *    这就是需求里那句「保留记忆任务层级」。
 *
 * listId 只在显式传入时才改，而且**只改被释放的那一个**；祖先保持各自原来的清单。
 */
export function restoreCompleted(id: number, listId?: number | null): Task | null {
  const c = conn()
  const stamp = nowStamp()
  const seen = new Set<number>()
  let cur: number | null = id
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur)
    const row = c
      .prepare('SELECT id, parent_id, status FROM task WHERE id = ?')
      .get(cur) as { id: number; parent_id: number | null; status: TaskStatus } | undefined
    if (!row) break
    if (row.status === 'done' || row.status === 'abandoned') {
      c.prepare('UPDATE task SET status = ?, completed_at = NULL, updated_at = ? WHERE id = ?').run(
        'todo',
        stamp,
        row.id
      )
    }
    cur = row.parent_id
  }
  if (listId !== undefined) {
    c.prepare('UPDATE task SET list_id = ?, updated_at = ? WHERE id = ?').run(listId, stamp, id)
  }
  return getTask(id)
}

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
  // 对齐 TaskService.add_subtask：未显式指定清单时继承父任务的 list_id，
  // 否则子任务会因自身 list_id 为空而同时出现在收件箱（T6）。
  const parent = parentId !== null ? getTask(parentId) : null
  const effectiveList = listId ?? parent?.list_id ?? null
  const stamp = nowStamp()
  // 新任务的开始时间就是**创建时刻**（日期 + 到分钟）：这样「进度」从一建好就开始算，
  // 而不是等用户自己去填一个开始日期
  const info = conn()
    .prepare(
      `INSERT INTO task (title, notes_md, status, priority, repeat_period, streak, sort_key,
                         parent_id, list_id, start_date, start_time, created_at, updated_at)
       VALUES (?, '', 'todo', 0, 'none', 0, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(clean, nextSortKey(parentId), parentId, effectiveList, today(), nowClock(), stamp, stamp)
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
  'due_time',
  'start_time',
  // 提醒时刻：此前编辑面板根本没有这个字段，于是提醒只能靠快速捕获的「明天3点」带出来
  'reminder_at',
  'repeat_period',
  'repeat_rule',
  'resume_at',
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
  // 对齐 T5：编辑面板改 status **不**写 completed_at（只有 set_status/toggle_complete 写），
  // 也不再隐式清 resume_at —— Python task_editor._commit_status 由编辑器显式传 resume_at。
  sets.push('updated_at = ?')
  args.push(stamp, id)
  conn().prepare(`UPDATE task SET ${sets.join(', ')} WHERE id = ?`).run(...args)

  reindexTask(id)
  // notes_md 变更后重新解析 [[笔记标题]]（对齐 task_service.update → _sync_wiki_links）
  if ('notes_md' in fields) syncTaskNoteLinks(id, String(fields.notes_md ?? ''))
  return getTask(id)
}


/** 置为等待中并可指定恢复日期（对齐 TaskService.pause，v0.15 P2-8）。 */
export function pauseTask(id: number, resumeAt: string | null = null): Task | null {
  return updateTask(id, { status: 'waiting', resume_at: resumeAt })
}

/** 恢复（默认回待办并清恢复日期，对齐 TaskService.resume）。 */
export function resumeTask(id: number, status: TaskStatus = 'todo'): Task | null {
  return updateTask(id, { status, resume_at: null })
}

// ------------------------------------------------ 任务↔笔记「段落级」上下文（T3）

/**
 * 记录任务关联笔记内某段落（幂等，对齐 TaskService.attach_block /
 * TaskRepository.link_context）。task 必须已存在，否则返回 null。
 */
export function attachBlock(
  taskId: number,
  noteId: number,
  blockKey: string,
  snippet = ''
): Task | null {
  if (!taskId || !noteId || !blockKey.trim()) return null
  const task = getTask(taskId)
  if (!task) return null
  conn()
    .prepare(
      `INSERT OR IGNORE INTO task_note_context (task_id, note_id, block_key, snippet, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(taskId, noteId, blockKey, snippet ?? '', nowStamp())
  return getTask(taskId)
}

/** 解除段落上下文；blockKey 为空则解除该 (task,note) 的全部段落（对齐 unlink_context）。 */
export function detachBlock(taskId: number, noteId: number, blockKey = ''): number {
  const c = conn()
  return blockKey
    ? c
        .prepare(
          'DELETE FROM task_note_context WHERE task_id = ? AND note_id = ? AND block_key = ?'
        )
        .run(taskId, noteId, blockKey).changes
    : c
        .prepare('DELETE FROM task_note_context WHERE task_id = ? AND note_id = ?')
        .run(taskId, noteId).changes
}

/** 某任务的全部段落上下文（软删笔记隐去，对齐 linked_contexts）。 */
export function listLinkedContexts(taskId: number): TaskNoteContext[] {
  return conn()
    .prepare(
      'SELECT c.* FROM task_note_context c JOIN note n ON n.id = c.note_id ' +
        'WHERE c.task_id = ? AND n.deleted_at IS NULL ORDER BY c.id'
    )
    .all(taskId) as TaskNoteContext[]
}

/** 某笔记的全部段落上下文（图谱反链/预览用，对齐 contexts_for_note）。 */
export function contextsForNote(noteId: number): TaskNoteContext[] {
  return conn()
    .prepare('SELECT * FROM task_note_context WHERE note_id = ? ORDER BY id')
    .all(noteId) as TaskNoteContext[]
}

/** 批量取多任务的段落上下文（图谱 task→anchor 构建用，对齐 context_notes_for）。 */
export function noteContextMap(taskIds: number[]): Record<number, TaskNoteContext[]> {
  if (!taskIds.length) return {}
  const marks = taskIds.map(() => '?').join(',')
  const rows = conn()
    .prepare(`SELECT * FROM task_note_context WHERE task_id IN (${marks})`)
    .all(...taskIds) as TaskNoteContext[]
  const out: Record<number, TaskNoteContext[]> = {}
  for (const r of rows) {
    const list = out[r.task_id] ?? []
    list.push(r)
    out[r.task_id] = list
  }
  return out
}

/**
 * 完成任务时沉淀复盘（对齐 AppController._write_note_after_done，T3）：
 * 有段落上下文 → 把「结论」追加回原笔记并保留段落锚；否则新建「复盘：X」笔记。
 */
export function writeNoteAfterDone(
  taskId: number,
  title: string
): { noteId: number; blockKey: string } | null {
  const contexts = listLinkedContexts(taskId)
  const ctx0 = contexts[0]
  if (ctx0) {
    const note = getNote(ctx0.note_id)
    if (note) {
      // 复用 appendNote（对齐 note_service.append：追加不触发版本快照）
      const fresh = appendNote(note.id, `## 结论（${today()}）\n- ✅ 已完成：${title}\n`)
      if (fresh) return { noteId: fresh.id, blockKey: ctx0.block_key }
    }
  }
  const created = createNote(
    `复盘：${title}`,
    null,
    `# 复盘：${title}\n\n## 收获\n\n## 待改进\n\n`
  )
  if (!created) return null
  return { noteId: created.id, blockKey: '' }
}

/**
 * 捕获目标选择器的任务候选（对齐 TaskService.task_candidates，T17）：
 * q 非空按标题模糊搜索（限 limit），否则返回近期（~今天+30 天）内的顶层未完成任务；
 * 两种口径都过滤已完成/已放弃。
 */
export function taskCandidates(q = '', limit = 20): Task[] {
  const c = conn()
  const query = q.trim()
  if (query) {
    return c
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM task
          WHERE deleted_at IS NULL AND status NOT IN ('done','abandoned') AND title LIKE ?
          LIMIT ?`
      )
      .all(`%${query}%`, limit) as Task[]
  }
  const end = new Date(Date.now() + 30 * 86_400_000).toLocaleDateString('sv-SE')
  return c
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM task
        WHERE deleted_at IS NULL AND status NOT IN ('done','abandoned')
          AND parent_id IS NULL AND due_date IS NOT NULL
          AND due_date >= '2000-01-01' AND due_date <= ?
        ORDER BY due_date ASC, priority DESC, id ASC LIMIT ?`
    )
    .all(end, limit) as Task[]
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

/**
 * 批量软删除：逐个级联子树，整体一个事务。
 *
 * 渲染层原来是 \`for (id of ids) await deleteTask(id)\` —— 第 N 条失败时前 N-1 条已经落库，
 * 一致性边界跑到了渲染进程里。收敛成一次 IPC，事务边界回到主进程。
 * \`seen\` 不能省：两个选中的 id 可能同属一棵子树，重复收集会让返回计数虚高。
 */
export function batchDeleteTasks(ids: number[]): number {
  const c = conn()
  const stamp = nowStamp()
  const all: number[] = []
  const seen = new Set<number>()
  const collect = (taskId: number): void => {
    if (seen.has(taskId)) return
    seen.add(taskId)
    all.push(taskId)
    const kids = c
      .prepare('SELECT id FROM task WHERE parent_id = ? AND deleted_at IS NULL')
      .all(taskId) as { id: number }[]
    for (const k of kids) collect(k.id)
  }
  // 收集阶段只读，放事务外；写阶段才需要原子性
  for (const id of ids) collect(id)
  const stmt = c.prepare('UPDATE task SET deleted_at = ?, updated_at = ? WHERE id = ?')
  const tx = c.transaction((rows: number[]) => {
    for (const r of rows) {
      stmt.run(stamp, stamp, r)
      removeFromIndex('task', r)
    }
  })
  tx(all)
  return all.length
}

/**
 * 撤销上一步操作（完成 / 取消完成 / 删除恢复），整批一个事务。
 *
 * 渲染层原本是 \`for (id of ids) { if (...) await restoreTrash(...) else ... }\` —— 任一条失败
 * 即中断，而撤销条已经被清掉了：用户既看不到错误，也无法重试。三种动作按来源分派，
 * 统一收进主进程的一次事务。prevStatus 存在时回写原状态，而不是简单翻转
 * （否则原本 doing / waiting 的任务会被 toggge 成 todo）。
 */
export function batchUndoLast(
  ids: number[],
  action: 'toggle' | 'restore',
  prevStatus: TaskStatus | null
): number {
  const c = conn()
  const tx = c.transaction((list: number[]) => {
    let n = 0
    for (const id of list) {
      if (action === 'restore') n += restoreTrash('task', id)
      else if (prevStatus) n += setStatus(id, prevStatus) ? 1 : 0
      else n += toggleTask(id) ? 1 : 0
    }
    return n
  })
  return tx(ids)
}