import { useMemo } from 'react'
import { marked } from 'marked'
import { linkifyWiki } from '@shared/wiki'
import { sanitizeHtml } from '@shared/sanitize-html'

marked.setOptions({ gfm: true, breaks: true })

/**
 * 渲染前清洗：笔记正文可能来自导入 / 粘贴 / AI，属不可信输入。
 *
 * 这里**不再自建消毒**。原先那份是黑名单（移除固定标签表 + on* + 裸 javascript:），
 * 而黑名单天生漏 —— 浏览器解析 URL 会剥掉 tab 与换行，\`java\tscript:alert(1)\` 绕得过去；
 * 它也不处理 svg / math / template / noscript。共享的 sanitizeHtml 是逐 token 的白名单，
 * 且 sanitize-html.ts 的注释早就写了「两边各写一套必然漂移」。
 */

interface Props {
  md: string
  /** 已解析的 [[标题]] → note_id；未出现在此表的即悬空链接 */
  resolved: Map<string, number>
  onOpenNote: (id: number) => void
  onCreateNote: (title: string) => void
}

export function MarkdownView({ md: source, resolved, onOpenNote, onCreateNote }: Props) {
  const html = useMemo(
    () => sanitizeHtml(marked.parse(linkifyWiki(source, resolved), { async: false }) as string),
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
