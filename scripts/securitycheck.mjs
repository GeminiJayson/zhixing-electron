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
import { setTimeout as sleep } from 'node:timers/promises'
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(root, '..')
const backup = join(repoRoot, 'backups', 'electron-migration', 'zhixing-before-electron-write.db')
const tmpHome = join(root, '.screenshots', 'security-home')
const PORT = 9242
// 迁移前那份备份早已从工作区清掉 —— 缺了就退回「当前正式库的副本」。
// 这些脚本要的只是「一张有数据的库」，对来源不敏感；没有这层回退，它们一启动就退出。
const liveDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
const seedDb = existsSync(backup) ? backup : liveDb
if (!existsSync(seedDb)) {
  console.error('✗ 既没有迁移前备份，也找不到 ' + liveDb)
  process.exit(1)
}
console.log('【基库】' + (seedDb === backup ? '迁移前备份' : '当前正式库副本'))
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(seedDb, join(tmpHome, 'zhixing.db'))
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpHome, 'p')}`], {
  cwd: root, env: { ...process.env, ZHIXING_HOME: tmpHome }, stdio: ['ignore', 'pipe', 'pipe'],
})
let page = null
for (let i = 0; i < 40 && !page; i++) {
  await sleep(500)
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); page = l.find((t) => t.type === 'page' && !t.url.includes('widget=1')) } catch {}
}
if (!page) { console.error('✗ 无法连接主窗口'); child.kill(); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const send = (m, p = {}) => new Promise((resolve) => {
  const id = Math.floor(Math.random() * 1e6)
  const h = (ev) => { const x = JSON.parse(ev.data); if (x.id !== id) return; ws.removeEventListener('message', h); resolve(x) }
  ws.addEventListener('message', h); ws.send(JSON.stringify({ id, method: m, params: p })) })
await send('Runtime.enable')
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'fail')
  return r.result?.result?.value }
await sleep(2600)

const results = []
const check = (n, ok, d = '') => { results.push([n, ok]); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`) }

// sandbox: true 之后 preload 桥与 IPC 必须照常工作（这是最容易被打回的一环）
const apiShape = await ev(`typeof window.zhixing?.db?.tasks === 'function' && typeof window.zhixing?.platform === 'string'`)
check('sandbox 下 preload 桥仍可用', apiShape === true)
const ipcWorks = await ev(`window.zhixing.db.tasks(5).then((r) => Array.isArray(r)).catch(() => false)`)
check('sandbox 下 IPC 调用可往返', ipcWorks === true)

// 1) 页面内导航：非白名单协议必须被 will-navigate 拦下
const before = await ev('location.href')
await ev(`location.href = 'file:///etc/passwd'`)
await sleep(1200)
let navigatedAway = false
try {
  const after = await ev('location.href')
  navigatedAway = after !== before
} catch {
  // 求值上下文都换了，说明导航真的发生了
  navigatedAway = true
}
check('file:// 导航被拦截，窗口没被带走', !navigatedAway, navigatedAway ? '窗口已被导航到 file://' : 'URL 未变')

// 2) window.open：setWindowOpenHandler 一律 deny，返回 null
const opened = await ev(`window.open('file:///etc/passwd') === null`)
check('window.open 被拒绝（不开新 Electron 窗口）', opened === true)

// 3) 应用自身页面仍能正常加载（加固不能把正常路径也拦掉）
const alive = await ev(`document.querySelector('#root') !== null && document.title.length > 0`)
check('应用自身页面未被误拦，界面仍在', alive === true)

ws.close()
child.kill()
await sleep(500)
rmSync(tmpHome, { recursive: true, force: true })
const failed = results.filter(([, ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
process.exit(failed ? 1 : 0)
