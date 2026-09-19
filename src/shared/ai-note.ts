/**
 * 笔记「大模型解读整理归纳」的共享定义：协议、提示词、附件占位符、审计规则、结果解析。
 *
 * 放在 shared 而不是主进程，是因为这几块都**必须可单测**且两端都想复用：
 *   - 占位符的抽取/还原是纯字符串处理；
 *   - 审计规则是「什么算整理坏了」的唯一真相 —— 主进程据此决定写不写库，
 *     界面据此告诉用户为什么没写；
 *   - 提示词模板与变量说明要同时出现在设置页（可编辑）与主进程（渲染）。
 */

// ---------------------------------------------------------------- 协议与设置

/** 支持的请求协议。都是「文本进、文本出」的对话式接口，差别只在请求/响应形状。 */
export type AiProtocol = 'openai' | 'anthropic' | 'gemini'

export interface AiProtocolSpec {
  value: AiProtocol
  label: string
  /** 请求地址该填到哪一级 */
  baseUrlHint: string
  defaultBaseUrl: string
  defaultModel: string
  hint: string
}

export const AI_PROTOCOLS: AiProtocolSpec[] = [
  {
    value: 'openai',
    label: 'OpenAI 兼容',
    baseUrlHint: '例如 https://api.deepseek.com/v1',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    hint: '填到 /v1 一级即可，会自动追加 /chat/completions。DeepSeek、通义、Kimi、Ollama、vLLM 等都走这个协议。',
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    baseUrlHint: '例如 https://api.anthropic.com/v1',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-5',
    hint: '会自动追加 /messages，并使用 x-api-key 与 anthropic-version 头。',
  },
  {
    value: 'gemini',
    label: 'Google Gemini',
    baseUrlHint: '例如 https://generativelanguage.googleapis.com/v1beta',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.0-flash',
    hint: '会自动追加 /models/<模型>:generateContent，Key 走查询参数。',
  },
]

export const DEFAULT_AI_PROTOCOL: AiProtocol = 'openai'

export function normalizeAiProtocol(raw: string | null | undefined): AiProtocol {
  const k = (raw ?? '').trim()
  return AI_PROTOCOLS.some((p) => p.value === k) ? (k as AiProtocol) : DEFAULT_AI_PROTOCOL
}

export function aiProtocolLabel(raw: string | null | undefined): string {
  const protocol = normalizeAiProtocol(raw)
  return AI_PROTOCOLS.find((p) => p.value === protocol)?.label ?? 'OpenAI 兼容'
}

/** 设置表里的键名（与其它设置一样，都存 settings 的 KV）。 */
export const AI_SETTING_KEYS = {
  baseUrl: 'ai_base_url',
  apiKey: 'ai_api_key',
  protocol: 'ai_protocol',
  model: 'ai_model',
  prompt: 'ai_prompt',
  /** 整库整理专用提示词；留空则回落到单篇那份 */
  libraryPrompt: 'ai_library_prompt',
  timeout: 'ai_timeout_sec',
} as const

export interface AiSettings {
  baseUrl: string
  apiKey: string
  protocol: AiProtocol
  model: string
  prompt: string
  /** 整库整理提示词；空字符串表示「跟单篇用同一份」 */
  libraryPrompt: string
  /** 单次请求的等待上限（秒） */
  timeoutSec: number
}

/** 提示词模板里可以用的变量。渲染后若缺 CONTENT，请求就没有意义，主进程会直接拒绝。 */
export const AI_PROMPT_VARS = [
  '{{FOLDERS}}',
  '{{NOTES}}',
  '{{TITLE}}',
  '{{FORMAT}}',
  '{{KIND}}',
  '{{ATTACHMENTS}}',
  '{{CONTENT}}',
] as const

/** 笔记类型 → 给模型看的说明（链接笔记与 Word/Excel 的处理方式完全不同）。 */
export const NOTE_KIND_HINTS: Record<string, string> = {
  markdown: 'Markdown 笔记（正文就在下面，需要整理排版）',
  richtext: '富文本笔记（正文在下面，按 Markdown 处理即可）',
  word: 'Word 文档（正文在本地 .docx 文件里，笔记库里只有标题 —— 只需归类）',
  excel: 'Excel 表格（正文在本地 .xlsx 文件里，笔记库里只有标题 —— 只需归类）',
  link: '链接笔记（内容是一组「标题 + 链接」，需要判断每条链接的去向）',
}

export function noteKindHint(format: string | null | undefined): string {
  return NOTE_KIND_HINTS[format ?? ''] ?? '笔记'
}

export const AI_DEFAULT_TIMEOUT_SEC = 120

// ---------------------------------------------------------------- 默认提示词

/**
 * 默认提示词。三条硬要求来自需求本身：
 *   1) 归类优先复用现有文件夹，实在没有才新建；
 *   2) 按内容优化排版；
 *   3) **信息与链接一个都不能丢** —— 这条是审计会真的去核的，不是一句客套。
 */
export const DEFAULT_AI_PROMPT = `你是「知行」笔记库的整理助手。请把下面这一篇 Markdown 笔记重新归类并优化排版，同时做到**一个字的信息都不丢**。

## 现有文件夹（优先从这里选，不要造同义目录）
{{FOLDERS}}

## 现有笔记标题（整理链接笔记时从这里挑归档目标，不要重复建同义笔记）
{{NOTES}}

## 待整理的笔记
标题：{{TITLE}}
格式：{{FORMAT}}
类型：{{KIND}}

附件占位符（代表文中的图片/文件，你只能移动它们的位置，不能删除、不能改写标记本身）：
{{ATTACHMENTS}}

正文（Markdown）：
<<<NOTE
{{CONTENT}}
NOTE

## 按类型办事

**Markdown / 富文本**：重排结构 —— 划分合理的标题层级、把并列要点改成列表、把重复啰嗦的句子收紧、修正错别字与中英文标点、统一术语；段落顺序可以调整得更连贯。笔记很短或本来就是零散想法时保持简洁即可，不要强行编造结构。完整返回整理后的正文到 content 字段。

**Word / Excel**：正文在本地文件里，笔记库里只有标题 —— 只需判断它该归入哪个文件夹。content 字段返回空字符串，不要凭空编写正文。

**链接笔记**：内容是一组「标题 + 链接」。为**每一条链接**决定去向：
- 留在本笔记：into 留空
- 归到某篇已有的链接笔记：into 填那篇笔记的标题（必须来自上面的「现有笔记标题」）
- 没有合适的就新建：into 填一个新的简洁标题（2~8 个字，不要与现有标题重复）
把每一条链接都写进 links 数组，url 原样照抄，一条都不能少。content 字段返回空字符串。

**三类都要做归类**：判断主题，从「现有文件夹」里挑最贴切的一个，返回它的完整路径；只有当确实没有合适归属时才新建（简洁名词、2~6 个字、最多两级、用 / 分隔，例如 技术/数据库）。宁可新建，也不要把不相关的内容硬塞进现有目录。

## 硬约束（违反即失败）

- **不得删除任何信息**：原文里的每一个事实、数字、链接、代码片段都必须出现在结果里。
- **不得新增原文没有的事实**：可以补过渡性小标题，但不能编造内容。
- 所有 \`[[双链]]\`、所有 \`[文字](链接)\`、以及所有 \`@@……@@\` 占位符必须**原样保留**；位置可以随上下文移动，但一个都不能少、不能改写法。
- 链接笔记的 links 数组必须覆盖内容里出现的**每一条**链接，url 一个字都不能改写。
- 不要翻译，保持原文的中英混排习惯。
- 输出**完整的 Markdown 正文**：不要写「以下是整理后的内容」这类前言后语，也不要用代码块把整篇包起来。

## 输出格式

只输出一个 JSON 对象，前后不要有任何其它文字：

{
  "folder": "文件夹完整路径，用 / 分隔；维持原样则填空字符串",
  "title": "优化后的标题；没有问题就原样返回",
  "summary": "一句话说明你做了什么，40 字以内",
  "content": "整理后的完整 Markdown 正文；Word / Excel / 链接笔记返回空字符串",
  "links": [
    { "title": "链接标题", "url": "https://…", "into": "归档到的笔记标题；留在本笔记则留空" }
  ]
}`

/** 渲染后的提示词最少要包含 CONTENT：否则模型拿不到正文，请求毫无意义。 */
export function renderAiPrompt(
  template: string,
  vars: {
    folders: string
    notes: string
    title: string
    format: string
    kind: string
    attachments: string
    content: string
  }
): { ok: boolean; prompt: string; missing: string[] } {
  const map: Record<string, string> = {
    '{{FOLDERS}}': vars.folders,
    '{{NOTES}}': vars.notes,
    '{{TITLE}}': vars.title,
    '{{FORMAT}}': vars.format,
    '{{KIND}}': vars.kind,
    '{{ATTACHMENTS}}': vars.attachments,
    '{{CONTENT}}': vars.content,
  }
  // 模板为空时先回落到默认提示词，再算「用了哪些变量」——
  // 否则用户清空提示词会把「空模板」判成缺 {{CONTENT}}，直接拒绝请求。
  let prompt = template || DEFAULT_AI_PROMPT
  const used = AI_PROMPT_VARS.filter((v) => prompt.includes(v))
  const missing = AI_PROMPT_VARS.filter((v) => !used.includes(v))
  for (const [k, v] of Object.entries(map)) prompt = prompt.split(k).join(v)
  return { ok: used.includes('{{CONTENT}}'), prompt, missing: [...missing] }
}

// ---------------------------------------------------------------- 附件占位符

export interface NotePlaceholder {
  /** 发给模型的标记，例如 @@IMG1@@ */
  token: string
  /** 原始 Markdown 片段，回来时原样填回 */
  raw: string
  kind: 'image' | 'file'
  /** 可读说明（alt 文本 / 链接文字），只用于给人看与写进提示词 */
  label: string
  target: string
}

/** Markdown 图片：![alt](src) / ![alt](src "title") */
const IMAGE_SRC = String.raw`!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)`
/** 内联 HTML 图片 */
const HTML_IMG_SRC = String.raw`<img\b[^>]*>`
/** Markdown 链接：[文字](目标) */
const LINK_SRC = String.raw`\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)`
/** 裸链接：只吃 RFC 3986 的合法字符，避免把紧跟其后的中文或标点一起吞掉 */
const BARE_URL_SRC = String.raw`https?:\/\/[A-Za-z0-9\-._~:\/?#\[\]@!$&'*+;=%]+`

/** 外部/锚点链接不算「文件」：它们本来就是可以直接写进正文的文本。 */
const EXTERNAL_TARGET = /^(https?:|mailto:|tel:|#|data:|ftp:)/i

/**
 * 把正文里的图片与本地文件引用抽成占位符。
 *
 * 为什么要抽：图片与附件是二进制，「把整篇笔记交给模型」不可能真的把文件塞进
 * 请求里；而模型只做文字工作，它需要知道的仅仅是「这里有一张图/一个文件」。
 * 于是先用 @@IMG1@@ / @@FILE1@@ 占位，模型改完排版后按标记原位填回。
 */
export function extractNotePlaceholders(markdown: string): {
  text: string
  items: NotePlaceholder[]
} {
  const srcText = markdown ?? ''
  interface Hit {
    index: number
    end: number
    kind: 'image' | 'file'
    raw: string
    label: string
    target: string
  }
  const hits: Hit[] = []
  const push = (m: RegExpMatchArray, kind: 'image' | 'file', label: string, target: string): void => {
    const index = m.index ?? 0
    hits.push({ index, end: index + m[0].length, kind, raw: m[0], label: label.trim(), target })
  }

  for (const m of srcText.matchAll(new RegExp(IMAGE_SRC, 'g'))) push(m, 'image', m[1] ?? '', m[2] ?? '')
  for (const m of srcText.matchAll(new RegExp(HTML_IMG_SRC, 'gi'))) {
    const alt = /alt\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1] ?? ''
    const src = /src\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1] ?? ''
    push(m, 'image', alt, src)
  }
  for (const m of srcText.matchAll(new RegExp(LINK_SRC, 'g'))) {
    const target = m[2] ?? ''
    if (EXTERNAL_TARGET.test(target)) continue // 外链/anchor 是正文的一部分，不动
    push(m, 'file', m[1] ?? '', target)
  }

  // 按出现位置排序后重建：这样占位符编号与正文顺序一致（提示词里的清单读起来才对得上）。
  // 图片内部的 [alt](src) 会被链接正则再匹配一次，用游标跳过被覆盖的那些。
  hits.sort((a, b) => a.index - b.index || b.end - a.end)
  const chosen: Hit[] = []
  let cursor = 0
  for (const h of hits) {
    if (h.index < cursor) continue
    chosen.push(h)
    cursor = h.end
  }

  const items: NotePlaceholder[] = []
  let imgSeq = 0
  let fileSeq = 0
  let out = ''
  let at = 0
  for (const h of chosen) {
    out += srcText.slice(at, h.index)
    const token = h.kind === 'image' ? `@@IMG${++imgSeq}@@` : `@@FILE${++fileSeq}@@`
    items.push({ token, raw: h.raw, kind: h.kind, label: h.label, target: h.target })
    out += token
    at = h.end
  }
  out += srcText.slice(at)

  return { text: out, items }
}

/** 占位符清单 → 写进提示词的人可读说明。 */
export function describePlaceholders(items: NotePlaceholder[]): string {
  if (!items.length) return '（本篇没有图片或附件）'
  return items
    .map((p) => {
      const kind = p.kind === 'image' ? '图片' : '文件'
      const name = p.label || p.target || '未命名'
      return `- ${p.token} → ${kind}：${name}`
    })
    .join('\n')
}

/**
 * 把占位符填回真实内容。返回缺失（模型弄丢的）与残留（模型自己造的）标记，
 * 由审计决定是否放行 —— 这里不做判断，只报告。
 */
export function restoreNotePlaceholders(
  text: string,
  items: NotePlaceholder[]
): {
  text: string
  missing: NotePlaceholder[]
  /** 模型没用占位符，但把原始片段一字不差地抄了回来 —— 内容并没丢 */
  preserved: NotePlaceholder[]
  duplicated: NotePlaceholder[]
  leftover: string[]
} {
  let out = text ?? ''
  const missing: NotePlaceholder[] = []
  const preserved: NotePlaceholder[] = []
  const duplicated: NotePlaceholder[] = []
  for (const p of items) {
    const hits = out.split(p.token).length - 1
    if (hits === 0) {
      // 有些模型会把占位符「翻译」成它以为的内容（提示词里写过 @@FILE1@@ 代表哪个文件）。
      // 只要它抄回来的原文一字不差，就等于没丢东西 —— 放行，但记一条提醒。
      if (out.includes(p.raw)) preserved.push(p)
      else missing.push(p)
      continue
    }
    if (hits > 1) duplicated.push(p)
    out = out.split(p.token).join(p.raw)
  }
  const known = new Set(items.map((p) => p.token))
  const leftover = [...out.matchAll(/@@[A-Za-z]+\d+@@/g)]
    .map((m) => m[0])
    .filter((t) => !known.has(t))
  return { text: out, missing, preserved, duplicated, leftover: [...new Set(leftover)] }
}

// ---------------------------------------------------------------- 审计

export interface AuditIssue {
  level: 'error' | 'warn'
  message: string
}

/** 抽 [[双链]] 的标题（去重）。 */
export function wikiLinks(markdown: string): string[] {
  return [...new Set([...(markdown ?? '').matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim()))]
}

/** 抽正文里出现过的 URL（markdown 链接目标 + 裸链接）。 */
export function urlsIn(markdown: string): string[] {
  const found = new Set<string>()
  for (const m of (markdown ?? '').matchAll(/\]\(\s*(https?:\/\/[^)\s]+)/g)) found.add(m[1])
  for (const m of (markdown ?? '').matchAll(new RegExp(BARE_URL_SRC, 'g'))) {
    // 裸链接末尾常被随手敲上标点，去掉再比对
    found.add(m[0].replace(/[.,;:!?]+$/, ''))
  }
  return [...found]
}

/**
 * 整理结果的审计：**这是写库前的最后一道闸**。
 *
 * 需求里最硬的一条是「链接不丢」，所以这里不是看「像不像整理过」，
 * 而是逐项核对「原文里的东西是不是都还在」：双链、外链、附件占位符。
 * error 一律阻止写入（宁可保留原笔记，也不能悄悄丢内容）；warn 只提示。
 */
export function auditOrganizedNote(input: {
  original: string
  next: string
  items: NotePlaceholder[]
}): { ok: boolean; issues: AuditIssue[] } {
  const issues: AuditIssue[] = []
  const original = input.original ?? ''
  const next = input.next ?? ''

  if (!next.trim()) {
    issues.push({ level: 'error', message: '整理结果为空' })
    return { ok: false, issues }
  }

  const { missing, preserved, duplicated, leftover } = checkPlaceholders(next, input.items)
  for (const p of preserved) {
    issues.push({
      level: 'warn',
      message: `${p.token} 被写成了原始内容（${p.label || p.target}）—— 内容还在，但下次请保留标记`,
    })
  }
  for (const p of missing) {
    issues.push({
      level: 'error',
      message: `丢失${p.kind === 'image' ? '图片' : '文件'}引用 ${p.token}（${p.label || p.target}）`,
    })
  }
  for (const p of duplicated) {
    issues.push({ level: 'warn', message: `${p.token} 在结果里出现了多次` })
  }
  for (const t of leftover) {
    issues.push({ level: 'warn', message: `结果里出现了来源不明的标记 ${t}` })
  }

  const beforeWiki = wikiLinks(original)
  const afterWiki = new Set(wikiLinks(next))
  const lostWiki = beforeWiki.filter((t) => !afterWiki.has(t))
  if (lostWiki.length) {
    issues.push({ level: 'error', message: `丢失双链：${lostWiki.map((t) => `[[${t}]]`).join('、')}` })
  }

  const lostUrls = urlsIn(original).filter((u) => !next.includes(u))
  if (lostUrls.length) {
    issues.push({ level: 'error', message: `丢失链接：${lostUrls.join('、')}` })
  }

  // 篇幅异常往往是「模型只回了摘要」或「把内容展开成了废话」的现场
  if (original.trim().length > 200 && next.length < original.length * 0.3) {
    issues.push({ level: 'error', message: `整理后篇幅骤减（${original.length} → ${next.length} 字），疑似内容被截断` })
  } else if (original.trim().length > 200 && next.length > original.length * 6) {
    issues.push({ level: 'warn', message: `整理后篇幅膨胀（${original.length} → ${next.length} 字），请确认没有注水` })
  }

  return { ok: !issues.some((i) => i.level === 'error'), issues }
}

/** 只做「占位符是否还在」的检查，不做替换 —— 审计阶段不该顺手改写正文。 */
function checkPlaceholders(
  next: string,
  items: NotePlaceholder[]
): {
  missing: NotePlaceholder[]
  preserved: NotePlaceholder[]
  duplicated: NotePlaceholder[]
  leftover: string[]
} {
  const missing: NotePlaceholder[] = []
  const preserved: NotePlaceholder[] = []
  const duplicated: NotePlaceholder[] = []
  for (const p of items) {
    const hits = next.split(p.token).length - 1
    if (hits === 0) {
      if (next.includes(p.raw)) preserved.push(p)
      else missing.push(p)
    } else if (hits > 1) duplicated.push(p)
  }
  const known = new Set(items.map((p) => p.token))
  const leftover = [...new Set([...next.matchAll(/@@[A-Za-z]+\d+@@/g)].map((m) => m[0]).filter((t) => !known.has(t)))]
  return { missing, preserved, duplicated, leftover }
}

// ---------------------------------------------------------------- 结果解析

/** 链接笔记里一条链接的去向。 */
export interface AiLinkAssignment {
  title: string
  url: string
  /** 归档到的笔记标题；空字符串 = 留在本笔记 */
  into: string
}

export interface AiOrganizeResult {
  folder: string
  title: string
  summary: string
  content: string
  /** 只有链接笔记会用到；其它类型是空数组 */
  links: AiLinkAssignment[]
}

/** 模型给的 links 可能是任何形状：逐项校验，坏项直接丢弃。 */
export function parseLinkAssignments(raw: unknown): AiLinkAssignment[] {
  if (!Array.isArray(raw)) return []
  const out: AiLinkAssignment[] = []
  for (const it of raw) {
    const rec = it && typeof it === 'object' ? (it as Record<string, unknown>) : null
    if (!rec) continue
    const url = typeof rec.url === 'string' ? rec.url.trim() : typeof rec.target === 'string' ? rec.target.trim() : ''
    if (!url) continue
    out.push({
      url,
      title: typeof rec.title === 'string' ? rec.title.trim() : '',
      into: typeof rec.into === 'string' ? rec.into.trim() : '',
    })
  }
  return out
}

/**
 * 链接笔记的审计：原文里**每一条链接**都必须有去向（留在本笔记，或归档到某处）。
 * 模型漏掉一条就等于丢一条，直接拦下不写库。
 */
export function auditLinkAssignment(input: {
  original: { title: string; target: string }[]
  returned: AiLinkAssignment[]
}): { ok: boolean; issues: AuditIssue[] } {
  const issues: AuditIssue[] = []
  const returnedUrls = new Set(input.returned.map((l) => l.url.trim()))
  const originalUrls = new Set(input.original.map((l) => l.target.trim()))
  for (const item of input.original) {
    if (!returnedUrls.has(item.target.trim())) {
      issues.push({
        level: 'error',
        message: `链接没有交代去向：${item.title || item.target}`,
      })
    }
  }
  for (const l of input.returned) {
    if (!originalUrls.has(l.url.trim())) {
      issues.push({ level: 'warn', message: `结果里多出了一条原文没有的链接：${l.url}` })
    }
  }
  return { ok: !issues.some((i) => i.level === 'error'), issues }
}

/**
 * 解析模型返回的 JSON。模型经常裹一层说明或代码围栏，所以先剥壳再解析；
 * 仍然失败就返回 null（调用方报「模型没有按要求返回 JSON」）。
 */
export function parseAiResult(raw: string): AiOrganizeResult | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  const fenced = /\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i.exec(text)
  const candidate = (fenced ? fenced[1] : text).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>
    if (!obj || typeof obj !== 'object') return null
    const folder = typeof obj.folder === 'string' ? obj.folder.trim() : ''
    const title = typeof obj.title === 'string' ? obj.title.trim() : ''
    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
    const content = typeof obj.content === 'string' ? obj.content : ''
    const links = parseLinkAssignments(obj.links)
    // Word / Excel / 链接笔记的 content 本来就是空的（正文不在库里），
    // 所以「空 content」不能当成解析失败 —— 只要有一个有效字段就算数。
    if (!content.trim() && !links.length && !folder && !title) return null
    return { folder, title, summary, content, links }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 文件夹路径

/** 把模型给的路径切成各级名称（容忍 / \\ > 等写法，去掉空白级）。 */
export function splitFolderPath(path: string): string[] {
  return (path ?? '')
    .split(/[\\/>]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4)
}

export interface FlatFolder {
  id: number
  parent_id: number | null
  name: string
}

/** 把所有文件夹摊平成「完整路径 → id」，供归类时匹配。 */
export function flattenFolders(folders: FlatFolder[]): Map<string, number> {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const out = new Map<string, number>()
  for (const f of folders) {
    const parts: string[] = []
    let cur: FlatFolder | undefined = f
    const seen = new Set<number>()
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      parts.unshift(cur.name)
      cur = cur.parent_id == null ? undefined : byId.get(cur.parent_id)
    }
    out.set(parts.join('/'), f.id)
  }
  return out
}

/** 文件夹清单 → 提示词里的可读列表。 */
export function describeFolders(paths: string[]): string {
  if (!paths.length) return '（当前还没有任何文件夹，可自行新建）'
  return paths.map((p) => `- ${p}`).join('\n')
}

/**
 * 笔记标题清单 → 提示词里的可读列表（链接笔记归档时要靠它挑目标）。
 * 标题可能上千条，按「链接笔记优先、其余按最近更新」取前 limit 条，
 * 免得把一次请求的上下文全塞满。
 */
export function describeNotes(
  notes: { title: string; format?: string | null }[],
  limit = 300
): string {
  if (!notes.length) return '（笔记库还是空的）'
  const links = notes.filter((n) => n.format === 'link')
  const rest = notes.filter((n) => n.format !== 'link')
  const picked = [...links, ...rest].slice(0, limit)
  const lines = picked.map((n) => `- ${n.title}${n.format === 'link' ? '（链接笔记）' : ''}`)
  if (notes.length > picked.length) lines.push(`（其余 ${notes.length - picked.length} 篇未列出）`)
  return lines.join('\n')
}

/** 整库整理的实时进度（主进程推给渲染层）。 */
export interface AiLibraryProgress {
  running: boolean
  total: number
  done: number
  ok: number
  failed: number
  /** 正文为空被跳过的篇数 */
  skipped: number
  createdFolders: number
  /** 正在处理的笔记标题 */
  currentTitle: string
  /** 用户点了停止（当前这一篇会跑完再停） */
  stopped: boolean
}

/** 整库整理的最终结果。 */
export interface AiLibraryOutcome {
  ok: boolean
  message: string
  total: number
  done: number
  okCount: number
  failedCount: number
  skipped: number
  createdFolders: number
  stopped: boolean
  /** 失败的笔记标题（最多列前 5 个） */
  failedTitles: string[]
}

/** 主进程返回给界面的整理结果。 */
export interface AiOrganizeOutcome {
  ok: boolean
  message: string
  issues?: AuditIssue[]
  summary?: string
  /** 最终归入的文件夹完整路径（未移动则为空） */
  folderPath?: string
  /** 本次新建的文件夹路径 */
  createdFolders?: string[]
  noteId?: number
  title?: string
}
