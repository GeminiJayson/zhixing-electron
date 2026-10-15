/**
 * 甘特图侧栏（任务页 · 列表视图右侧）的端到端验收：
 *   1. 开关：工具栏按钮出现 / 收起，且只在列表视图存在；
 *   2. 行与列表逐行对应 —— 两个视图共用同一份展平结果，不该有谁多一行；
 *   3. 条的形状：区间 / 只有截止 / 只有开始 / 无日期 / 视窗外；
 *   4. 视窗：日 = 两周、周 = 一季度、月 = 一年；翻页与「今天」；
 *   5. 宽度：拖左边缘改宽并落 localStorage；← → 微调**不得**误触列表的折叠快捷键。
 */
import { join } from 'node:path'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

// fixture: false —— 脚本自己造任务，别让启动时的夹具注入去抢渲染线程
// （cdp.mjs 的注释里写着这条：抢了之后紧接着的 evaluate 会超时）
const app = await launchApp({
  port: 9411,
  home: join(ROOT, '.screenshots', 'gantt-home'),
  fixture: false,
})
const { check, finish } = createChecker()

const pad2 = (n) => String(n).padStart(2, '0')
const fmt = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
const dayStr = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return fmt(d)
}
const addDaysStr = (day, n) => {
  const d = new Date(day + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return fmt(d)
}
/** 该日所在周的周一（与日历默认的周起始同一套） */
const mondayOf = (day) => addDaysStr(day, -((new Date(day + 'T00:00:00').getDay() + 6) % 7))
const monthStart = (day) => day.slice(0, 8) + '01'

const TODAY = dayStr(0)
const TITLES = {
  range: '甘特验收·区间',
  due: '甘特验收·只截止',
  start: '甘特验收·只开始',
  none: '甘特验收·无日期',
  far: '甘特验收·远在视窗外',
  parent: '甘特验收·父任务',
  child: '甘特验收·子任务',
}

/** 甘特图整体状态：行数、每行有没有条、刻度、视窗、当前粒度、今天线 */
const SNAP = `(() => {
  const g = document.querySelector('.gantt')
  if (!g) return null
  const ticks = [...g.querySelectorAll('.gantt__tick')]
  const rows = [...g.querySelectorAll('.gantt__row')]
  const css = getComputedStyle(g)
  return {
    width: Math.round(g.getBoundingClientRect().width),
    rows: rows.length,
    titles: rows.map((r) => r.querySelector('.gantt__title').textContent.trim()),
    bars: rows.map((r) => {
      const b = r.querySelector('.gantt__bar')
      return b ? b.className.replace(/^gantt__bar\s*/, '') : null
    }),
    cols: ticks.length,
    firstTick: ticks.length ? ticks[0].title : null,
    lastTick: ticks.length ? ticks[ticks.length - 1].title : null,
    pressed: [...g.querySelectorAll('.seg button')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.textContent.trim()),
    range: (g.querySelector('.gantt__range') || {}).textContent || '',
    now: !!g.querySelector('.gantt__now'),
    radius: css.borderRadius,
    bg: css.backgroundColor,
    listsBg: getComputedStyle(document.querySelector('.tasklists')).backgroundColor,
  }
})()`

const pickScale = (label) => `(() => {
  const b = [...document.querySelectorAll('.gantt .seg button')].find((x) => (x.textContent || '').trim() === '${label}')
  if (!b) return 'no-button'
  b.click()
  return 'ok'
})()`

const clickLabel = (label) => `(() => {
  const b = document.querySelector('.gantt [aria-label="${label}"]')
  if (!b) return 'no-button'
  b.click()
  return 'ok'
})()`

try {
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    if (i % 3 === 2) console.log('  ' + Math.round((i + 1) * 0.5) + 's')
  }
  /**
   * 先把界面偏好清干净再重载：localStorage 落在 <home>/profile 里，一旦上一轮跑完
   * 留下过 tasks.ganttWidth / tasks.ganttScale，这一轮的"默认值"就不是默认值了
   * （实测：第二次跑读到 425px，断言全对不上）。清完 reload，React 会重新读一遍默认值。
   */
  await app.evaluate('localStorage.clear()')
  await app.evaluate("document.querySelector('[data-nav-item=\"tasks\"]')?.click()")
  await sleep(1800)

  // ---------------------------------------------------------------- 1. 造数据
  const made = await app.evaluate(`(async () => {
    const db = window.zhixing.db
    const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE') }
    const mk = async (title, start, due, priority, parentId) => {
      const t = await db.createTask(title, parentId ?? null, null)
      if (!t) return null
      await db.updateTask(t.id, { start_date: start, due_date: due, priority: priority })
      return t.id
    }
    const parent = await mk('甘特验收·父任务', day(-1), day(4), 6)
    const child = await mk('甘特验收·子任务', day(0), day(2), 2, parent)
    return {
      parent,
      child,
      range: await mk('甘特验收·区间', day(-2), day(3), 5),
      due: await mk('甘特验收·只截止', null, day(6), 3),
      start: await mk('甘特验收·只开始', day(-1), null, 1),
      none: await mk('甘特验收·无日期', null, null, 0),
      far: await mk('甘特验收·远在视窗外', day(400), day(405), 2),
    }
  })()`)
  check(
    '造出六种排期的任务（区间 / 只截止 / 只开始 / 无日期 / 父子 / 视窗外）',
    !!made && made.range > 0 && made.child > 0 && made.far > 0,
    J(made)
  )
  await sleep(1500)

  // ---------------------------------------------------------------- 2. 打开侧栏
  const beforeOpen = await app.evaluate("!!document.querySelector('.gantt')")
  const opened = await app.evaluate(`(() => {
    const b = [...document.querySelectorAll('.tb .text-btn')].find((x) => (x.textContent || '').trim() === '甘特图')
    if (!b) return 'no-button'
    b.click()
    return 'ok'
  })()`)
  await sleep(1200)
  const snap = await app.evaluate(SNAP)
  check(
    '工具栏「甘特图」按钮能在右侧展开侧栏（默认 360px、默认周档）',
    opened === 'ok' && !beforeOpen && !!snap && snap.width === 360 && snap.pressed.join() === '周',
    J({ beforeOpen, opened, width: snap && snap.width, pressed: snap && snap.pressed })
  )
  check(
    '侧栏与清单栏同一层玻璃（圆角 12px + 同一个 --bg-layer 底色）',
    snap.radius === '12px' && snap.bg === snap.listsBg,
    J({ radius: snap.radius, bg: snap.bg, listsBg: snap.listsBg })
  )
  check('默认视窗里画出了「今天」竖线', snap.now === true, J(snap.now))

  // ---------------------------------------------------------------- 3. 行与列表对应
  const listRows = await app.evaluate(
    "(() => [...document.querySelectorAll('.trow .trow__title-text')].map((t) => t.textContent.trim()))()"
  )
  const sameRows =
    Array.isArray(listRows) &&
    snap.titles.length === listRows.length &&
    snap.titles.every((t, i) => t === listRows[i])
  check(
    '甘特图的行与列表逐行对应（同一份展平结果，含折叠与过滤）',
    sameRows,
    J({ gantt: snap.titles, list: listRows })
  )

  // ---------------------------------------------------------------- 4. 条的形状
  const barOf = (title) => snap.bars[snap.titles.indexOf(title)] || ''
  check('区间任务画成实心区间条', barOf(TITLES.range).includes('gantt__bar--range'), J(barOf(TITLES.range)))
  check('只有截止日 → 单端标记（due）', barOf(TITLES.due).includes('gantt__bar--due'), J(barOf(TITLES.due)))
  check(
    '只有开始日 → 单端标记（start）',
    barOf(TITLES.start).includes('gantt__bar--start'),
    J(barOf(TITLES.start))
  )
  check('两个日期都没有 → 不画条', barOf(TITLES.none) === '', J(barOf(TITLES.none)))
  check(
    '整条落在视窗外 → 不画（也不伪造一条顶到边界的长条）',
    barOf(TITLES.far) === '',
    J(barOf(TITLES.far))
  )

  const indents = await app.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.gantt__row')]
    const find = (t) => rows.find((r) => r.querySelector('.gantt__title').textContent.trim() === t)
    const a = find('${TITLES.parent}')
    const b = find('${TITLES.child}')
    if (!a || !b) return null
    return {
      parent: parseFloat(getComputedStyle(a.querySelector('.gantt__label')).paddingLeft),
      child: parseFloat(getComputedStyle(b.querySelector('.gantt__label')).paddingLeft),
    }
  })()`)
  check('子任务按同一份 depth 缩进', !!indents && indents.child > indents.parent, J(indents))

  // ---------------------------------------------------------------- 5. 视窗：周 / 日 / 月
  const weekly = await app.evaluate(SNAP)
  check(
    '默认周档：视窗从本周一起、共 12 列（一季度）',
    weekly.cols === 12 &&
      weekly.pressed.join() === '周' &&
      weekly.firstTick === mondayOf(TODAY) + ' ~ ' + addDaysStr(mondayOf(TODAY), 6),
    J({ cols: weekly.cols, pressed: weekly.pressed, first: weekly.firstTick, monday: mondayOf(TODAY) })
  )

  const dayClicked = await app.evaluate(pickScale('日'))
  await sleep(900)
  const daily = await app.evaluate(SNAP)
  check(
    '切到日档：14 列、每列一天（从今天起两周）',
    dayClicked === 'ok' &&
      daily.cols === 14 &&
      daily.pressed.join() === '日' &&
      daily.firstTick === TODAY &&
      daily.lastTick === dayStr(13),
    J({ dayClicked, cols: daily.cols, pressed: daily.pressed, first: daily.firstTick, last: daily.lastTick })
  )

  // 几何实测：条的左右端要真的落在日期的位置上（不是"有 class 就算过"）
  const geo = await app.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.gantt__row')]
    const measure = (t) => {
      const row = rows.find((r) => r.querySelector('.gantt__title').textContent.trim() === t)
      if (!row) return null
      const lane = row.querySelector('.gantt__lane').getBoundingClientRect()
      const bar = row.querySelector('.gantt__bar')
      if (!bar) return null
      const b = bar.getBoundingClientRect()
      return {
        left: Math.round(((b.left - lane.left) / lane.width) * 1000) / 10,
        width: Math.round((b.width / lane.width) * 1000) / 10,
        clip: bar.className.includes('clip-start') ? 'start' : bar.className.includes('clip-end') ? 'end' : '',
      }
    }
    return { range: measure('${TITLES.range}'), due: measure('${TITLES.due}'), start: measure('${TITLES.start}') }
  })()`)
  // 日档 14 列：区间 = 今天-2 ~ 今天+3 → 左端被裁到 0、右端在 4/14；只截止（今天+6）= 6/14 起一格
  const near = (a, b) => Math.abs(a - b) < 0.6
  check(
    '日档下条的左右端与日期一致（实测像素换算：区间 0→28.6%、只截止 42.9% 起一格）',
    !!geo &&
      !!geo.range &&
      near(geo.range.left, 0) &&
      near(geo.range.width, (4 / 14) * 100) &&
      geo.range.clip === 'start' &&
      near(geo.due.left, (6 / 14) * 100) &&
      near(geo.due.width, (1 / 14) * 100),
    J(geo)
  )

  const axis = await app.evaluate(`(() => {
    const ticks = document.querySelector('.gantt__ticks')
    const lane = document.querySelector('.gantt__lane')
    if (!ticks || !lane) return null
    const a = ticks.getBoundingClientRect()
    const b = lane.getBoundingClientRect()
    return {
      ticksLeft: Math.round(a.left),
      ticksWidth: Math.round(a.width),
      laneLeft: Math.round(b.left),
      laneWidth: Math.round(b.width),
    }
  })()`)
  check(
    '表头的时间轴与行内的轨道是同一条（刻度、网格线与条不会错位）',
    !!axis && Math.abs(axis.ticksLeft - axis.laneLeft) <= 1 && Math.abs(axis.ticksWidth - axis.laneWidth) <= 1,
    J(axis)
  )

  const monthClicked = await app.evaluate(pickScale('月'))
  await sleep(900)
  const monthly = await app.evaluate(SNAP)
  check(
    '切到月档：12 列、从本月 1 号起（一年）',
    monthClicked === 'ok' &&
      monthly.cols === 12 &&
      monthly.pressed.join() === '月' &&
      String(monthly.firstTick).startsWith(monthStart(TODAY)),
    J({ monthClicked, cols: monthly.cols, pressed: monthly.pressed, first: monthly.firstTick })
  )

  const labels = await app.evaluate(
    "(() => ({ shown: document.querySelectorAll('.gantt__tick b').length, cols: document.querySelectorAll('.gantt__tick').length, longest: Math.max(...[...document.querySelectorAll('.gantt__tick b')].map((b) => b.textContent.length)) }))()"
  )
  check(
    '窄栏里月档隔列显示标签（12 列只标 4 处），跨年那格仍写全「27年1月」',
    labels.cols === 12 && labels.shown === 4 && labels.longest >= 3,
    J(labels)
  )

  const nextClicked = await app.evaluate(clickLabel('下一段'))
  await sleep(900)
  const shifted = await app.evaluate(SNAP)
  const expectNext = addDaysStr(String(monthly.lastTick).split(' ~ ')[1], 1)
  check(
    '「下一段」把整窗往后挪一段（从上一段的次日接上，不重叠也不跳空）',
    nextClicked === 'ok' && String(shifted.firstTick).startsWith(expectNext),
    J({ nextClicked, from: monthly.firstTick, to: shifted.firstTick, expectNext })
  )

  const todayClicked = await app.evaluate(`(() => {
    const b = [...document.querySelectorAll('.gantt .text-btn')].find((x) => (x.textContent || '').trim() === '今天')
    if (!b) return 'no-button'
    b.click()
    return 'ok'
  })()`)
  await sleep(900)
  const home = await app.evaluate(SNAP)
  check(
    '「今天」把视窗拉回今天所在的一段，今天线也回来',
    todayClicked === 'ok' &&
      home.now === true &&
      String(home.firstTick).startsWith(monthStart(TODAY)),
    J({ todayClicked, first: home.firstTick, now: home.now })
  )

  // ---------------------------------------------------------------- 6. 宽度：拖动
  const dragResult = await app.evaluate(`(() => {
    const box = document.querySelector('.gantt')
    const el = document.querySelector('.gantt__resizer')
    if (!box || !el) return null
    const before = Math.round(box.getBoundingClientRect().width)
    const r = el.getBoundingClientRect()
    const y = r.top + 20
    const x = r.left + r.width / 2
    const fire = (type, cx) =>
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: cx, clientY: y, pointerId: 1, isPrimary: true,
        buttons: type === 'pointerup' ? 0 : 1
      }))
    fire('pointerdown', x)
    fire('pointermove', x - 60)
    fire('pointerup', x - 60)
    return { before, after: Math.round(box.getBoundingClientRect().width) }
  })()`)
  await sleep(700)
  const afterDrag = await app.evaluate("Math.round(document.querySelector('.gantt').getBoundingClientRect().width)")
  const storedWidth = await app.evaluate("localStorage.getItem('tasks.ganttWidth')")
  check(
    '拖动左边缘把侧栏拖宽（指针左移 60px → 宽度 +60px）',
    !!dragResult && afterDrag - dragResult.before === 60,
    J({ dragResult, afterDrag })
  )
  check('松手才落盘：宽度写进 tasks.ganttWidth', Number(storedWidth) === afterDrag, J(storedWidth))

  const resizerSpec = await app.evaluate(`(() => {
    const el = document.querySelector('.gantt__resizer')
    const work = document.querySelector('.tasks-work')
    if (!el || !work) return null
    return {
      role: el.getAttribute('role'),
      orientation: el.getAttribute('aria-orientation'),
      tabIndex: el.tabIndex,
      hit: Math.round(el.getBoundingClientRect().width),
      // 命中区要正好铺满面板之间的那道间隙，否则会有一条"拖不动"的缝
      gap: Math.round(parseFloat(getComputedStyle(work).columnGap)),
    }
  })()`)
  check(
    '分隔条与另两处侧栏同一套规格（role=separator / 竖向 / 可聚焦 / 命中区铺满面板间隙）',
    resizerSpec.role === 'separator' &&
      resizerSpec.orientation === 'vertical' &&
      resizerSpec.tabIndex === 0 &&
      resizerSpec.hit === resizerSpec.gap,
    J(resizerSpec)
  )

  // ---------------------------------------------------------------- 7. ← → 微调不得误触折叠
  const keyBefore = await app.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.trow')]
    const parent = rows.find((r) => (r.querySelector('.trow__title-text') || {}).textContent === '${TITLES.parent}')
    if (!parent) return null
    parent.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    const caret = parent.querySelector('.trow__caret')
    return {
      expanded: caret ? caret.getAttribute('aria-expanded') : null,
      width: Math.round(document.querySelector('.gantt').getBoundingClientRect().width),
    }
  })()`)
  await sleep(400)
  const keyFired = await app.evaluate(`(() => {
    const el = document.querySelector('.gantt__resizer')
    el.focus()
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    return document.activeElement === el
  })()`)
  await sleep(700)
  const keyAfter = await app.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.trow')]
    const parent = rows.find((r) => (r.querySelector('.trow__title-text') || {}).textContent === '${TITLES.parent}')
    const caret = parent && parent.querySelector('.trow__caret')
    return {
      expanded: caret ? caret.getAttribute('aria-expanded') : null,
      childRows: rows.filter((r) => (r.querySelector('.trow__title-text') || {}).textContent === '${TITLES.child}').length,
      width: Math.round(document.querySelector('.gantt').getBoundingClientRect().width),
    }
  })()`)
  check(
    '← 微调宽度 +16px，且没有顺手改掉列表的折叠状态',
    !!keyBefore &&
      keyFired === true &&
      keyAfter.width === keyBefore.width + 16 &&
      keyAfter.expanded === keyBefore.expanded &&
      keyAfter.childRows === 1,
    J({ keyBefore, keyFired, keyAfter })
  )

  // ---------------------------------------------------------------- 8. 只在列表视图
  const toBoard = await app.evaluate(
    "(() => { const b = [...document.querySelectorAll('.seg button')].find((x) => (x.textContent || '').trim() === '看板'); if (!b) return false; b.click(); return true })()"
  )
  await sleep(900)
  const boardState = await app.evaluate(`(() => ({
    gantt: !!document.querySelector('.gantt'),
    button: [...document.querySelectorAll('.tb .text-btn')].some((x) => (x.textContent || '').trim() === '甘特图'),
  }))()`)
  check(
    '切到看板：侧栏与开关一起消失（甘特图只在列表视图）',
    toBoard === true && !boardState.gantt && !boardState.button,
    J({ toBoard, boardState })
  )

  const backList = await app.evaluate(
    "(() => { const b = [...document.querySelectorAll('.seg button')].find((x) => (x.textContent || '').trim() === '列表'); if (!b) return false; b.click(); return true })()"
  )
  await sleep(900)
  const listState = await app.evaluate(
    "(() => ({ gantt: !!document.querySelector('.gantt'), width: document.querySelector('.gantt') ? Math.round(document.querySelector('.gantt').getBoundingClientRect().width) : 0 }))()"
  )
  check(
    '切回列表：侧栏按开关状态自动回来（宽度仍是拖过的那一档）',
    backList === true && listState.gantt && listState.width === keyAfter.width,
    J({ backList, listState, expected: keyAfter.width })
  )

  // ---------------------------------------------------------------- 9. 两根分隔条的上限与名称列
  const labelDrag = await app.evaluate(`(() => {
    const el = document.querySelector('.gantt__labelbar')
    if (!el) return null
    const box = document.querySelector('.gantt').getBoundingClientRect()
    const before = parseFloat(getComputedStyle(document.querySelector('.gantt')).getPropertyValue('--gantt-label'))
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const fire = (type, cx) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: cx, clientY: y, pointerId: 3, isPrimary: true,
      buttons: type === 'pointerup' ? 0 : 1
    }))
    fire('pointerdown', x)
    fire('pointermove', x + 40)
    fire('pointerup', x + 40)
    return {
      before,
      barW: Math.round(box.width),
      role: el.getAttribute('role'),
      tabIndex: el.tabIndex,
      hit: Math.round(r.width),
      vmin: Number(el.getAttribute('aria-valuemin')),
      vmax: Number(el.getAttribute('aria-valuemax')),
    }
  })()`)
  await sleep(700)
  const labelAfter = await app.evaluate(`(() => {
    const g = document.querySelector('.gantt')
    const ticks = document.querySelector('.gantt__ticks').getBoundingClientRect()
    const lane = document.querySelector('.gantt__lane').getBoundingClientRect()
    return {
      now: parseFloat(getComputedStyle(g).getPropertyValue('--gantt-label')),
      stored: localStorage.getItem('tasks.ganttLabel'),
      aligned: Math.abs(ticks.left - lane.left) <= 1 && Math.abs(ticks.width - lane.width) <= 1,
    }
  })()`)
  check(
    '名称列可拖：往右 40px → 标题列宽 +40px 并落盘 tasks.ganttLabel，表头与行内仍同轨',
    !!labelDrag &&
      Math.abs(labelAfter.now - (labelDrag.before + 40)) <= 1 &&
      Number(labelAfter.stored) === Math.round(labelAfter.now) &&
      labelAfter.aligned,
    J({ labelDrag, labelAfter })
  )
  check(
    '名称列分隔条与另两根同一套规格（separator / 可聚焦 / 14px 命中区 / 上限 = 侧栏宽的 60%）',
    !!labelDrag &&
      labelDrag.role === 'separator' &&
      labelDrag.tabIndex === 0 &&
      labelDrag.hit === 14 &&
      labelDrag.vmin === 72 &&
      Math.abs(labelDrag.vmax - Math.round(labelDrag.barW * 0.6)) <= 2,
    J(labelDrag)
  )

  const labelKey = await app.evaluate(`(() => {
    const el = document.querySelector('.gantt__labelbar')
    const w0 = parseFloat(getComputedStyle(document.querySelector('.gantt')).getPropertyValue('--gantt-label'))
    el.focus()
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    return { w0, focused: document.activeElement === el }
  })()`)
  await sleep(500)
  const labelKeyAfter = await app.evaluate(
    "parseFloat(getComputedStyle(document.querySelector('.gantt')).getPropertyValue('--gantt-label'))"
  )
  check(
    '名称列 ← → 各 16px（与面板那根同一套手感）',
    labelKey.focused && Math.abs(labelKeyAfter - (labelKey.w0 + 16)) <= 1,
    J({ labelKey, labelKeyAfter })
  )

  // 侧栏宽度上限 = 任务面板的 85%：一路拖到远超上限，看它停在哪儿
  const capInfo = await app.evaluate(`(() => {
    const el = document.querySelector('.gantt__resizer')
    const work = document.querySelector('.tasks-work')
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + 20
    const fire = (type, cx) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: cx, clientY: y, pointerId: 4, isPrimary: true,
      buttons: type === 'pointerup' ? 0 : 1
    }))
    fire('pointerdown', x)
    fire('pointermove', x - 4000)
    fire('pointerup', x - 4000)
    return { panel: Math.round(work.getBoundingClientRect().width), vmax: Number(el.getAttribute('aria-valuemax')) }
  })()`)
  await sleep(700)
  const capState = await app.evaluate(`(() => {
    const work = document.querySelector('.tasks-work')
    return {
      width: Math.round(document.querySelector('.gantt').getBoundingClientRect().width),
      main: Math.round(document.querySelector('.tasks-main').getBoundingClientRect().width),
      overflow: work.scrollWidth - work.clientWidth,
      stored: localStorage.getItem('tasks.ganttWidth'),
    }
  })()`)
  const expectCap = Math.round(capInfo.panel * 0.85)
  check(
    '侧栏宽度上限 = 任务面板的 85%（拖到底也不会把工作区撑出横向溢出）',
    Math.abs(capState.width - expectCap) <= 1 &&
      capInfo.vmax === expectCap &&
      capState.overflow <= 1 &&
      Number(capState.stored) === capState.width,
    J({ capInfo, capState, expectCap })
  )

  // ---------------------------------------------------------------- 10. 关闭
  const closed = await app.evaluate(clickLabel('关闭甘特图'))
  await sleep(800)
  const closedState = await app.evaluate(
    "(() => ({ gantt: !!document.querySelector('.gantt'), flag: localStorage.getItem('zhixing.gantt.tasks'), scale: localStorage.getItem('tasks.ganttScale') }))()"
  )
  check(
    '关闭按钮收起侧栏，并把开关与粒度写进 localStorage',
    closed === 'ok' && !closedState.gantt && closedState.flag === '0' && closedState.scale === 'month',
    J({ closed, closedState })
  )

  const afterClose = await app.evaluate(
    "(() => [...document.querySelectorAll('.trow .trow__title-text')].length)()"
  )
  check(
    '收起侧栏不影响列表（行数不变）',
    typeof afterClose === 'number' && afterClose === listRows.length,
    J({ afterClose, list: listRows.length })
  )
} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}
await app.close()
process.exit(finish())
