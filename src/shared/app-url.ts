/**
 * 判断一个 URL 是不是应用自己的页面。
 *
 * 这个判定守着 `will-navigate`：命中就放行，未命中就 preventDefault 并交给系统浏览器。
 * 所以它必须做**精确比较**，不能做前缀匹配 —— 前缀匹配会把这些一起放行：
 *
 *   http://localhost:5173.evil.com/        以 devUrl 为前缀（dev 模式）
 *   file:///…/renderer/index.html.evil     以入口路径为前缀（**打包后也中**）
 *
 * 放行意味着外部页面被装进一个带着 preload 与全部 IPC 的窗口里。
 * 判定逻辑放在 shared 而不是 main，是为了能在不拉 electron 的前提下单测。
 */
export interface AppUrlContext {
  /** dev 下 vite server 的地址（生产为 undefined）。 */
  devUrl?: string | undefined
  /** 打包后 renderer 入口的 file URL。 */
  htmlHref: string
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/** 逐字符相等的自身页面判定；解析不了的一律不放行。 */
export function isAppOwnUrl(raw: string, ctx: AppUrlContext): boolean {
  const target = parse(raw)
  if (!target) return false

  // dev：认 origin（协议 + 主机 + 端口）。路径不比较 —— vite 的 HMR 与 hash 路由都在同源下。
  const dev = ctx.devUrl ? parse(ctx.devUrl) : null
  if (dev && target.origin === dev.origin) return true

  // 打包：只认入口这一个文件。hash / 查询串放行（reload 与 hash 路由都在这一层），
  // 路径必须逐字符相等，否则 index.html.bak、index.html/../secret 也会命中。
  const own = parse(ctx.htmlHref)
  if (!own) return false
  return target.protocol === own.protocol && target.host === own.host && target.pathname === own.pathname
}
