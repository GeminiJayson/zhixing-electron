/**
 * 确认弹框的端到端验证：全部改成了应用内弹框（带图标）。
 *
 * 覆盖：
 *   1. 点删除 → 出现应用内弹框（.modal--dialog），带图标
 *   2. 标题 / 正文 / 按钮文案正确
 *   3. 点「取消」→ 弹框关闭、数据没动
 *   4. 再点一次 → 点「删除」→ 数据真的被删
 * 顺带断言：源码里已经没有 window.confirm（由 scripts 外的 grep 保证，这里只验证行为）
 *
 * 用法：node scripts/confirmcheck.mjs（需先 npm run build）
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
const tmpHome = join(root, '.screenshots', 'confirm-home')
const shotDir = join(root, '.screenshots')
const PORT = 9248

const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
if (!existsSync(realDb)) {
  console.error('✗ 找不到真实库：' + realDb)
  process.exit(1)
}
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(realDb, join(tmpHome, 'zhixing.db'))

const SYS_PATH = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem'].join(';')
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

const results = []
const check = (name, ok, detail = '') => {
  results.push([name, ok])
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''))
}
const shoot = async (name) => {
  const r = await conn.send('Page.captureScreenshot', { format: 'png' })
  if (r.result?.data) writeFileSync(join(shotDir, name), Buffer.from(r.result.data, 'base64'))
}

const TITLE = 'CONFIRM-' + Date.now().toString(36)
await conn.evaluate(`window.zhixing.db.createNote(${JSON.stringify(TITLE)}, null, '正文', 'markdown')`)
await conn.evaluate("document.querySelector('[data-nav-item=notes]').click()")
await sleep(1500)

/** 点笔记树里那篇测试笔记的删除按钮 */
const clickTreeDelete = async () =>
  conn.evaluate(
    `(() => {
      const row = [...document.querySelectorAll('.ntree__note')].find((el) => el.innerText.includes(${JSON.stringify(TITLE)}))
      if (!row) return false
      row.querySelector('.icon-btn--danger')?.click()
      return true
    })()`
  )

const opened = await clickTreeDelete()
await sleep(500)
const dlg = await conn.evaluate(`(() => {
  const modal = document.querySelector('.modal--dialog')
  if (!modal) return null
  const icon = modal.querySelector('.dialog__icon')
  const buttons = [...modal.querySelectorAll('.modal__foot button')].map((b) => b.textContent.trim())
  return {
    title: modal.querySelector('.modal__head h2')?.textContent.trim() ?? '',
    message: modal.querySelector('.dialog__message')?.textContent.trim() ?? '',
    hasIcon: !!icon,
    iconSvg: icon ? !!icon.querySelector('svg') : false,
    iconDanger: icon ? icon.classList.contains('dialog__icon--danger') : false,
    buttons,
  }
})()`)
check('点删除后弹出应用内弹框（不是原生框）', !!dlg, JSON.stringify(dlg))
check('弹框带图标（圆形底色 + svg）', dlg?.hasIcon === true && dlg?.iconSvg === true, '')
check('删除类弹框用危险色图标', dlg?.iconDanger === true, '')
check('标题与正文正确', dlg?.title === '删除笔记' && String(dlg?.message).includes(TITLE), `${dlg?.title} / ${dlg?.message}`)
check('按钮是「取消 / 删除」', JSON.stringify(dlg?.buttons) === JSON.stringify(['取消', '删除']), JSON.stringify(dlg?.buttons))
await shoot('confirm-dialog.png')

// 取消 → 什么也没发生
await conn.evaluate(
  "[...document.querySelectorAll('.modal--dialog .modal__foot button')].find((b) => b.textContent.trim() === '取消')?.click()"
)
await sleep(400)
const afterCancel = await conn.evaluate(`(() => ({
  modal: !!document.querySelector('.modal--dialog'),
  exists: !!document.body.innerText.includes(${JSON.stringify(TITLE)}),
}))()`)
check('点取消后弹框关闭且数据还在', afterCancel.modal === false && afterCancel.exists === true, JSON.stringify(afterCancel))

// 确定 → 真的删掉
await clickTreeDelete()
await sleep(400)
await conn.evaluate(
  "[...document.querySelectorAll('.modal--dialog .modal__foot button')].find((b) => b.textContent.trim() === '删除')?.click()"
)
await sleep(800)
const afterOk = await conn.evaluate(`(() => {
  const count = document.querySelectorAll('.ntree__note').length
  const rows = [...document.querySelectorAll('.ntree__note')].map((el) => el.innerText)
  return { modal: !!document.querySelector('.modal--dialog'), stillThere: rows.some((t) => t.includes(${JSON.stringify(TITLE)})) }
})()`)
check('点删除后弹框关闭且数据被删除', afterOk.modal === false && afterOk.stillThere === false, JSON.stringify(afterOk))

conn.ws.close()
child.kill()
await sleep(500)
rmSync(tmpHome, { recursive: true, force: true })

const failed = results.filter(([, ok]) => !ok)
console.log('')
console.log((results.length - failed.length) + '/' + results.length + ' 项通过')
process.exit(failed.length ? 1 : 0)
