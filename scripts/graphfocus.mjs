/**
 * 图谱节点「选中/焦点框」只应包住图标、不该把标签文字也圈进去。
 * 用真实聚焦（element.focus()）+ 截图取证：打印 <g> 的包围盒与圆的包围盒做对比。
 * 用法：node scripts/graphfocus.mjs [after]
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = join(root, '.screenshots', 'graphfocus-home')
const shotDir = join(root, '.screenshots')
const tag = process.argv[2] === 'after' ? 'after' : 'before'
const PORT = 9233

const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
if (!existsSync(realDb)) {
  console.error('✗ 找不到真实库：' + realDb)
  process.exit(1)
}
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(realDb, join(tmpHome, 'zhixing.db'))

const SYS_PATH = [
  'C:\\Windows\\System32',
  'C:\\Windows',
  'C:\\Windows\\System32\\Wbem',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
].join(';')

const child = spawn(
  electronPath,
  ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpHome, 'profile')}`],
  {
    cwd: root,
    env: { ...process.env, PATH: `${SYS_PATH};${process.env.PATH ?? ''}`, ZHIXING_HOME: tmpHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
)

const attach = async () => {
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      page = list.find((t) => t.type === 'page')
    } catch {
      /* 等待 */
    }
    if (!page) await sleep(500)
  }
  if (!page) return null
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = Math.floor(Math.random() * 1e6)
      const h = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id !== id) return
        ws.removeEventListener('message', h)
        resolve(m)
      }
      ws.addEventListener('message', h)
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  await send('Page.enable')
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails)
      throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result?.result?.value
  }
  return { ws, send, evaluate }
}

const conn = await attach()
if (!conn) {
  console.error('✗ 无法连接渲染进程')
  child.kill()
  process.exit(1)
}
await sleep(3000)
await conn.evaluate(`document.querySelector('[data-nav-item="graph"]')?.click()`)
await sleep(4000)

// 选一个稳稳落在视野内的节点
const picked = await conn.evaluate(`(() => {
  const all = [...document.querySelectorAll('.gnode')]
  for (const el of all) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.top > 120 && r.bottom < window.innerHeight - 120 && r.left > 300 && r.right < window.innerWidth - 300) {
      return { label: el.getAttribute('aria-label'), rect: { x: r.x, y: r.y, w: r.width, h: r.height } }
    }
  }
  return null
})()`)
console.log('节点:', JSON.stringify(picked))

const geom = await conn.evaluate(`(() => {
  const all = [...document.querySelectorAll('.gnode')]
  const el = all.find((e) => {
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.top > 120 && r.bottom < window.innerHeight - 120 && r.left > 300 && r.right < window.innerWidth - 300
  })
  if (!el) return null
  el.focus()
  const g = el.getBoundingClientRect()
  const c = el.querySelector('circle')?.getBoundingClientRect() ?? null
  return {
    focusIsG: document.activeElement === el,
    gRect: { w: Math.round(g.width), h: Math.round(g.height) },
    circleRect: c ? { w: Math.round(c.width), h: Math.round(c.height) } : null,
    focusVisible: el.matches(':focus-visible'),
    outlineStyle: getComputedStyle(el).outlineStyle,
  }
})()`)
console.log('几何:', JSON.stringify(geom))
await sleep(500)

const r = await conn.send('Page.captureScreenshot', { format: 'png' })
if (r.result?.data) writeFileSync(join(shotDir, `graph-focus-${tag}.png`), Buffer.from(r.result.data, 'base64'))

// 判据：默认 outline 必须是 none（否则它按包围盒画，就把标签文字一起圈了），
// 同时自绘的焦点圆环必须存在 —— 键盘可达性不能因为关掉 outline 而丢掉。
// React 的 setState 是异步的：等它把焦点圆环渲染出来再量
await sleep(400)
const ring = await conn.evaluate(`(() => {
  const c = document.querySelector('.gnode__focus')
  if (!c) return null
  const r = c.getBoundingClientRect()
  return { w: Math.round(r.width), h: Math.round(r.height) }
})()`)

if (geom) {
  console.log(`<g> 包围盒 ${geom.gRect.w}×${geom.gRect.h}px（默认 outline 覆盖的范围 —— 含标签文字，所以原先那个框是扁长的）`)
  console.log(`outlineStyle=${geom.outlineStyle}  自绘焦点圆环=${ring ? `${ring.w}×${ring.h}px` : '无'}`)
  const ok = geom.outlineStyle === 'none' && ring && Math.abs(ring.w - ring.h) <= 2 && ring.h < geom.gRect.h
  console.log(
    ok
      ? '✓ 焦点指示只围图标：默认框已关，圆环是正圆且比包围盒矮'
      : '✗ 焦点框仍然按包围盒绘制 / 或没有可见焦点指示'
  )
}

conn.ws.close()
child.kill()
await sleep(500)
rmSync(tmpHome, { recursive: true, force: true })
