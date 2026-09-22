/**
 * 保存的查询（智能清单）。
 *
 * 表达式本身由 shared/query.ts 解析、在渲染层过滤；这里只负责把「名称 + 表达式」存下来。
 * 用私有表，不动 schema 迁移链。
 */
import { conn } from './connection'

export interface SavedQuery {
  id: number
  name: string
  kind: string
  expr: string
}

export function listSavedQueries(): SavedQuery[] {
  return conn()
    .prepare('SELECT id, name, kind, expr FROM saved_query ORDER BY sort_key, id')
    .all() as SavedQuery[]
}

export function saveSavedQuery(input: {
  id?: number
  name: string
  kind?: string
  expr: string
}): { ok: boolean; id?: number; problems: string[] } {
  const name = input.name.trim()
  const expr = input.expr.trim()
  if (!name) return { ok: false, problems: ['名称不能为空'] }
  if (!expr) return { ok: false, problems: ['表达式不能为空'] }
  const c = conn()
  const stamp = new Date().toISOString()
  if (input.id) {
    c.prepare('UPDATE saved_query SET name = ?, expr = ?, updated_at = ? WHERE id = ?').run(
      name,
      expr,
      stamp,
      input.id
    )
    return { ok: true, id: input.id, problems: [] }
  }
  const info = c
    .prepare(
      'INSERT INTO saved_query (name, kind, expr, sort_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(name, input.kind ?? 'task', expr, String(Date.now()), stamp, stamp)
  return { ok: true, id: Number(info.lastInsertRowid), problems: [] }
}

export function deleteSavedQuery(id: number): boolean {
  return conn().prepare('DELETE FROM saved_query WHERE id = ?').run(id).changes > 0
}
