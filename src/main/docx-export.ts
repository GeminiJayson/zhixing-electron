/**
 * HTML → docx 段落。
 *
 * 为什么不用现成的 html-to-docx 库：试过 @turbodocx/html-to-docx，它在主进程里一加载就
 * 把整个进程卡死（连渲染进程的 JS 都停了）—— 那个包拖着 12 个依赖，里面混着浏览器相关的东西。
 * 这里自己映射：我们只需要覆盖富文本编辑器真正会产出的那几种结构。
 *
 * 覆盖：段落 / h1–h3 / 有序无序列表 / 粗体 / 斜体 / 下划线 / 删除线 / 链接文字。
 * 图片与复杂排版不在这里还原 —— 这也是「导出生成新文件、原件不动」的原因。
 */
import { HeadingLevel, Paragraph, TextRun } from 'docx'

interface Run {
  text: string
  bold?: boolean
  italics?: boolean
  underline?: boolean
  strike?: boolean
}

function stripTags(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
}

/** 把一段 HTML 拆成若干带格式的文本段（粗体/斜体/下划线/删除线）。 */
function runsOf(fragment: string): Run[] {
  const runs: Run[] = []
  const re = /<(strong|b|em|i|u|s|a)\b[^>]*>([\s\S]*?)<\/\1>|<([^<>]+)>/gi
  let last = 0
  let m: RegExpExecArray | null
  const push = (text: string, fmt: Partial<Run> = {}): void => {
    const t = stripTags(text)
    if (t) runs.push({ text: t, ...fmt })
  }
  while ((m = re.exec(fragment)) !== null) {
    if (m.index > last) push(fragment.slice(last, m.index))
    if (m[1]) {
      const tag = m[1].toLowerCase()
      const fmt: Partial<Run> = {}
      if (tag === 'strong' || tag === 'b') fmt.bold = true
      if (tag === 'em' || tag === 'i') fmt.italics = true
      if (tag === 'u') fmt.underline = true
      if (tag === 's') fmt.strike = true
      push(m[2] ?? '', fmt)
    }
    last = re.lastIndex
  }
  if (last < fragment.length) push(fragment.slice(last))
  return runs
}

function toRuns(fragment: string): TextRun[] {
  const runs = runsOf(fragment)
  return (runs.length ? runs : [{ text: stripTags(fragment) }]).map(
    (r) =>
      new TextRun({
        text: r.text,
        bold: r.bold,
        italics: r.italics,
        underline: r.underline ? {} : undefined,
        strike: r.strike,
      })
  )
}

const HEADINGS: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  h1: HeadingLevel.HEADING_1,
  h2: HeadingLevel.HEADING_2,
  h3: HeadingLevel.HEADING_3,
}

/** HTML 片段 → docx 段落数组。纯函数，便于单测。 */
export function buildDocxParagraphs(html: string): Paragraph[] {
  const out: Paragraph[] = []
  const blocks = String(html ?? '').match(/<(h1|h2|h3|p|li|blockquote)\b[^>]*>[\s\S]*?<\/\1>|<[^>]+>/gi) ?? []
  for (const b of blocks) {
    const tag = (b.match(/^<([a-z0-9]+)/i)?.[1] ?? '').toLowerCase()
    const inner = b.replace(/^<[a-z0-9]+[^>]*>/i, '').replace(/<\/[a-z0-9]+>$/i, '')
    if (HEADINGS[tag]) {
      out.push(new Paragraph({ heading: HEADINGS[tag], children: toRuns(inner) }))
    } else if (tag === 'li') {
      out.push(new Paragraph({ bullet: { level: 0 }, children: toRuns(inner) }))
    } else if (tag === 'blockquote') {
      out.push(new Paragraph({ indent: { left: 480 }, children: toRuns(inner) }))
    } else if (tag === 'p') {
      out.push(new Paragraph({ children: toRuns(inner) }))
    }
  }
  // 一个段落都没有时给一个空段落，docx 不接受空文档
  if (!out.length) out.push(new Paragraph({ children: [new TextRun({ text: stripTags(html) })] }))
  return out
}
