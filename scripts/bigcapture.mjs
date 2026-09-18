import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const profile = join(root, '.screenshots', 'big-profile')
const PORT = 9230
rmSync(profile, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })

const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], {
  cwd: root,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let page = null
for (let i = 0; i < 40 && !page; i++) {
  await sleep(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    page = list.find((t) => t.type === 'page')
  } catch {}
}
if (!page) { console.error('no target'); child.kill(); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const send = (m, p = {}) =>
  new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e6)
    const h = (ev) => {
      const x = JSON.parse(ev.data)
      if (x.id !== id) return
      ws.removeEventListener('message', h)
      resolve(x)
    }
    ws.addEventListener('message', h)
    ws.send(JSON.stringify({ id, method: m, params: p }))
  })
await send('Runtime.enable')
await send('Page.enable')
await sleep(2500)

await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false })
await sleep(600)

const shots = [['today', ''], ['tasks', '列表'], ['notes', ''], ['review', '']]
for (const [nav, sub] of shots) {
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-nav-item="${nav}"]')?.click()` })
  await sleep(600)
  if (sub) {
    await send('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('.seg button')].find(b => b.textContent.trim() === '${sub}')?.click()`,
    })
    await sleep(600)
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const path = `/tmp/big-${nav}.png`
  writeFileSync(path, Buffer.from(shot.result.data, 'base64'))
  console.log('saved', path)
}
ws.close()
child.kill()
rmSync(profile, { recursive: true, force: true })