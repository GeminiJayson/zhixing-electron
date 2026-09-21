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
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

// 老脚本里的 root 一律指向仓库根，原样保留的自有声明就能继续用
const root = ROOT
const shotDir = join(root, '.screenshots')
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
const focusWindow = async (c) => {
  // SendKeys 必须发给「当前前台窗口」，所以这里要发一次真实鼠标点击抢焦点。
  // 坐标是硬编码的：用户库内容多时它落在侧栏空白处，夹具库内容少时它会落在导航项上
  // 把页面切走 —— 调用方因此在点完之后要确认还停在原页面（见下面的「回到笔记页」）。
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 30, y: 320, button: 'left', clickCount: 1, buttons: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 30, y: 320, button: 'left', clickCount: 1, buttons: 0 })
  await sleep(250)
}
const pressHotkey = (keys) => {
  return new Promise((resolve) => {
    const ps = spawn(PS, ['-NoProfile', '-NonInteractive', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${keys}")`], { windowsHide: true, stdio: 'ignore' })
    ps.once('close', resolve)
    ps.once('error', resolve)
  })
}

const tmpHome = join(ROOT, '.screenshots', 'sel-home')
const PORT = 9254

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()
/** 等捕获窗口出现并 attach，返回 { cw, text }（text 会等它填好） */
const waitCaptureWindow = async (timeout = 15000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const win = (await app.targets()).find((t) => String(t.url).includes('capture=1'))
    if (win) {
      const cw = await app.attach((x) => String(x.url).includes('capture=1'))
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

// 主窗口：切到笔记页。**先夺回焦点、再选中文字** —— 反过来点一下会把选区取消掉
await app.evaluate("document.querySelector('[data-nav-item=notes]').click()")
await sleep(1500)
await focusWindow(app)
// 抢焦点那一下可能落在导航项上（侧栏内容少时），把页面切走了 —— 切回笔记页再选，
// 否则下面找不到 .ntree__search-input，而 OS 焦点已经拿到，不影响后续 SendKeys 复制。
await app.evaluate("document.querySelector('[data-nav-item=notes]').click()")
await sleep(1200)
const SELECTED = 'SELECTED-TEXT-FOR-CHECK'
const selected = await app.evaluate(`(() => {
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
// 无边框窗口的贴合度：窗口高度应当贴着卡片（下方不留空白）
const fitted = await captured?.cw.evaluate(`(() => {
  const card = document.querySelector('.modal')
  if (!card) return null
  return {
    card: Math.round(card.getBoundingClientRect().height),
    win: Math.round(window.innerHeight),
    cardW: Math.round(card.getBoundingClientRect().width),
    winW: Math.round(window.innerWidth),
  }
})()`)
check(
  '卡片贴合窗口（无边框窗口里没有多余空白）',
  !!fitted &&
    Math.abs(fitted.card - fitted.win) <= 2 &&
    Math.abs(fitted.cardW - fitted.winW) <= 2 &&
    // 内容只有一百多像素，窗口必须跟着缩下来（否则下方会留一大块白）
    fitted.win < 280,
  JSON.stringify(fitted)
)
check('内容 = 当前选中的文字', captured?.text?.trim() === SELECTED, J(captured?.text))
const mainHasPanel = await app.evaluate("!!document.querySelector('.capture-host')")
check('主窗口里没有捕获面板', mainHasPanel === false, '')
// 圆角窗口：页面底色必须透明，否则卡片圆角外会露一圈方角
const bg = await captured?.cw.evaluate(`(() => ({
  body: getComputedStyle(document.body).backgroundColor,
  html: getComputedStyle(document.documentElement).backgroundColor,
}))()`)
check(
  '页面底色透明（圆角外不露方角）',
  bg?.body === 'rgba(0, 0, 0, 0)' && bg?.html === 'rgba(0, 0, 0, 0)',
  JSON.stringify(bg)
)
if (captured) {
  const shot = await captured.cw.send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) writeFileSync(join(shotDir, 'capture-window.png'), Buffer.from(shot.result.data, 'base64'))
}

// ---------------- 场景 3：Esc 关窗
await captured?.cw.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
await sleep(900)
const gone = (await app.targets()).every((t) => !String(t.url).includes('capture=1'))
check('Esc 关闭后窗口消失', gone, '')
captured?.cw.ws.close()

// ---------------- 场景 2：没有选区 + 剪贴板有旧内容 → 空
await focusWindow(app)
await app.evaluate("navigator.clipboard.writeText('OLD-CLIP-CONTENT').catch(() => 0)")
await sleep(300)
await app.evaluate(`(() => {
  const el = document.querySelector('.ntree__search-input')
  if (el) { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); el.blur() }
  window.getSelection()?.removeAllRanges()
})()`)
await sleep(300)
await pressHotkey('^%n')
const second = await waitCaptureWindow()
check('没有选区时窗口仍然是空的（不误用旧剪贴板）', second?.text?.trim() === '', J(second?.text))
await app.close()

process.exit(finish())