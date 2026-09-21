/**
 * 窗口安全加固验证（对照 electron-development skill 的 Production Security Checklist）：
 * will-navigate 拦截、window.open 拒绝、sandbox 下 preload/IPC 仍可用。
 *
 * 用法：node scripts/securitycheck.mjs
 *
 * 只拿**非白名单协议**（file:// 之类）当靶子：这类 URL 会被记日志并拦下，
 * 不会真的拉起系统浏览器，验证过程不打扰使用者。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

// 老脚本里的 root / require 一律保留：原样带过来的自有声明（sql/countOf/dbFile 等）还依赖它们
const root = ROOT
const require = createRequire(import.meta.url)
const tmpHome = join(ROOT, '.screenshots', 'security-home')
const PORT = 9242

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()
// sandbox: true 之后 preload 桥与 IPC 必须照常工作（这是最容易被打回的一环）
const apiShape = await app.evaluate(`typeof window.zhixing?.db?.tasks === 'function' && typeof window.zhixing?.platform === 'string'`)
check('sandbox 下 preload 桥仍可用', apiShape === true)
const ipcWorks = await app.evaluate(`window.zhixing.db.tasks(5).then((r) => Array.isArray(r)).catch(() => false)`)
check('sandbox 下 IPC 调用可往返', ipcWorks === true)

// 1) 页面内导航：非白名单协议必须被 will-navigate 拦下
const before = await app.evaluate('location.href')
await app.evaluate(`location.href = 'file:///etc/passwd'`)
await sleep(1200)
let navigatedAway = false
try {
  const after = await app.evaluate('location.href')
  navigatedAway = after !== before
} catch {
  // 求值上下文都换了，说明导航真的发生了
  navigatedAway = true
}
check('file:// 导航被拦截，窗口没被带走', !navigatedAway, navigatedAway ? '窗口已被导航到 file://' : 'URL 未变')

// 2) window.open：setWindowOpenHandler 一律 deny，返回 null
const opened = await app.evaluate(`window.open('file:///etc/passwd') === null`)
check('window.open 被拒绝（不开新 Electron 窗口）', opened === true)

// 3) 应用自身页面仍能正常加载（加固不能把正常路径也拦掉）
const alive = await app.evaluate(`document.querySelector('#root') !== null && document.title.length > 0`)
check('应用自身页面未被误拦，界面仍在', alive === true)

await sleep(500)

await app.close()
process.exit(finish())