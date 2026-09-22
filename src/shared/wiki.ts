/**
 * [[wiki 链接]] 解析。
 * 链接按标题引用：[[标题]] → note_link.dst_title，可解析则绑定 dst_note_id。
 */

const WIKI = /\[\[([^\[\]\n]+?)\]\]/g
const CODE_FENCE = /```[\s\S]*?```/g
const INLINE_CODE = /`[^`\n]*`/g

/** 去掉代码块与行内代码，避免把示例里的 [[..]] 当成真链接。 */
export function stripCode(md: string): string {
  return md.replace(CODE_FENCE, '').replace(INLINE_CODE, '')
}

/** 提取正文全部 [[链接]] 目标标题（保持出现顺序、去重）。 */
export function extractLinks(md: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of stripCode(md).matchAll(WIKI)) {
    const title = m[1].trim()
    if (title && !seen.has(title)) {
      seen.add(title)
      out.push(title)
    }
  }
  return out
}


/**
 * 把 [[标题]] 换成 Markdown 链接后交给 marked 渲染：
 * 已解析 → zhixing-note://<id>；悬空 → zhixing-note://new/<标题>（可一键建笔记）。
 * 代码块内不替换。
 */
export function linkifyWiki(md: string, resolved: Map<string, number>): string {
  const parts = md.split(/(```[\s\S]*?```)/g)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part
      return part.replace(/\[\[([^\[\]\n]+?)\]\]/g, (_whole, raw: string) => {
        const title = raw.trim()
        const id = resolved.get(title)
        const href = id
          ? `zhixing-note://${id}`
          : `zhixing-note://new/${encodeURIComponent(title)}`
        return `[${title}](${href})`
      })
    })
    .join('')
}
/** 取链接处 ±radius 字符的上下文摘录（反链面板用）。 */
export function snippetAround(md: string, title: string, radius = 40): string {
  const text = md.replace(/\n/g, ' ')
  let idx = text.indexOf(`[[${title}`)
  if (idx < 0) idx = text.indexOf(title)
  if (idx < 0) return text.slice(0, radius * 2) + (text.length > radius * 2 ? '…' : '')
  const start = Math.max(0, idx - radius)
  const end = Math.min(text.length, idx + title.length + radius)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

/** 首个一级/二级标题，用作新建笔记时的默认标题。 */
export function firstHeading(md: string, fallback = '无标题'): string {
  for (const line of md.split('\n')) {
    const s = line.trim()
    if (s.startsWith('# ')) return s.slice(2).trim()
    if (s.startsWith('## ')) return s.slice(3).trim()
  }
  return fallback
}

/** 字数估算：中日韩按字计，其余按空白分词。 */
export function countWords(md: string): number {
  const cjk = (md.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length
  const latin = (md.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[A-Za-z0-9_'-]+/g) ?? []).length
  return cjk + latin
}
