import { join } from 'node:path'
import { countWords, extractLinks, snippetAround } from '../../shared/wiki'
import type {
  Backlink,
  Note,
  NoteFolder,
  NoteLink,
  NoteRevision,
} from '../../shared/types'
import { conn, nowStamp } from './connection'
import { reindexNote, removeFromIndex } from './fts'

// ---------------------------------------------------------------- 笔记

export const NOTE_COLUMNS = `id, folder_id, title, content_md, format, pinned, word_count, created_at, updated_at`

export function listNoteFolders(): NoteFolder[] {
  return conn()
    .prepare('SELECT id, parent_id, name, sort FROM note_folder ORDER BY sort ASC, name ASC')
    .all() as NoteFolder[]
}

export function getNote(id: number): Note | null {
  return (conn().prepare(`SELECT ${NOTE_COLUMNS} FROM note WHERE id = ?`).get(id) as Note | undefined) ?? null
}

/** 按标题解析笔记 id（与 note_service.resolve → notes.by_title 同义）。 */
export function resolveNoteTitle(title: string): number | null {
  const row = conn()
    .prepare(
      'SELECT id FROM note WHERE title = ? AND deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC LIMIT 1'
    )
    .get(title) as { id: number } | undefined
  return row?.id ?? null
}

/**
 * 保存正文时按 [[标题]] 同步 note_link，语义等同 note_service._pipeline 的 diff：
 * 正文里消失的链接删行；新增的插入并按标题尝试绑定 dst_note_id；
 * 已存在的悬空行在目标出现后转正（绑定 dst_note_id）。
 */
export function syncNoteLinks(noteId: number, contentMd: string): void {
  const c = conn()
  const titles = extractLinks(contentMd)
  const wanted = new Set(titles)
  const existing = c
    .prepare('SELECT dst_title FROM note_link WHERE src_note_id = ?')
    .all(noteId) as { dst_title: string }[]

  const del = c.prepare('DELETE FROM note_link WHERE src_note_id = ? AND dst_title = ?')
  for (const row of existing) {
    if (!wanted.has(row.dst_title)) del.run(noteId, row.dst_title)
  }

  const have = new Set(existing.map((r) => r.dst_title))
  const ins = c.prepare('INSERT INTO note_link (src_note_id, dst_title, dst_note_id) VALUES (?, ?, ?)')
  const bind = c.prepare('UPDATE note_link SET dst_note_id = ? WHERE src_note_id = ? AND dst_title = ?')
  for (const title of titles) {
    const resolved = resolveNoteTitle(title)
    const dst = resolved === noteId ? null : resolved // 自链接不绑定，留作悬空
    if (have.has(title)) bind.run(dst, noteId, title)
    else ins.run(noteId, title, dst)
  }
}

export function saveNote(
  id: number,
  fields: {
    title?: string
    content_md?: string
    folder_id?: number | null
    pinned?: boolean
    format?: string
  }
): Note | null {
  const c = conn()
  const before = getNote(id)
  if (!before) return null

  const sets: string[] = []
  const args: unknown[] = []
  let nextTitle = before.title
  if ('title' in fields) {
    nextTitle = (fields.title ?? '').trim() || '未命名笔记'
    sets.push('title = ?')
    args.push(nextTitle)
  }
  if ('content_md' in fields) {
    const md = fields.content_md ?? ''
    sets.push('content_md = ?', 'word_count = ?')
    args.push(md, countWords(md))
  }
  if ('folder_id' in fields) {
    sets.push('folder_id = ?')
    args.push(fields.folder_id ?? null)
  }
  if ('pinned' in fields) {
    sets.push('pinned = ?')
    args.push(fields.pinned ? 1 : 0)
  }
  // 格式此前被锁死为 markdown（新建时硬编码、saveNote 白名单也没有它），
  // 于是 Word/Excel/链接/富文本笔记根本无法创建或转换。
  if ('format' in fields) {
    sets.push('format = ?')
    args.push(validFormat(fields.format))
  }
  if (!sets.length) return before

  // 正文变更前先落一份版本快照（与 note_service.save 的 _snapshot 时机一致）
  if ('content_md' in fields) snapshotNote(id)

  const stamp = nowStamp()
  sets.push('updated_at = ?')
  args.push(stamp, id)
  c.prepare(`UPDATE note SET ${sets.join(', ')} WHERE id = ?`).run(...args)

  if ('content_md' in fields) syncNoteLinks(id, fields.content_md ?? '')
  // 改名后，原先指向旧标题的链接跟随改名（对齐 links.rename_target）
  if (nextTitle !== before.title) {
    c.prepare('UPDATE note_link SET dst_title = ? WHERE dst_title = ?').run(nextTitle, before.title)
  }
  reindexNote(id)
  return getNote(id)
}

/** 五种笔记格式（对齐 NOTE_FORMATS）。word/excel 的 content_md 存本地路径，link 存 URL。 */
export const NOTE_FORMATS = ['markdown', 'richtext', 'word', 'excel', 'link'] as const
export type NoteFormat = (typeof NOTE_FORMATS)[number]

/** 非法或缺失格式一律回退 markdown，避免脏值进库。 */
export function validFormat(value: unknown): NoteFormat {
  return NOTE_FORMATS.includes(value as NoteFormat) ? (value as NoteFormat) : 'markdown'
}

export function createNote(
  title: string,
  folderId: number | null,
  contentMd = '',
  format: string = 'markdown'
): Note | null {
  const stamp = nowStamp()
  const clean = title.trim() || '未命名笔记'
  const info = conn()
    .prepare(
      `INSERT INTO note (folder_id, title, content_md, format, pinned, word_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
    )
    .run(folderId, clean, contentMd, validFormat(format), countWords(contentMd), stamp, stamp)
  const id = Number(info.lastInsertRowid)
  if (contentMd) syncNoteLinks(id, contentMd)
  reindexNote(id)
  return getNote(id)
}

/**
 * 软删除（与 note_service.delete 一致，可从回收站恢复）。
 * 同步把指向它的入链悬空化：dst_note_id→NULL 但保留 dst_title，
 * 否则图谱会因 dst 已删除而整条丢弃该引用。
 */
export function deleteNote(id: number): number {
  const c = conn()
  const stamp = nowStamp()
  const changes = c
    .prepare('UPDATE note SET deleted_at = ?, updated_at = ? WHERE id = ?')
    .run(stamp, stamp, id).changes
  c.prepare('UPDATE note_link SET dst_note_id = NULL WHERE dst_note_id = ?').run(id)
  // 软删即移出全文索引；从回收站恢复时重建
  removeFromIndex('note', id)
  return changes
}

export function listOutLinks(noteId: number): NoteLink[] {
  return conn()
    .prepare('SELECT id, src_note_id, dst_note_id, dst_title FROM note_link WHERE src_note_id = ? ORDER BY id ASC')
    .all(noteId) as NoteLink[]
}

/** 反链：按 dst_note_id 或 dst_title 命中本笔记的来源（对齐 links.backlinks）。 */
export function listBacklinks(noteId: number): Backlink[] {
  const me = getNote(noteId)
  const rows = conn()
    .prepare(
      `SELECT l.src_note_id, l.dst_title, n.title AS src_title, n.content_md
         FROM note_link l JOIN note n ON n.id = l.src_note_id
        WHERE n.deleted_at IS NULL AND (l.dst_note_id = ? OR l.dst_title = ?)
        ORDER BY n.updated_at DESC`
    )
    .all(noteId, me?.title ?? '') as {
    src_note_id: number
    dst_title: string
    src_title: string
    content_md: string
  }[]
  return rows.map((r) => ({
    src_note_id: r.src_note_id,
    src_title: r.src_title,
    snippet: snippetAround(r.content_md ?? '', r.dst_title),
  }))
}

/** 把悬空「待建」引用转正：目标不存在则按标题新建（对齐 materialize_dangling）。 */
export function materializeDangling(srcNoteId: number, title: string): number | null {
  const clean = title.trim()
  if (!clean) return null
  let dst = resolveNoteTitle(clean)
  if (dst === null) dst = createNote(clean, null)?.id ?? null
  if (dst === null) return null
  conn()
    .prepare('UPDATE note_link SET dst_note_id = ? WHERE src_note_id = ? AND dst_title = ?')
    .run(dst, srcNoteId, clean)
  return dst
}

/** 图谱里创建「待建」笔记后，把同标题的悬空引用一次性绑定过去。 */
export function bindDanglingByTitle(title: string): number {
  const clean = title.trim()
  if (!clean) return 0
  const dst = resolveNoteTitle(clean)
  if (dst === null) return 0
  return conn()
    .prepare('UPDATE note_link SET dst_note_id = ? WHERE dst_title = ? AND dst_note_id IS NULL')
    .run(dst, clean).changes
}

export function createNoteFolder(name: string, parentId: number | null): NoteFolder | null {
  const clean = name.trim()
  if (!clean) return null
  const c = conn()
  const row = c.prepare('SELECT MAX(sort) m FROM note_folder').get() as { m: number | null } | undefined
  const info = c
    .prepare('INSERT INTO note_folder (parent_id, name, sort) VALUES (?, ?, ?)')
    .run(parentId, clean, (row?.m ?? 0) + 1)
  return c
    .prepare('SELECT id, parent_id, name, sort FROM note_folder WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as NoteFolder
}

export function renameNoteFolder(id: number, name: string): NoteFolder | null {
  const clean = name.trim()
  if (!clean) return null
  conn().prepare('UPDATE note_folder SET name = ? WHERE id = ?').run(clean, id)
  return conn()
    .prepare('SELECT id, parent_id, name, sort FROM note_folder WHERE id = ?')
    .get(id) as NoteFolder
}

// ---------------------------------------------------------------- 笔记版本历史 / 孤儿 / 模板

/** 版本历史保留最近 20 版（对齐 note_service._NOTE_REVISION_LIMIT）。 */
export const NOTE_REVISION_LIMIT = 20

/** 笔记模板（对齐 NOTE_TEMPLATES：标题前缀 + 内容骨架）。 */
export const NOTE_TEMPLATES: Record<string, { title: string; content: string }> = {
  每日笔记: {
    title: '每日笔记 ',
    content: '# 每日笔记\n\n## 今日计划\n\n- \n\n## 今日回顾\n\n',
  },
  会议记录: {
    title: '会议记录 ',
    content: '# 会议记录\n\n- 时间：\n- 参与人：\n- 议题：\n\n## 结论\n\n## 待办\n\n',
  },
  读书笔记: {
    title: '读书笔记 ',
    content: '# 读书笔记\n\n- 书名：\n- 作者：\n\n## 摘录\n\n## 思考\n\n',
  },
}

/**
 * 保存/回滚前把当前内容存入版本历史（对齐 _snapshot）：
 * 与上一版内容相同则跳过，超出 20 版删最旧的。
 */
export function snapshotNote(noteId: number): void {
  const c = conn()
  const note = getNote(noteId)
  if (!note) return
  const content = note.content_md ?? ''
  const last = c
    .prepare('SELECT content_md FROM note_revision WHERE note_id = ? ORDER BY id DESC LIMIT 1')
    .get(noteId) as { content_md: string } | undefined
  if (last && last.content_md === content) return
  c.prepare(
    'INSERT INTO note_revision (note_id, title, content_md, format, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(noteId, note.title, content, note.format, nowStamp())
  const stale = c
    .prepare('SELECT id FROM note_revision WHERE note_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?')
    .all(noteId, NOTE_REVISION_LIMIT) as { id: number }[]
  const del = c.prepare('DELETE FROM note_revision WHERE id = ?')
  for (const r of stale) del.run(r.id)
}

export function listNoteRevisions(noteId: number): NoteRevision[] {
  return conn()
    .prepare(
      'SELECT id, note_id, title, content_md, format, created_at FROM note_revision WHERE note_id = ? ORDER BY created_at DESC, id DESC'
    )
    .all(noteId) as NoteRevision[]
}

/** 回滚到某版：先给当前内容留快照，避免回滚不可逆（对齐 restore_revision）。 */
export function restoreNoteRevision(noteId: number, revId: number): Note | null {
  const c = conn()
  const rev = c
    .prepare('SELECT id, note_id, title, content_md, format FROM note_revision WHERE id = ?')
    .get(revId) as NoteRevision | undefined
  if (!rev || rev.note_id !== noteId) return null
  snapshotNote(noteId)
  const stamp = nowStamp()
  c.prepare(
    "UPDATE note SET title = ?, content_md = ?, format = ?, word_count = ?, updated_at = ? WHERE id = ?"
  ).run(rev.title, rev.content_md, rev.format || 'markdown', countWords(rev.content_md ?? ''), stamp, noteId)
  syncNoteLinks(noteId, rev.content_md ?? '')
  reindexNote(noteId)
  return getNote(noteId)
}

/** 孤儿笔记：既无出链也无入链（对齐 orphans）。 */
export function orphanNotes(): Note[] {
  const c = conn()
  const notes = c
    .prepare(`SELECT ${NOTE_COLUMNS} FROM note WHERE deleted_at IS NULL ORDER BY updated_at DESC`)
    .all() as Note[]
  const linked = new Set<number>()
  for (const r of c.prepare('SELECT src_note_id, dst_note_id FROM note_link').all() as {
    src_note_id: number
    dst_note_id: number | null
  }[]) {
    linked.add(r.src_note_id)
    if (r.dst_note_id) linked.add(r.dst_note_id)
  }
  return notes.filter((n) => !linked.has(n.id))
}

/** 失效链接：目标是待建状态（dst_note_id 为空）的引用（对齐 broken_links）。 */
export function brokenLinks(): { src_note_id: number; src_title: string; dst_title: string }[] {
  return conn()
    .prepare(
      `SELECT l.src_note_id, n.title AS src_title, l.dst_title
         FROM note_link l JOIN note n ON n.id = l.src_note_id
        WHERE n.deleted_at IS NULL AND l.dst_note_id IS NULL
        ORDER BY n.updated_at DESC`
    )
    .all() as { src_note_id: number; src_title: string; dst_title: string }[]
}

/** 按模板新建笔记（标题带 MM-DD 后缀，对齐 create_from_template）。 */
export function createNoteFromTemplate(kind: string, folderId: number | null): Note | null {
  const tpl = NOTE_TEMPLATES[kind]
  if (!tpl) return null
  const now = new Date()
  const suffix = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return createNote(tpl.title + suffix, folderId, tpl.content)
}
