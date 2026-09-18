import { conn, stampOf } from './connection'
import { reindexRow, removeFromIndex } from './fts'

// ---------------------------------------------------------------- 回收站 / 标签管理

export interface TrashItem {
  id: number
  label: string
  deleted_at: string
}

/**
 * 回收站列表：三类软删除记录（对齐 RecycleBinDialog 的三个 Tab）。
 *
 * 排序口径与 Python 各自的 trash() 一致（D13）：Python 的 trash() 都是复用各仓储的
 * list 查询再筛 deleted_at，并不按删除时间排：
 *   - 任务：TaskRepository.list_all → ORDER BY sort_key, id
 *   - 笔记：NoteRepository.all    → ORDER BY pinned DESC, updated_at DESC
 *   - 闪念：FlashRepository         → ORDER BY deleted_at DESC
 */
export function trashItems(kind: 'task' | 'note' | 'flash'): TrashItem[] {
  const c = conn()
  if (kind === 'task') {
    return (
      c
        .prepare("SELECT id, title AS label, deleted_at FROM task WHERE deleted_at IS NOT NULL ORDER BY sort_key, id")
        .all() as TrashItem[]
    )
  }
  if (kind === 'note') {
    return (
      c
        .prepare("SELECT id, title AS label, deleted_at FROM note WHERE deleted_at IS NOT NULL ORDER BY pinned DESC, updated_at DESC")
        .all() as TrashItem[]
    )
  }
  return (
    c
      .prepare("SELECT id, substr(content, 1, 40) AS label, deleted_at FROM flash WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC")
      .all() as TrashItem[]
  )
}

/** 恢复：只清 deleted_at（对齐 TaskRepository.restore，不级联恢复子任务）。 */
export function restoreTrash(kind: 'task' | 'note' | 'flash', id: number): number {
  const table = kind === 'task' ? 'task' : kind === 'note' ? 'note' : 'flash'
  const changes = conn().prepare(`UPDATE ${table} SET deleted_at = NULL WHERE id = ?`).run(id).changes
  // 恢复回可见即重建全文索引
  if (changes) reindexRow(kind, id)
  return changes
}

/**
 * 彻底删除：先解除所有指向它的外键引用再删行。
 * 任务尤其要注意自引用（子任务）与番茄钟记录，否则会 FOREIGN KEY constraint failed。
 */
export function purgeTrash(kind: 'task' | 'note' | 'flash', id: number): number {
  const c = conn()
  if (kind === 'task') {
    const tx = c.transaction(() => {
      c.prepare('DELETE FROM task_tag WHERE task_id = ?').run(id)
      c.prepare('DELETE FROM task_note_link WHERE task_id = ?').run(id)
      c.prepare('DELETE FROM task_note_context WHERE task_id = ?').run(id)
      c.prepare('UPDATE task SET parent_id = NULL WHERE parent_id = ?').run(id)
      c.prepare('UPDATE pomodoro_session SET task_id = NULL WHERE task_id = ?').run(id)
      removeFromIndex('task', id)
      return c.prepare('DELETE FROM task WHERE id = ?').run(id).changes
    })
    return tx()
  }
  if (kind === 'note') {
    const tx = c.transaction(() => {
      c.prepare('DELETE FROM note_link WHERE src_note_id = ?').run(id)
      c.prepare('UPDATE note_link SET dst_note_id = NULL WHERE dst_note_id = ?').run(id)
      c.prepare('DELETE FROM note_tag WHERE note_id = ?').run(id)
      c.prepare('DELETE FROM task_note_link WHERE note_id = ?').run(id)
      c.prepare('DELETE FROM task_note_context WHERE note_id = ?').run(id)
      c.prepare('DELETE FROM note_revision WHERE note_id = ?').run(id)
      removeFromIndex('note', id)
      return c.prepare('DELETE FROM note WHERE id = ?').run(id).changes
    })
    return tx()
  }
  const tx = c.transaction(() => {
    c.prepare('DELETE FROM flash_tag WHERE flash_id = ?').run(id)
    removeFromIndex('flash', id)
    return c.prepare('DELETE FROM flash WHERE id = ?').run(id).changes
  })
  return tx()
}

export function emptyTrash(kind: 'task' | 'note' | 'flash'): number {
  let n = 0
  for (const item of trashItems(kind)) n += purgeTrash(kind, item.id)
  return n
}

/**
 * 按保留天数清理（对齐 Python 的 purge_older_than）。
 *
 * Python 用 datetime 比较：`deleted_at < datetime.now() - timedelta(days)`（D12）。
 * 此前这里把 deleted_at 截到前 10 位再和「今天 - days」比日期，等价于保留到当天 00:00，
 * 恰 N 天前删除的记录会多留一天。改用完整时间戳比较，与 Python 逐微秒一致。
 */
export function purgeTrashOlderThan(days: number): number {
  const cutoff = stampOf(new Date(Date.now() - days * 86_400_000))
  let n = 0
  for (const kind of ['task', 'note', 'flash'] as const) {
    for (const item of trashItems(kind)) {
      if (item.deleted_at && item.deleted_at < cutoff) n += purgeTrash(kind, item.id)
    }
  }
  return n
}

/** 标签 + 使用数（任务与笔记合计，对齐 TagRepository.usage_count）。 */
export function tagsWithUsage(): { id: number; name: string; color: string; count: number }[] {
  return conn()
    .prepare(
      `SELECT t.id, t.name, t.color,
              (SELECT COUNT(*) FROM task_tag tt WHERE tt.tag_id = t.id) +
              (SELECT COUNT(*) FROM note_tag nt WHERE nt.tag_id = t.id) AS count
         FROM tag t ORDER BY t.name ASC`
    )
    .all() as { id: number; name: string; color: string; count: number }[]
}

export function createTag(name: string, color = '#0D9488'): number | null {
  const clean = name.trim()
  if (!clean) return null
  const c = conn()
  const row = c.prepare('SELECT id FROM tag WHERE name = ?').get(clean) as { id: number } | undefined
  if (row) return row.id
  const info = c.prepare('INSERT INTO tag (name, color) VALUES (?, ?)').run(clean, color)
  return Number(info.lastInsertRowid)
}

export function renameTag(id: number, name: string): void {
  const clean = name.trim()
  if (!clean) return
  conn().prepare('UPDATE tag SET name = ? WHERE id = ?').run(clean, id)
}

/** 删除标签：task_tag / note_tag / flash_tag 由外键 ON DELETE CASCADE 连带清理。 */
export function deleteTag(id: number): number {
  return conn().prepare('DELETE FROM tag WHERE id = ?').run(id).changes
}

/**
 * 合并标签：sources 的任务/笔记/闪念关联重挂到 target（同实体已挂 target 则跳过），
 * 随后删除来源标签（对齐 TagRepository.merge + note_service.merge_tags）。
 */
export function mergeTags(target: number, sources: number[]): number {
  const c = conn()
  const srcs = sources.filter((s) => s && s !== target)
  if (!srcs.length) return 0
  const tx = c.transaction(() => {
    let moved = 0
    for (const src of srcs) {
      for (const [table, fk] of [
        ['task_tag', 'task_id'],
        ['note_tag', 'note_id'],
        ['flash_tag', 'flash_id'],
      ] as const) {
        const rows = c.prepare(`SELECT ${fk} AS ref FROM ${table} WHERE tag_id = ?`).all(src) as {
          ref: number
        }[]
        for (const r of rows) {
          const dup = c
            .prepare(`SELECT 1 FROM ${table} WHERE tag_id = ? AND ${fk} = ?`)
            .get(target, r.ref)
          if (!dup) {
            c.prepare(`UPDATE ${table} SET tag_id = ? WHERE tag_id = ? AND ${fk} = ?`).run(
              target,
              src,
              r.ref
            )
            moved += 1
          }
        }
      }
      c.prepare('DELETE FROM tag WHERE id = ?').run(src)
    }
    return moved
  })
  return tx()
}
