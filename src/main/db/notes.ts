import { join } from 'node:path'
import { countWords, extractLinks, snippetAround } from '../../shared/wiki'
import { relinkTasksForTitle, resolveNoteTitle } from './task-note-links'
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

// 按标题解析笔记 id 挪到 task-note-links.ts（那边要在笔记侧回调时用），这里原样再导出，
// 免得已有的十几个 import 全改一遍。
export { resolveNoteTitle } from './task-note-links'

// ---------------------------------------------------------------- 标签（笔记侧）

/**
 * 全部笔记的标签关联：渲染层拿它给笔记行挂胶囊。
 * tag 表与任务共用一套，所以这里只查 note_tag 一侧，颜色随标签全局一致。
 */
export function noteTagMap(): { note_id: number; id: number; name: string; color: string }[] {
  return conn()
    .prepare(
      `SELECT nt.note_id, t.id, t.name, t.color
         FROM note_tag nt JOIN tag t ON t.id = nt.tag_id
        ORDER BY t.name ASC`
    )
    .all() as { note_id: number; id: number; name: string; color: string }[]
}

/**
 * 覆盖式设置笔记标签：
 * 标签不存在时按名新建，与任务共用同一张 tag 表 —— 于是「给笔记打标签」不需要
 * 另建一套标签体系，标签管理里的重命名 / 合并 / 删除自动同时作用于两边。
 */
export function setNoteTags(noteId: number, names: string[]): void {
  const c = conn()
  c.prepare('DELETE FROM note_tag WHERE note_id = ?').run(noteId)
  const find = c.prepare('SELECT id FROM tag WHERE name = ?')
  const add = c.prepare('INSERT INTO tag (name, color) VALUES (?, ?)')
  const link = c.prepare('INSERT OR IGNORE INTO note_tag (note_id, tag_id) VALUES (?, ?)')
  for (const raw of names) {
    const name = raw.trim()
    if (!name) continue
    let row = find.get(name) as { id: number } | undefined
    if (!row) {
      const info = add.run(name, '#0D9488')
      row = { id: Number(info.lastInsertRowid) }
    }
    link.run(noteId, row.id)
  }
}

/**
 * 保存正文时按 [[标题]] 同步 note_link：
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
    // 解析到什么就绑什么，
    // **不特判自链接**。原先把自链接置空，会让正文里出现自己标题的
    // 笔记在两侧产生不同形态的链接行。
    const dst = resolveNoteTitle(title)
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
    /** 结构化属性（JSON 对象字符串） */
    props?: string | null
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
  if ('props' in fields) {
    sets.push('props = ?')
    args.push(fields.props ?? null)
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

  const stamp = nowStamp()
  sets.push('updated_at = ?')
  args.push(stamp, id)
  const sql = `UPDATE note SET ${sets.join(', ')} WHERE id = ?`

  /**
   * 五步写收进一个事务：版本快照 → 正文 UPDATE → 关联删插 → 改名传播 → 重建索引。
   * 原先是裸的连续写：任一步抛错就留下「快照落了、正文没改」这类半完成状态。
   * 这几步全是同步的，正好适合 better-sqlite3 的同步事务 —— 异步副作用必须留在事务外。
   */
  const tx = c.transaction(() => {
    // 正文变更前先落一份版本快照
    if ('content_md' in fields) snapshotNote(id)
    c.prepare(sql).run(...args)
    if ('content_md' in fields) syncNoteLinks(id, fields.content_md ?? '')
    // 改名后，原先指向旧标题的链接跟随改名
    if (nextTitle !== before.title) {
      c.prepare('UPDATE note_link SET dst_title = ? WHERE dst_title = ?').run(nextTitle, before.title)
      // 任务正文里写的还是旧标题的那些行：按旧标题掉链、按新标题补链
      relinkTasksForTitle(before.title)
      relinkTasksForTitle(nextTitle)
    }
    reindexNote(id)
    return getNote(id)
  })
  return tx()
}

/** 五种笔记格式。word/excel 的 content_md 存本地路径，link 存 URL。 */
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
  // 任务正文可能是**先**写的（那时这篇笔记还不存在），此刻才有机会落链
  relinkTasksForTitle(clean)
  return getNote(id)
}

/**
 * 软删除（可从回收站恢复）。
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

/**
 * 反链：谁引用了我。
 *
 * **只按 dst_note_id 命中，不再按标题兜底。**
 *
 * 原先写的是 `dst_note_id = ? OR dst_title = ?` —— 那第二条是为了"目标被软删后
 * 仍能看到反链"（deleteNote 会把 dst_note_id 置空但保留标题）。但代价是
 * **同名笔记会互相命中**：A 引用了「发布记录」，那么另一篇也叫「发布记录」的
 * 笔记也会在自己的反链里看到 A。连接关系一律以 id 为准，这类误判不该存在。
 *
 * 目标重新出现时 dst_note_id 会被重新绑上（syncNoteLinks / relink 系列），
 * 所以去掉标题兜底不会让引用永久丢失。
 */
export function listBacklinks(noteId: number): Backlink[] {
  const rows = conn()
    .prepare(
      `SELECT l.src_note_id, l.dst_title, n.title AS src_title, n.content_md
         FROM note_link l JOIN note n ON n.id = l.src_note_id
        WHERE n.deleted_at IS NULL AND l.dst_note_id = ?
        ORDER BY n.updated_at DESC`
    )
    .all(noteId) as {
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

/** 把悬空「待建」引用转正：目标不存在则按标题新建。 */
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

/**
 * 笔记文件夹为空时自动新建默认文件夹。
 *
 * 保证「全部笔记」之外始终有一个可归属的目录。返回新建的文件夹，已有则返回 null。
 */
export function ensureDefaultFolder(): NoteFolder | null {
  const c = conn()
  const row = c.prepare('SELECT COUNT(*) n FROM note_folder').get() as { n: number }
  if (row.n > 0) return null
  return createNoteFolder('我的笔记', null)
}

/**
 * 移动笔记文件夹到新父级。
 * 提交前做祖先链回环校验：拒绝挂到自身或自己的子孙下，成环时返回 null 且不写库。
 */
export function moveNoteFolder(folderId: number, newParentId: number | null): NoteFolder | null {
  const c = conn()
  const parents = new Map<number, number | null>()
  for (const f of c.prepare('SELECT id, parent_id FROM note_folder').all() as {
    id: number
    parent_id: number | null
  }[]) {
    parents.set(f.id, f.parent_id)
  }
  if (!parents.has(folderId)) return null
  if (newParentId !== null && !parents.has(newParentId)) return null
  const seen = new Set<number>()
  let cur = newParentId
  while (cur !== null) {
    if (cur === folderId) return null
    if (seen.has(cur)) return null // 既有坏环数据：保守拒绝
    seen.add(cur)
    cur = parents.get(cur) ?? null
  }
  c.prepare('UPDATE note_folder SET parent_id = ? WHERE id = ?').run(newParentId, folderId)
  return c
    .prepare('SELECT id, parent_id, name, sort FROM note_folder WHERE id = ?')
    .get(folderId) as NoteFolder
}

/**
 * 删除笔记文件夹：
 * 其下笔记（含已软删的回收站笔记）回落「全部笔记」，子文件夹上移一级。
 */
export function deleteNoteFolder(folderId: number): number {
  const c = conn()
  const row = c.prepare('SELECT parent_id FROM note_folder WHERE id = ?').get(folderId) as
    | { parent_id: number | null }
    | undefined
  if (!row) return 0
  c.prepare('UPDATE note SET folder_id = NULL, updated_at = ? WHERE folder_id = ?').run(
    nowStamp(),
    folderId
  )
  c.prepare('UPDATE note_folder SET parent_id = ? WHERE parent_id = ?').run(row.parent_id, folderId)
  return c.prepare('DELETE FROM note_folder WHERE id = ?').run(folderId).changes
}

// ---------------------------------------------------------------- 主动引用 / 归属 / 追加

/** add_reference_link 的状态码。 */
export type ReferenceStatus = 'added' | 'dangling' | 'bound' | 'duplicate' | 'invalid' | 'self'

/**
 * 主动建引用 note_link(src → dst)：
 * target 为笔记 id → 引用该笔记（不存在/已软删 → invalid）；target 为标题 →
 * 精确解析到笔记则引用它，解析不到建「待建」悬空链接（dst_note_id=None）。
 * 按 (src, dst_title) 幂等：已存在且目标一致 → duplicate；悬空行转正 → bound。
 */
export function addReferenceLink(srcNoteId: number, target: number | string): ReferenceStatus {
  if (!srcNoteId) return 'invalid'
  let dstId: number | null
  let title: string
  if (typeof target === 'string') {
    title = target.trim()
    if (!title) return 'invalid'
    dstId = resolveNoteTitle(title)
    // 标题解析到自己时按 self 拒绝
    if (dstId === srcNoteId) return 'self'
  } else if (typeof target === 'number') {
    if (target <= 0) return 'invalid'
    if (target === srcNoteId) return 'self'
    const alive = conn()
      .prepare('SELECT title FROM note WHERE id = ? AND deleted_at IS NULL')
      .get(target) as { title: string } | undefined
    if (!alive) return 'invalid'
    dstId = target
    title = (alive.title || '').trim() || '无标题'
  } else {
    return 'invalid'
  }

  const c = conn()
  const row = c
    .prepare('SELECT id, dst_note_id FROM note_link WHERE src_note_id = ? AND dst_title = ?')
    .get(srcNoteId, title) as { id: number; dst_note_id: number | null } | undefined
  if (!row) {
    c.prepare('INSERT INTO note_link (src_note_id, dst_title, dst_note_id) VALUES (?, ?, ?)').run(
      srcNoteId,
      title,
      dstId
    )
    return dstId === null ? 'dangling' : 'added'
  }
  if ((row.dst_note_id ?? null) === (dstId ?? null)) return 'duplicate'
  c.prepare('UPDATE note_link SET dst_note_id = ? WHERE id = ?').run(dstId, row.id)
  return 'bound'
}

/**
 * 向笔记正文追加一段文本，供完成任务时的「复盘/结论」回写。
 * 非空正文前补两个换行；这次写入不触发版本快照。
 */
export function appendNote(noteId: number, text: string): Note | null {
  const note = getNote(noteId)
  if (!note) return null
  const body = (note.content_md ?? '') + (note.content_md ? '\n\n' : '') + text
  const stamp = nowStamp()
  conn()
    .prepare('UPDATE note SET content_md = ?, word_count = ?, updated_at = ? WHERE id = ?')
    .run(body, countWords(body), stamp, noteId)
  reindexNote(noteId)
  return getNote(noteId)
}

/**
 * 段落级上下文：
 * 记录「任务关联了本笔记的某一段落」，同 (task, note, block_key) 幂等。
 * 「选文转任务并关联段落」写这里，供任务侧一键跳回本段。
 */
export function attachNoteBlockContext(
  taskId: number,
  noteId: number,
  blockKey: string,
  snippet = ''
): number {
  if (!blockKey) return 0
  return conn()
    .prepare(
      `INSERT OR IGNORE INTO task_note_context (task_id, note_id, block_key, snippet, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(taskId, noteId, blockKey, snippet, nowStamp()).changes
}

/** 某笔记的全部段落上下文。 */
export function listNoteBlockContexts(
  noteId: number
): { id: number; task_id: number; note_id: number; block_key: string; snippet: string }[] {
  return conn()
    .prepare(
      'SELECT id, task_id, note_id, block_key, snippet FROM task_note_context WHERE note_id = ? ORDER BY id'
    )
    .all(noteId) as {
    id: number
    task_id: number
    note_id: number
    block_key: string
    snippet: string
  }[]
}

/** 本笔记归属的任务。 */
export function noteAttachedTasks(noteId: number): { id: number; title: string }[] {
  return conn()
    .prepare(
      `SELECT t.id, t.title FROM task t JOIN task_note_link l ON l.task_id = t.id
        WHERE l.note_id = ? AND t.deleted_at IS NULL ORDER BY t.updated_at DESC`
    )
    .all(noteId) as { id: number; title: string }[]
}

/**
 * 「关联到任务」候选。
 *
 * 非删、非终态任务；q 非空按标题模糊过滤，按 updated_at 倒序取前 limit 条。
 *
 * **带上所属列表与列表分组的名字**（listName / groupName）：弹层要按层级展示，
 * 原先只回 id 与 title，用户看到一列平铺的任务标题，根本分不清哪个是哪儿的 ——
 * 同名任务（"写文档"这种）尤其明显。
 */
export interface TaskCandidate {
  id: number
  title: string
  /** 所属列表名；任务不属于任何列表时为空 */
  listName: string
  /** 列表所属的分组名（列表文件夹）；没有分组时为空 */
  groupName: string
}

export function noteTaskCandidates(q: string, limit = 30): TaskCandidate[] {
  const needle = q.trim()
  const base = `SELECT t.id, t.title,
        COALESCE(l.name, '') AS listName,
        COALESCE(g.name, '') AS groupName
      FROM task t
      LEFT JOIN list_folder l ON l.id = t.list_id
      LEFT JOIN list_folder g ON g.id = l.parent_id AND g.kind = 'group'
      WHERE t.deleted_at IS NULL AND t.status NOT IN ('done', 'abandoned')`
  if (!needle) {
    return conn()
      .prepare(`${base} ORDER BY t.updated_at DESC LIMIT ?`)
      .all(limit) as TaskCandidate[]
  }
  return conn()
    .prepare(`${base} AND t.title LIKE ? ORDER BY t.updated_at DESC LIMIT ?`)
    .all(`%${needle}%`, limit) as TaskCandidate[]
}

// ---------------------------------------------------------------- 笔记版本历史 / 孤儿 / 模板

/** 版本历史保留最近 20 版。 */
export const NOTE_REVISION_LIMIT = 20

/** 笔记模板。 */
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
 * 保存/回滚前把当前内容存入版本历史：
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

/** 回滚到某版：先给当前内容留快照，避免回滚不可逆。 */
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

/** 孤儿笔记：既无出链也无入链。 */
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

/**
 * 失效链接：
 * dst_note_id 为空（待建/目标已删）**且标题当前解析不到现存笔记**才算失效。
 * 少了后半段过滤时，正文里刚写下的 [[标题]]（目标已存在但尚未绑定 dst_note_id）
 * 会被误报成失效链接。
 */
export function brokenLinks(): { src_note_id: number; src_title: string; dst_title: string }[] {
  const rows = conn()
    .prepare(
      `SELECT l.src_note_id, n.title AS src_title, l.dst_title
         FROM note_link l JOIN note n ON n.id = l.src_note_id
        WHERE n.deleted_at IS NULL AND l.dst_note_id IS NULL
        ORDER BY n.updated_at DESC`
    )
    .all() as { src_note_id: number; src_title: string; dst_title: string }[]
  const existing = new Set(
    (
      conn()
        .prepare('SELECT title FROM note WHERE deleted_at IS NULL')
        .all() as { title: string }[]
    ).map((r) => r.title)
  )
  return rows.filter((r) => !existing.has(r.dst_title))
}

/** 按模板新建笔记。 */
export function createNoteFromTemplate(kind: string, folderId: number | null): Note | null {
  const tpl = NOTE_TEMPLATES[kind]
  if (!tpl) return null
  const now = new Date()
  const suffix = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return createNote(tpl.title + suffix, folderId, tpl.content)
}
