/**
 * 全局热键「读取当前选中文字」验证。
 *
 * 做法：在主窗口的输入框里真的选中一段文字 → 用 PowerShell SendKeys 发**真实**的全局热键
 * （ctrl+alt+n，快速任务）→ 检查捕获面板是否被预填成那段文字。
 * 这正是「主进程先模拟 Ctrl+C、再显示窗口」这条链路的端到端验证。
 *
 * 覆盖：
 *   1. 有选区时：面板内容 = 选中的文字
 *   2. 没有选区、但剪贴板里有旧内容时：面板**为空**（不会误用旧剪贴板）
 *
 * 用法：node scripts/selectioncheck.mjs（需先 npm run build）
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
const tmpHome = join(root, '.screenshots', 'sel-home')
const PORT = 9254
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
if (!existsSync(realDb)) {
  console.error('✗ 找不到真实库：' + realDb)
  process.exit(1)
}
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(realDb, join(tmpHome, 'zhixing.db'))

const SYS_PATH = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'].join(';')
const child = spawn(
  electronPath,
  ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(tmpHome, 'profile')],
  {
    cwd: root,
    env: { ...process.env, PATH: SYS_PATH + ';' + (process.env.PATH ?? ''), ZHIXING_HOME: tmpHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
)

const attach = async () => {
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
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
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails)
      throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result?.result?.value
  }
  return { ws, send, evaluate }
}

/** 用真实按键触发热键（SendKeys：^ = Ctrl、% = Alt） */
const pressHotkey = (keys) =>
  new Promise((resolve) => {
    const ps = spawn(PS, ['-NoProfile', '-NonInteractive', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${keys}")`], { windowsHide: true, stdio: 'ignore' })
    ps.once('close', resolve)
    ps.once('error', resolve)
  })

const conn = await attach()
if (!conn) {
  console.error('✗ 无法连接渲染进程')
  child.kill()
  process.exit(1)
}
await sleep(3000)

const results = []
const check = (name, ok, detail = '') => {
  results.push([name, ok])
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''))
}
const J = (v) => JSON.stringify(v)

/** 等捕获面板出现并拿到内容 */
const waitPanelText = async (timeout = 12000) => {
  const t0 = Date.now()
  let seen = ''
  while (Date.now() - t0 < timeout) {
    const v = await conn.evaluate(
      "(document.querySelector('.capture__text') || {}).value ?? null"
    )
    if (typeof v === 'string') {
      seen = v
      if (v.trim()) return v
    }
    await sleep(200)
  }
  return seen
}
const closePanel = async () => {
  await conn.evaluate(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"
  )
  await sleep(400)
}

// 切到笔记页，那里有搜索框可以「真的选中一段文字」
await conn.evaluate("document.querySelector('[data-nav-item=notes]').click()")
await sleep(1500)

const SELECTED = 'SELECTED-TEXT-FOR-CHECK'
const selected = await conn.evaluate(`(() => {
  const el = document.querySelector('.ntree__search-input')
  if (!el) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, ${J(SELECTED)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.focus()
  el.select()
  return (el.selectionStart === 0 && el.selectionEnd === ${SELECTED.length})
})()`)
check('在主窗口的输入框里选中了一段文字', selected === true, '')

// ---------------- 场景 1：有选区 → 面板预填选中的文字
await pressHotkey('^%n')
const text1 = await waitPanelText()
check('热键唤出捕获面板', typeof text1 === 'string' && text1.length > 0, J(text1))
check('面板内容 = 当前选中的文字', text1.trim() === SELECTED, J(text1))
await closePanel()

// ---------------- 场景 2：没有选区 + 剪贴板里有旧内容 → 面板应为空
await conn.evaluate(`navigator.clipboard.writeText('OLD-CLIP-CONTENT').catch(() => 0)`)
await sleep(300)
await conn.evaluate(`(() => {
  const el = document.querySelector('.ntree__search-input')
  if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); el.blur() }
  window.getSelection()?.removeAllRanges()
  document.body.focus()
})()`)
await sleep(300)
await pressHotkey('^%n')
await sleep(3500)
const text2 = await conn.evaluate("(document.querySelector('.capture__text') || {}).value ?? null")
check('没有选区时面板不误用旧剪贴板内容', typeof text2 === 'string' && text2.trim() === '', J(text2))
await closePanel()

conn.ws.close()
child.kill()
await sleep(500)
rmSync(tmpHome, { recursive: true, force: true })

const failed = results.filter(([, ok]) => !ok)
console.log('')
console.log((results.length - failed.length) + '/' + results.length + ' 项通过')
process.exit(failed.length ? 1 : 0)
