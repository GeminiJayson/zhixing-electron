/**
 * 主题包验证（O8）：换包改变语义色、明暗两套各自生效、强调色保持正交。
 * 用法：node scripts/themecheck.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
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
const tmpHome = join(root, '.screenshots', 'theme-home')
const PORT = 9240
const sql = (f, q) => execFileSync('sqlite3', [f, q]).toString().trim()
if (!existsSync(backup)) { console.error('✗ 缺备份库'); process.exit(1) }
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(backup, join(tmpHome, 'zhixing.db'))
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpHome, 'p')}`], {
  cwd: root, env: { ...process.env, ZHIXING_HOME: tmpHome }, stdio: ['ignore', 'pipe', 'pipe'],
})
/** 每接一个 page target（主窗口 / 浮窗）就给一份独立求值器。 */
const attach = async (target) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
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
  return { ws, ev }
}
// 浮窗是第二个 page target：主题检查要同时盯着主窗口和浮窗
let targets = []
for (let i = 0; i < 40 && targets.length < 2; i++) {
  await sleep(500)
  try { targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page') } catch {}
}
const mainTarget = targets.find((t) => !t.url.includes('widget=1'))
const widgetTarget = targets.find((t) => t.url.includes('widget=1'))
if (!mainTarget || !widgetTarget) { console.error('✗ 无法连接（主窗口/浮窗）'); child.kill(); process.exit(1) }
const { ws, ev } = await attach(mainTarget)
const widget = await attach(widgetTarget)
await sleep(2600)
const results = []
const check = (n, ok, d = '') => { results.push([n, ok]); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`) }
const token = (name) => ev(`getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`)
const wToken = (name) => widget.ev(`getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`)

// 初始：墨黑 + light
const canvas0 = await token('--bg-canvas')
check('默认主题包（墨黑）的 canvas 生效', canvas0.toLowerCase() === '#f5f5f5', canvas0)
const bodyBg0 = await ev(`getComputedStyle(document.body).backgroundColor`)
check('主窗口底色由主题变量驱动（不是透明的窗口底色）', bodyBg0 === 'rgb(245, 245, 245)', bodyBg0)
const accent0 = await token('--accent')
check('强调色独立生效', accent0.toLowerCase() === '#2563eb', accent0)
const wCanvas0 = await wToken('--bg-canvas')
check('浮窗初始与主窗口同为默认主题包浅色', wCanvas0.toLowerCase() === '#f5f5f5', wCanvas0)

// 切到设置页并换主题包
await ev(`document.querySelector('[data-nav-item="settings"]')?.click()`)
await sleep(700)
const switched = await ev(`(() => {
  const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === '樱花粉'))
  if (!sel) return 'NO_SELECT'
  sel.value = '樱花粉'
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return 'OK'
})()`, false)
await sleep(900)
check('设置页有主题包下拉', switched === 'OK', String(switched))

const canvas1 = await token('--bg-canvas')
check('换包后 canvas 变成樱花粉的浅色', canvas1.toLowerCase() === '#fdf3f6', canvas1)
const fg1 = await token('--fg-primary')
check('换包后前景色同步', fg1.toLowerCase() === '#5a2b3b', fg1)
const accent1 = await token('--accent')
check('换主题包不改强调色（两者正交）', accent1.toLowerCase() === accent0.toLowerCase(), `${accent0} -> ${accent1}`)

// 切深色：应取同一主题包的 dark 一套
await ev(`([...document.querySelectorAll('.seg button')].find(b => b.textContent === '深色'))?.click()`)
await sleep(900)
const canvas2 = await token('--bg-canvas')
check('深色模式取该包的 dark 配色', canvas2.toLowerCase() === '#241a1e', canvas2)
const warm = await token('--accent-warm')
check('语义色（暖色）取该包 dark 的取值', warm.toLowerCase() === '#f3b58a', warm)

// --- 桌面浮窗（?widget=1 的第二窗口）：换包 / 切明暗要跟着主窗口一起走 ---
const wSurface = await widget.ev(`document.documentElement.dataset.surface`)
check('浮窗连的是 widget 视图', wSurface === 'widget', String(wSurface))
const wBodyBg = await widget.ev(`getComputedStyle(document.body).backgroundColor`)
check('浮窗保持透明（透明窗口依赖它）', wBodyBg === 'rgba(0, 0, 0, 0)', wBodyBg)
const wCanvas1 = await wToken('--bg-canvas')
check('换主题包后浮窗同色', wCanvas1.toLowerCase() === canvas2.toLowerCase(), wCanvas1)
const wFg = await wToken('--fg-primary')
check('浮窗深色前景色取该包 dark', wFg.toLowerCase() === '#f5e7ec', wFg)

// 标题栏切浅色：只改 data-theme 不会重铺已内联的 token，必须整体重铺，浮窗同步跟上
await ev(`document.querySelector('.titlebar__actions button')?.click()`)
await sleep(900)
const canvas3 = await token('--bg-canvas')
check('标题栏切浅色：主题包的另一套配色真正重铺', canvas3.toLowerCase() === '#fdf3f6', canvas3)
const wCanvas2 = await wToken('--bg-canvas')
check('浮窗同步切回浅色', wCanvas2.toLowerCase() === '#fdf3f6', wCanvas2)

// 持久化：theme_pack 落库
ws.close()
widget.ws.close()
child.kill()
await sleep(600)
const tmpDb = join(tmpHome, 'zhixing.db')
check('主题包已写入 settings 表', sql(tmpDb, "SELECT value FROM settings WHERE key = 'theme_pack';") === '樱花粉')
const realDb = join(process.env.HOME, 'Library/Application Support/ZhiXing/zhixing.db')
check('真实库的主题包未被改动', sql(realDb, "SELECT value FROM settings WHERE key = 'theme_pack';") === '墨黑')
rmSync(tmpHome, { recursive: true, force: true })
const failed = results.filter(([, ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
process.exit(failed ? 1 : 0)
