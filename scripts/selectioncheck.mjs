/**
 * 全局热键 → **独立捕获窗口** 的端到端验证。
 *
 * 做法：在主窗口输入框里真的选中一段文字 → PowerShell SendKeys 发**真实**全局热键
 * （ctrl+alt+n，快速任务）→ 检查是否开出一个独立窗口（url 含 capture=1）、
 * 内容是否为那段选中的文字，且主窗口里没有面板。
 *
 * 覆盖：
 *   1. 有选区：独立窗口出现，内容 = 选中的文字；主窗口里没有捕获面板
 *   2. 没有选区、剪贴板里有旧内容：窗口内容为空（不误用旧剪贴板）
 *   3. Esc 关闭窗口 → 窗口消失
 *
 * 用法：node scripts/selectioncheck.mjs（需先 npm run build）
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
const tmpHome = join(root, '.screenshots', 'sel-home')
const shotDir = join(root, '.screenshots')
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

const list = async () => {
  try {
    return await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
  } catch {
    return []
  }
}
const connect = async (target) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
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

const pressHotkey = (keys) =>
  new Promise((resolve) => {
    const ps = spawn(PS, ['-NoProfile', '-NonInteractive', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${keys}")`], { windowsHide: true, stdio: 'ignore' })
    ps.once('close', resolve)
    ps.once('error', resolve)
  })

let mainTarget = null
for (let i = 0; i < 60 && !mainTarget; i++) {
  mainTarget = (await list()).find((t) => t.type === 'page' && !String(t.url).includes('capture=1'))
  if (!mainTarget) await sleep(500)
}
const conn = await connect(mainTarget)
await sleep(3000)

const results = []
const check = (name, ok, detail = '') => {
  results.push([name, ok])
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''))
}
const J = (v) => JSON.stringify(v)

/** 等捕获窗口出现并 attach，返回 { cw, text }（text 会等它填好） */
const waitCaptureWindow = async (timeout = 15000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const win = (await list()).find((t) => String(t.url).includes('capture=1'))
    if (win) {
      const cw = await connect(win)
      let text = null
      for (let i = 0; i < 40; i++) {
        const v = await cw.evaluate("(document.querySelector('.capture__text') || {}).value ?? null")
        if (typeof v === 'string') {
          if (v.trim()) return { cw, text: v }
          text = v
        }
        await sleep(150)
      }
      return { cw, text: text ?? '' }
    }
    await sleep(250)
  }
  return null
}

// 主窗口：切到笔记页，选中搜索框里的一段文字
await conn.evaluate("document.querySelector('[data-nav-item=notes]').click()")
await sleep(1500)
const SELECTED = 'SELECTED-TEXT-FOR-CHECK'
const selected = await conn.evaluate(`(() => {
  const el = document.querySelector('.ntree__search-input')
  if (!el) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, ${J(SELECTED)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.focus(); el.select()
  return el.selectionStart === 0 && el.selectionEnd === ${SELECTED.length}
})()`)
check('在主窗口里选中了一段文字', selected === true, '')

// ---------------- 场景 1：独立窗口 + 选中文字
await pressHotkey('^%n')
const captured = await waitCaptureWindow()
check('热键开出了**独立窗口**（不是主窗口里的面板）', !!captured, captured ? 'capture=1' : '（没出现）')
check('窗口里就是捕获卡片（复用弹框骨架）', (await captured?.cw.evaluate("!!document.querySelector('.modal--capture .modal__head')")) === true, '')
check('内容 = 当前选中的文字', captured?.text?.trim() === SELECTED, J(captured?.text))
const mainHasPanel = await conn.evaluate("!!document.querySelector('.capture-host')")
check('主窗口里没有捕获面板', mainHasPanel === false, '')
if (captured) {
  const shot = await captured.cw.send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) writeFileSync(join(shotDir, 'capture-window.png'), Buffer.from(shot.result.data, 'base64'))
}

// ---------------- 场景 3：Esc 关窗
await captured?.cw.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
await sleep(900)
const gone = (await list()).every((t) => !String(t.url).includes('capture=1'))
check('Esc 关闭后窗口消失', gone, '')
captured?.cw.ws.close()

// ---------------- 场景 2：没有选区 + 剪贴板有旧内容 → 空
await conn.evaluate("navigator.clipboard.writeText('OLD-CLIP-CONTENT').catch(() => 0)")
await sleep(300)
await conn.evaluate(`(() => {
  const el = document.querySelector('.ntree__search-input')
  if (el) { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); el.blur() }
  window.getSelection()?.removeAllRanges()
})()`)
await sleep(300)
await pressHotkey('^%n')
const second = await waitCaptureWindow()
check('没有选区时窗口仍然是空的（不误用旧剪贴板）', second?.text?.trim() === '', J(second?.text))
second?.cw.ws.close()

conn.ws.close()
child.kill()
await sleep(500)
rmSync(tmpHome, { recursive: true, force: true })

const failed = results.filter(([, ok]) => !ok)
console.log('')
console.log((results.length - failed.length) + '/' + results.length + ' 项通过')
process.exit(failed.length ? 1 : 0)
