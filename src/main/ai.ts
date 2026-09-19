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
import { createNoteFolder, getNote, listNoteFolders, saveNote } from './db/notes'
import { listSettings } from './db/settings'
import { parseSettings } from '../shared/settings'
import {
  auditOrganizedNote,
  describeFolders,
  describePlaceholders,
  extractNotePlaceholders,
  flattenFolders,
  parseAiResult,
  renderAiPrompt,
  restoreNotePlaceholders,
  splitFolderPath,
  type AuditIssue,
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
    timeoutSec: s.ai_timeout_sec,
  }
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
 * 整理一篇笔记。任何一步不放心都返回 ok:false 且**不写库**。
 */
export async function organizeNoteWithAi(noteId: number): Promise<AiOrganizeOutcome> {
  const s = currentAiSettings()
  if (!s.baseUrl.trim() || !s.model.trim()) {
    return { ok: false, message: '还没配置大模型：请到「设置 → 笔记 AI 整理」填好请求地址与模型' }
  }
  const note = getNote(noteId)
  if (!note) return { ok: false, message: '笔记不存在或已被删除' }
  if (note.format !== 'markdown' && note.format !== 'richtext') {
    return { ok: false, message: `「${note.format}」格式的笔记不支持整理（只支持 Markdown / 富文本）` }
  }

  const original = note.content_md ?? ''
  if (!original.trim()) return { ok: false, message: '笔记正文是空的，没什么可整理的' }

  const folderPaths = [...flattenFolders(listNoteFolders()).keys()].sort()
  const { text: masked, items } = extractNotePlaceholders(original)
  const rendered = renderAiPrompt(s.prompt, {
    folders: describeFolders(folderPaths),
    title: note.title,
    format: note.format,
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

  return {
    ok: true,
    message: '已整理并保存',
    summary: parsed.summary,
    folderPath: folderId != null ? folderPath : '',
    createdFolders: created,
    noteId,
    title: saved.title,
    issues,
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
