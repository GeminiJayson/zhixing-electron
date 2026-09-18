/**
 * 交互回归检查：用户实测报过的两条路径。
 *
 *   1. 任务页「新建任务」必须真的出现添加行，且能输入（此前添加行没计入虚拟列表行数，
 *      点下去什么都不发生）；
 *   2. 弹框（dialog.prompt）的输入框必须能输入（此前只有 value 没有 onChange，
 *      是只读受控输入，敲键盘无效）。
 *
 * 用法：node scripts/interactioncheck.mjs
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
const repoRoot = join(root, '..')
const backup = join(repoRoot, 'backups', 'electron-migration', 'zhixing-before-electron-write.db')
const tmpHome = join(root, '.screenshots', 'interaction-home')
const PORT = 9244
if (!existsSync(backup)) { console.error('✗ 缺备份库'); process.exit(1) }
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(backup, join(tmpHome, 'zhixing.db'))
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpHome, 'p')}`], {
  cwd: root, env: { ...process.env, ZHIXING_HOME: tmpHome }, stdio: ['ignore', 'pipe', 'pipe'],
})
let page = null
for (let i = 0; i < 40 && !page; i++) {
  await sleep(500)
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); page = l.find((t) => t.type === 'page' && !t.url.includes('widget=1')) } catch {}
}
if (!page) { console.error('✗ 无法连接主窗口'); child.kill(); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const send = (m, p = {}) => new Promise((resolve) => {
  const id = Math.floor(Math.random() * 1e6)
  const h = (ev) => { const x = JSON.parse(ev.data); if (x.id !== id) return; ws.removeEventListener('message', h); resolve(x) }
  ws.addEventListener('message', h); ws.send(JSON.stringify({ id, method: m, params: p })) })
await send('Runtime.enable')
// 临时：把渲染进程的运行时异常打出来（页面白屏/元素不渲染时，这是唯一能看到原因的地方）
ws.addEventListener('message', (raw) => {
  let m
  try {
    m = JSON.parse(raw.data)
  } catch {
    return
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails?.exception?.description ?? JSON.stringify(m.params).slice(0, 200)
    console.log('EXC', String(d).split('\n').slice(0, 4).join(' | '))
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
    console.log('CONSOLE-ERR', String(text).split('\n').slice(0, 3).join(' | ').slice(0, 220))
  }
})
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'fail')
  return r.result?.result?.value }
/** 走真实输入通道：聚焦后用 Input.insertText，能在 onChange 缺失时暴露出来。 */
const typeInto = async (selector, text) => {
  await ev(`document.querySelector(${JSON.stringify(selector)})?.focus()`)
  await send('Input.insertText', { text })
  await sleep(250)
  return ev(`document.querySelector(${JSON.stringify(selector)})?.value`)
}
await sleep(2600)
const results = []
const check = (n, ok, d = '') => { results.push([n, ok]); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`) }
/**
 * 轮询等待条件成立。图谱要等 IPC 取数 + 力导向布局跑出坐标，
 * 固定 sleep 在负载高时必然偶发失败 —— 这类检查必须轮询。
 */
const waitFor = async (expr, timeoutMs = 9000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await ev(expr)) return true
    await sleep(250)
  }
  return false
}
const clickByText = (text) =>
  ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().includes(${JSON.stringify(text)})); if (!b) return false; b.click(); return true })()`)

// 切到任务页
await ev(`document.querySelector('[data-nav-item="tasks"]')?.click()`)
await sleep(900)

// 1) 新建任务：点完必须出现添加行，且能输入
const clicked = await clickByText('新建任务')
check('任务页存在「新建任务」按钮并可点击', clicked === true)
await sleep(500)
const rowShown = await ev(`document.querySelector('.trow--adding input') !== null`)
check('点击后出现添加行', rowShown === true)
if (rowShown) {
  const typed = await typeInto('.trow--adding input', '回归检查任务')
  check('添加行输入框能输入', typed === '回归检查任务', `value=${JSON.stringify(typed)}`)
  await ev(`document.querySelector('.trow--adding input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(300)
}

// 2) 弹框输入：新建清单走 dialog.prompt，输入框必须能输入
const opened = await clickByText('新建清单')
check('能唤起 dialog.prompt', opened === true)
await sleep(500)
const promptShown = await ev(`document.querySelector('.modal--dialog input.field') !== null`)
check('弹框输入框已渲染', promptShown === true)
if (promptShown) {
  const typed = await typeInto('.modal--dialog input.field', '回归检查清单')
  check('弹框输入框能输入', typed === '回归检查清单', `value=${JSON.stringify(typed)}`)
  // 必须关掉：遮罩是全屏的，留着它后面所有 hover 都会落在遮罩上（排查了半天就是这个）
  await ev(`(() => {
    const b = [...document.querySelectorAll('.modal--dialog button')].find((x) => (x.textContent || '').trim() === '取消')
    if (!b) return false
    b.click()
    return true
  })()`)
  await sleep(400)
  const closed = await ev(`document.querySelector('.modal-mask') === null`)
  check('弹框已关闭（不残留遮罩）', closed === true)
}

// 3) 笔记树工具栏不能溢出卡片（240px 宽，格式选择器曾是 200px 固定宽）
await ev(`document.querySelector('[data-nav-item="notes"]')?.click()`)
await sleep(900)
const overflow = await ev(
  `(() => { const el = document.querySelector('.ntree__tools'); return el ? el.scrollWidth - el.clientWidth : null })()`
)
check('笔记树工具栏不溢出卡片', overflow !== null && overflow <= 1, `溢出 ${overflow}px`)

// 4) 每个页面的标题行都要有副标题
const navKeys = ['today', 'tasks', 'inbox', 'notes', 'workflow', 'graph', 'review', 'settings']
const missing = []
for (const key of navKeys) {
  await ev(`document.querySelector('[data-nav-item="${key}"]')?.click()`)
  await sleep(400)
  const ok = await ev(
    `(() => { const h = document.querySelector('.page__head'); const s = document.querySelector('.page__subtitle'); return Boolean(h && s && s.textContent.trim()) })()`
  )
  if (!ok) missing.push(key)
}
check('每个页面标题行都有副标题', missing.length === 0, missing.length ? `缺 ${missing.join(', ')}` : `${navKeys.length}/${navKeys.length}`)

/** 画布交互：滚轮缩放、拖背景平移、重置视图。两个画布同一套实现，分开各验一遍。 */
const wheelZoom = (selector) =>
  ev(`(() => {
    const el = document.querySelector('${selector}')
    if (!el) return false
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }))
    return true
  })()`)
const dragPan = (selector) =>
  ev(`(() => {
    const el = document.querySelector('${selector}')
    if (!el) return false
    const r = el.getBoundingClientRect()
    const o = { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1, isPrimary: true }
    el.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: r.left + 30, clientY: r.top + 30 }))
    el.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: r.left + 130, clientY: r.top + 110 }))
    el.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: r.left + 130, clientY: r.top + 110 }))
    return true
  })()`)
const clickReset = () =>
  ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('重置视图')); if (!b) return false; b.click(); return true })()`)

for (const [nav, selector, label] of [
  ['graph', 'svg.graph', '图谱'],
  ['workflow', 'svg.wf-canvas', '工作流'],
]) {
  await ev(`document.querySelector('[data-nav-item="${nav}"]')?.click()`)
  await sleep(1000)
  const base = await ev(`document.querySelector('${selector}')?.getAttribute('viewBox')`)
  check(`${label}画布已渲染`, typeof base === 'string' && base.length > 0, base)

  await wheelZoom(selector)
  await sleep(300)
  const zoomed = await ev(`document.querySelector('${selector}')?.getAttribute('viewBox')`)
  check(`${label}滚轮缩放改变 viewBox`, zoomed !== base, `${base} → ${zoomed}`)

  await dragPan(selector)
  await sleep(300)
  const panned = await ev(`document.querySelector('${selector}')?.getAttribute('viewBox')`)
  check(`${label}拖背景平移 viewBox`, panned !== zoomed, `${zoomed} → ${panned}`)

  await clickReset()
  await sleep(300)
  const reset = await ev(`document.querySelector('${selector}')?.getAttribute('viewBox')`)
  check(`${label}重置视图回到初始`, reset === base, reset)
}

// 5) 图谱连线编辑：悬停亮出手柄与删除按钮，点删除后连线消失
await ev(`document.querySelector('[data-nav-item="graph"]')?.click()`)
await waitFor(`document.querySelectorAll('svg.graph .graph__edge').length > 0`)
const graphEdges = () => ev(`document.querySelectorAll('svg.graph .graph__edge').length`)
const edgesBefore = await graphEdges()
check('图谱存在可编辑连线', edgesBefore > 0, `${edgesBefore} 条`)

// 必须用 getScreenCTM：SVG 默认 preserveAspectRatio="xMidYMid meet"，
// viewBox → 屏幕不是按 rect 比例直接映射（之前就是这里算错导致 hover 落空）
const probe = await ev(`(() => {
  const svg = document.querySelector('svg.graph')
  const hit = document.querySelector('svg.graph .graph__edge-hit')
  if (!svg || !hit) return null
  const m = svg.getScreenCTM()
  if (!m) return null
  const pt = svg.createSVGPoint()
  pt.x = (Number(hit.getAttribute('x1')) + Number(hit.getAttribute('x2'))) / 2
  pt.y = (Number(hit.getAttribute('y1')) + Number(hit.getAttribute('y2'))) / 2
  const s = pt.matrixTransform(m)
  return { x: s.x, y: s.y }
})()`)
check('图谱连线存在透明热区', probe !== null)
if (probe) {
  // React 的 onPointerEnter 是由原生 pointerover 合成的，直接派发它就等于走通同一条路径；
  // CDP 的合成鼠标移动在这条链路上不可靠（测过，事件到不了 SVG 元素）
  await ev(`document.querySelector('svg.graph .graph__edge-hit')?.dispatchEvent(
    new PointerEvent('pointerover', { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true })
  )`)
  await sleep(400)
  const handles = await ev(`document.querySelectorAll('svg.graph .edge-handle').length`)
  check('悬停连线后出现两个端点手柄', handles === 2, `${handles} 个`)
  const delCount = await ev(`document.querySelectorAll('svg.graph .edge-del').length`)
  check('悬停连线后出现删除按钮', delCount === 1, `${delCount} 个`)
  if (delCount === 1) {
    await ev(`(() => {
      const el = document.querySelector('svg.graph .edge-del')
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1 }))
      return true
    })()`)
    await sleep(900)
    const edgesAfter = await graphEdges()
    check('点删除后连线减少', edgesAfter < edgesBefore, `${edgesBefore} → ${edgesAfter}`)
  }
}

// 6) 工作流分支连线：同样悬停出工具、点删除后消失
await ev(`document.querySelector('[data-nav-item="workflow"]')?.click()`)
await sleep(1200)
await ev(`document.querySelector('.wf-list button')?.click()`)
await waitFor(`document.querySelectorAll('svg.wf-canvas .wf-node').length > 0`)
const branches = () => ev(`document.querySelectorAll('svg.wf-canvas .wf-edge--branch').length`)
const branchBefore = await branches()
check('工作流存在分支连线', branchBefore > 0, `${branchBefore} 条`)
if (branchBefore > 0) {
  const bprobe = await ev(`(() => {
    const svg = document.querySelector('svg.wf-canvas')
    const hit = [...document.querySelectorAll('svg.wf-canvas .graph__edge-hit')].pop()
    if (!svg || !hit) return null
    const m = svg.getScreenCTM()
    if (!m) return null
    const pt = svg.createSVGPoint()
    pt.x = (Number(hit.getAttribute('x1')) + Number(hit.getAttribute('x2'))) / 2
    pt.y = (Number(hit.getAttribute('y1')) + Number(hit.getAttribute('y2'))) / 2
    const s = pt.matrixTransform(m)
    return { x: s.x, y: s.y }
  })()`)
  if (bprobe) {
    await ev(`[...document.querySelectorAll('svg.wf-canvas .graph__edge-hit')].pop()?.dispatchEvent(
      new PointerEvent('pointerover', { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true })
    )`)
    await sleep(400)
    const bdel = await ev(`document.querySelectorAll('svg.wf-canvas .edge-del').length`)
    check('悬停分支连线后出现删除按钮', bdel === 1, `${bdel} 个`)
    if (bdel === 1) {
      await ev(`(() => {
        const el = document.querySelector('svg.wf-canvas .edge-del')
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1 }))
        return true
      })()`)
      await sleep(1000)
      const branchAfter = await branches()
      check('点删除后分支连线消失', branchAfter < branchBefore, `${branchBefore} → ${branchAfter}`)
    }
  }
}

// 7) 三处布局改动的实测（对应用户截图报的问题）
await ev(`document.querySelector('[data-nav-item="today"]')?.click()`)
await sleep(900)
const subCount = await ev(`document.querySelectorAll('.page__subtitle').length`)
const legacyGreeting = await ev(`document.querySelectorAll('.today-greeting').length`)
check(
  '今日页只有一条副标题（无残留 greeting）',
  subCount === 1 && legacyGreeting === 0,
  `subtitle=${subCount} greeting=${legacyGreeting}`
)

// 笔记页：链接面板应在编辑区下方
await ev(`document.querySelector('[data-nav-item="notes"]')?.click()`)
await waitFor(`document.querySelectorAll('.ntree__note').length > 0`)
// 必须先选一篇笔记 —— 没选中时编辑器与链接面板都不渲染
await ev(`document.querySelector('.ntree__note')?.click()`)
await waitFor(`!!document.querySelector('.editor')`)
// 「链接」是开关，而面板默认就是展开的 —— 无脑点一下反而会把它关掉
await ev(`(() => {
  if (document.querySelector('.links')) return true
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '链接')
  if (b) b.click()
  return true
})()`)
await sleep(700)
const panelPos = await ev(`(() => {
  const ed = document.querySelector('.editor')
  const lk = document.querySelector('.links')
  if (!ed || !lk) return null
  const e = ed.getBoundingClientRect()
  const l = lk.getBoundingClientRect()
  return { edBottom: Math.round(e.bottom), lkTop: Math.round(l.top), lkLeft: Math.round(l.left) }
})()`)
check(
  '链接面板在编辑区下方',
  panelPos !== null && panelPos.lkTop >= panelPos.edBottom - 12,
  panelPos ? `editor.bottom=${panelPos.edBottom} links.top=${panelPos.lkTop}` : '找不到 .editor / .links'
)

// 任务页：工具栏按钮不能被压成多行
await ev(`document.querySelector('[data-nav-item="tasks"]')?.click()`)
await sleep(1000)
const tallest = await ev(`(() => {
  const bs = [...document.querySelectorAll('.tasks-toolbar .text-btn')]
  if (!bs.length) return null
  return Math.max(...bs.map((b) => Math.round(b.getBoundingClientRect().height)))
})()`)
check('任务页工具栏按钮不竖排', tallest !== null && tallest <= 40, `最高 ${tallest}px`)

// 8) Obsidian 风连线：贝塞尔曲线 + 悬浮聚焦（图谱与工作流各验一遍）
const curveInfo = (selector) =>
  ev(`(() => {
    const p = document.querySelector('${selector} .graph__edge, ${selector} .wf-edge')
    if (!p) return null
    const d = p.getAttribute('d') || ''
    return { tag: p.tagName.toLowerCase(), isCurve: d.includes('C'), head: d.slice(0, 36) }
  })()`)

/** 依次悬浮节点直到找到「有相连连线」的那个（前几个可能是孤立点）。 */
const focusInfo = async (svgSel, nodeSel, litSel) => {
  for (let i = 0; i < 10; i++) {
    const dispatched = await ev(`(() => {
      const n = document.querySelectorAll('${nodeSel}')[${i}]
      if (!n) return false
      n.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }))
      return true
    })()`)
    if (!dispatched) return null
    await sleep(260)
    const info = await ev(`(() => ({
      lit: document.querySelectorAll('${litSel}').length,
      dimmed: document.querySelectorAll('${svgSel} .is-dimmed').length,
      opacity: (() => { const el = document.querySelector('${svgSel} .is-dimmed'); return el ? getComputedStyle(el).opacity : null })()
    }))()`)
    if (info.lit > 0) return info
  }
  return null
}

await ev(`document.querySelector('[data-nav-item="graph"]')?.click()`)
await sleep(1500)
const gCurve = await curveInfo('svg.graph')
check('图谱连线是贝塞尔曲线（非直线）', gCurve !== null && gCurve.isCurve, gCurve ? gCurve.head : '找不到连线')
const gFocus = await focusInfo('svg.graph', 'svg.graph .gnode', 'svg.graph .graph__edge--on')
check('图谱：悬浮节点后相连连线高亮', gFocus !== null && gFocus.lit > 0, gFocus ? `lit=${gFocus.lit}` : '没找到有连线的节点')
check(
  '图谱：无关元素淡到 0.05',
  gFocus !== null && gFocus.dimmed > 0 && gFocus.opacity === '0.05',
  gFocus ? `dimmed=${gFocus.dimmed} opacity=${gFocus.opacity}` : '—'
)

await ev(`document.querySelector('[data-nav-item="workflow"]')?.click()`)
await sleep(1200)
await ev(`document.querySelector('.wf-list button')?.click()`)
await sleep(900)
const wCurve = await curveInfo('svg.wf-canvas')
check('工作流连线是贝塞尔曲线（非直线）', wCurve !== null && wCurve.isCurve, wCurve ? wCurve.head : '找不到连线')
const wFocus = await focusInfo('svg.wf-canvas', 'svg.wf-canvas .wf-node', 'svg.wf-canvas .wf-edge--on')
check('工作流：悬浮步骤后相连连线高亮', wFocus !== null && wFocus.lit > 0, wFocus ? `lit=${wFocus.lit}` : '没找到有连线的节点')

// 9) 连线模式下不得淡化候选节点（否则目标节点淡到 0.05，根本看不见点哪里）
await ev(`document.querySelector('[data-nav-item="graph"]')?.click()`)
await sleep(1500)
await ev(`(() => {
  const n = document.querySelector('svg.graph .gnode')
  if (!n) return false
  const o = { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: 1, isPrimary: true }
  n.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 0, clientY: 0 }))
  n.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 0, clientY: 0 }))
  return true
})()`)
await sleep(600)
const entered = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('从此节点连线'))
  if (!b) return false
  b.click()
  return true
})()`)
await sleep(500)
await ev(`(() => {
  const n = document.querySelectorAll('svg.graph .gnode')[1]
  if (!n) return false
  n.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }))
  return true
})()`)
await sleep(500)
const dimmedInLink = await ev(`document.querySelectorAll('svg.graph .is-dimmed').length`)
check(
  '连线模式下不淡化候选节点',
  entered === true && dimmedInLink === 0,
  `进入连线模式=${entered} dimmed=${dimmedInLink}`
)

// 10) 连线箭头（图谱 + 工作流）
const gArrow = await ev(`(() => {
  const p = document.querySelector('svg.graph .graph__edge')
  return {
    marker: p ? p.getAttribute('marker-end') : null,
    markers: document.querySelectorAll('svg.graph defs marker').length
  }
})()`)
check(
  '图谱连线带箭头',
  gArrow.marker !== null && String(gArrow.marker).includes('edge-arrow') && gArrow.markers === 2,
  `marker=${gArrow.marker} defs=${gArrow.markers}`
)

await ev(`document.querySelector('[data-nav-item="workflow"]')?.click()`)
await waitFor(`document.querySelectorAll('svg.wf-canvas .wf-node').length > 0`)
await ev(`document.querySelector('.wf-list button')?.click()`)
await sleep(900)
const wArrow = await ev(`(() => {
  const p = document.querySelector('svg.wf-canvas .wf-edge')
  return {
    marker: p ? p.getAttribute('marker-end') : null,
    markers: document.querySelectorAll('svg.wf-canvas defs marker').length
  }
})()`)
check(
  '工作流连线带箭头',
  wArrow.marker !== null && String(wArrow.marker).includes('wf-arrow') && wArrow.markers === 2,
  `marker=${wArrow.marker} defs=${wArrow.markers}`
)

ws.close()
child.kill()
await sleep(400)
rmSync(tmpHome, { recursive: true, force: true })
const failed = results.filter(([, ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
process.exit(failed ? 1 : 0)
