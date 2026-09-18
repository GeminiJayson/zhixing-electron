import { useMemo } from 'react'
import { marked } from 'marked'
import { linkifyWiki } from '@shared/wiki'

marked.setOptions({ gfm: true, breaks: true })

/**
 * 渲染前清洗：笔记正文可能来自导入或粘贴，去掉可执行内容与内联事件处理器。
 * 不依赖额外依赖，用浏览器自带的 DOMParser 做白名单式清理。
 */
function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script,iframe,object,embed,link,style,form,base').forEach((n) => n.remove())
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name)
      else if (/^(href|src|xlink:href)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value))
        el.removeAttribute(attr.name)
    }
  }
  return doc.body.innerHTML
}

interface Props {
  md: string
  /** 已解析的 [[标题]] → note_id；未出现在此表的即悬空链接 */
  resolved: Map<string, number>
  onOpenNote: (id: number) => void
  onCreateNote: (title: string) => void
}

export function MarkdownView({ md: source, resolved, onOpenNote, onCreateNote }: Props) {
  const html = useMemo(
    () => sanitize(marked.parse(linkifyWiki(source, resolved), { async: false }) as string),
    [source, resolved]
  )

  const onClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const anchor = (e.target as HTMLElement).closest('a[href^="zhixing-note://"]')
    if (!anchor) return
    e.preventDefault()
    const rest = (anchor.getAttribute('href') ?? '').replace('zhixing-note://', '')
    if (rest.startsWith('new/')) onCreateNote(decodeURIComponent(rest.slice(4)))
    else if (/^\d+$/.test(rest)) onOpenNote(Number(rest))
  }

  return <div className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}
