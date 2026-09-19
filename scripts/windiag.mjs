/**
 * 独立弹窗（条件确认 / 捕获）的外观诊断：主题变量、页面底色、卡片圆角。
 * 用法：node scripts/windiag.mjs（先 npm run build）
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
const tmpHome = join(root, '.screenshots', 'windiag-home')
const PORT = 9256
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
if (!existsSync(realDb)) process.exit(1)
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(realDb, join(tmpHome, 'zhixing.db'))

const SYS_PATH = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'].join(';')
const child = spawn(electronPath, ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(tmpHome, 'profile')], {
  cwd: root,
  env: { ...process.env, PATH: SYS_PATH + ';' + (process.env.PATH ?? ''), ZHIXING_HOME: tmpHome },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stderr?.on('data', (b) => console.error('[electron] ' + String(b).slice(0, 200)))

const list = async () => { try { return await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json() } catch { return [] } }
const connect = async (t) => {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
  const send = (m, p = {}) => new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e6)
    const h = (ev) => { const x = JSON.parse(ev.data); if (x.id !== id) return; ws.removeEventListener('message', h); resolve(x) }
    ws.addEventListener('message', h); ws.send(JSON.stringify({ id, method: m, params: p }))
  })
  await send('Runtime.enable')
  const evaluate = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value
  return { ws, send, evaluate }
}

const PROBE = `(() => {
  const card = document.querySelector('.modal')
  const host = document.querySelector('.capture-host') || document.querySelector('.cond-win')
  const cs = (el) => (el ? getComputedStyle(el) : null)
  const rootStyle = cs(document.documentElement)
  return {
    theme: document.documentElement.dataset.theme ?? '(未设置)',
    surface: document.documentElement.dataset.surface,
    bodyBg: cs(document.body)?.backgroundColor,
    htmlBg: rootStyle?.backgroundColor,
    rootBg: cs(document.getElementById('root'))?.backgroundColor,
    hostBg: cs(host)?.backgroundColor,
    cardBg: cs(card)?.backgroundColor,
    cardRadius: cs(card)?.borderRadius,
    layerSolid: rootStyle?.getPropertyValue('--bg-layer-solid').trim(),
    canvas: rootStyle?.getPropertyValue('--bg-canvas').trim(),
    themePack: rootStyle?.getPropertyValue('--theme-pack').trim(),
  }
})()`

let mainT = null
for (let i = 0; i < 60 && !mainT; i++) { mainT = (await list()).find((t) => t.type === 'page' && !String(t.url).includes('capture=1')); if (!mainT) await sleep(500) }
const conn = await connect(mainT)
await sleep(2800)

// 复现用户的深色主题
await conn.evaluate("window.zhixing.db.setSettings({ theme_mode: 'dark' })")
await sleep(500)
console.log('主窗口：', JSON.stringify(await conn.evaluate(PROBE), null, 0))

// 夺焦点 → 选中文字 → 触发热键
await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 30, y: 320, button: 'left', clickCount: 1, buttons: 1 })
await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 30, y: 320, button: 'left', clickCount: 1, buttons: 0 })
await sleep(300)
await conn.evaluate("document.querySelector('[data-nav-item=notes]').click()")
await sleep(1200)
await conn.evaluate("(() => { const el = document.querySelector('.ntree__search-input'); if (el) { el.focus(); el.select() } })()")
await new Promise((res) => {
  const ps = spawn(PS, ['-NoProfile', '-NonInteractive', '-STA', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^%n")'], { windowsHide: true, stdio: 'ignore' })
  ps.once('close', res); ps.once('error', res)
})

let capT = null
for (let i = 0; i < 40 && !capT; i++) { capT = (await list()).find((t) => String(t.url).includes('capture=1')); if (!capT) await sleep(250) }
if (!capT) { console.log('✗ 捕获窗口没出现'); conn.ws.close(); child.kill(); process.exit(1) }
const cw = await connect(capT)
await sleep(1500)
console.log('捕获窗口：', JSON.stringify(await cw.evaluate(PROBE), null, 0))
const shot = await cw.send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(root, '.screenshots', 'windiag-dark.png'), Buffer.from(shot.result.data, 'base64'))
  console.log('已截图 .screenshots/windiag-dark.png')
}

cw.ws.close(); conn.ws.close(); child.kill()
await sleep(500)
rmSync(tmpHome, { recursive: true, force: true })
