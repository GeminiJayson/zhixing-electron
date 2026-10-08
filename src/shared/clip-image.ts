/**
 * 剪藏正文里图片地址的**本地化**（纯逻辑部分）。
 *
 * 为什么不留外链：原站删图、防盗链、改 CDN —— 剪藏的价值就是"以后还能看"，
 * 留一个 `https://` 地址等于赌对方不删。所以图片要**下载成文件**存在数据目录，
 * 正文里改成 `zx-attach://` 引用（主进程注册了这个协议，渲染层直接就能显示）。
 */
export const CLIP_ATTACH_SCHEME = 'zx-attach'

/** 单张图片的大小上限：超过就保留外链。剪藏常见的是插图，50MB 的是源文件。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** 一篇正文最多抓多少张：防着"图集页"一次拉几百张把落库拖住。 */
export const MAX_IMAGES_PER_CLIP = 20
/** 单张下载超时（毫秒）。 */
export const IMAGE_TIMEOUT_MS = 10_000

/** 认得出的图片扩展名；认不出就按 content-type 推，再不行按 .img 存。 */
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
}

/** 按 content-type → URL 扩展名 → 兜底的顺序定扩展名。 */
export function imageExt(contentType: string, url: string): string {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase()
  if (EXT_BY_TYPE[ct]) return EXT_BY_TYPE[ct]
  try {
    const path = new URL(url).pathname
    const m = /\.([a-z0-9]{2,5})$/i.exec(path)
    if (m && Object.values(EXT_BY_TYPE).includes(m[1].toLowerCase())) return m[1].toLowerCase()
  } catch {
    /* URL 不合法就走兜底 */
  }
  return 'img'
}

/** 提取正文里所有 `img[src]`（去重、保序、只认 http/https）。 */
export function collectImageUrls(html: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of html.matchAll(/<img\b[^>]*?\ssrc="([^"]+)"/gi)) {
    const url = m[1].trim()
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/** 把某个 URL 的所有引用（src 与 srcset 里的那一段）换成本地引用。 */
export function replaceImageUrl(html: string, remote: string, localUrl: string): string {
  const esc = remote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return html
    .replace(new RegExp('(\\ssrc=")' + esc + '(")', 'gi'), '$1' + localUrl + '$2')
    .replace(new RegExp('(\\ssrcset="[^"]*)' + esc, 'gi'), '$1' + localUrl)
}

/** 本地引用：`zx-attach://<目录名>/<文件名>`。目录名由调用方给（每篇剪藏一个）。 */
export function attachUrl(dir: string, file: string): string {
  return `${CLIP_ATTACH_SCHEME}://${encodeURIComponent(dir)}/${encodeURIComponent(file)}`
}

/**
 * 解析 `zx-attach://` 请求路径 → `{ dir, file }`；不合法返回 null。
 *
 * 单独抽出来是因为它是**安全边界**：协议 handler 只允许读数据目录下 attachments 里的文件，
 * 这里先把 `..` 之类的路径挡掉，再由调用方拼绝对路径并复核前缀。
 */
export function parseAttachUrl(raw: string): { dir: string; file: string } | null {
  if (!raw) return null
  // 整串匹配（只允许两段，后面的 ?query/#hash 可以带）：
  // 用宽松匹配会放过 zx-attach://a/b/c.png —— 那种路径已经越过"目录/文件"两级，
  // 与其在后面猜，不如在这里就不认。
  const m = /^zx-attach:\/\/([^/]+)\/([^/?#]+)(?:[?#].*)?$/i.exec(raw.trim())
  if (!m) return null
  const dir = decodeURIComponent(m[1])
  const file = decodeURIComponent(m[2])
  if (!dir || !file) return null
  if (dir.includes('..') || file.includes('..')) return null
  if (dir.includes('/') || dir.includes('\\') || file.includes('/') || file.includes('\\')) return null
  return { dir, file }
}
