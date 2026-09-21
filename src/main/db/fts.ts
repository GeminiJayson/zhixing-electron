/**
 * FTS5 全文检索（对齐 Python 的 zhixing/model/infrastructure/fts.py）。
 *
 * 关键：Python 在**写入时**就用 jieba 的 cut_for_search 把正文切成空格分隔的词再交给
 * unicode61 索引。两版共用同一个 FTS 表，Electron 若直接写原文，索引里就会同时存在
 * 「按词」与「按字」两套内容，跨客户端检索会互相漏检。所以这里用同一个分词器。
 */
import { conn } from './connection'
import { queryTerms, tokenize } from './fts-query'
import { quietFailure } from '../../shared/quiet-failure'

// 分词与查询表达式统一放在 fts-query.ts（可在 node 环境单测），这里只负责索引读写
export { queryTerms, tokenize }

export type Kind = 'task' | 'note' | 'flash'

const FT = {
  task: ['task_fts', 'task_id'],
  note: ['note_fts', 'note_id'],
  flash: ['flash_fts', 'flash_id'],
} as const

/** 先删后插（对齐 db.fts_replace），单行幂等。 */
function replace(table: string, idCol: string, rowId: number, cols: Record<string, string>): void {
  const c = conn()
  c.prepare('DELETE FROM ' + table + ' WHERE ' + idCol + ' = ?').run(rowId)
  const names = Object.keys(cols)
  const sql =
    'INSERT INTO ' + table + '(' + names.join(', ') + ', ' + idCol + ') VALUES(' +
    names.map(() => '?').join(', ') + ', ?)'
  c.prepare(sql).run(...names.map((n) => cols[n]), rowId)
}

export function indexTask(taskId: number, title: string, notes: string): void {
  replace('task_fts', 'task_id', taskId, { title: tokenize(title), notes: tokenize(notes ?? '') })
}

export function indexNote(noteId: number, title: string, content: string): void {
  replace('note_fts', 'note_id', noteId, {
    title: tokenize(title),
    content: tokenize(content ?? ''),
  })
}

export function indexFlash(flashId: number, content: string, remark = ''): void {
  replace('flash_fts', 'flash_id', flashId, {
    content: tokenize(content ?? ''),
    remark: tokenize(remark ?? ''),
  })
}

/**
 * 从库里读回最新内容并重建索引 —— 写路径统一调用这一组，
 * 调用点不必自己拼字段，也不会因为漏传参数造成索引陈旧。
 */
export function reindexTask(taskId: number): void {
  const row = conn().prepare('SELECT title, notes_md FROM task WHERE id = ?').get(taskId) as
    | { title: string | null; notes_md: string | null }
    | undefined
  if (!row) return removeFromIndex('task', taskId)
  indexTask(taskId, row.title ?? '', row.notes_md ?? '')
}

export function reindexNote(noteId: number): void {
  const row = conn().prepare('SELECT title, content_md FROM note WHERE id = ?').get(noteId) as
    | { title: string | null; content_md: string | null }
    | undefined
  if (!row) return removeFromIndex('note', noteId)
  indexNote(noteId, row.title ?? '', row.content_md ?? '')
}

export function reindexFlash(flashId: number): void {
  const row = conn().prepare('SELECT content, remark FROM flash WHERE id = ?').get(flashId) as
    | { content: string | null; remark: string | null }
    | undefined
  if (!row) return removeFromIndex('flash', flashId)
  indexFlash(flashId, row.content ?? '', row.remark ?? '')
}

/** 按类型重建索引（回收站恢复等按 kind 分发的写路径用）。 */
export function reindexRow(kind: Kind, rowId: number): void {
  if (kind === 'task') return reindexTask(rowId)
  if (kind === 'note') return reindexNote(rowId)
  reindexFlash(rowId)
}

export function removeFromIndex(kind: Kind, rowId: number): void {
  const [table, idCol] = FT[kind]
  conn().prepare('DELETE FROM ' + table + ' WHERE ' + idCol + ' = ?').run(rowId)
}

/** 检索（对齐 FTSService.search）：返回 [row_id, rank]，rank 越小越相关。 */
export function searchIndex(kind: Kind, q: string, limit = 50): [number, number][] {
  const expr = queryTerms(q)
  if (!expr) return []
  const [table, idCol] = FT[kind]
  try {
    const rows = conn()
      .prepare(
        'SELECT ' + idCol + ', bm25(' + table + ') AS r FROM ' + table + ' WHERE ' + table + ' MATCH ? ORDER BY r LIMIT ?'
      )
      .all(expr, limit) as Record<string, number>[]
    return rows.map((r) => [r[idCol], r.r] as [number, number])
  } catch (e) {
    // 检索失败不能把界面带崩，但也不能一点痕迹不留 —— 否则「查不到」与「出错」长得一样
    quietFailure('全文检索', e, 'kind=' + kind + ' q=' + q)
    return []
  }
}
