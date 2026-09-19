/**
 * 笔记「大模型解读整理归纳」的主进程实现。
 *
 * 一次整理的完整链路（每一步失败都保持原笔记不变）：
 *   1. 读设置 —— 地址 / Key / 协议 / 模型 / 提示词，缺一不可；
 *   2. 把正文里的图片与本地文件抽成占位符（@@IMG1@@ / @@FILE1@@），**不把二进制发出去**；
 *   3. 渲染提示词（注入现有文件夹路径、标题、占位符清单、正文）并调用模型；
 *   4. 解析模型返回的 JSON（剥代码围栏、找最外层 {}）；
 *   5. **审计**：双链 / 外链 / 附件占位符 / 篇幅逐项核对，error 直接拒绝写库；
 *   6. 把占位符填回真实 Markdown，按模型给的路径找现有文件夹或逐级新建；
 *   7. saveNote 落库（它自己会在正文变更前留一份版本快照，可回滚）。
 *
 * 为什么不把「整理」做成一步到位的替换：模型有概率丢内容，而笔记是用户唯一的正本。
 * 宁可这次不写、告诉他哪里对不上，也不能悄悄丢一段。
 */
import { conn } from './db/connection'
import { createNote, createNoteFolder, getNote, listNoteFolders, resolveNoteTitle, saveNote } from './db/notes'
import { repairNoteAssociations } from './db/note-assoc'
import {
  appendLinkItems,
  describeLinkItems,
  parseLinkItems,
  serializeLinkItems,
  type NoteLinkItem,
} from '../shared/note-links'
import { listSettings } from './db/settings'
import { parseSettings } from '../shared/settings'
import {
  DEFAULT_AI_LIBRARY_PROMPT,
  auditLinkAssignment,
  auditOrganizedNote,
  describeFolders,
  describeNotes,
  describePlaceholders,
  extractNotePlaceholders,
  flattenFolders,
  noteKindHint,
  parseAiResult,
  renderAiPrompt,
  restoreNotePlaceholders,
  splitFolderPath,
  type AuditIssue,
  type AiLibraryOutcome,
  type AiLibraryProgress,
  type AiOrganizeOutcome,
  type AiProtocol,
  type AiSettings,
} from '../shared/ai-note'

/** 系统角色固定不变：用户的提示词模板整条走 user 消息，三家协议都吃得下。 */
const SYSTEM_PROMPT = '你是一个严谨的笔记整理助手。严格按要求只输出 JSON，不要输出任何额外说明。'

/** 组装当前生效的 AI 配置。 */
export function currentAiSettings(): AiSettings {
  const s = parseSettings(listSettings())
  return {
    baseUrl: s.ai_base_url,
    apiKey: s.ai_api_key,
    protocol: s.ai_protocol,
    model: s.ai_model,
    prompt: s.ai_prompt,
    libraryPrompt: s.ai_library_prompt,
    timeoutSec: s.ai_timeout_sec,
  }
}

/**
 * 整理落库后的**关联修复**：标题引用（任务备注里的 [[标题]]）与段落锚（block_key 指纹）。
 * 返回一句可拼进回执的说明；没有可修的就返回空串。
 */
function repairAfter(noteId: number, prev: { title: string; content_md: string }): string {
  try {
    const r = repairNoteAssociations(noteId, prev)
    const parts: string[] = []
    if (r.taskNotes) parts.push(`同步 ${r.taskNotes} 条任务关联`)
    if (r.contexts) parts.push(`重算 ${r.contexts} 个段落锚`)
    if (r.unresolved) parts.push(`${r.unresolved} 个段落锚因正文改动过大已失效`)
    return parts.join('，')
  } catch (err) {
    console.error('[ai] 关联修复失败', err)
    return ''
  }
}

/** 现有笔记标题清单（链接归档时要靠它挑目标；只取最近 400 条，别把上下文塞满）。 */
function noteListForPrompt(): { title: string; format: string | null }[] {
  return conn()
    .prepare(
      `SELECT title, format FROM note WHERE deleted_at IS NULL
        ORDER BY updated_at DESC, id DESC LIMIT 400`
    )
    .all() as { title: string; format: string | null }[]
}

export interface AiHttpRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/**
 * 按协议组装请求。三家形状不同，但都只是「把一段文本发出去、拿一段文本回来」：
 *   openai    POST {base}/chat/completions   Authorization: Bearer <key>
 *   anthropic POST {base}/messages           x-api-key + anthropic-version
 *   gemini    POST {base}/models/<model>:generateContent?key=<key>
 * base 若已写到具体 endpoint（例如以 /chat/completions 结尾）就不再追加，免得拼出双份。
 */
export function buildAiRequest(s: AiSettings, prompt: string): AiHttpRequest {
  const base = (s.baseUrl || '').trim().replace(/\/+$/, '')
  if (s.protocol === 'anthropic') {
    const url = /\/messages$/.test(base) ? base : `${base}/messages`
    return {
      url,
      headers: {
        'content-type': 'application/json',
        'x-api-key': s.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: s.model,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      }),
    }
  }
  if (s.protocol === 'gemini') {
    const url = `${base}/models/${encodeURIComponent(s.model)}:generateContent?key=${encodeURIComponent(s.apiKey)}`
    return {
      url,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 },
      }),
    }
  }
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
  return {
    url,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.apiKey}` },
    body: JSON.stringify({
      model: s.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      stream: false,
    }),
  }
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null
const asText = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 从三家响应里取出正文文本；取不到返回空串（调用方会当成失败）。 */
export function extractAiText(protocol: AiProtocol, payload: unknown): string {
  const root = asRecord(payload)
  if (!root) return ''
  if (protocol === 'anthropic') {
    const parts = root.content
    return Array.isArray(parts)
      ? parts.map((p) => asText(asRecord(p)?.text)).join('').trim()
      : ''
  }
  if (protocol === 'gemini') {
    const candidates = root.candidates
    const first = Array.isArray(candidates) ? asRecord(candidates[0]) : null
    const parts = asRecord(first?.content)?.parts
    return Array.isArray(parts) ? parts.map((p) => asText(asRecord(p)?.text)).join('').trim() : ''
  }
  const choice = Array.isArray(root.choices) ? asRecord(root.choices[0]) : null
  const message = asRecord(choice?.message)?.content
  if (typeof message === 'string') return message.trim()
  // 有些 OpenAI 兼容端点按多模态格式返回数组
  if (Array.isArray(message)) return message.map((p) => asText(asRecord(p)?.text)).join('').trim()
  return ''
}

async function callAiModel(s: AiSettings, prompt: string, timeoutSec?: number): Promise<string> {
  const req = buildAiRequest(s, prompt)
  const seconds = Math.max(5, timeoutSec ?? s.timeoutSec)
  let res: Response
  try {
    res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(seconds * 1000),
    })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`等待超过 ${seconds} 秒（模型太慢或地址不通），可在设置里调大超时`)
    }
    throw new Error(err instanceof Error ? err.message : String(err))
  }
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 400) || '（无响应体）'}`)
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`返回的不是 JSON：${text.slice(0, 200)}`)
  }
  const out = extractAiText(s.protocol, payload)
  if (!out) throw new Error(`返回里没有文本内容：${text.slice(0, 200)}`)
  return out
}

/** 按名称在指定父级下找文件夹（同级同名不唯一，但按父级定位就够稳定）。 */
function findFolderId(name: string, parentId: number | null): number | null {
  const row = conn()
    .prepare('SELECT id FROM note_folder WHERE name = ? AND parent_id IS ? ORDER BY id LIMIT 1')
    .get(name, parentId) as { id: number } | undefined
  return row?.id ?? null
}

/**
 * 把模型给的路径变成真实 folder_id：逐级「有就复用、没有就新建」。
 * 返回最终 id、完整路径与本次新建的路径（后者用于提示用户）。
 */
export function resolveFolderPath(path: string): {
  folderId: number | null
  folderPath: string
  created: string[]
} {
  const parts = splitFolderPath(path)
  if (!parts.length) return { folderId: null, folderPath: '', created: [] }
  const created: string[] = []
  const walked: string[] = []
  let parentId: number | null = null
  for (const name of parts) {
    walked.push(name)
    const existing = findFolderId(name, parentId)
    if (existing != null) {
      parentId = existing
      continue
    }
    const made = createNoteFolder(name, parentId)
    if (!made) break
    parentId = made.id
    created.push(walked.join('/'))
  }
  return { folderId: parentId, folderPath: walked.join('/'), created }
}

/**
 * Word / Excel：库里只有标题，正文在 .docx / .xlsx 文件里。
 * 所以这一路**只做归类**（顺带接受模型给的新标题），绝不碰 content_md。
 */
async function organizeMetaNote(
  note: { id: number; title: string; format: string; folder_id: number | null; content_md: string | null },
  s: AiSettings,
  template: string
): Promise<AiOrganizeOutcome> {
  const rendered = renderAiPrompt(template, {
    folders: describeFolders([...flattenFolders(listNoteFolders()).keys()].sort()),
    notes: describeNotes(noteListForPrompt()),
    title: note.title,
    format: note.format,
    kind: noteKindHint(note.format),
    attachments: '（无：正文在本地文件里）',
    content: `（正文不在笔记库里；这是 ${note.format === 'word' ? 'Word 文档' : 'Excel 表格'}，只需要判断它该归入哪个文件夹）`,
  })
  if (!rendered.ok) return { ok: false, message: '提示词里缺少 {{CONTENT}} 变量：请到设置里补上或点「恢复默认」' }

  let raw: string
  try {
    raw = await callAiModel(s, rendered.prompt)
  } catch (err) {
    return { ok: false, message: `调用大模型失败：${err instanceof Error ? err.message : String(err)}` }
  }
  const parsed = parseAiResult(raw)
  if (!parsed) return { ok: false, message: `模型没有按要求返回 JSON（前 200 字）：${raw.slice(0, 200)}` }

  const issues: AuditIssue[] = []
  if (parsed.content.trim()) {
    issues.push({ level: 'warn', message: '模型为 Office 笔记返回了正文，已忽略（正文在本地文件里）' })
  }
  const { folderId, folderPath, created } = resolveFolderPath(parsed.folder)
  const fields: { title?: string; folder_id?: number | null } = {}
  if (parsed.title && parsed.title !== note.title) fields.title = parsed.title
  if (folderId != null && folderId !== note.folder_id) fields.folder_id = folderId
  const saved = Object.keys(fields).length ? saveNote(note.id, fields) : getNote(note.id)
  if (!saved) return { ok: false, message: '写入失败（笔记可能已被删除）', issues }
  // 正文没动，但标题可能变了 —— 任务备注里的 [[旧标题]] 要跟着改
  const repaired = repairAfter(note.id, {
    title: note.title,
    content_md: note.content_md ?? '',
  })
  return {
    ok: true,
    message: `${folderId != null ? `已归类到「${folderPath}」` : '已整理'}${repaired ? `（${repaired}）` : ''}${duplicateTitleHint(note.id)}`,
    summary: parsed.summary,
    folderPath: folderId != null ? folderPath : '',
    createdFolders: created,
    noteId: note.id,
    title: saved.title,
    issues,
  }
}

/**
 * 链接笔记：内容是一组「标题 + 链接」。
 *
 * 模型为每条链接给出 into（目标笔记标题）：
 *   - 空 → 留在本笔记
 *   - 已存在的链接笔记 → 追加进去（同 url 去重）
 *   - 不存在 → 新建一篇链接笔记，放在与本笔记相同的文件夹
 * 写库顺序刻意是「先目标、后本笔记」：中途失败时本笔记仍保有全部链接，不会丢东西。
 */
async function organizeLinkNote(
  note: { id: number; title: string; folder_id: number | null; content_md: string | null },
  s: AiSettings,
  template: string
): Promise<AiOrganizeOutcome> {
  const original = parseLinkItems(note.content_md)
  if (!original.length) return { ok: false, message: '这篇链接笔记里还没有链接' }

  const rendered = renderAiPrompt(template, {
    folders: describeFolders([...flattenFolders(listNoteFolders()).keys()].sort()),
    notes: describeNotes(noteListForPrompt()),
    title: note.title,
    format: 'link',
    kind: noteKindHint('link'),
    attachments: '（无）',
    content: describeLinkItems(original),
  })
  if (!rendered.ok) return { ok: false, message: '提示词里缺少 {{CONTENT}} 变量：请到设置里补上或点「恢复默认」' }

  let raw: string
  try {
    raw = await callAiModel(s, rendered.prompt)
  } catch (err) {
    return { ok: false, message: `调用大模型失败：${err instanceof Error ? err.message : String(err)}` }
  }
  const parsed = parseAiResult(raw)
  if (!parsed) return { ok: false, message: `模型没有按要求返回 JSON（前 200 字）：${raw.slice(0, 200)}` }
  if (!parsed.links.length) return { ok: false, message: '模型没有返回 links 数组，无法判断每条链接的去向' }

  const audit = auditLinkAssignment({ original, returned: parsed.links })
  if (!audit.ok) return { ok: false, message: '整理结果没通过审计，已保持原笔记不变', issues: audit.issues }

  // 分配：留下的 vs 要归档到某标题下的
  const keep: NoteLinkItem[] = []
  const moves = new Map<string, NoteLinkItem[]>()
  for (const l of parsed.links) {
    const item: NoteLinkItem = { title: l.title || l.url, target: l.url }
    if (!l.into) {
      keep.push(item)
      continue
    }
    const arr = moves.get(l.into) ?? []
    arr.push(item)
    moves.set(l.into, arr)
  }

  const { folderId, folderPath, created } = resolveFolderPath(parsed.folder)
  const targetFolder = folderId ?? note.folder_id
  const notesCreated: string[] = []
  let moved = 0
  for (const [targetTitle, items] of moves) {
    const existingId = resolveNoteTitle(targetTitle)
    const existing = existingId == null ? null : getNote(existingId)
    if (existing && existing.format === 'link') {
      const merged = appendLinkItems(parseLinkItems(existing.content_md), items)
      if (merged.added) saveNote(existing.id, { content_md: serializeLinkItems(merged.items) })
      moved += merged.added
      continue
    }
    const made = createNote(targetTitle, targetFolder, serializeLinkItems(items), 'link')
    if (made) {
      notesCreated.push(targetTitle)
      moved += items.length
    }
  }

  const fields: { title?: string; content_md: string; folder_id?: number | null } = {
    content_md: serializeLinkItems(keep),
  }
  if (parsed.title && parsed.title !== note.title) fields.title = parsed.title
  if (folderId != null && folderId !== note.folder_id) fields.folder_id = folderId
  const saved = saveNote(note.id, fields)
  if (!saved) return { ok: false, message: '写入失败（笔记可能已被删除）', issues: audit.issues }

  const repaired = repairAfter(note.id, { title: note.title, content_md: note.content_md ?? '' })
  const parts = [`保留了 ${keep.length} 条链接`]
  if (moved) parts.push(`归档 ${moved} 条`)
  if (notesCreated.length) parts.push(`新建笔记：${notesCreated.join('、')}`)
  if (repaired) parts.push(repaired)
  const dupHint = duplicateTitleHint(note.id)
  if (dupHint) parts.push(dupHint.replace(/^；/, ''))
  return {
    ok: true,
    message: parts.join('，'),
    summary: parsed.summary,
    folderPath: folderId != null ? folderPath : '',
    createdFolders: created,
    noteId: note.id,
    title: saved.title,
    issues: audit.issues,
  }
}

/**
 * 整理一篇笔记。任何一步不放心都返回 ok:false 且**不写库**。
 *
 * 按格式分派：Word / Excel 只归类（正文在文件里）、链接笔记做链接分发、
 * Markdown / 富文本走正文整理。
 */
export async function organizeNoteWithAi(
  noteId: number,
  promptOverride?: string
): Promise<AiOrganizeOutcome> {
  const s = currentAiSettings()
  if (!s.baseUrl.trim() || !s.model.trim()) {
    return { ok: false, message: '还没配置大模型：请到「设置 → 笔记 AI 整理」填好请求地址与模型' }
  }
  const note = getNote(noteId)
  if (!note) return { ok: false, message: '笔记不存在或已被删除' }
  // 整库整理可以带自己的提示词（为空则用单篇那份）
  const template = promptOverride?.trim() ? promptOverride : s.prompt

  // 按格式分派：Word / Excel 正文在文件里（只归类）、链接笔记做链接分发
  if (note.format === 'word' || note.format === 'excel') return organizeMetaNote(note, s, template)
  if (note.format === 'link') return organizeLinkNote(note, s, template)

  const original = note.content_md ?? ''
  if (!original.trim()) return { ok: false, message: '笔记正文是空的，没什么可整理的' }

  const folderPaths = [...flattenFolders(listNoteFolders()).keys()].sort()
  const { text: masked, items } = extractNotePlaceholders(original)
  const rendered = renderAiPrompt(template, {
    folders: describeFolders(folderPaths),
    notes: describeNotes(noteListForPrompt()),
    title: note.title,
    format: note.format,
    kind: noteKindHint(note.format),
    attachments: describePlaceholders(items),
    content: masked,
  })
  if (!rendered.ok) {
    return {
      ok: false,
      message: '提示词里缺少 {{CONTENT}} 变量，模型拿不到正文。请到设置里补上，或点「恢复默认提示词」。',
    }
  }

  let raw: string
  try {
    raw = await callAiModel(s, rendered.prompt)
  } catch (err) {
    return { ok: false, message: `调用大模型失败：${err instanceof Error ? err.message : String(err)}` }
  }

  const parsed = parseAiResult(raw)
  if (!parsed) {
    return { ok: false, message: `模型没有按要求返回 JSON（前 200 字）：${raw.slice(0, 200)}` }
  }

  // 第一道审计：占位符、双链、外链、篇幅 —— 这一遍是在**还没还原**的文本上做的，
  // 所以能明确知道模型有没有把某张图/某个附件弄丢。
  const maskedAudit = auditOrganizedNote({ original, next: parsed.content, items })
  if (!maskedAudit.ok) {
    return { ok: false, message: '整理结果没通过审计，已保持原笔记不变', issues: maskedAudit.issues }
  }

  const { text: content, missing } = restoreNotePlaceholders(parsed.content, items)
  if (missing.length) {
    return {
      ok: false,
      message: '整理结果没通过审计：附件引用缺失',
      issues: maskedAudit.issues,
    }
  }
  // 第二道审计：在**还原后**的正文上再核一遍链接与篇幅 ——
  // 藏在附件片段里的链接只有还原之后才看得见。
  const finalAudit = auditOrganizedNote({ original, next: content, items: [] })
  const issues: AuditIssue[] = [...maskedAudit.issues, ...finalAudit.issues]
  if (!finalAudit.ok) {
    return { ok: false, message: '整理结果没通过审计，已保持原笔记不变', issues }
  }

  const { folderId, folderPath, created } = resolveFolderPath(parsed.folder)
  const fields: { title?: string; content_md: string; folder_id?: number | null } = {
    content_md: content,
  }
  if (parsed.title && parsed.title !== note.title) fields.title = parsed.title
  if (folderId != null && folderId !== note.folder_id) fields.folder_id = folderId

  const saved = saveNote(noteId, fields)
  if (!saved) return { ok: false, message: '写入失败（笔记可能已被删除）', issues }
  const repaired = repairAfter(noteId, { title: note.title, content_md: original })

  return {
    ok: true,
    message: (repaired ? `已整理并保存（${repaired}）` : '已整理并保存') + duplicateTitleHint(noteId),
    summary: parsed.summary,
    folderPath: folderId != null ? folderPath : '',
    createdFolders: created,
    noteId,
    title: saved.title,
    issues,
  }
}

// ---------------------------------------------------------------- 整库整理

/**
 * 逐篇整理整个笔记库。
 *
 * 几个刻意的选择：
 *   - **串行**：一批请求并发打出去最容易撞限流，而整理本来就是慢活；一篇好了再下一篇。
 *   - **每篇独立审计**：某一篇没过审计只记它失败，不影响其余；失败清单会带回去。
 *   - **文件夹每篇现读**：前一篇新建的目录，后一篇就能复用 —— 否则整库会造出一堆同义目录。
 *   - **可停止**：停止只影响「下一篇」，已经发出的那一篇会跑完并入库（请求已经花掉了）。
 */
let libraryProgress: AiLibraryProgress | null = null
let libraryCancel = false
let libraryNotifier: ((p: AiLibraryProgress) => void) | null = null

/** 进度回调由 IPC 层注入（ai.ts 不该直接碰 BrowserWindow）。 */
export function setAiLibraryNotifier(fn: ((p: AiLibraryProgress) => void) | null): void {
  libraryNotifier = fn
}

function emitLibraryProgress(p: AiLibraryProgress): void {
  libraryProgress = p
  try {
    libraryNotifier?.({ ...p })
  } catch (err) {
    console.error('[ai] 进度通知失败', err)
  }
}

/** 当前整库任务的进度（渲染层挂载时问一次，用来恢复进度显示）。 */
export function currentLibraryProgress(): AiLibraryProgress | null {
  return libraryProgress
}

/**
 * 请求停止整库整理。
 * 返回说明而不是裸 boolean —— 之前调用方分不清「没任务在跑」和「取消失败」，
 * 只能把 false 当成功静默吞掉（冒烟脚本就被这个语义坑过）。
 */
export function cancelOrganizeLibrary(): { ok: boolean; message: string } {
  if (!libraryProgress?.running) {
    return { ok: false, message: '当前没有正在运行的整库整理' }
  }
  libraryCancel = true
  return { ok: true, message: '已请求停止，当前这篇处理完就停下' }
}

/**
 * 标题被改后与别的笔记撞名了吗？撞了就在回执里提示（**不擅自改名**——
 * 两篇的取舍只有用户知道）。整库整理用同一个假模型时特别容易出现这种情况。
 */
function duplicateTitleHint(noteId: number): string {
  const row = conn().prepare('SELECT title FROM note WHERE id = ? AND deleted_at IS NULL').get(noteId) as
    | { title: string }
    | undefined
  if (!row) return ''
  const dup = conn()
    .prepare('SELECT COUNT(*) AS n FROM note WHERE title = ? AND id != ? AND deleted_at IS NULL')
    .get(row.title, noteId) as { n: number } | undefined
  return dup && dup.n > 0 ? `；标题「${row.title}」与另外 ${dup.n} 篇重复，建议改名` : ''
}

/** 待整理的笔记：Markdown / 富文本 / Word / Excel / 链接笔记都在范围内（各有各的处理方式）。 */
function notesToOrganize(): { id: number; title: string; format: string; content_md: string | null }[] {
  return conn()
    .prepare(
      `SELECT id, title, format, content_md FROM note
        WHERE deleted_at IS NULL
        ORDER BY updated_at DESC, id DESC`
    )
    .all() as { id: number; title: string; format: string; content_md: string | null }[]
}

/**
 * 这一篇值不值得花一次请求：
 *   - Word / Excel：库里只有标题，照样能归类；
 *   - 链接笔记：要有链接才有的可分配；
 *   - 其余：正文为空就没得整理。
 */
function worthOrganizing(row: { format: string; content_md: string | null }): boolean {
  if (row.format === 'word' || row.format === 'excel') return true
  if (row.format === 'link') return parseLinkItems(row.content_md).length > 0
  return !!(row.content_md ?? '').trim()
}

export async function organizeLibraryWithAi(): Promise<AiLibraryOutcome> {
  const empty = (message: string): AiLibraryOutcome => ({
    ok: false,
    message,
    total: 0,
    done: 0,
    okCount: 0,
    failedCount: 0,
    skipped: 0,
    createdFolders: 0,
    stopped: false,
    failedTitles: [],
  })
  if (libraryProgress?.running) return empty('已经有一个整库整理在进行中')
  const s = currentAiSettings()
  if (!s.baseUrl.trim() || !s.model.trim()) {
    return empty('还没配置大模型：请到「设置 → 笔记 AI 整理」填好请求地址与模型')
  }

  const rows = notesToOrganize()
  if (!rows.length) return empty('没有可整理的 Markdown / 富文本笔记')

  libraryCancel = false
  let done = 0
  let okCount = 0
  let failedCount = 0
  let skipped = 0
  let createdFolders = 0
  let currentTitle = ''
  const failedTitles: string[] = []
  const snapshot = (patch: Partial<AiLibraryProgress> = {}): AiLibraryProgress => ({
    running: true,
    total: rows.length,
    done,
    ok: okCount,
    failed: failedCount,
    skipped,
    createdFolders,
    currentTitle,
    stopped: libraryCancel,
    ...patch,
  })

  emitLibraryProgress(snapshot())
  for (const row of rows) {
    if (libraryCancel) break
    currentTitle = row.title
    emitLibraryProgress(snapshot())

    // 没内容的没必要花一次请求：直接跳过（与前一篇的成败无关）
    if (!worthOrganizing(row)) {
      skipped += 1
      done += 1
      emitLibraryProgress(snapshot())
      continue
    }

    let res: AiOrganizeOutcome
    try {
      // 整库有自己的一份默认提示词（比单篇更克制）；用户填了就用用户的
      res = await organizeNoteWithAi(row.id, s.libraryPrompt.trim() || DEFAULT_AI_LIBRARY_PROMPT)
    } catch (err) {
      res = { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
    if (res.ok) {
      okCount += 1
      createdFolders += res.createdFolders?.length ?? 0
    } else {
      failedCount += 1
      if (failedTitles.length < 5) failedTitles.push(row.title)
    }
    done += 1
    emitLibraryProgress(snapshot())
  }

  const stopped = libraryCancel
  // 收尾事件：running=false，界面据此收起进度条
  emitLibraryProgress({ ...snapshot(), running: false, currentTitle: '', stopped })
  libraryProgress = null
  libraryCancel = false

  const parts = [stopped ? `已停止：处理了 ${done}/${rows.length} 篇` : `整库整理完成：共 ${rows.length} 篇`]
  parts.push(`成功 ${okCount}`)
  if (failedCount) parts.push(`失败 ${failedCount}`)
  if (skipped) parts.push(`跳过 ${skipped}（正文为空）`)
  if (createdFolders) parts.push(`新建文件夹 ${createdFolders} 个`)
  return {
    ok: true,
    message: parts.join('，'),
    total: rows.length,
    done,
    okCount,
    failedCount,
    skipped,
    createdFolders,
    stopped,
    failedTitles,
  }
}

/** 设置页的「测试连接」：发一句最小请求，只验证地址 / Key / 协议是否通。 */
export async function testAiConnection(): Promise<{ ok: boolean; message: string }> {
  const s = currentAiSettings()
  if (!s.baseUrl.trim() || !s.model.trim()) return { ok: false, message: '请先填写请求地址与模型' }
  try {
    const out = await callAiModel(s, '连接测试：请只回复「连接正常」四个字。', Math.min(s.timeoutSec, 30))
    return { ok: true, message: `连接正常，模型回复：${out.slice(0, 60)}` }
  } catch (err) {
    return { ok: false, message: `连接失败：${err instanceof Error ? err.message : String(err)}` }
  }
}
