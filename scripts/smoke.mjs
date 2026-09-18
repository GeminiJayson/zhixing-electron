/**
 * 最小冒烟检查：真实启动 Electron，通过 CDP 读取渲染层结果。
 * 验证链路：主进程 → 窗口 → preload 注入 → better-sqlite3 读库 → React 渲染。
 * 用法：node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9222

const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: root,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let mainLog = ''
child.stdout.on('data', (d) => (mainLog += d.toString()))
child.stderr.on('data', (d) => (mainLog += d.toString()))

const dumpLog = () => console.error('主进程日志:\n' + mainLog.split('\n').filter(Boolean).slice(-20).join('\n'))

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      if (list.length) return list
    } catch {
      /* 端口未就绪 */
    }
    await sleep(500)
  }
  return []
}

const list = await targets()
if (!list.length) {
  console.error('✗ CDP 目标未出现')
  dumpLog()
  child.kill()
  process.exit(1)
}
console.log('CDP targets:', list.map((t) => `${t.type}:${t.url.slice(0, 60)}`).join(' | '))

const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('✗ 未找到 page 类型目标')
  child.kill()
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

const events = []
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    events.push('EXCEPTION: ' + (d.exception?.description ?? d.text))
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    events.push(`console.${msg.params.type}: ` + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  }
})

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e6)
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== id) return
      ws.removeEventListener('message', onMessage)
      resolve(msg)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })

await send('Runtime.enable')

const evaluate = async (expression) => {
  const msg = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (msg.result?.exceptionDetails) {
    const d = msg.result.exceptionDetails
    throw new Error('evaluate 失败: ' + (d.exception?.description ?? d.text))
  }
  return msg.result?.result?.value
}

let snap = null
let lastErr = null
for (let i = 0; i < 20; i++) {
  try {
    snap = await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.stat-card__value')].map(e => e.textContent)
      const nav = [...document.querySelectorAll('[data-nav-item]')]
        .map(e => e.querySelector('.nav-item__label')?.textContent ?? '')
      return { title: document.title, theme: document.documentElement.dataset.theme,
               cards, nav, rows: document.querySelectorAll('.trow').length,
               hasApi: typeof window.zhixing === 'object',
               rootHtml: (document.getElementById('root')?.innerHTML ?? '').slice(0, 60) }
    })()`)
    lastErr = null
    if (snap && snap.cards.length === 4) break
  } catch (err) {
    lastErr = err.message
  }
  await sleep(400)
}

ws.close()
child.kill()

console.log('渲染快照:', JSON.stringify(snap))
if (events.length) console.log('渲染事件:\n' + events.slice(-10).join('\n'))
if (lastErr) console.log('最后一次 evaluate 错误:', lastErr)

const checks = [
  ['窗口标题', snap?.title === '知行 ZhiXing'],
  ['preload 已注入 window.zhixing', snap?.hasApi === true],
  ['概览四卡渲染', snap?.cards?.length === 4],
  ['左侧 8 项导航', snap?.nav?.length === 8],
  ['今日任务列表已挂载', (snap?.rows ?? 0) > 0],
]
let ok = true
for (const [name, passed] of checks) {
  console.log(`${passed ? '✓' : '✗'} ${name}`)
  if (!passed) ok = false
}
if (!ok) dumpLog()
process.exit(ok ? 0 : 1)
