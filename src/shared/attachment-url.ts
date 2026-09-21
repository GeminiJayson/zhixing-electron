/**
 * 附件绝对路径 → 可用的 file:// URL。
 *
 * 为什么单独立一个模块：这段拼装原先散在三处（RichTextEditor 的图片预览与附件链接、
 * XlsxGrid 的单元格图片），其中两处在 Windows 上产出的是 \`file://C%3A%5C...\` ——
 * 实测 \`new URL()\` 直接报 \`Invalid URL\`，双击预览原图与附件链接全体失效。
 *
 * 两个必须绕开的坑：
 * 1. 落库路径来自 \`path.join\`，Windows 上是**反斜杠**。\`split('/')\` 切不动它，
 *    整串会被当成一段去编码。
 * 2. 逐段 \`encodeURIComponent\` 会把盘符的冒号也编码成 \`C%3A\`。而 \`encodeURI\` 又会
 *    放过 \`#\` 和 \`?\`（文件名里出现它们会截断路径）。
 *
 * 所以做法是：先统一分隔符 → 逐段 encodeURIComponent，但**盘符段原样保留**。
 */
export function attachmentUrl(path: string): string {
  const normalized = String(path ?? '').replace(/\\/g, '/')
  if (!normalized) return ''
  // 已经是 URL 形态（作者手工写的外链）就别再加工
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) return normalized
  const encoded = normalized
    .split('/')
    .map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg)))
    .join('/')
  return 'file:///' + encoded
}
