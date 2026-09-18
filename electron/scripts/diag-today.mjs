import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const profile = join(root, '.screenshots', 'diag-profile')
rmSync(profile, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })
const child = spawn(electronPath, ['.', '--remote-debugging-port=9232', `--user-data-dir=${profile}`], {
  cwd: root,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let page = null
for (let i = 0; i < 40 && !page; i++) {
  await sleep(500)
  try {
    const list = await (await fetch('http://127.0.0.1:9232/json/list')).json()
    page = list.find((t) => t.type === 'page')
  } catch {}
}
if (!page) { console.log('NO_TARGET'); child.kill(); process.exit(1) }
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
await sleep(3000)
const r = await send('Runtime.evaluate', {
  expression: `(async () => {
    const t = await window.zhixing.db.todayTasks()
    const ov = await window.zhixing.db.overview()
    const all = await window.zhixing.db.tasks()
    return JSON.stringify({
      overview: ov,
      todayRoots: t.roots.length,
      subtree: t.subtree.length,
      allCount: all.length,
      topLevel: all.filter(x => x.parent_id === null).length,
      sample: t.subtree.slice(0, 3).map(x => ({ id: x.id, title: x.title, parent: x.parent_id, due: x.due_date, status: x.status })),
      domRows: document.querySelectorAll('.task-row').length,
      domTree: document.querySelectorAll('.task-tree').length,
      emptyHint: document.querySelector('.empty-hint')?.textContent ?? null,
    })
  })()`,
  returnByValue: true,
  awaitPromise: true,
})
console.log(r.result?.result?.value ?? JSON.stringify(r.result))
ws.close()
child.kill()
rmSync(profile, { recursive: true, force: true })
