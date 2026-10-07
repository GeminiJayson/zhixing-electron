/**
 * 笔记「数据库视图」的取数：一条查询把表格要的列一次取齐。
 *
 * 为什么不复用 listNotes()：那个查询走 NOTE_COLUMNS（不含 props / kind），
 * 它是给笔记树用的 —— 树上的每一项既不需要属性也不需要知识类型，
 * 多带这两列等于每次开笔记页都白读一遍全库的 JSON。
 * 表格视图是另一个消费方，给它一条自己的查询，比把树的那条加宽更划算。
 */
import { conn } from './connection'
import type { NoteRow } from '../../shared/note-view'

/** props 是 JSON 对象字符串；坏值当空对象 —— 一条坏记录不该让整张表打不开。 */
export function parseProps(raw: string): Record<string, string> {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = val === null || val === undefined ? '' : String(val)
    }
    return out
  } catch {
    return {}
  }
}

export function noteTableRows(): NoteRow[] {
  const c = conn()
  const folderName = new Map<number, string>()
  for (const r of c.prepare('SELECT id, name FROM note_folder').all() as {
    id: number
    name: string
  }[]) {
    folderName.set(r.id, r.name)
  }
  const tagsOf = new Map<number, string[]>()
  for (const r of c
    .prepare(
      'SELECT nt.note_id AS note_id, t.name AS name FROM note_tag nt JOIN tag t ON t.id = nt.tag_id ORDER BY t.name'
    )
    .all() as { note_id: number; name: string }[]) {
    const list = tagsOf.get(r.note_id)
    if (list) list.push(r.name)
    else tagsOf.set(r.note_id, [r.name])
  }
  const rows = c
    .prepare(
      `SELECT id, title, COALESCE(kind, 'note') AS kind, COALESCE(format, 'markdown') AS format,
              COALESCE(word_count, 0) AS word_count, COALESCE(updated_at, created_at, '') AS updated_at,
              COALESCE(props, '') AS props, folder_id
         FROM note WHERE deleted_at IS NULL ORDER BY updated_at DESC`
    )
    .all() as {
    id: number
    title: string
    kind: string
    format: string
    word_count: number
    updated_at: string
    props: string
    folder_id: number | null
  }[]
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    folder: r.folder_id === null ? '' : (folderName.get(r.folder_id) ?? ''),
    kind: r.kind,
    format: r.format,
    tags: tagsOf.get(r.id) ?? [],
    props: parseProps(r.props),
    word_count: Number(r.word_count) || 0,
    updated_at: r.updated_at,
  }))
}
