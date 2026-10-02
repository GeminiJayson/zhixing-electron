import { conn } from './connection'
import { createNote, getNote } from './notes'
import type { Note } from '../../shared/types'

/**
 * 知识库重组的领域逻辑。设计见 docs/specs/knowledge-base-reorg.md。
 *
 * 这个文件里只有**规则**，没有界面。三条硬规则：
 *
 *   1. **创建即待确认** —— 不存在「直接创建一条可用知识」的函数（方案 §4 第 2 步）；
 *   2. **知识类条目的来源是必填** —— 没有来源只能停在待确认（方案 §8 规则 1）；
 *   3. **从可用退回待确认是一等操作** —— 知识会被推翻，退回并记原因，
 *      而不是删掉（删掉的话下次还会踩同一个坑，方案 §5）。
 */

/** 七个知识类型 + 两个工作区类型。 */
export const KNOWLEDGE_KINDS = [
  'note',
  'project',
  'concept',
  'summary',
  'synthesis',
  'method',
  'output',
  'pitfall',
] as const

export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number]

/** 从资料里提炼出来的类型 —— 它们**必须有来源**才能标为可用。 */
const DERIVED_KINDS: KnowledgeKind[] = ['concept', 'summary', 'synthesis', 'method', 'output', 'pitfall']

export const KIND_LABELS: Record<KnowledgeKind, string> = {
  note: '笔记',
  project: '项目记录',
  concept: '概念',
  summary: '摘要',
  synthesis: '综合分析',
  method: '方法论',
  output: '输出',
  pitfall: '踩坑',
}

export function isKnowledgeKind(v: unknown): v is KnowledgeKind {
  return typeof v === 'string' && (KNOWLEDGE_KINDS as readonly string[]).includes(v)
}

export function needsSource(kind: KnowledgeKind): boolean {
  return DERIVED_KINDS.includes(kind)
}

export interface KnowledgeRow {
  id: number
  title: string
  kind: KnowledgeKind
  verified_at: string | null
  archived_at: string | null
  verify_note: string | null
  updated_at: string | null
}

export type KnowledgeStatus = 'draft' | 'verified' | 'all'

function ensureKind(v: unknown): KnowledgeKind {
  return isKnowledgeKind(v) ? v : 'note'
}

export function knowledgeMeta(id: number): KnowledgeRow | null {
  const r = conn()
    .prepare('SELECT id, title, kind, verified_at, archived_at, verify_note, updated_at FROM note WHERE id = ?')
    .get(id) as KnowledgeRow | undefined
  if (!r) return null
  return { ...r, kind: ensureKind(r.kind) }
}

export interface KnowledgeFilter {
  kind?: KnowledgeKind | 'all'
  status?: KnowledgeStatus
  includeArchived?: boolean
  limit?: number
}

/**
 * 按类型与可信状态列出知识条目。
 *
 * **默认只显示 verified** —— 这是「待确认不进可用区域」在查询层的落地。
 * 想看未核对的，得显式传 status: 'draft'。
 */
export function listKnowledge(filter: KnowledgeFilter = {}): KnowledgeRow[] {
  const where: string[] = ['n.deleted_at IS NULL']
  const params: unknown[] = []

  if (filter.kind && filter.kind !== 'all') {
    where.push('n.kind = ?')
    params.push(filter.kind)
  }
  const status = filter.status ?? 'verified'
  if (status === 'draft') where.push('n.verified_at IS NULL')
  else if (status === 'verified') where.push('n.verified_at IS NOT NULL')

  if (!filter.includeArchived) where.push('n.archived_at IS NULL')

  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
  return conn()
    .prepare(
      'SELECT n.id, n.title, n.kind, n.verified_at, n.archived_at, n.verify_note, n.updated_at ' +
        'FROM note n WHERE ' +
        where.join(' AND ') +
        ' ORDER BY n.updated_at DESC, n.id DESC LIMIT ?'
    )
    .all(...params, limit) as KnowledgeRow[]
}

/** 各类型下可用 / 待确认的条数，用于界面的筛选标签。 */
export function knowledgeCounts(): Record<string, { verified: number; draft: number }> {
  const rows = conn()
    .prepare(
      'SELECT kind, ' +
        'SUM(CASE WHEN verified_at IS NOT NULL THEN 1 ELSE 0 END) AS verified, ' +
        'SUM(CASE WHEN verified_at IS NULL THEN 1 ELSE 0 END) AS draft ' +
        'FROM note WHERE deleted_at IS NULL AND archived_at IS NULL GROUP BY kind'
    )
    .all() as { kind: string; verified: number; draft: number }[]
  const out: Record<string, { verified: number; draft: number }> = {}
  for (const r of rows) out[ensureKind(r.kind)] = { verified: r.verified ?? 0, draft: r.draft ?? 0 }
  return out
}

export interface CreateKnowledgeInput {
  title: string
  content: string
  kind: KnowledgeKind
  /** 来源（原始资料那条笔记的 id） */
  sourceNoteId?: number | null
}

export interface CreateResult {
  ok: boolean
  id?: number
  message?: string
}

/**
 * 新建知识条目。
 *
 * **一律是待确认（verified_at = NULL），没有例外** —— 想变可用只有一条路：
 * verifyKnowledge()，而且对知识类条目必须先挂上来源。
 */
export function createKnowledge(input: CreateKnowledgeInput): CreateResult {
  const title = input.title.trim()
  if (!title) return { ok: false, message: '标题不能为空' }
  const kind = ensureKind(input.kind)

  // createNote 的签名是 (title, folderId, contentMd, format) —— 它不认识 kind，
  // 所以先按普通笔记建出来，再补上类型。两步之间没有别的写入者，
  // 而 kind 有 NOT NULL DEFAULT 'note' 兜底，不存在"短暂的无类型状态"被读到。
  const note = createNote(title, null, input.content)
  if (!note) return { ok: false, message: '创建失败' }

  conn().prepare('UPDATE note SET kind = ? WHERE id = ?').run(kind, note.id)
  if (input.sourceNoteId) linkKnowledge(note.id, input.sourceNoteId, 'derived_from')
  return { ok: true, id: note.id }
}

function stamp(): string {
  return new Date().toISOString()
}

/**
 * 核对通过 —— 从待确认变可用。
 *
 * **知识类条目必须有来源**（方案 §8 规则 1）。没有来源的结论，
 * 三个月后你没法回答「当初凭什么信它」。
 */
export function verifyKnowledge(id: number, verifyNote: string): CreateResult {
  const meta = knowledgeMeta(id)
  if (!meta) return { ok: false, message: '条目不存在' }
  if (needsSource(meta.kind) && incomingSources(id).length === 0) {
    return { ok: false, message: '这条还没有来源，补上来源之后才能标为可用' }
  }
  conn()
    .prepare('UPDATE note SET verified_at = ?, verify_note = ?, updated_at = ? WHERE id = ?')
    .run(stamp(), verifyNote.trim(), stamp(), id)
  return { ok: true, id }
}

/**
 * 退回待确认。
 *
 * **这是知识被推翻时的正确动作，而不是删除** —— 删掉的话你下次还会踩同一个坑。
 * 退回要留原因，所以 verify_note 会被覆盖成退回原因。
 */
export function unverifyKnowledge(id: number, reason: string): CreateResult {
  const meta = knowledgeMeta(id)
  if (!meta) return { ok: false, message: '条目不存在' }
  const note = '退回：' + reason.trim()
  conn()
    .prepare('UPDATE note SET verified_at = NULL, verify_note = ?, updated_at = ? WHERE id = ?')
    .run(note, stamp(), id)
  return { ok: true, id }
}

export function archiveKnowledge(id: number): void {
  conn().prepare('UPDATE note SET archived_at = ?, updated_at = ? WHERE id = ?').run(stamp(), stamp(), id)
}

export function unarchiveKnowledge(id: number): void {
  conn().prepare('UPDATE note SET archived_at = NULL, updated_at = ? WHERE id = ?').run(stamp(), id)
}

// ---------------------------------------------------------------- 来源引用

export type LinkKind = 'related' | 'derived_from' | 'supports' | 'contradicts'

export const LINK_LABELS: Record<LinkKind, string> = {
  related: '相关',
  derived_from: '来源',
  supports: '支持',
  contradicts: '反对',
}

export function isLinkKind(v: unknown): v is LinkKind {
  return v === 'related' || v === 'derived_from' || v === 'supports' || v === 'contradicts'
}

/**
 * 记一条引用关系。
 *
 * 用 note_link 承载（那张表本来就是按标题存的），加一列 link_kind 区分
 * 「相关」与「来源」—— 链接表达相关，而来源要能追溯。
 */
export function linkKnowledge(srcId: number, dstNoteId: number | null, kind: LinkKind, dstTitle?: string): void {
  const target = dstTitle ?? (dstNoteId ? (getNote(dstNoteId)?.title ?? '') : '')
  if (!target) return
  conn()
    .prepare(
      'INSERT INTO note_link (src_note_id, dst_note_id, dst_title, link_kind) VALUES (?,?,?,?) ' +
        'ON CONFLICT (src_note_id, dst_title) DO UPDATE SET link_kind = excluded.link_kind, dst_note_id = excluded.dst_note_id'
    )
    .run(srcId, dstNoteId, target, kind)
}

/** 这条知识引用了谁（来源 / 支持 / 反对 / 相关）。 */
export function outgoingSources(id: number): { title: string; kind: LinkKind; noteId: number | null }[] {
  const rows = conn()
    .prepare('SELECT dst_note_id, dst_title, link_kind FROM note_link WHERE src_note_id = ?')
    .all(id) as { dst_note_id: number | null; dst_title: string; link_kind: string | null }[]
  return rows.map((r) => ({
    noteId: r.dst_note_id,
    title: r.dst_title,
    kind: isLinkKind(r.link_kind) ? r.link_kind : 'related',
  }))
}

/** 只取「来源」那一种。verify 的时候看的是它。 */
export function incomingSources(id: number): { title: string; noteId: number | null }[] {
  return outgoingSources(id)
    .filter((s) => s.kind === 'derived_from')
    .map((s) => ({ title: s.title, noteId: s.noteId }))
}

/** 这份原始资料被哪些知识引用了。删除来源前要看它。 */
export function derivedFrom(sourceId: number): { id: number; title: string }[] {
  return conn()
    .prepare(
      'SELECT n.id AS id, n.title AS title FROM note_link l JOIN note n ON n.id = l.src_note_id ' +
        "WHERE l.dst_note_id = ? AND l.link_kind = 'derived_from' AND n.deleted_at IS NULL"
    )
    .all(sourceId) as { id: number; title: string }[]
}

/**
 * 删除一份原始资料之前先问一句。
 *
 * 方案 §8 规则 3：**被引用的来源不允许直接删** —— 否则那些知识条目会变成
 * 指向空气的结论，而你当时并不知道。
 */
export function canDeleteSource(sourceId: number): { ok: boolean; count: number; titles: string[] } {
  const refs = derivedFrom(sourceId)
  return { ok: refs.length === 0, count: refs.length, titles: refs.slice(0, 5).map((r) => r.title) }
}

/** 界面用：一条笔记加上它的知识元信息。 */
export function noteWithMeta(id: number): (Note & { meta: KnowledgeRow }) | null {
  const n = getNote(id)
  const meta = knowledgeMeta(id)
  if (!n || !meta) return null
  return { ...n, meta }
}
