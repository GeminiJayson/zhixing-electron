/**
 * 画布上的悬停提示 —— 两个画布共用的一点小工具。
 *
 * G6 的 `tooltip` 插件要求 `getContent` 返回 HTML 字符串（或元素），所以这里负责
 * **拼 HTML 与转义**：节点标题是用户数据，直接插进 innerHTML 里既不安全也会被
 * 标题里的 `<` / `&` 弄乱排版。
 *
 * 样式不用插件的内置那套（白底、固定圆角、不跟主题）—— 在 `graph.css` 里用
 * `.g6-tip` 按 token 覆盖，见那里的注释。
 */

/** HTML 转义：只处理会破坏结构的五个字符。 */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

/** 提示框内容：一行主标题 + 一行次要信息（都可选）。 */
export function tipHtml(title: string, sub?: string): string {
  if (!title && !sub) return ''
  return (
    '<div class="gtip">' +
    (title ? `<div class="gtip__t">${esc(title)}</div>` : '') +
    (sub ? `<div class="gtip__s">${esc(sub)}</div>` : '') +
    '</div>'
  )
}
