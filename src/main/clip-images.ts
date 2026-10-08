import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { dataDir } from './db/connection'
import {
  IMAGE_TIMEOUT_MS,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_CLIP,
  attachUrl,
  collectImageUrls,
  imageExt,
  parseAttachUrl,
  replaceImageUrl,
} from '../shared/clip-image'

/** 剪藏图片的落盘根目录：`<数据目录>/attachments/clip/<每篇一个目录>`。 */
export function clipImagesDir(): string {
  return join(dataDir(), 'attachments', 'clip')
}

/**
 * 下载单张图片。
 *
 * 两个"不存"的判据 —— 都不是理论问题，是抓网页时真的会遇到：
 * 1. **content-type 不是图片**：防盗链/登录墙会把图片请求 302 到一个 HTML 登录页，
 *    存下来就是一张伪装成图的网页文件；
 * 2. **超过大小上限**：正文里的插图通常几十到几百 KB，遇到几十 MB 的多半是原图附件，
 *    落盘会把库撑爆（保留外链至少还能看）。
 */
async function downloadImage(url: string): Promise<{ data: Buffer; type: string } | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), IMAGE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      // 多数站点按 UA 决定给不给图；用扩展的 UA 最容易拿到真图
      headers: { accept: 'image/*,*/*;q=0.8' },
    })
    if (!res.ok) return null
    const type = res.headers.get('content-type') ?? ''
    if (type && !/^image\//i.test(type)) return null
    const len = Number(res.headers.get('content-length') ?? '0')
    if (Number.isFinite(len) && len > MAX_IMAGE_BYTES) return null
    const data = Buffer.from(await res.arrayBuffer())
    if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) return null
    return { data, type }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把正文里的**外链图片下载成本地文件**，并把 `src` 改写成 `zx-attach://`。
 *
 * 为什么要下载：剪藏的价值是"以后还能看"。留一个 `https://` 地址等于赌对方不删图、
 * 不换 CDN、不上防盗链 —— 而这几件事每天都在发生。
 *
 * **单张失败只跳过那一张**（保留它的外链）：抓不到的图不该连累整篇剪藏。
 * 返回改写后的 HTML；一张都没成功时原样返回。
 */
export async function localizeClipImages(html: string, pageUrl: string): Promise<string> {
  const urls = collectImageUrls(html).slice(0, MAX_IMAGES_PER_CLIP)
  if (!urls.length) return html
  const dir = 'clip-' + randomBytes(6).toString('hex')
  const target = join(clipImagesDir(), dir)
  let out = html
  let saved = 0
  for (const url of urls) {
    const got = await downloadImage(url)
    if (!got) continue
    const name = createHash('sha1').update(url).digest('hex').slice(0, 12) + '.' + imageExt(got.type, url)
    try {
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, name), got.data)
    } catch {
      continue
    }
    out = replaceImageUrl(out, url, attachUrl(dir, name))
    saved++
  }
  if (saved === 0 && !pageUrl) return html
  return out
}

/** 协议 handler 用：`zx-attach://` → 真实文件路径；越界或不存在返回 null。 */
export function resolveAttachFile(rawUrl: string): string | null {
  const parsed = parseAttachUrl(rawUrl)
  if (!parsed) return null
  const root = clipImagesDir()
  const file = join(root, parsed.dir, parsed.file)
  // parseAttachUrl 已经挡了 .. 与斜杠，这里再复核一次前缀 —— 安全边界不嫌两层
  if (!file.startsWith(root)) return null
  return existsSync(file) ? file : null
}
