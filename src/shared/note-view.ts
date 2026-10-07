/**
 * 笔记「数据库视图」的查询语法与属性列推导 —— 纯函数。
 *
 * 与任务侧的 shared/query.ts 同构：语法 → 条件 → 在渲染层过滤。
 * 不下推 SQL 的理由也一样：个人库的笔记量级可控，而"先看懂用户写了什么"
 * 比"少扫几百行"重要得多。
 *
 * 支持的写法（空格分隔，多个条件之间是「与」）：
 *   text:关键词        标题或任一属性值包含它（裸词也按 text 处理）
 *   tag:写作            带这个标签
 *   folder:读书         所在文件夹名
 *   kind:concept        知识类型（note / concept / summary / method / pitfall …）
 *   prop:来源=书籍      属性等于某值
 *   prop:评分           只要有这条属性（不管值是什么）
 */

export interface NoteRow {
  id: number
  title: string
  /** 所在文件夹名；顶层是空串 */
  folder: string
  /** 知识类型（note / concept / …） */
  kind: string
  format: string
  tags: string[]
  /** 结构化属性（已解析成对象） */
  props: Record<string, string>
  word_count: number
  updated_at: string
}

export interface NoteQuery {
  text: string
  tag: string
  folder: string
  kind: string
  props: { key: string; value: string | null }[]
  /** 没看懂的片段 —— 界面上要提示，而不是静默当成"没有条件" */
  unknown: string[]
}

export const EMPTY_NOTE_QUERY: NoteQuery = {
  text: '',
  tag: '',
  folder: '',
  kind: '',
  props: [],
  unknown: [],
}

const lower = (s: string): string => s.toLowerCase()

/**
 * 拆条件。
 *
 * 裸词（不带前缀）并按 text 处理，而不是丢进 unknown：用户想"筛出含这几个字的笔记"
 * 是最自然的输入，逼他写 text: 只会让人以为这个框坏了。
 */
export function parseNoteQuery(expr: string): NoteQuery {
  const q: NoteQuery = { ...EMPTY_NOTE_QUERY, props: [] }
  const words: string[] = []
  for (const raw of String(expr ?? '').split(/\s+/)) {
    const token = raw.trim()
    if (!token) continue
    const i = token.indexOf(':')
    if (i <= 0) {
      // 带比较运算符的裸词（priority>=3 / due<today / !done）是**任务**侧的语法：
      // 当关键词搜会静默搜不到，不如明确提示"这个条件笔记视图不认"
      if (/[<>=!]/.test(token)) q.unknown.push(token)
      else words.push(token)
      continue
    }
    const key = token.slice(0, i).toLowerCase()
    const value = token.slice(i + 1).trim()
    if (!value && key !== 'prop') {
      q.unknown.push(token)
      continue
    }
    if (key === 'text') q.text = q.text ? q.text + ' ' + value : value
    else if (key === 'tag') q.tag = value
    else if (key === 'folder') q.folder = value
    else if (key === 'kind') q.kind = value
    else if (key === 'prop') {
      const eq = value.indexOf('=')
      if (eq < 0) {
        if (value) q.props.push({ key: value, value: null })
        else q.unknown.push(token)
      } else {
        const k = value.slice(0, eq).trim()
        if (k) q.props.push({ key: k, value: value.slice(eq + 1).trim() })
        else q.unknown.push(token)
      }
    } else q.unknown.push(token)
  }
  if (words.length) q.text = [q.text, ...words].filter(Boolean).join(' ')
  return q
}

/** 这条笔记满足条件吗。空条件全过。 */
export function matchNoteQuery(row: NoteRow, q: NoteQuery): boolean {
  if (q.text) {
    // 一个 text: 里可能有多个词（含并进来的裸词）—— 逐个都要求命中，
    // 与"空格分隔 = 与"的大规则保持一致
    const haystack = [row.title, ...Object.values(row.props)].map(lower)
    for (const w of q.text.split(/\s+/).filter(Boolean)) {
      if (!haystack.some((h) => h.includes(lower(w)))) return false
    }
  }
  if (q.tag && !row.tags.some((t) => lower(t) === lower(q.tag))) return false
  if (q.folder && !lower(row.folder).includes(lower(q.folder))) return false
  if (q.kind && lower(row.kind) !== lower(q.kind)) return false
  for (const p of q.props) {
    const hit = Object.entries(row.props).find(([k]) => lower(k) === lower(p.key))
    if (!hit) return false
    if (p.value !== null && lower(hit[1]) !== lower(p.value)) return false
  }
  return true
}

/**
 * 哪些属性该成为表格的一列。
 *
 * 只收出现 ≥2 次的键：只出现一次的键做成列，整列就一个值加一片空白，
 * 既占宽度又看不出规律。按出现次数降序、同次数按首次出现的顺序，保证列序稳定。
 */
export function propColumnsOf(rows: NoteRow[], limit = 6): string[] {
  const count = new Map<string, number>()
  const first = new Map<string, number>()
  rows.forEach((r, i) => {
    for (const k of Object.keys(r.props)) {
      count.set(k, (count.get(k) ?? 0) + 1)
      if (!first.has(k)) first.set(k, i)
    }
  })
  return [...count.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || (first.get(a[0]) ?? 0) - (first.get(b[0]) ?? 0))
    .slice(0, Math.max(0, limit))
    .map(([k]) => k)
}

/** 知识类型的中文名（表格里显示 kind 用）。未知类型原样显示。 */
export const KIND_LABELS: Record<string, string> = {
  note: '笔记',
  project: '项目记录',
  concept: '概念',
  summary: '摘要',
  synthesis: '综述',
  method: '方法论',
  output: '产出',
  pitfall: '踩坑',
}

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}
