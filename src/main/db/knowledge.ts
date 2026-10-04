import { type CheckNote, serializeCheckNote } from '../../shared/knowledge-check'
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
  /** 是否有"来源"（derived_from 引用）。筛选条上「无来源」那一档用它 */
  has_source: number
  /**
   * 有多少条知识引用了它（别人把它当来源）。
   *
   * **0 意味着"提炼了却没人用"** —— 这是成熟度三个数字里的「未被引用」。
   * 与 has_source 同构：也把列带回来让界面自己算，不为每种组合写 COUNT 查询。
   */
  ref_count: number
}

/**
 * 筛选档位。
 *
 * 'archived' 是独立一档：归档不是"另一种可信状态"，而是"我现在不看它了"。
 * 'noSource' 也是独立一档 —— 它是"缺来源"这件事本身，与是否已核对无关
 *（知识类条目没有来源就永远核对不了，所以这一档是最该被看见的待办）。
 */
export type KnowledgeStatus = 'draft' | 'verified' | 'all' | 'archived' | 'noSource' | 'unused'

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

  if (status === 'noSource') {
    where.push(
      "NOT EXISTS(SELECT 1 FROM note_link l WHERE l.src_note_id = n.id AND l.link_kind = 'derived_from')"
    )
  }

  if (status === 'unused') {
    // 有来源（是被提炼出来的），但没人引用它 —— "提炼了却没人用"
    where.push(
      "n.kind != 'note' AND n.kind != 'project' AND " +
        "EXISTS(SELECT 1 FROM note_link l WHERE l.src_note_id = n.id AND l.link_kind = 'derived_from') AND " +
        "NOT EXISTS(SELECT 1 FROM note_link l2 WHERE l2.dst_note_id = n.id AND l2.link_kind = 'derived_from')"
    )
  }

  if (status === 'archived') {
    where.push('n.archived_at IS NOT NULL')
  } else if (!filter.includeArchived) {
    where.push('n.archived_at IS NULL')
  }

  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
  return conn()
    .prepare(
      /*
        has_source：这条有没有"来源"（derived_from 引用）。
        ref_count：有多少条知识引用了它 —— 0 就是「提炼了却没人用」。

        筛选条上「无来源」「未被引用」两档要它们，而每一档都要显示计数 ——
        与其为每种组合各写一个 COUNT 查询，不如把这两列带回来让界面自己算：
        条数本来就在几百这个量级，一次取回比多打几轮 IPC 划算，也不用维护两套口径。
      */
      'SELECT n.id, n.title, n.kind, n.verified_at, n.archived_at, n.verify_note, n.updated_at, ' +
        "EXISTS(SELECT 1 FROM note_link l WHERE l.src_note_id = n.id AND l.link_kind = 'derived_from') AS has_source, " +
        "(SELECT COUNT(*) FROM note_link l2 WHERE l2.dst_note_id = n.id AND l2.link_kind = 'derived_from') AS ref_count " +
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
export function verifyKnowledge(id: number, check: CheckNote): CreateResult {
  const meta = knowledgeMeta(id)
  if (!meta) return { ok: false, message: '条目不存在' }

  if (needsSource(meta.kind) && incomingSources(id).length === 0) {
    return { ok: false, message: '这条还没有来源，补上来源之后才能标为可用' }
  }

  /**
   * **方案 §9 的硬规则：关键说法没有依据，就不允许转成可用。**
   *
   * 核对清单的其他项都是"提示"，只有这一项是闸门 —— 它守的是整个流程的意义：
   * 一条自己都承认"没有依据"的结论，不该出现在可用知识里。
   */
  if (check.evidence === 'no') {
    return { ok: false, message: '关键说法还没有依据 —— 补上依据，或把它留在待确认' }
  }

  /**
   * **综合分析的专属闸门**（方案 §7）。
   *
   * 一条既列出支持又列出反对、却不解释"为什么还是倾向某一边"的综合分析，
   * 等于没做 —— 它只是把矛盾原样摊开，没有产生任何判断。
   * 所以只要挂了"反对"的资料，就必须在核对时把矛盾解释清楚。
   */
  if (meta.kind === 'synthesis') {
    const contradictions = incomingSourcesOfKind(id, 'contradicts')
    if (contradictions.length > 0 && !check.conflict.trim()) {
      return {
        ok: false,
        message: '这条挂了 ' + contradictions.length + ' 份反对的资料，必须在「冲突」里解释为什么还是倾向某一边',
      }
    }
  }

  conn()
    .prepare('UPDATE note SET verified_at = ?, verify_note = ?, updated_at = ? WHERE id = ?')
    .run(stamp(), serializeCheckNote(check), stamp(), id)
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

/**
 * 切换类型。
 *
 * **一个例外要处理**：从「笔记 / 项目记录」改成知识类（概念 / 摘要 / …）之后，
 * 这条就变成了"需要来源"的条目。如果它当时没有来源，就不该继续挂着"可用" ——
 * 否则规则 2 会被"先建笔记再改类型"绕过去。
 */
export function setKnowledgeKind(id: number, kind: KnowledgeKind): { ok: boolean; demoted?: boolean } {
  const meta = knowledgeMeta(id)
  if (!meta) return { ok: false }
  conn().prepare('UPDATE note SET kind = ?, updated_at = ? WHERE id = ?').run(kind, stamp(), id)

  if (needsSource(kind) && meta.verified_at && incomingSources(id).length === 0) {
    conn()
      .prepare('UPDATE note SET verified_at = NULL, verify_note = ? WHERE id = ?')
      .run('改为需要来源的类型，但没有来源，已退回待确认', id)
    return { ok: true, demoted: true }
  }
  return { ok: true }
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

/** 取消一条来源引用。 */
export function unlinkKnowledge(srcId: number, dstTitle: string): void {
  conn().prepare('DELETE FROM note_link WHERE src_note_id = ? AND dst_title = ?').run(srcId, dstTitle)
}

/**
 * 搜索可以当来源的笔记。
 *
 * **在内存里过滤而不是走 FTS** —— 这里要的是"按标题找一条笔记"，
 * 候选量是几百条，全取回来做 includes 比走一次 FTS 更简单，也不会把
 * 保险箱那种不该出现在索引里的东西牵扯进来。
 */
export function searchSourceCandidates(query: string, limit = 12): { id: number; title: string; kind: string }[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const rows = conn()
    .prepare(
      'SELECT id, title, kind FROM note WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 800'
    )
    .all() as { id: number; title: string; kind: string }[]
  return rows
    .filter((r) => r.title.toLowerCase().includes(q))
    .slice(0, limit)
    .map((r) => ({ id: r.id, title: r.title, kind: ensureKind(r.kind) }))
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

/** 取某一种引用（来源 / 支持 / 反对）。 */
export function incomingSourcesOfKind(
  id: number,
  kind: LinkKind
): { title: string; noteId: number | null }[] {
  return outgoingSources(id)
    .filter((s) => s.kind === kind)
    .map((s) => ({ title: s.title, noteId: s.noteId }))
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

/**
 * 知识库的三个"待办数字"。设计见 docs/specs/phase3-research.md §2.3。
 *
 * 刻意不做仪表盘 —— 这三个数的价值在于**提醒你去处理**，而提醒要出现在
 * 你本来就待着的地方（笔记页的筛选条），不是一个要专门点进去的页面。
 *
 * 三个数都回答"我现在该做什么"，而不是"我做得怎么样"：
 *   draft    —— 收了但没核对，堆着就是在给自己制造负债
 *   noSource —— 知识类却没有来源，它们永远卡在待确认
 *   unused   —— 有来源但没被任何知识引用，说明提炼了却没用起来
 */
export function knowledgeHealth(): { draft: number; noSource: number; unused: number } {
  const c = conn()
  const draft = (c.prepare('SELECT COUNT(*) n FROM note WHERE deleted_at IS NULL AND archived_at IS NULL AND verified_at IS NULL').get() as { n: number }).n

  const noSource = (
    c
      .prepare(
        'SELECT COUNT(*) n FROM note n WHERE n.deleted_at IS NULL AND n.archived_at IS NULL ' +
          "AND n.kind IN ('concept','summary','synthesis','method','output','pitfall') " +
          "AND NOT EXISTS (SELECT 1 FROM note_link l WHERE l.src_note_id = n.id AND l.link_kind = 'derived_from')"
      )
      .get() as { n: number }
  ).n

  const unused = (
    c
      .prepare(
        'SELECT COUNT(*) n FROM note n WHERE n.deleted_at IS NULL AND n.archived_at IS NULL ' +
          "AND EXISTS (SELECT 1 FROM note_link l WHERE l.src_note_id = n.id AND l.link_kind = 'derived_from') " +
          'AND NOT EXISTS (SELECT 1 FROM note_link r WHERE r.dst_note_id = n.id)'
      )
      .get() as { n: number }
  ).n

  return { draft, noSource, unused }
}

/** 界面用：一条笔记加上它的知识元信息。 */
export function noteWithMeta(id: number): (Note & { meta: KnowledgeRow }) | null {
  const n = getNote(id)
  const meta = knowledgeMeta(id)
  if (!n || !meta) return null
  return { ...n, meta }
}
