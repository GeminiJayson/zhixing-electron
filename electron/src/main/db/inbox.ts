import { nextSortKey } from './tasks'
import { createNote } from './notes'
import type {
  Flash,
  Task,
} from '../../shared/types'
import { conn, nowStamp, TASK_COLUMNS } from './connection'
import { reindexFlash, removeFromIndex } from './fts'

// ---------------------------------------------------------------- 收件箱 / 闪念

export const FLASH_COLUMNS =
  'id, content, remark, source_app, source_url, status, converted_type, converted_id, created_at'

/** 任务收件箱：未归入任何列表（list_id IS NULL）的任务，对齐 task_service.list_tree(None)。 */
export function listInboxTasks(): Task[] {
  return conn()
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM task WHERE deleted_at IS NULL AND list_id IS NULL ORDER BY sort_key ASC, id ASC`
    )
    .all() as Task[]
}

export const getFlash = (id: number): Flash | null =>
  (conn().prepare(`SELECT ${FLASH_COLUMNS} FROM flash WHERE id = ?`).get(id) as Flash | undefined) ?? null

/** status 传 null 表示不过滤（全部未删除）。 */
export function listFlashesByStatus(status: string | null): Flash[] {
  const c = conn()
  return status === null
    ? (c
        .prepare(`SELECT ${FLASH_COLUMNS} FROM flash WHERE deleted_at IS NULL ORDER BY created_at DESC`)
        .all() as Flash[])
    : (c
        .prepare(
          `SELECT ${FLASH_COLUMNS} FROM flash WHERE deleted_at IS NULL AND status = ? ORDER BY created_at DESC`
        )
        .all(status) as Flash[])
}

export function addFlash(
  content: string,
  remark = '',
  sourceApp = '',
  sourceUrl = ''
): Flash | null {
  const clean = content.trim()
  if (!clean) return null
  const info = conn()
    .prepare(
      `INSERT INTO flash (content, remark, source_app, source_url, status, converted_type, converted_id, created_at)
       VALUES (?, ?, ?, ?, 'inbox', '', 0, ?)`
    )
    // 对齐 flash_service.add：正文截 2000、备注截 200，避免超长内容撑爆列表与检索索引
    .run(clean.slice(0, 2000), remark.slice(0, 200), sourceApp, sourceUrl, nowStamp())
  const id = Number(info.lastInsertRowid)
  reindexFlash(id)
  return getFlash(id)
}

export function setFlashStatus(id: number, status: 'inbox' | 'archived'): Flash | null {
  conn().prepare('UPDATE flash SET status = ? WHERE id = ?').run(status, id)
  return getFlash(id)
}

export function deleteFlash(id: number): number {
  const changes = conn().prepare('UPDATE flash SET deleted_at = ? WHERE id = ?').run(nowStamp(), id).changes
  // 软删即移出全文索引；从回收站恢复时重建
  if (changes) removeFromIndex('flash', id)
  return changes
}

/** 改备注（对齐 update_remark）。 */
export function updateFlashRemark(id: number, remark: string): Flash | null {
  conn()
    .prepare('UPDATE flash SET remark = ? WHERE id = ?')
    .run((remark ?? '').slice(0, 200), id)
  reindexFlash(id)
  return getFlash(id)
}

/**
 * 给闪念打标签（对齐 flash_service.tag）：按名 ensure 后**整体覆盖**。
 * flash_tag 表此前只有建表 DDL，没有任何写入路径。
 */
export function tagFlash(id: number, tagNames: string[]): void {
  const c = conn()
  const ensure = (name: string): number => {
    const found = c.prepare('SELECT id FROM tag WHERE name = ?').get(name) as { id: number } | undefined
    if (found) return found.id
    const info = c.prepare("INSERT INTO tag (name, color) VALUES (?, '#0D9488')").run(name)
    return Number(info.lastInsertRowid)
  }
  const ids: number[] = []
  for (const raw of tagNames) {
    const name = (raw ?? '').trim()
    if (name) ids.push(ensure(name))
  }
  const run = c.transaction(() => {
    c.prepare('DELETE FROM flash_tag WHERE flash_id = ?').run(id)
    const ins = c.prepare('INSERT OR IGNORE INTO flash_tag (flash_id, tag_id) VALUES (?, ?)')
    for (const tid of ids) ins.run(id, tid)
  })
  run()
}

/**
 * 合并多条闪念（对齐 flash_service.merge）：正文以分隔线拼接、备注与来源取首条、
 * 标签取并集，原条软删，返回新条。
 */
export function mergeFlashes(ids: number[]): Flash | null {
  const items = ids.map((i) => getFlash(i)).filter((f): f is Flash => !!f)
  if (items.length < 2) return items[0] ?? null
  const c = conn()
  const sourceUrl = items.find((i) => i.source_url)?.source_url ?? ''
  const merged = addFlash(
    items.map((i) => i.content ?? '').join('\n\n---\n\n'),
    items[0].remark ?? '',
    items[0].source_app ?? '',
    sourceUrl
  )
  if (!merged) return null
  const tagIds = new Set<number>()
  for (const i of items) {
    for (const row of c.prepare('SELECT tag_id FROM flash_tag WHERE flash_id = ?').all(i.id) as {
      tag_id: number
    }[]) {
      tagIds.add(row.tag_id)
    }
  }
  if (tagIds.size) {
    const ins = c.prepare('INSERT OR IGNORE INTO flash_tag (flash_id, tag_id) VALUES (?, ?)')
    for (const tid of tagIds) ins.run(merged.id, tid)
  }
  for (const i of items) deleteFlash(i.id)
  return getFlash(merged.id)
}

/** 标记闪念已转换（status=converted + 去向），对齐 flash_service._mark_converted。 */
export function markFlashConverted(
  id: number,
  kind: 'task' | 'note' | 'subtask',
  targetId: number
): void {
  conn()
    .prepare("UPDATE flash SET status = 'converted', converted_type = ?, converted_id = ? WHERE id = ?")
    .run(kind, targetId, id)
}

/** 闪念 → 任务：标题取正文首行前 60 字，原正文写入备注（对齐 to_task）。 */
export function flashToTask(id: number): number | null {
  const f = getFlash(id)
  if (!f) return null
  const stamp = nowStamp()
  const title = (f.content ?? '').split('\n')[0].slice(0, 60) || '来自闪念的任务'
  const info = conn()
    .prepare(
      `INSERT INTO task (title, notes_md, status, priority, repeat_period, streak, sort_key, created_at, updated_at)
       VALUES (?, ?, 'todo', 0, 'none', 0, ?, ?, ?)`
    )
    .run(title, `来自闪念：${(f.content ?? '').slice(0, 200)}`, nextSortKey(null), stamp, stamp)
  const taskId = Number(info.lastInsertRowid)
  markFlashConverted(id, 'task', taskId)
  return taskId
}

/** 闪念 → 子任务（对齐 to_subtask）：挂到指定父任务下。 */
export function flashToSubtask(id: number, parentTaskId: number): number | null {
  const f = getFlash(id)
  if (!f) return null
  const stamp = nowStamp()
  const title = (f.content ?? '').split('\n')[0].slice(0, 60) || '来自闪念的子任务'
  const info = conn()
    .prepare(
      `INSERT INTO task (title, notes_md, status, priority, repeat_period, streak, sort_key,
                         parent_id, created_at, updated_at)
       VALUES (?, ?, 'todo', 0, 'none', 0, ?, ?, ?, ?)`
    )
    .run(
      title,
      `来自闪念：${(f.content ?? '').slice(0, 200)}`,
      nextSortKey(parentTaskId),
      parentTaskId,
      stamp,
      stamp
    )
  const taskId = Number(info.lastInsertRowid)
  markFlashConverted(id, 'subtask', taskId)
  return taskId
}

/** 闪念 → 笔记：标题取备注或正文首行前 40 字（对齐 to_note）。 */
export function flashToNote(id: number, folderId: number | null = null): number | null {
  const f = getFlash(id)
  if (!f) return null
  const title = ((f.remark || f.content) ?? '').split('\n')[0].slice(0, 40) || '来自闪念'
  const note = createNote(title, folderId, f.content ?? '')
  if (!note) return null
  markFlashConverted(id, 'note', note.id)
  return note.id
}
