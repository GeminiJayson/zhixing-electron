/**
 * 任务进度条与「精确到分钟」的端到端检查。
 *
 * 覆盖：
 *   1. 新建任务的开始时间就是创建时刻（日期 = 今天，时刻 = 当前 HH:MM）；
 *   2. 进度条真的画在任务行上，且色阶随紧迫度变化（从容 → 过点）；
 *   3. 编辑弹窗里开始/截止各有一个 time 输入，且分钟精度能存下去。
 *
 * 用法：node scripts/taskprogresscheck.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = join(root, '.screenshots', 'progress-home')
const PORT = 9331
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db'), join(tmpHome, 'zhixing.db'))

const SYS_PATH = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem'].join(';')
const child = spawn(electronPath, ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(tmpHome, 'profile')], {
  cwd: root,
  env: { ...process.env, PATH: SYS_PATH + ';' + (process.env.PATH ?? ''), ZHIXING_HOME: tmpHome },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const list = async () => { try { return await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json() } catch { return [] } }
const connect = async (t) => {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
  const send = (m, p = {}) => new Promise((resolve) => { const id = Math.floor(Math.random() * 1e6); const h = (ev) => { const x = JSON.parse(ev.data); if (x.id !== id) return; ws.removeEventListener('message', h); resolve(x) }; ws.addEventListener('message', h); ws.send(JSON.stringify({ id, method: m, params: p })) })
  await send('Runtime.enable')
  const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed'); return r.result?.result?.value }
  return { send, evaluate }
}

let main = null
for (let i = 0; i < 60 && !main; i++) { main = (await list()).find((t) => t.type === 'page'); if (!main) await sleep(500) }
if (!main) { console.error('✗ 主窗口没起来'); child.kill(); process.exit(1) }
const conn = await connect(main)
await sleep(2600)

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : '')) }
const J = (v) => JSON.stringify(v)
const mouse = (type, x, y, buttons) =>
  conn.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 })
const clickReal = async (expr) => {
  const p = await conn.evaluate("(() => { const el = " + expr + "; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()")
  if (!p) return false
  await mouse('mouseMoved', p.x, p.y, 0)
  await sleep(60)
  await mouse('mousePressed', p.x, p.y, 1)
  await sleep(60)
  await mouse('mouseReleased', p.x, p.y, 0)
  return true
}

try {
  // ---- 1. 新建任务：开始时间 = 创建时刻
  const created = await conn.evaluate("window.zhixing.db.createTask('进度条检查任务', null, null)")
  const now = new Date()
  const todayStr = now.toLocaleDateString('sv-SE')
  const hhmm = now.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })
  check('新列已建好（返回对象里有 start_time）', created && 'start_time' in created, J({ start_time: created?.start_time, start_date: created?.start_date }))
  check('开始日期 = 今天', created?.start_date === todayStr, J({ got: created?.start_date, want: todayStr }))
  const drift = (() => {
    if (!created?.start_time) return 999
    const [h, m] = created.start_time.split(':').map(Number)
    const [nh, nm] = hhmm.split(':').map(Number)
    return Math.abs(h * 60 + m - (nh * 60 + nm))
  })()
  check('开始时刻 = 创建时刻（误差 2 分钟内）', drift <= 2, J({ start_time: created?.start_time, now: hhmm, 分钟差: drift }))

  // ---- 2. 进度条与色阶
  await conn.evaluate("document.querySelector('[data-nav-item=\"tasks\"]')?.click()")
  await sleep(1500)
  // 每句都带分号：这些片段是拼成一个表达式的，漏了分号会直接变成语法错误
  const probe = (token) =>
    conn.evaluate(
      "(() => {" +
        "const row = [...document.querySelectorAll('.trow')].find((r) => r.querySelector('.trow__title')?.textContent === '进度条检查任务');" +
        "if (!row) return { found: false };" +
        "const bar = row.querySelector('.trow__progress');" +
        "const probeEl = document.createElement('div');" +
        "probeEl.style.color = 'var(--" + token + ")';" +
        "document.body.appendChild(probeEl);" +
        "const want = getComputedStyle(probeEl).color;" +
        "probeEl.remove();" +
        "return { found: true, hasBar: !!bar, cls: bar ? bar.className : null, color: bar ? getComputedStyle(bar).color : null, want," +
        " html: row.outerHTML.slice(0, 1400)," +
        " chips: [...row.querySelectorAll('.chip')].map((c) => c.textContent.trim())," +
        " titleAttr: (() => { const b = [...row.querySelectorAll('button')].find((x) => /编辑/.test(x.getAttribute('aria-label') || '')); return b ? { title: b.getAttribute('title'), aria: b.getAttribute('aria-label'), html: b.outerHTML.slice(0, 160) } : null })() };" +
      "})()"
    )
  // 进度需要一头一尾：新建任务只有开始时刻，所以先给它一个截止
  const updated = await conn.evaluate(
    "window.zhixing.db.updateTask(" + created.id + ", { due_date: '" + todayStr + "', due_time: '23:59' })"
  )
  console.log(
    '[update] ' +
      J({ id: created.id, due_date: updated?.due_date, due_time: updated?.due_time, start_time: updated?.start_time })
  )
  await sleep(1600)
  const future = await probe('success')
  console.log('[row] ' + String(future.html))
  console.log('[buttons] ' + J(future.buttons))
  check('任务行上画出了进度条', future.found && future.hasBar, J({ hasBar: future.hasBar, cls: future.cls }))
  check('未到期用的是「从容」色阶（绿）', String(future.cls ?? '').includes('progress--calm'), J({ cls: future.cls }))
  check('色阶取的是 --success', future.color === future.want, J({ color: future.color, want: future.want }))

  // 把截止挪到刚刚过去（起点仍在更早的昨天）：色阶应当转为「过点」。
  // 注意不能把截止设到早于开始日期 —— 那种情况本来就不算进度（见 taskProgress 的单测）
  const justPast = new Date(now.getTime() - 60_000)
  const yesterday = new Date(now.getTime() - 86_400_000).toLocaleDateString('sv-SE')
  const pastClock = justPast.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })
  await conn.evaluate(
    "window.zhixing.db.updateTask(" + created.id + ", { start_date: '" + yesterday + "', start_time: '00:00', due_date: '" + todayStr + "', due_time: '" + pastClock + "' })"
  )
  await sleep(1600)
  const past = await probe('danger')
  check('过点后色阶转为「逾期」（红）', String(past.cls ?? '').includes('progress--overdue'), J({ cls: past.cls }))
  check('逾期色取的是 --danger', past.color === past.want, J({ color: past.color, want: past.want }))

  // ---- 3. 分钟精度能存下去 + 编辑弹窗有时刻输入
  const back = await conn.evaluate("window.zhixing.db.updateTask(" + created.id + ", { due_date: '" + todayStr + "', due_time: '23:59' })")
  check('分钟精度能存下去（23:59 存进去读回来还是 23:59）', back?.due_time === '23:59', J({ due_time: back?.due_time }))
  const cleared = await conn.evaluate("window.zhixing.db.updateTask(" + created.id + ", { due_time: null })")
  check('时刻可以清空（清空 = 只精确到天）', cleared?.due_time === null || cleared?.due_time === undefined, J({ due_time: cleared?.due_time }))

  // 操作按钮平时是收起的（悬浮才浮现），所以用程序化点击：它不受可见性影响
  await conn.evaluate(
    "(() => { const row = [...document.querySelectorAll('.trow')].find((r) => r.querySelector('.trow__title')?.textContent === '进度条检查任务'); const b = [...row.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('编辑')); b?.click() })()"
  )
  await sleep(1200)
  const editor = await conn.evaluate("(() => { const m = document.querySelector('.modal[role=\"dialog\"]'); return { masks: document.querySelectorAll('.modal-mask').length, modals: document.querySelectorAll('.modal').length, open: !!m, times: m ? m.querySelectorAll('input[type=\"time\"]').length : 0, dates: m ? m.querySelectorAll('input[type=\"date\"]').length : 0 } })()")
  check('编辑弹窗里开始与截止各有一个时刻输入', editor.open && editor.times === 2, J(editor))
} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}

const failed = results.filter((r) => !r).length
console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 全部通过') + '（' + results.length + ' 项）')
await sleep(300)
child.kill()
process.exit(failed ? 1 : 0)
