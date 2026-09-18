/**
 * 窗口与外链的安全收口（对照 electron-development skill 的 Production Security Checklist）。
 *
 * 三条出口必须集中管理，不能每个窗口各写一份：
 *   1. will-navigate        —— 页面内导航（笔记正文里的链接点下去就是这条）
 *   2. setWindowOpenHandler —— window.open / target=_blank
 *   3. will-attach-webview  —— <webview> 逃生通道
 *
 * 以及 shell.openExternal 的协议白名单：渲染进程里能出现的链接全部来自用户内容
 * （笔记正文、导入的数据），不校验就交给系统，等于把任意协议处理器暴露给内容层。
 */
import { shell, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 允许交给系统处理的协议；其余（file:、javascript:、ms-msdt:、smb: …）一律拒绝。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** URL 是否允许交给系统打开。 */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(raw).protocol)
  } catch {
    return false
  }
}

/** 校验后交给系统浏览器；不合法的只记日志——既不抛给调用方，也绝不放行。 */
export function openExternalSafely(raw: string): void {
  if (isSafeExternalUrl(raw)) {
    void shell.openExternal(raw)
    return
  }
  console.warn('[security] 已拦截非白名单协议的对外打开请求：', raw)
}

/** 应用自身入口（打包后用 loadFile 加载，dev 下是 vite server）。 */
function isAppOwnUrl(url: string): boolean {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl && url.startsWith(devUrl)) return true
  return url.startsWith(pathToFileURL(join(__dirname, '../renderer/index.html')).href)
}

/** 给一个窗口装上导航、弹窗、webview 三道防线。 */
export function hardenWindow(win: BrowserWindow): void {
  const contents = win.webContents

  // 除了应用自己的页面，任何导航都拦下；确实要出站的链接交给系统浏览器。
  contents.on('will-navigate', (event, url) => {
    if (isAppOwnUrl(url)) return
    event.preventDefault()
    openExternalSafely(url)
  })

  // 不开任何新的 Electron 窗口，外链走系统浏览器。
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })

  // 应用不使用 <webview>，整条通道直接封掉。
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}
