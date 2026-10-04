import { clipboard, ipcMain } from 'electron'
import { type BrowserKey, availableBrowsers, importFromBrowser } from './chrome'
import { rotateVaultToken, vaultPort, vaultServerPort, vaultToken } from './server'
import { GENERATE_DEFAULTS, type GenerateOptions, generatePassword, strengthOf } from './generate'
import { shouldAutoLock, shouldClearClipboard } from './timers'
import * as store from './store'
import type { VaultEntryInput } from './store'

/** 从 origin_url 里取出主机名当标题。解不出来就原样返回。 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url || '(未知站点)'
  }
}

/**
 * 保险箱的 IPC 层：通道注册 + 两个"随时间发生的事"（自动锁定、剪贴板清除）。
 *
 * **渲染层拿不到主密钥** —— 这里只转发"解密后的结果"，密钥始终留在 store 里。
 */

/** 剪贴板里的密码多久后清除。 */
const CLIPBOARD_TTL_MS = 30_000

/** 自动锁定的检查间隔。用轮询而不是精确计时器：它只需要"到点后不久就锁"。 */
const AUTOLOCK_TICK_MS = 15_000

let clipboardTimer: NodeJS.Timeout | null = null
let autoLockTimer: NodeJS.Timeout | null = null

/**
 * 复制到剪贴板，并安排清除。
 *
 * **只在剪贴板内容仍等于我们写进去的值时才清** —— 否则用户在这 30 秒里
 * 复制了别的东西，会被我们误删。KeePass / Bitwarden 都是这个逻辑。
 */
export function copySecret(text: string): void {
  clipboard.writeText(text)
  if (clipboardTimer) clearTimeout(clipboardTimer)
  clipboardTimer = setTimeout(() => {
    // 判据抽在 timers.ts 里并有单测：只在内容仍是那个值时才清
    if (shouldClearClipboard(clipboard.readText(), text)) clipboard.clear()
    clipboardTimer = null
  }, CLIPBOARD_TTL_MS)
}

/** 自动锁定：读设置里的分钟数，超时就锁。0 表示"从不"。 */
function startAutoLock(getMinutes: () => number, onLock: () => void): void {
  if (autoLockTimer) clearInterval(autoLockTimer)
  autoLockTimer = setInterval(() => {
    // 判据抽在 timers.ts 里并有单测（含 0=从不、未解锁不重复锁）
    if (shouldAutoLock(getMinutes(), store.status(), store.idleMs())) {
      store.lock()
      onLock()
    }
  }, AUTOLOCK_TICK_MS)
  // 不阻止进程退出
  autoLockTimer.unref?.()
}

export function stopVaultTimers(): void {
  if (autoLockTimer) clearInterval(autoLockTimer)
  if (clipboardTimer) clearTimeout(clipboardTimer)
  stopClipboardWatch()
  autoLockTimer = null
  clipboardTimer = null
}

// ---------------------------------------------------------------- 剪贴板助手

let clipWatch: NodeJS.Timeout | null = null
let lastClip = ''

/** 像是一条密码：有长度、没有空白。**刻意保守** —— 宁可漏报也不要打扰。 */
function looksLikeSecret(s: string): boolean {
  if (s.length < 8 || s.length > 128) return false
  if (/\s/.test(s)) return false
  // 纯中文短语、纯数字的短串都不太可能是密码
  if (/^[\u4e00-\u9fa5]+$/.test(s)) return false
  if (/^\d+$/.test(s) && s.length < 12) return false
  return true
}

/**
 * 监听剪贴板变化。
 *
 * **只在保险箱已解锁时运行** —— 锁定状态下一律不读剪贴板（锁定时会被主动停掉）。
 * 它拿不到"内容是从哪儿复制的"，所以只把候选**交给界面显示一个提示条**，
 * 绝不自动建条目、也绝不弹窗打断。
 */
function startClipboardWatch(onCandidate: (text: string) => void): void {
  stopClipboardWatch()
  lastClip = clipboard.readText()
  clipWatch = setInterval(() => {
    if (store.status() !== 'unlocked') {
      stopClipboardWatch()
      return
    }
    const now = clipboard.readText()
    if (now === lastClip) return
    lastClip = now
    if (looksLikeSecret(now)) onCandidate(now)
  }, 1500)
  clipWatch.unref?.()
}

function stopClipboardWatch(): void {
  if (clipWatch) clearInterval(clipWatch)
  clipWatch = null
  lastClip = ''
}

/**
 * 注册全部保险箱通道。
 *
 * `getAutoLockMinutes` 由调用方注入（它要读设置表），这样这个文件不依赖 db/settings。
 * `onLocked` 用于在自动锁定时通知渲染层刷新界面。
 */
export function registerVaultIpc(opts: {
  getAutoLockMinutes: () => number
  onLocked: () => void
  /** 剪贴板里出现像密码的内容时通知界面（只提示，不自动保存） */
  onClipboardCandidate: (text: string) => void
}): void {
  ipcMain.handle('vault:status', () => store.status())

  ipcMain.handle('vault:setup', (_e, password: string) => {
    const r = store.setup(password)
    if (r.ok) opts.onLocked() // 让界面从"未初始化"切到"已解锁"
    return r
  })

  ipcMain.handle('vault:unlock', (_e, password: string) => store.unlock(password))
  ipcMain.handle('vault:lock', () => {
    store.lock()
    opts.onLocked()
    return { ok: true }
  })

  // 列表需要已解锁；未解锁时 store 会抛，这里转成明确的失败结果而不是让 IPC 报错
  ipcMain.handle('vault:list', () => {
    try {
      store.touch()
      return { ok: true, entries: store.list() }
    } catch (err) {
      return { ok: false, message: (err as Error).message, entries: [] }
    }
  })

  ipcMain.handle('vault:create', (_e, input: VaultEntryInput) => {
    try {
      return { ok: true, entry: store.create(input) }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  ipcMain.handle('vault:update', (_e, id: number, input: VaultEntryInput) => store.update(id, input))
  ipcMain.handle('vault:remove', (_e, id: number) => store.remove(id))

  /** 清空重建 —— 忘记主密码后唯一的出路，界面那边要求二次确认。 */
  ipcMain.handle('vault:destroy', () => store.destroy())

  ipcMain.handle('vault:touch', () => {
    store.touch()
    return true
  })

  ipcMain.handle('vault:copy', (_e, text: string) => {
    copySecret(text)
    return true
  })

  ipcMain.handle('vault:generate', (_e, opts?: Partial<GenerateOptions>) =>
    generatePassword(opts ?? GENERATE_DEFAULTS)
  )

  ipcMain.handle('vault:strength', (_e, password: string) => strengthOf(password))

  // ---------------------------------------------------------------- 浏览器导入

  ipcMain.handle('vault:browsers', () => availableBrowsers())

  ipcMain.handle('vault:importBrowser', async (_e, key: BrowserKey) => {
    if (store.status() !== 'unlocked') return { ok: false, message: '请先解锁保险箱', imported: 0 }
    const r = await importFromBrowser(key)
    if (!r.ok) return { ok: false, message: r.message, imported: 0 }
    // 标题取站点主机名：origin_url 太长，作为列表标题读不出来
    const items = r.logins.map((l) => ({ title: hostOf(l.origin), username: l.username, password: l.password, url: l.origin }))
    const { imported, skipped } = store.importEntries(items)
    const skippedNote = skipped > 0 ? `，${skipped} 条已存在` : ''
    const decryptNote = r.skipped > 0 ? `（${r.skipped} 条用了新版加密，无法解密）` : ''
    return { ok: true, message: `导入 ${imported} 条${skippedNote}${decryptNote}`, imported }
  })

  // ---------------------------------------------------------------- 剪贴板助手

  ipcMain.handle('vault:clipboardStart', () => {
    startClipboardWatch(opts.onClipboardCandidate)
    return true
  })
  ipcMain.handle('vault:clipboardStop', () => {
    stopClipboardWatch()
    return true
  })
  /** 用户点"存进保险箱"时把内容取走 */
  ipcMain.handle('vault:clipboardTake', () => clipboard.readText())

  // ---------------------------------------------------------------- 浏览器扩展

  /**
   * 给扩展配置用的信息：端口与令牌。
   *
   * 令牌显示出来是必要的 —— 用户得把它手动粘进扩展；但它**不是主密码**：
   * 拿到它只能往保险箱里写，而且**锁定状态下端点一律拒收**（423），
   * 读不到任何已有内容。
   */
  ipcMain.handle('vault:httpInfo', () => ({
    port: vaultServerPort() || vaultPort(),
    token: vaultToken(),
  }))

  ipcMain.handle('vault:rotateToken', () => {
    const t = rotateVaultToken()
    opts.onLocked() // 让界面刷新一次，把新令牌显示出来
    return { token: t }
  })

  startAutoLock(opts.getAutoLockMinutes, () => {
    store.lock()
    opts.onLocked()
  })
}
