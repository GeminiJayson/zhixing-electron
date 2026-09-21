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
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

const root = ROOT
const require = createRequire(import.meta.url)
const tmpHome = join(ROOT, '.screenshots', 'progress-home')
const PORT = 9331

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish, results } = createChecker()
const mouse = (type, x, y, buttons) =>
  app.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 })
const clickReal = async (expr) => {
  const p = await app.evaluate("(() => { const el = " + expr + "; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()")
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
  const created = await app.evaluate("window.zhixing.db.createTask('进度条检查任务', null, null)")
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
  await app.evaluate("document.querySelector('[data-nav-item=\"tasks\"]')?.click()")
  await sleep(1500)
  // 每句都带分号：这些片段是拼成一个表达式的，漏了分号会直接变成语法错误
  const probe = (token) =>
    app.evaluate(
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
  const updated = await app.evaluate(
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
  // 进度条应当从勾选框的位置开始，而不是行的最左边
  const barGeo = await app.evaluate(
    "(() => { const row = [...document.querySelectorAll('.trow')].find((r) => r.querySelector('.trow__progress'));" +
      "if (!row) return { found: false };" +
      "const bar = row.querySelector('.trow__progress'); const check = row.querySelector('.check');" +
      "const a = bar.getBoundingClientRect(); const b = check.getBoundingClientRect();" +
      "return { found: true, bar: Math.round(a.left), check: Math.round(b.left), right: Math.round(a.right), rowRight: Math.round(row.getBoundingClientRect().right) }; })()"
  )
  check('进度条从勾选框位置开始', barGeo.found && Math.abs(barGeo.bar - barGeo.check) <= 1, J(barGeo))
  check('进度条仍然铺到行的右端', barGeo.found && Math.abs(barGeo.right - barGeo.rowRight) <= 1, J(barGeo))
  check('未到期用的是「从容」色阶（绿）', String(future.cls ?? '').includes('progress--calm'), J({ cls: future.cls }))
  check('色阶取的是 --success', future.color === future.want, J({ color: future.color, want: future.want }))

  // 把截止挪到刚刚过去（起点仍在更早的昨天）：色阶应当转为「过点」。
  // 注意不能把截止设到早于开始日期 —— 那种情况本来就不算进度（见 taskProgress 的单测）
  const justPast = new Date(now.getTime() - 60_000)
  const yesterday = new Date(now.getTime() - 86_400_000).toLocaleDateString('sv-SE')
  const pastClock = justPast.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })
  await app.evaluate(
    "window.zhixing.db.updateTask(" + created.id + ", { start_date: '" + yesterday + "', start_time: '00:00', due_date: '" + todayStr + "', due_time: '" + pastClock + "' })"
  )
  await sleep(1600)
  const past = await probe('danger')
  check('过点后色阶转为「逾期」（红）', String(past.cls ?? '').includes('progress--overdue'), J({ cls: past.cls }))
  check('逾期色取的是 --danger', past.color === past.want, J({ color: past.color, want: past.want }))

  // ---- 3. 分钟精度能存下去 + 编辑弹窗有时刻输入
  const back = await app.evaluate("window.zhixing.db.updateTask(" + created.id + ", { due_date: '" + todayStr + "', due_time: '23:59' })")
  check('分钟精度能存下去（23:59 存进去读回来还是 23:59）', back?.due_time === '23:59', J({ due_time: back?.due_time }))
  const cleared = await app.evaluate("window.zhixing.db.updateTask(" + created.id + ", { due_time: null })")
  check('时刻可以清空（清空 = 只精确到天）', cleared?.due_time === null || cleared?.due_time === undefined, J({ due_time: cleared?.due_time }))

  // 操作按钮平时是收起的（悬浮才浮现），所以用程序化点击：它不受可见性影响
  await app.evaluate(
    "(() => { const row = [...document.querySelectorAll('.trow')].find((r) => r.querySelector('.trow__title')?.textContent === '进度条检查任务'); const b = [...row.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('编辑')); b?.click() })()"
  )
  await sleep(1200)
  const editor = await app.evaluate("(() => { const m = document.querySelector('.modal[role=\"dialog\"]'); return { open: !!m, picks: m ? m.querySelectorAll('.timepick').length : 0, dates: m ? m.querySelectorAll('.datepick').length : 0 } })()")
  // 编器现在有三组日期/时刻：开始、截止、**提醒**（提醒那组是后加的界面入口）。
  // 原先写死 === 2，于是在提醒入口加出来之后就一直是红的 —— 又是「行为改了、断言没跟」。
  // 这里改成不写死数字：日期至少两组、时刻与日期一一配对。再加字段不必回来改。
  check('编辑弹窗里开始与截止都有日期选择器', editor.open && editor.dates >= 2, J(editor))
  check(
    '时刻选择器与日期选择器一一配对（开始 / 截止 / 提醒）',
    editor.open && editor.picks === editor.dates && editor.picks >= 2,
    J(editor)
  )

  // ---- 自绘日期选择器：日历面板与格子尺寸
  await app.evaluate("document.querySelector('.modal .datepick').click()")
  await sleep(700)
  const cal = await app.evaluate(
    "(() => {" +
      "const el = document.querySelector('.popmenu--date');" +
      "if (!el) return { open: false };" +
      "const probe = document.createElement('div');" +
      "probe.style.height = 'var(--control-h)';" +
      "document.body.appendChild(probe);" +
      "const want = Math.round(probe.getBoundingClientRect().height);" +
      "probe.remove();" +
      "const days = [...el.querySelectorAll('.dpick__day')];" +
      "const sizes = days.map((b) => { const r = b.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); });" +
      "return { open: true, title: el.querySelector('.dpick__title')?.textContent, count: days.length, uniq: [...new Set(sizes)], want };" +
    "})()"
  )
  check('点开后弹出日历（6×7 = 42 格）', cal.open === true && cal.count === 42, J({ open: cal.open, count: cal.count, title: cal.title }))
  check(
    '日期格是「控件高度」见方',
    cal.open === true && cal.uniq.length === 1 && cal.uniq[0] === cal.want + 'x' + cal.want,
    J({ want: cal.want, sizes: cal.uniq })
  )
  // 翻月：标题里的月份应当变
  await app.evaluate("document.querySelector('.dpick__nav[aria-label=\"下个月\"]').click()")
  await sleep(400)
  const shifted = await app.evaluate("document.querySelector('.dpick__title')?.textContent")
  check('翻月按钮切换了月份', shifted !== cal.title, J({ before: cal.title, after: shifted }))
  // 翻回本月再截图（给用户看日历）
  await app.evaluate("document.querySelector('.dpick__nav[aria-label=\"上个月\"]').click()")
  await sleep(500)
  const calShot = await app.send('Page.captureScreenshot', { format: 'png' })
  const fs4 = await import('node:fs')
  const fs5 = await import('node:fs')
  fs4.writeFileSync(join(root, '.screenshots', 'datepicker-custom.png'), Buffer.from(calShot.result.data, 'base64'))
  console.log('（截图 .screenshots/datepicker-custom.png）')

  // 点「今天」应当**立刻**落库并收起（日历上点一下就完成选择，不必再等失焦）
  const todayIso = new Date().toLocaleDateString('sv-SE')
  await app.evaluate("document.querySelector('.dpick__foot button').click()")
  await sleep(600)
  const dpAfter = await app.evaluate("(() => ({ open: !!document.querySelector('.popmenu--date'), text: document.querySelector('.modal .datepick').textContent.trim() }))()")
  check('点「今天」后日历立刻消失', dpAfter.open === false, J(dpAfter))
  check('点「今天」把日期落了下去', dpAfter.text === todayIso, J({ got: dpAfter.text, want: todayIso }))

  // ---- 年月跳转：点标题切到两列，选完回到日历
  await app.evaluate("document.querySelector('.modal .datepick').click()")
  await sleep(500)
  await app.evaluate("document.querySelector('.dpick__title').click()")
  await sleep(600)
  const ym = await app.evaluate(
    "(() => {" +
      "const el = document.querySelector('.popmenu--date');" +
      "if (!el) return { open: false };" +
      "const ys = [...el.querySelectorAll('.dpick__ylist .popmenu__item')];" +
      "const ms = [...el.querySelectorAll('.dpick__mlist .popmenu__item')];" +
      "const probe = document.createElement('div');" +
      "probe.style.height = 'var(--control-h)';" +
      "document.body.appendChild(probe);" +
      "const want = Math.round(probe.getBoundingClientRect().height);" +
      "probe.remove();" +
      "const hs = [...ys, ...ms].map((b) => Math.round(b.getBoundingClientRect().height));" +
      "return { open: true, years: ys.length, months: ms.length, minH: Math.min(...hs), maxH: Math.max(...hs), want };" +
    "})()"
  )
  check('点标题展开年月跳转（151 年 + 12 月）', ym.open === true && ym.years === 151 && ym.months === 12, J(ym))
  check('年月项高度 = 控件高度', ym.open === true && ym.minH === ym.want && ym.maxH === ym.want, J(ym))
  const titleBefore = await app.evaluate("document.querySelector('.dpick__title').textContent")
  const ymShot = await app.send('Page.captureScreenshot', { format: 'png' })
  fs5.writeFileSync(join(root, '.screenshots', 'datepicker-yearmonth.png'), Buffer.from(ymShot.result.data, 'base64'))
  console.log('（截图 .screenshots/datepicker-yearmonth.png）')
  await app.evaluate("[...document.querySelectorAll('.dpick__ylist .popmenu__item')].find((b) => b.textContent.trim() === '2030 年').click()")
  await sleep(500)
  const afterYear = await app.evaluate("(() => ({ title: document.querySelector('.dpick__title')?.textContent, grid: !!document.querySelector('.dpick__grid') }))()")
  check(
    '选年份后仍留在年月视图，且年月已落到面板上',
    afterYear.grid === false && String(afterYear.title).includes('2030'),
    J({ titleBefore, afterYear })
  )
  // 「落到日期选择器」= 值本身跟着变（保留原来那一天）
  const valAfterYear = await app.evaluate("document.querySelector('.modal .datepick').textContent.trim()")
  check('选年份后值也回填了（保留原来那一天）', valAfterYear.startsWith('2030-'), J(valAfterYear))
  // 选月份同样不退回，标题继续跟着走
  await app.evaluate("[...document.querySelectorAll('.dpick__mlist .popmenu__item')].find((b) => b.textContent.trim() === '3 月').click()")
  await sleep(500)
  const afterMonth = await app.evaluate("(() => ({ title: document.querySelector('.dpick__title')?.textContent, grid: !!document.querySelector('.dpick__grid') }))()")
  check(
    '选月份后仍留在年月视图，标题也更新',
    afterMonth.grid === false && String(afterMonth.title).includes('2030') && String(afterMonth.title).includes('3 月'),
    J(afterMonth)
  )
  // 走「返回日历」才切回日期网格
  const dbg = await app.evaluate(
    "(() => {" +
      "const btns = [...document.querySelectorAll('.dpick__pick .dpick__foot button')];" +
      "const el = btns[0];" +
      "if (!el) return { found: 0, pick: !!document.querySelector('.dpick__pick') };" +
      "const r = el.getBoundingClientRect();" +
      "const h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);" +
      "return { found: btns.length, text: el.textContent.trim(), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, hit: h ? (h.className || h.tagName) : null };" +
    "})()"
  )
  console.log('[返回按钮] ' + J(dbg))
  // 用真实鼠标：程序化 click() 不派发 mousedown，「点面板里却把面板关掉」这类 bug 只有真鼠标能抓到
  await clickReal("[...document.querySelectorAll('.dpick__pick .dpick__foot button')][0]")
  await sleep(500)
  const backToDay = await app.evaluate("(() => ({ grid: !!document.querySelector('.dpick__grid'), pick: !!document.querySelector('.dpick__pick'), panel: !!document.querySelector('.popmenu--date'), title: document.querySelector('.dpick__title')?.textContent }))()")
  check('点「返回日历」切回日期网格，月份仍是刚选的', backToDay.grid === true && String(backToDay.title).includes('2030'), J(backToDay))
  const backToDayValue = await app.evaluate("document.querySelector('.modal .datepick').textContent.trim()")
  // ---- 真实鼠标点某一天：面板必须关掉且不弹回来（用户报的「反而重新唤起」）
  // 先把面板关干净：**必须用真实鼠标** —— 程序化 click() 不派发 mousedown，
  // 而「点外面收起」正挂在 mousedown 的捕获阶段上，用 click() 根本关不掉（踩过这个坑）
  if (await app.evaluate("!!document.querySelector('.popmenu--date')")) {
    await clickReal("document.querySelector('.modal__head')")
    await sleep(500)
  }
  await app.evaluate("document.querySelector('.modal .datepick').click()")
  await sleep(700)
  const openedForDay = await app.evaluate("!!document.querySelector('.popmenu--date')")
  check('先确认日期面板真的打开了（防假阳性）', openedForDay === true, J(openedForDay))
  const dayPoint = await app.evaluate(
    "(() => { const b = [...document.querySelectorAll('.dpick__day')].find((x) => x.textContent.trim() === '15'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()"
  )
  // 装页面级异常捕获：如果 setOpen(false) 没生效是因为渲染抛错，这里能看见
  await app.evaluate(
    "(() => { localStorage.removeItem('__err');" +
      "window.addEventListener('error', (e) => localStorage.setItem('__err', String((e.error && e.error.stack) || e.message).slice(0, 700)));" +
      "window.addEventListener('unhandledrejection', (e) => localStorage.setItem('__err', 'rejection: ' + String((e.reason && e.reason.stack) || e.reason).slice(0, 700))); })()"
  )
  console.log('[待点的日期格] ' + J(dayPoint))
  if (dayPoint) {
    await mouse('mouseMoved', dayPoint.x, dayPoint.y, 0)
    await sleep(80)
    await mouse('mousePressed', dayPoint.x, dayPoint.y, 1)
    await sleep(80)
    await mouse('mouseReleased', dayPoint.x, dayPoint.y, 0)
    await sleep(800)
  }
  const afterDay = await app.evaluate(
    "(() => { const b = document.querySelector('.modal .datepick'); return { open: !!document.querySelector('.popmenu--date'), text: b.textContent.trim() }; })()"
  )
  console.log('[真实点日期后] ' + J(afterDay))
  check('真实鼠标点日期后，面板保持关闭（不弹回来）', afterDay.open === false, J(afterDay))
  check('真实鼠标点日期后，值落到了那一天', afterDay.text.endsWith('-15'), J(afterDay))

  // 点外面只是收起，不改值 —— 基准取「点外面前」的值（前面刚用真实鼠标点过 15 号）
  const valueBeforeOutside = await app.evaluate("document.querySelector('.modal .datepick').textContent.trim()")
  await clickReal("document.querySelector('.modal__head')")
  await sleep(600)
  const stillToday = await app.evaluate("document.querySelector('.modal .datepick').textContent.trim()")
  // 这一步只验证「点外面只是收起」—— 值在更早的年月操作里已经被改过了，
  // 所以比对的是「点外面前后是否一致」，而不是跟最初的今天比
  check('点外面收起时不会改动已选日期', stillToday === valueBeforeOutside, J({ got: stillToday, want: valueBeforeOutside }))

  // ---- 自绘的时刻选择器：项高必须与控件高度一致（原生面板做不到这件事）
  await clickReal("document.querySelector('.modal .timepick')")
  await sleep(700)
  const menu = await app.evaluate(
    "(() => {" +
      "const el = document.querySelector('.popmenu--time');" +
      "if (!el) return { open: false };" +
      "const probe = document.createElement('div');" +
      "probe.style.height = 'var(--control-h)';" +
      "document.body.appendChild(probe);" +
      "const want = Math.round(probe.getBoundingClientRect().height);" +
      "probe.remove();" +
      "const items = [...el.querySelectorAll('.popmenu__item')].map((b) => Math.round(b.getBoundingClientRect().height));" +
      "return { open: true, want, count: items.length, min: Math.min(...items), max: Math.max(...items) };" +
    "})()"
  )
  check('点开后弹出两列时刻列表（24 小时 + 60 分钟 + 清除）', menu.open === true && menu.count === 85, J({ open: menu.open, count: menu.count }))
  check(
    '列表项高度 = 控件高度 —— 这正是原生面板做不到的',
    menu.open === true && menu.min === menu.want && menu.max === menu.want,
    J(menu)
  )
  await app.evaluate("[...document.querySelectorAll('.popmenu--time .popmenu__item')].find((b) => b.textContent.trim() === '07')?.click()")
  await sleep(600)
  const picked = await app.evaluate("document.querySelector('.modal .timepick').textContent.trim()")
  check('点选后按钮上立刻预览（此时还没落库）', picked.includes('07'), J(picked))

  // 只选小时，然后失焦：面板应当自己消失，并把选到的时刻回填（而不是丢掉）
  await app.evaluate("[...document.querySelectorAll('.popmenu--time .popmenu__item')].find((b) => b.textContent.trim() === '09')?.click()")
  await sleep(400)
  const midPreview = await app.evaluate("document.querySelector('.modal .timepick').textContent.trim()")
  check('只选一半也会实时预览（09:00）', midPreview.includes('09'), J(midPreview))
  await clickReal("document.querySelector('.modal__head')")
  await sleep(600)
  const blurred = await app.evaluate("(() => ({ open: !!document.querySelector('.popmenu--time'), text: document.querySelector('.modal .timepick').textContent.trim() }))()")
  check('失焦后面板自己消失', blurred.open === false, J(blurred))
  check('失焦时把选到的时刻回填了', blurred.text.includes('09'), J(blurred))

  // 什么都没选就失焦：原值不动（「也有可能没选」）
  await clickReal("document.querySelector('.modal .timepick')")
  await sleep(500)
  await clickReal("document.querySelector('.modal__head')")
  await sleep(500)
  const untouched = await app.evaluate("document.querySelector('.modal .timepick').textContent.trim()")
  check('什么都没选就关掉，原值不变', untouched === blurred.text, J({ before: blurred.text, after: untouched }))

  // ---- 表单栅格：状态 / 优先级 / 循环 同一行，开始 / 截止 下一行
  const grid = await app.evaluate(
    "(() => {" +
      "const m = document.querySelector('.modal[role=\"dialog\"]');" +
      "const tops = (sel) => [...m.querySelectorAll(sel)].map((el) => Math.round(el.getBoundingClientRect().top));" +
      "return { thirds: tops('.form-row--third'), halves: tops('.form-row--half') };" +
    "})()"
  )
  check('状态 / 优先级 / 循环 在同一行', grid.thirds.length === 3 && new Set(grid.thirds).size === 1, J(grid))
  check(
    '开始 / 截止 在下一行且两者同行',
    grid.halves.length === 2 && new Set(grid.halves).size === 1 && grid.halves[0] > grid.thirds[0],
    J(grid)
  )

  // 再点开一次截个图（给用户看项高）
  await clickReal("document.querySelector('.modal .timepick')")
  await sleep(700)
  const tpShot = await app.send('Page.captureScreenshot', { format: 'png' })
  const fs3 = await import('node:fs')
  fs3.writeFileSync(join(root, '.screenshots', 'timepicker-custom.png'), Buffer.from(tpShot.result.data, 'base64'))
  console.log('（截图 .screenshots/timepicker-custom.png）')

  // 日期 / 时间原生输入的内在高度比 --control-h 高，只给 min-height 压不住 ——
  // 这一条盯着它们与同行的其它控件严格等高
  const heights = await app.evaluate(
    "(() => {" +
      "const m = document.querySelector('.modal[role=\"dialog\"]');" +
      "const probe = document.createElement('div');" +
      "probe.style.height = 'var(--control-h)';" +
      "document.body.appendChild(probe);" +
      "const want = Math.round(probe.getBoundingClientRect().height);" +
      "probe.remove();" +
      "const h = (sel) => [...m.querySelectorAll(sel)].map((el) => Math.round(el.getBoundingClientRect().height));" +
      "return { want, times: h('.timepick'), dates: h('.datepick'), text: h('input:not([type])') };" +
    "})()"
  )
  check('自绘日期选择器的高度 = 控件高度', heights.dates.length >= 2 && heights.dates.every((x) => x === heights.want), J(heights))
  check('自绘时刻选择器的高度 = 控件高度', heights.times.length >= 2 && heights.times.every((x) => x === heights.want), J(heights))

  // 弹窗里所有控件的实测高度：只比 date/time 是看不出「与整体不一致」的
  const all = await app.evaluate(
    "(() => {" +
      "const m = document.querySelector('.modal[role=\"dialog\"]');" +
      "const probe = document.createElement('div');" +
      "probe.style.height = 'var(--control-h)';" +
      "document.body.appendChild(probe);" +
      "const want = Math.round(probe.getBoundingClientRect().height);" +
      "probe.remove();" +
      "const rows = [...m.querySelectorAll('input, select, textarea, button')].map((el) => ({" +
      "  kind: el.tagName.toLowerCase() + (el.getAttribute('type') ? '[' + el.getAttribute('type') + ']' : '')," +
      "  cls: el.className.slice(0, 24)," +
      "  h: Math.round(el.getBoundingClientRect().height)," +
      "  fs: getComputedStyle(el).fontSize" +
      "}));" +
      "return { want, rows };" +
    "})()"
  )
  console.log('[控件高度] want=' + all.want)
  for (const r of all.rows) console.log('   ' + r.h + '	' + r.fs + '	' + r.kind + '  .' + r.cls)
  const box = await app.evaluate("(() => { const m = document.querySelector('.modal[role=\"dialog\"]'); const r = m.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()")
  const shot = await app.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 2 } })
  const fs2 = await import('node:fs')
  fs2.writeFileSync(join(root, '.screenshots', 'task-editor-heights.png'), Buffer.from(shot.result.data, 'base64'))
  console.log('（截图 .screenshots/task-editor-heights.png）')
} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}
await sleep(300)
await app.close()
process.exit(finish())