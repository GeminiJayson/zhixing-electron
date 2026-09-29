/**
 * HTML ↔ 纯文本的小工具。
 *
 * 主进程（闪念转笔记时取标题）与渲染层（把富文本内容追加进 markdown 笔记）都要用，
 * 所以放 shared —— 两份实现迟早会在"块级元素之间要不要补空格"这种细节上分叉。
 */

/** 内容像 HTML 吗。富文本编辑器产出的必然以块级标签开头，纯文本不会。 */
export function looksLikeHtml(s: string): boolean {
  return /^\s*<(p|h[1-6]|ul|ol|li|blockquote|pre|div|span|strong|em|br)\b/i.test((s ?? '').trim())
}

/** 剥标签取纯文本。块级元素之间补空格，免得"第一段第二段"黏成一串。 */
export function plainTextOfHtml(html: string): string {
  return (html ?? '')
    .replace(/<(br|\/p|\/h[1-6]|\/li|\/blockquote|\/pre|\/div)\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 取内容的首段当标题，超长截断。
 *
 * HTML 不能直接 plainTextOfHtml 再取首行 —— 那个函数把块级标签换成空格，
 * <p>标题</p><p>正文</p> 会被连成"标题 正文"一整行，首行取到的就是全篇。
 * 所以先按块级标签切段，再取第一段。
 */
export function titleFromContent(content: string, max = 40): string {
  const c = content ?? ''
  if (!looksLikeHtml(c)) return c.split('\n')[0].slice(0, max).trim()
  const first = c
    .split(/<\/?(?:p|h[1-6]|li|blockquote|pre|div|ul|ol)\b[^>]*>/i)
    .map((seg) => plainTextOfHtml(seg))
    .find((seg) => seg.length > 0)
  return (first ?? '').slice(0, max)
}
