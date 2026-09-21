import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = join(root, '.screenshots', 'reminder-home')
const PORT = 9384
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db'), join(tmpHome, 'zhixing.db'))

const SYS_PATH = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem'].join(';')
console.log('【启动】拉起 Electron…')
const child = spawn(
  electronPath,
  ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(tmpHome, 'profile')],
  {
    cwd: root,
    env: { ...process.env, PATH: SYS_PATH + ';' + (process.env.PATH ?? ''), ZHIXING_HOME: tmpHome },
    stdio: ['ignore', 'pipe', 'pipe']
  }
)

const listTargets = async () => {
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
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true })
  })
  const send = (m, p = {}) =>
    new Promise((resolve, reject) => {
      const id = Math.floor(Math.random() * 1e6)
      const timer = setTimeout(() => {
        ws.removeEventListener('message', h)
        reject(new Error('CDP 超时（15s 无响应）：' + m))
      }, 15000)
      const h = (ev) => {
        const x = JSON.parse(ev.data)
        if (x.id !== id) return
        clearTimeout(timer)
        ws.removeEventListener('message', h)
        resolve(x)
      }
      ws.addEventListener('message', h)
      ws.send(JSON.stringify({ id, method: m, params: p }))
    })
  await send('Runtime.enable')
  const evaluate = async (expr, quiet) => {
    if (!quiet) console.log('  · eval ' + String(expr).replace(/\s+/g, ' ').slice(0, 70))
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval 失败')
    }
    return r.result?.result?.value
  }
  return { evaluate, close: () => ws.close() }
}

const results = []
const check = (n, ok, d = '') => {
  results.push(ok)
  console.log((ok ? '✓ ' : '✗ ') + n + (d ? ' — ' + d : ''))
}
const J = (v) => JSON.stringify(v)

let main = null
let widget = null
let bubble = null
try {
  console.log('【就绪】等待主窗口…')
  for (let i = 0; i < 70 && !main; i++) {
    const all = await listTargets()
    const t = all.find(
      (x) => x.type === 'page' && !/[?&](widget|reminder|condition|capture)=1/.test(x.url)
    )
    if (t) main = await connect(t)
    else {
      if (i % 4 === 0) console.log('  ' + Math.round(i * 0.5) + 's')
      await sleep(500)
    }
  }
  if (!main) throw new Error('主窗口始终没出现')
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    if (i % 3 === 2) console.log('  ' + Math.round((i + 1) * 0.5) + 's')
  }

  // ---------------------------------------------------------------- 已完成收归
  console.log('【步骤】已完成任务应从当前清单收走')
  await main.evaluate("document.querySelector('[data-nav-item=\"tasks\"]')?.click()")
  await sleep(1500)
  const entry = await main.evaluate(
    "(() => { const s = document.querySelector('select[aria-label=\"按清单筛选\"]'); return s ? [...s.options].map((o) => o.textContent) : null })()"
  )
  check('清单筛选里出现「已完成」入口', Array.isArray(entry) && entry.includes('已完成'), J(entry))

  await main.evaluate(`(async () => {
    const t = await window.zhixing.db.createTask('收归验证任务', null, null)
    window.__t = t.id
    return t.id
  })()`)
  await sleep(1200)
  const before = await main.evaluate(
    "(() => [...document.querySelectorAll('.trow__title')].map((e) => e.textContent))()"
  )
  check('未完成时它出现在当前清单里', before.includes('收归验证任务'), J(before.slice(0, 6)))

  await main.evaluate('window.zhixing.db.setStatus(window.__t, "done")')
  await sleep(1600)
  const gone = await main.evaluate(
    "(() => [...document.querySelectorAll('.trow__title')].map((e) => e.textContent))()"
  )
  check('完成后它从当前清单消失', !gone.includes('收归验证任务'), J(gone.slice(0, 6)))

  // 切到「已完成」清单：用原生 setter + change 事件，React 才认
  await main.evaluate(`(() => {
    const s = document.querySelector('select[aria-label="按清单筛选"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(s, '__done')
    s.dispatchEvent(new Event('change', { bubbles: true }))
    return s.value
  })()`)
  await sleep(1600)
  const inDone = await main.evaluate(
    "(() => [...document.querySelectorAll('.trow__title')].map((e) => e.textContent))()"
  )
  check('它在「已完成」清单里露面', inDone.includes('收归验证任务'), J(inDone.slice(0, 6)))
  // 切回全部清单，免得影响后面
  await main.evaluate(`(() => {
    const s = document.querySelector('select[aria-label="按清单筛选"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(s, '')
    s.dispatchEvent(new Event('change', { bubbles: true }))
    return s.value
  })()`)
  await sleep(900)

  // ---------------------------------------------------------------- 提醒时刻可编辑
  console.log('【步骤】任务编辑面板里的提醒时刻')
  const setRem = await main.evaluate(`(async () => {
    const t = await window.zhixing.db.updateTask(window.__t, { reminder_at: '2031-03-05 08:30:00.000000' })
    const back = await window.zhixing.db.getTask(window.__t)
    return { saved: t && t.reminder_at, read: back && back.reminder_at }
  })()`)
  check(
    'reminder_at 能写进库并读回（白名单已放开）',
    setRem.read === '2031-03-05 08:30:00.000000',
    J(setRem)
  )

  // 再用一个**未完成**的任务验证编辑面板。两个坑：
  //   1. 双击标题是「行内改名」，不是打开面板 —— 打开面板要点铅笔按钮
  //   2. 已完成的那个已被当前清单收走，列表里根本找不到它
  await main.evaluate(`(async () => {
    const t = await window.zhixing.db.createTask('提醒编辑验证', null, null)
    await window.zhixing.db.updateTask(t.id, { reminder_at: '2031-03-05 08:30:00.000000' })
    window.__e = t.id
    return t.id
  })()`)
  await sleep(1500)
  const opened = await main.evaluate(`(() => {
    const row = [...document.querySelectorAll('.trow')].find((r) => r.textContent.includes('提醒编辑验证'))
    const btn = row && row.querySelector('[aria-label="编辑任务"]')
    if (btn) btn.click()
    return !!btn
  })()`)
  check('点到编辑面板的入口', opened === true, J(opened))
  await sleep(900)
  const editor = await main.evaluate(`(() => {
    const d = document.querySelector('[aria-label="提醒日期"]')
    const t = document.querySelector('[aria-label="提醒时间"]')
    return { hasDate: !!d, hasTime: !!t, dateText: d ? d.textContent.trim() : null, timeText: t ? t.textContent.trim() : null }
  })()`)
  check('编辑面板有「提醒日期 + 提醒时间」两个控件', editor.hasDate && editor.hasTime, J(editor))
  check(
    '两个控件回显了库里的提醒时刻',
    (editor.dateText ?? '').includes('2031-03-05') && (editor.timeText ?? '').includes('08:30'),
    J(editor)
  )
  // 按文字找「取消」：第一个 text-btn 是「删除」，按位置找会误删任务
  await main.evaluate(
    "[...document.querySelectorAll('.modal__foot button')].find((b) => b.textContent.trim() === '取消')?.click()"
  )
  await sleep(600)

  // ---------------------------------------------------------------- 悬浮表情气泡
  console.log('【步骤】让提醒走悬浮表情气泡')
  // 这一条必须在动浮窗**之前**查：气泡窗口是启动序列里就创建的（不等有提醒才建，
  // 否则首次推送会落在窗口加载完成之前、那一条就丢了）。
  const earlyTargets = await listTargets()
  const bubbleAtBoot = earlyTargets.find((x) => x.type === 'page' && x.url.includes('reminder=1'))
  check(
    '气泡窗口（?reminder=1）随应用启动就已创建',
    !!bubbleAtBoot,
    J(earlyTargets.map((x) => x.url))
  )
  await main.evaluate("window.zhixing.db.setSetting('widget_enabled', '1')")
  await sleep(600)
  // 两次 toggle：第一次确保窗口存在（不存在时它负责创建），第二次关掉它并把
  // 「手动打开」标记清回 false —— 留着那个标记的话 syncWidgetVisibility 会对浮窗
  // 撒手不管，下面那条「球被藏起来」的基线就永远等不到。
  await main.evaluate('window.zhixing.widget.toggle()')
  await sleep(900)
  await main.evaluate('window.zhixing.widget.toggle()')
  await sleep(900)
  let targets = await listTargets()
  const wt = targets.find((x) => x.type === 'page' && x.url.includes('widget=1'))
  const rb = targets.find((x) => x.type === 'page' && x.url.includes('reminder=1'))
  if (wt) widget = await connect(wt)
  if (rb) bubble = await connect(rb)
  check('气泡窗口已挂上 CDP（可用于后续断言）', !!rb, J(targets.map((x) => x.url)))
  if (widget) {
    await widget.evaluate(
      "(() => { window.__notice = null; window.zhixing.widget.onNotice((n) => { window.__notice = n }); return true })()"
    )
  }

  // 收成悬浮球：提醒该从「悬浮表情」旁边冒出来，这条只有球形态才验得到。
  // 随后的写操作会触发显隐联动把球藏起来 —— 前面那句断言正是在等这个状态。
  await main.evaluate('window.zhixing.widget.close()')
  await sleep(1200)

  // 造一条已经过期的提醒：状态必须是待办，否则降级规则会把它挡掉
  const overdue = await main.evaluate(`(async () => {
    const t = await window.zhixing.db.createTask('提醒验证任务', null, null)
    await window.zhixing.db.updateTask(t.id, { reminder_at: '2020-01-01 09:00:00.000000' })
    window.__r = t.id
    return t.id
  })()`)
  check('造出一条已过期的提醒', typeof overdue === 'number', J(overdue))

  // 基线：上面那次写操作触发了显隐联动，球该被藏起来了。
  // 这一条必须在写操作**之后**查 —— 只有先藏起来，「提醒来了球就露面」才说明是提醒唤出来的，
  // 而不是「它本来就一直开着」。
  await sleep(1500)
  const ballHidden = await widget.evaluate(
    "document.visibilityState === 'hidden' || !document.querySelector('.wball')",
    true
  )
  check('写操作后球被显隐联动藏起来（提醒前的基线）', ballHidden === true, J(ballHidden))

  console.log('【等待】主进程派发周期 30 秒，持续输出以免被判静默…')
  let cards = 0
  let notice = null
  let mainCards = 0
  let ballShown = false
  for (let i = 0; i < 25; i++) {
    await sleep(2000)
    console.log('  ' + (i + 1) * 2 + 's')
    if (!bubble) {
      const all = await listTargets()
      const t = all.find((x) => x.type === 'page' && x.url.includes('reminder=1'))
      if (t) bubble = await connect(t)
    }
    if (bubble) cards = await bubble.evaluate("document.querySelectorAll('.rbug__card').length", true)
    if (widget) notice = await widget.evaluate('window.__notice === null ? null : window.__notice', true)
    if (widget) {
      ballShown = await widget.evaluate(
        "document.visibilityState === 'visible' && !!document.querySelector('.wball')",
        true
      )
    }
    mainCards = await main.evaluate("document.querySelectorAll('.reminder').length", true)
    if (cards > 0 && (notice ?? 0) > 0) break
  }
  check('悬浮表情旁边的气泡里出现了提醒卡片', cards > 0, 'cards=' + cards)
  check('提醒来了球就露面（悬浮表情真的出现了）', ballShown === true, 'ballShown=' + ballShown)
  check('悬浮球收到了提醒条数（会切 notify 表情）', (notice ?? 0) > 0, 'notice=' + J(notice))
  check('主窗口那张卡片没有出现（说明走的是气泡通道）', mainCards === 0, 'mainCards=' + mainCards)

  // 知道了 → 从气泡里消失
  if (cards > 0) {
    await bubble.evaluate(
      "[...document.querySelectorAll('.rbug__actions button')].find((b) => b.textContent.trim() === '知道了')?.click()"
    )
    await sleep(1200)
    const after = await bubble.evaluate("document.querySelectorAll('.rbug__card').length", true)
    check('点「知道了」后气泡收起该条', after === 0, 'after=' + after)
    const still = await main.evaluate(
      "window.zhixing.db.getTask(window.__r).then((t) => t && t.reminder_at)",
      true
    )
    check('reminder_at 已被消费（一次性语义，重启不会再打扰）', still === null, J(still))
  }
} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}
const failed = results.filter((r) => !r).length
console.log('')
console.log(failed ? '✗ ' + failed + ' 项未通过' : '✓ 全部通过（' + results.length + ' 项）')
await sleep(500)
child.kill()
process.exit(failed ? 1 : 0)
