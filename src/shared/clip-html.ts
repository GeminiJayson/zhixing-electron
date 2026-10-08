/**
 * 把剪藏正文里的图片地址补成**绝对**，并还原懒加载图。
 *
 * 插件侧也会做（`browser-extension/content.js` 的 absolutizeImages），这一层是**兜底**：
 * 用旧版扩展的用户、以及拿 curl 手测的场景，正文里的 `/uploads/a.png` 存进库里就是死链。
 * 主进程恰好知道页面地址（请求体里的 url），所以在这里再兜一次。
 *
 * 只动 `img` 的 `src` / `srcset`：`a[href]` 相对地址在保存下来的静态正文里无害，
 * 而批量重写链接容易踩到页面自身的脚本 URL（`javascript:`、锚点跳转）。
 */
export function absolutizeClipImages(html: string, pageUrl: string): string {
  if (!html || !pageUrl) return html
  let base: URL
  try {
    base = new URL(pageUrl)
  } catch {
    return html
  }
  const abs = (raw: string): string => {
    const v = raw.trim()
    if (!v || /^(data:|blob:|https?:|mailto:|tel:|#)/i.test(v)) return raw
    try {
      return new URL(v, base).href
    } catch {
      return raw
    }
  }
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    let out = tag
    // 懒加载：真图常在 data-src / data-original / data-lazy-src，src 只是占位
    if (/\ssrc="(?:\s*|data:image\/(?:gif|png);base64,[A-Za-z0-9+/=]{0,120})"/i.test(out)) {
      const lazy = /\sdata-(?:src|original|lazy-src|actualsrc)="([^"]+)"/i.exec(out)
      if (lazy) out = out.replace(/\ssrc="[^"]*"/i, ' src="' + abs(lazy[1]) + '"')
    }
    out = out.replace(/(\ssrc=")([^"]*)(")/i, (_m, pre: string, src: string, post: string) => pre + abs(src) + post)
    out = out.replace(/(\ssrcset=")([^"]*)(")/i, (_m, pre: string, set: string, post: string) =>
      pre +
      set
        .split(',')
        .map((part) => {
          const seg = part.trim().split(/\s+/)
          if (!seg[0]) return part.trim()
          seg[0] = abs(seg[0])
          return seg.join(' ')
        })
        .join(', ') +
      post
    )
    return out
  })
}
