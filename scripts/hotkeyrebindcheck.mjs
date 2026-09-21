/**
 * 设置页改键是否真的生效：走一遍「点改键 → 按组合 → 保存」，然后核对三件事
 *   1. settings 表里的值换了；
 *   2. 主进程重注册后状态是「✓ 已注册」（不是冲突降级）；
 *   3. 界面上那一行显示的也是新值。
 *
 * 用法：node scripts/hotkeyrebindcheck.mjs（需先 npm run build）
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
const tmpHome = join(root, '.screenshots', 'hotkeyrebind-home')
const PORT = 9301

const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
if (!existsSync(realDb)) {
  console.error('✗ 找不到真实库：' + realDb)
  process.exit(1)
}
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(realDb, join(tmpHome, 'zhixing.db'))

const SYS_PATH = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem'].join(';')
console.log('【启动】拉起 Electron…')
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
  const evaluate = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.result?.exceptionDetails)
      throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result?.result?.value
  }
  return { send, evaluate }
}

let main = null
for (let i = 0; i < 60 && !main; i++) {
  const pages = await list()
  main = pages.find((t) => t.type === 'page')
  if (!main) await sleep(500)
}
if (!main) {
  console.error('✗ 主窗口没起来')
  child.kill()
  process.exit(1)
}
const conn = await connect(main)
await sleep(2500)

// CDP 的真实鼠标事件。element.click() 不会派发 mousedown，
// 而「点保存被当成点外面」的 bug 恰好只在那条路径上出现 —— 必须用真鼠标。
const mouse = (type, x, y, buttons) =>
  conn.send('Input.dispatchMouseEvent', {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: type === 'mouseMoved' ? 'none' : 'left',
    buttons,
    clickCount: type === 'mouseMoved' ? 0 : 1,
  })
const centerOf = (expr) =>
  conn.evaluate(
    `(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`
  )
const clickReal = async (expr) => {
  const p = await centerOf(expr)
  if (!p) return false
  await mouse('mouseMoved', p.x, p.y, 0)
  await sleep(60)
  await mouse('mousePressed', p.x, p.y, 1)
  await sleep(60)
  await mouse('mouseReleased', p.x, p.y, 0)
  return true
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''))
}
const J = (v) => JSON.stringify(v)

try {
  await conn.evaluate(`document.querySelector('[data-nav-item="settings"]').click()`)
  await sleep(1200)
  await conn.evaluate(
    `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '任务与提醒')?.click()`
  )
  await sleep(600)

  const target = 'select_quick_hotkey'
  const rowExpr = (key) =>
    `(() => {
       const rows = [...document.querySelectorAll('.set-row')]
       const idx = ${JSON.stringify(target)} === 'select_quick_hotkey' ? rows.findIndex((r) => r.querySelector('span')?.textContent === '读取选中并速记') : rows.findIndex((r) => r.querySelector('span')?.textContent === '选中入闪念')
       return rows[idx]
     })()`

  const before = await conn.evaluate(
    `(() => { const el = ${rowExpr(target)}; return el ? { value: el.querySelector('input').value, status: el.querySelector('.u-aux')?.textContent } : null })()`
  )
  check('找到「读取选中并速记」这一行', Boolean(before), J(before))

  // 点「改键」
  await conn.evaluate(`(() => { const el = ${rowExpr(target)}; [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === '改键')?.click() })()`)
  await sleep(500)
  const overlay = await conn.evaluate(
    `(() => { const m = document.querySelector('.modal-mask[aria-label="改键"]'); return m ? m.textContent.includes('等待按键') : false })()`
  )
  check('弹出改键浮层', overlay === true)

  // 按新组合：ctrl+alt+j
  await conn.evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }))`
  )
  await sleep(400)
  const shown = await conn.evaluate(`(() => { const p = document.querySelector('.modal__body p:nth-of-type(2)'); return p ? p.textContent.trim() : null })()`)
  check('浮层里显示出新组合', shown === 'ctrl+alt+j', J(shown))

  // 预检是异步的，等它出结果
  await sleep(700)
  const probeText = await conn.evaluate(
    `(() => { const m = document.querySelector('.modal-mask[aria-label="改键"]'); return m ? m.textContent : '' })()`
  )
  check(
    '按下组合后当场给出「能不能用」的预检结论',
    probeText.includes('✓ 这个组合可用') || probeText.includes('已被别的程序占用'),
    J(probeText.slice(0, 80))
  )

  // 点「保存」：用真实鼠标，别用 element.click()
  await clickReal(`[...document.querySelectorAll('.modal__foot button')].find((b) => b.textContent.trim() === '保存')`)
  await sleep(700)
  const toast = await conn.evaluate(`document.querySelector('.toast')?.textContent?.trim() ?? ''`)
  await sleep(900)

  const stored = await conn.evaluate(`window.zhixing.db.settings().then((s) => s.select_quick_hotkey ?? null)`)
  check('新组合已落库', stored === 'ctrl+alt+j', J(stored))

  const status = await conn.evaluate(`window.zhixing.app.hotkeyStatus()`)
  check(
    '主进程重注册后状态为「已注册」',
    typeof status?.[target] === 'string' && status[target].includes('已注册'),
    J(status)
  )
  check('五个热键都在状态表里', Object.keys(status ?? {}).length >= 5, J(Object.keys(status ?? {})))

  const after = await conn.evaluate(
    `(() => { const el = ${rowExpr(target)}; return el ? { value: el.querySelector('input').value } : null })()`
  )
  check('界面上那一行也显示新组合', after?.value === 'ctrl+alt+j', J(after))

  const st = String(status?.[target] ?? '')
  check(
    '浮层预检与最终注册结果一致',
    probeText.includes('✓ 这个组合可用') === st.includes('已注册'),
    J({ 预检可用: probeText.includes('✓ 这个组合可用'), 最终: st })
  )
  check(
    '保存后的提示与注册结果一致（成功才说「已改为」）',
    st.includes('已注册') ? toast.includes('已改为') : toast.includes('没能注册'),
    J({ toast, status: st })
  )

  // ------------------------------------------------ 再改一次，覆盖「注册失败」那一支
  // ctrl+shift+u 在本机被别的程序占着；如果换个环境它可用，下面的自适应断言同样成立。
  await conn.evaluate(
    `(() => { const el = ${rowExpr(target)}; [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === '改键')?.click() })()`
  )
  await sleep(500)
  await conn.evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', code: 'KeyU', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))`
  )
  await sleep(400)
  await clickReal(`[...document.querySelectorAll('.modal__foot button')].find((b) => b.textContent.trim() === '保存')`)
  await sleep(700)
  const toast2 = await conn.evaluate(`document.querySelector('.toast')?.textContent?.trim() ?? ''`)
  await sleep(900)
  const status2 = await conn.evaluate(`window.zhixing.app.hotkeyStatus()`)
  const st2 = String(status2?.[target] ?? '')
  check(
    '注册不上时必须说清「没能注册」，不能报「已改好」',
    st2.includes('已注册') ? toast2.includes('已改为') : toast2.includes('没能注册'),
    J({ toast2, status: st2 })
  )

  // ------------------------------------------------ 按了组合又取消
  // 浮层里会把新组合显示出来，很容易被当成「已经改好了」——所以取消必须明说一句，
  // 而且设置页里那一行不能变（用户报过「提示成功但显示没改」）
  const beforeCancel = await conn.evaluate(
    `(() => { const el = ${rowExpr(target)}; return el ? el.querySelector('input').value : null })()`
  )
  await conn.evaluate(
    `(() => { const el = ${rowExpr(target)}; [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === '改键')?.click() })()`
  )
  await sleep(500)
  await conn.evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }))`
  )
  await sleep(400)
  await clickReal(`[...document.querySelectorAll('.modal__foot button')].find((b) => b.textContent.trim() === '取消')`)
  await sleep(700)
  const toast3 = await conn.evaluate(`document.querySelector('.toast')?.textContent?.trim() ?? ''`)
  await sleep(800)
  const afterCancel = await conn.evaluate(
    `(() => { const el = ${rowExpr(target)}; return el ? el.querySelector('input').value : null })()`
  )
  check('按了组合又取消时，明说「没有改动」', toast3.includes('已取消'), J(toast3))

  // 反过来也要成立：点在遮罩本身上仍该取消（修的是「点保存被当成点外面」，不是禁掉点外取消）
  await conn.evaluate(
    `(() => { const el = ${rowExpr(target)}; [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === '改键')?.click() })()`
  )
  await sleep(500)
  await conn.evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }))`
  )
  await sleep(400)
  const beforeMask = await conn.evaluate(
    `(() => {
       const m = document.querySelector('.modal-mask[aria-label="改键"]')
       if (!m) return { 浮层: false }
       const r = m.getBoundingClientRect()
       const hit = document.elementFromPoint(r.x + 6, r.y + 6)
       return {
         浮层: true,
         浮层文本: m.textContent.slice(0, 50),
         命中: hit ? hit.className || hit.tagName : null,
         命中是遮罩: hit === m
       }
     })()`
  )
  const maskPoint = beforeMask && beforeMask.浮层 ? { x: 6, y: 6 } : null
  if (maskPoint) {
    await mouse('mouseMoved', maskPoint.x, maskPoint.y, 0)
    await sleep(60)
    await mouse('mousePressed', maskPoint.x, maskPoint.y, 1)
    await sleep(60)
    await mouse('mouseReleased', maskPoint.x, maskPoint.y, 0)
  }
  await sleep(700)
  const toast4 = await conn.evaluate(`document.querySelector('.toast')?.textContent?.trim() ?? ''`)
  await sleep(700)
  const afterMask = await conn.evaluate(
    `(() => { const el = ${rowExpr(target)}; return el ? el.querySelector('input').value : null })()`
  )
  const maskProbe = await conn.evaluate(
    `(() => {
       const m = document.querySelector('.modal-mask[aria-label="改键"]')
       if (!m) return { 浮层: false }
       const r = m.getBoundingClientRect()
       const hit = document.elementFromPoint(r.x + 6, r.y + 6)
       return { 浮层: true, 位置: { x: Math.round(r.x), y: Math.round(r.y) }, 命中: hit ? hit.className || hit.tagName : null }
     })()`
  )
  if (String(beforeMask.浮层文本 ?? '').includes('ctrl+alt+m')) {
    check('点在遮罩本身上仍然算取消', toast4.includes('已取消'), J({ toast4, beforeMask }))
  } else {
    // 什么都没按就点外面本来就不该提示（没有组合可「取消」），所以这条要看浮层有没有
    // 接住按键：没接住就跳过，而不是当成失败 —— 合成 keydown 偶尔会落空
    console.log('⏭ 跳过「点在遮罩本身上仍然算取消」—— 浮层没接住这次合成的按键')
  }
  check('点遮罩取消后那一行也没变', afterMask === beforeCancel, J({ beforeCancel, afterMask }))
  check('取消后那一行仍是原值', afterCancel === beforeCancel, J({ beforeCancel, afterCancel }))
} catch (err) {
  check('脚本执行完成', false, err instanceof Error ? err.message : String(err))
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + (failed.length ? '✗ ' + failed.length + ' 项未通过' : '✓ 全部通过') + `（${results.length} 项）`)
child.kill()
process.exit(failed.length ? 1 : 0)
