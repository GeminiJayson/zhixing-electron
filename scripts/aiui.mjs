/**
 * 「AI 整理」界面验证：设置页的配置卡片 + 笔记页的入口按钮。
 * 用法：node scripts/aiui.mjs（需先 npm run build）
 *
 * 表达式一律**单行 + 简单**：多行 IIFE 里混着属性选择器与可选链时，
 * 一旦某处转义出错，报的只是「Invalid or unexpected token」，很难定位。
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
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')

const tmpHome = join(ROOT, '.screenshots', 'aiui-home')
const PORT = 9242

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish, results } = createChecker()
const shoot = async (name) => {
  const r = await app.send('Page.captureScreenshot', { format: 'png' })
  if (r.result?.data) writeFileSync(join(shotDir, name), Buffer.from(r.result.data, 'base64'))
}

// ---------------- 设置页
await app.evaluate("document.querySelector('[data-nav-item=settings]').click()")
await sleep(1200)
const tabs = await app.evaluate(
  "[...document.querySelectorAll('[role=tab]')].map((b) => b.textContent.trim()).join(',')"
)
check('设置页出现「AI 整理」分区', String(tabs).includes('AI 整理'), tabs)

await app.evaluate(
  "[...document.querySelectorAll('[role=tab]')].filter((b) => b.textContent.trim() === 'AI 整理')[0].click()"
)
await sleep(700)

const promptSel = "textarea[aria-label='整理提示词']"
const promptValue = await app.evaluate(
  "(document.querySelector(" + JSON.stringify(promptSel) + ") || {}).value || ''"
)
const panelText = await app.evaluate(
  "[...document.querySelectorAll('.set-card')].map((c) => c.innerText).join(' | ')"
)
const hasKey = await app.evaluate("!!document.querySelector('input[type=password]')")
const hasProtocol = await app.evaluate(
  "[...document.querySelectorAll('select')].some((s) => [...s.options].some((o) => o.value === 'anthropic'))"
)
const cardCount = await app.evaluate("document.querySelectorAll('.set-card').length")

check('配置卡片齐全（协议 / 地址 / Key / 模型 / 超时）', hasKey === true && cardCount >= 2, 'cards=' + cardCount)
check('协议下拉含三种协议', hasProtocol === true, '')
check('有可编辑的提示词框', String(promptValue).length > 50, String(promptValue).length + ' 字')
check(
  '提示词里说明了关键变量',
  String(promptValue).includes('{{CONTENT}}') && String(promptValue).includes('{{FOLDERS}}'),
  ''
)
check(
  '卡片文案说明了占位符机制',
  String(panelText).includes('@@IMG1@@') && String(panelText).includes('不会上传'),
  ''
)
check(
  '有「测试连接」与「恢复默认提示词」',
  String(panelText).includes('测试连接') && String(panelText).includes('恢复默认提示词'),
  ''
)
const libPromptValue = await app.evaluate(
  "(document.querySelector(" + JSON.stringify("textarea[aria-label='全库整理提示词']") + ") || {}).value ?? null"
)
check(
  '全库提示词默认就是一份整库专用提示词（不是空）',
  String(libPromptValue).length > 300 && String(libPromptValue).includes('成批'),
  String(libPromptValue).length + ' 字'
)

// 工具栏左分隔：设置页左侧是 tab 组 → 50px；笔记编辑器工具栏左侧为空 → 不加
const settingGap = await app.evaluate(`(() => {
  const left = document.querySelector('.tb__subleft')
  const right = document.querySelector('.tb__subright')
  if (!left || !right) return null
  return {
    leftW: Math.round(left.getBoundingClientRect().width),
    gap: Math.round(right.getBoundingClientRect().left - left.getBoundingClientRect().right),
  }
})()`)
check(
  '设置页：工具栏左侧与工具区之间是 50px',
  !!settingGap && settingGap.leftW > 0 && Math.abs(settingGap.gap - 50) <= 2,
  JSON.stringify(settingGap)
)

// 改动 2：提示词的两个动作行要靠右（按钮右边缘与上方 textarea 对齐）
const actionsAlign = await app.evaluate(`(() => {
  const rows = [...document.querySelectorAll('.set-row--end')]
  const areas = [...document.querySelectorAll('textarea[aria-label="整理提示词"], textarea[aria-label="全库整理提示词"]')]
  return rows.map((row, i) => {
    // 比的是按钮组的**右端**（最后一个按钮）—— margin-left:auto 把整组推到右边后，
    // 贴住 textarea 右边缘的是最后一个按钮，不是第一个
    const btn = [...row.querySelectorAll('button')].pop()
    const area = areas[i]
    if (!btn || !area) return null
    const b = btn.getBoundingClientRect()
    const a = area.getBoundingClientRect()
    return Math.round(a.right - b.right)
  })
})()`)
check(
  '提示词动作行靠右（按钮右边缘与输入框对齐）',
  Array.isArray(actionsAlign) && actionsAlign.length === 2 && actionsAlign.every((d) => d !== null && Math.abs(d) <= 18),
  JSON.stringify(actionsAlign)
)
await shoot('ai-settings.png')

// 外部任务同步卡片（在「任务与提醒」分区）
await app.evaluate(
  "[...document.querySelectorAll('[role=tab]')].filter((b) => b.textContent.trim() === '任务与提醒')[0].click()"
)
await sleep(700)
const syncCard = await app.evaluate(`(() => {
  const cards = [...document.querySelectorAll('.set-card')]
  const card = cards.find((c) => c.innerText.includes('外部任务同步'))
  if (!card) return null
  return {
    text: card.innerText.slice(0, 120),
    hasUrl: !!card.querySelector('input[placeholder*="api/tasks"]'),
    hasNow: [...card.querySelectorAll('button')].some((b) => b.textContent.includes('立即同步')),
  }
})()`)
check(
  '设置页有「外部任务同步」卡片（地址 + 立即同步）',
  !!syncCard && syncCard.hasUrl && syncCard.hasNow,
  syncCard ? syncCard.text.replace(/\n/g, ' / ') : '（没找到）'
)

// 今日页：今日待办比最近笔记高 100px
await app.evaluate("document.querySelector('[data-nav-item=today]').click()")
await sleep(1500)
const heights = await app.evaluate(`(() => {
  const todo = document.querySelector('.section--today-todo')
  const recent = [...document.querySelectorAll('.section--grow')].find((s) => !s.classList.contains('section--today-todo'))
  if (!todo || !recent) return null
  return {
    todo: Math.round(todo.getBoundingClientRect().height),
    recent: Math.round(recent.getBoundingClientRect().height),
  }
})()`)
check(
  '今日待办比最近笔记高 100px',
  !!heights && Math.abs(heights.todo - heights.recent - 100) <= 6,
  JSON.stringify(heights)
)
await shoot('today-heights.png')

// ---------------- 笔记页入口
// 先用 API 造一篇链接笔记，稍后检查它的编辑器
const linkNote = await app.evaluate(
  "window.zhixing.db.createNote('UI验证-链接笔记', null, JSON.stringify([{title:'知乎',target:'https://zhihu.com'}]), 'link')"
)
await app.evaluate("document.querySelector('[data-nav-item=notes]').click()")
await sleep(1500)

const treeActions = await app.evaluate(
  "[...document.querySelectorAll('.ntree__topbar button')].map((b) => b.textContent.trim()).join(' | ')"
)
check('「AI 整理全库」在笔记树里（搜索框下方）', String(treeActions).includes('AI 整理全库'), treeActions)

// 改动 1：按钮与搜索框同宽
const widthDelta = await app.evaluate(`(() => {
  const btn = document.querySelector('.ntree__topbar button')
  const box = document.querySelector('.ntree__search-input')
  if (!btn || !box) return null
  return Math.round(Math.abs(btn.getBoundingClientRect().width - box.getBoundingClientRect().width))
})()`)
check('全库按钮与搜索框等宽（占满父布局）', widthDelta !== null && widthDelta <= 2, 'delta=' + widthDelta + 'px')
const allLibButtons = await app.evaluate(
  "[...document.querySelectorAll('button')].filter((b) => b.textContent.includes('整理全库')).length"
)
check('全库入口只有树里这一个（编辑器工具栏已移除）', allLibButtons === 1, 'count=' + allLibButtons)
const noteTitle = await app.evaluate(
  "window.zhixing.db.notes(1).then((rows) => (rows[0] && rows[0].title) || '')"
)
// 笔记树里的一行是 div.ntree__note（不是 button），按标题文本命中后点它
await app.evaluate(
  "[...document.querySelectorAll('.ntree__note')].filter((el) => el.innerText.includes(" +
    JSON.stringify(noteTitle) +
    '))[0]?.click()'
)
await sleep(1500)
const toolbarText = await app.evaluate(
  "[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).join(' | ')"
)
check('笔记工具栏有「AI 整理」入口', String(toolbarText).includes('AI 整理'), '选中：' + noteTitle)
const noteGap = await app.evaluate(`(() => {
  const left = document.querySelector('.editor .tb__subleft')
  const right = document.querySelector('.editor .tb__subright')
  if (!left || !right) return null
  return {
    leftW: Math.round(left.getBoundingClientRect().width),
    gap: Math.round(right.getBoundingClientRect().left - left.getBoundingClientRect().right),
  }
})()`)
check(
  '笔记页：左侧没有其它布局时不加这 50px',
  !!noteGap && noteGap.leftW === 0 && noteGap.gap <= 14,
  JSON.stringify(noteGap)
)
const editorButtons = await app.evaluate(
  "[...document.querySelectorAll('.editor button')].map((b) => b.textContent.trim()).join(' | ')"
)
check('编辑器工具栏不再有全库入口', !String(editorButtons).includes('整理全库'), '')
await shoot('ai-note-toolbar.png')

// 链接笔记：多链接可编辑
await app.evaluate(
  "[...document.querySelectorAll('.ntree__note')].filter((el) => el.innerText.includes('UI验证-链接笔记'))[0]?.click()"
)
await sleep(1200)
const linkEditor = await app.evaluate(
  "JSON.stringify({ titleInputs: document.querySelectorAll('input[aria-label=\\'链接标题\\']').length, targetInputs: document.querySelectorAll('input[aria-label=\\'链接地址\\']').length, hasAdd: [...document.querySelectorAll('button')].some((b) => b.textContent.includes('添加链接')) })"
)
const linkInfo = JSON.parse(String(linkEditor))
check(
  '链接笔记可编辑多链接（标题 + 地址 + 添加）',
  linkInfo.titleInputs >= 1 && linkInfo.targetInputs >= 1 && linkInfo.hasAdd,
  JSON.stringify(linkInfo)
)

// 表格形态：三列表头、操作列固定宽、列宽可拖
const table = await app.evaluate(`(() => {
  const head = document.querySelector('.link-table__head')
  const row = document.querySelector('.link-table__row')
  if (!head || !row) return null
  const headers = [...head.children]
    .filter((c) => !c.classList.contains('link-table__grip'))
    .map((c) => c.textContent.trim())
  return {
    headers,
    titleW: Math.round(row.children[0].getBoundingClientRect().width),
    opsW: Math.round(row.children[3].getBoundingClientRect().width),
    opsButtons: row.querySelectorAll('.link-table__ops .icon-btn').length,
  }
})()`)
check(
  '链接表格：三列表头（标题 / 链接 / 操作）',
  JSON.stringify(table?.headers) === JSON.stringify(['标题', '链接', '操作']),
  JSON.stringify(table?.headers)
)
check('操作列固定宽 76px，放两个图标按钮', Math.abs((table?.opsW ?? 0) - 76) <= 2 && table?.opsButtons === 2, JSON.stringify(table))
await shoot('ai-link-note.png')

// 拖分界改列宽（真实鼠标事件）
const grip = await app.evaluate(`(() => {
  const g = document.querySelector('.link-table__grip')
  if (!g) return null
  const r = g.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})()`)
if (grip) {
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: grip.x, y: grip.y, button: 'left', clickCount: 1, buttons: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x + 150, y: grip.y, button: 'left', buttons: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grip.x + 150, y: grip.y, button: 'left', clickCount: 1, buttons: 0 })
}
await sleep(400)
const resized = await app.evaluate(
  "Math.round(document.querySelector('.link-table__row').children[0].getBoundingClientRect().width)"
)
check(
  '拖分界能改变列宽',
  typeof resized === 'number' && resized > (table?.titleW ?? 0) + 80,
  `${table?.titleW}px → ${resized}px`
)
await shoot('ai-link-table-resized.png')
await app.evaluate("window.zhixing.db.deleteNote(" + linkNote.id + ").catch(() => 0)")

// 改动 3：折叠从左边开始收 —— 「⋯」出现在已显示项的左侧，右侧那组原位不动
await app.send('Emulation.setDeviceMetricsOverride', {
  width: 1000,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
})
await sleep(900)
await app.evaluate("document.querySelector('[data-nav-item=notes]').click()")
await sleep(1200)
await app.evaluate(
  "[...document.querySelectorAll('.ntree__note')].filter((el) => el.innerText.includes(" +
    JSON.stringify(noteTitle) +
    '))[0]?.click()'
)
await sleep(1200)
const fold = await app.evaluate(`(() => {
  const right = document.querySelector('.tb__subright')
  if (!right) return null
  const kids = [...right.children]
  const moreIdx = kids.findIndex((k) => k.classList.contains('tb__more'))
  const after = moreIdx >= 0 ? kids.slice(moreIdx + 1).length : 0
  const before = moreIdx >= 0 ? kids.slice(0, moreIdx).filter((k) => k.tagName !== 'INPUT').length : -1
  const count = moreIdx >= 0 ? (right.querySelector('.tb-btn__n')?.textContent ?? '') : ''
  return { moreIdx, before, after, count }
})()`)
check('窄窗口下确实发生了折叠', !!fold && fold.moreIdx >= 0 && Number(fold.count) > 0, JSON.stringify(fold))
// 「⋯」必须落在已显示项**之后**（after=0）—— 这就是「从右边开始收」的判据；
// 宽度再窄时会全部收进 ⋯，那时 after 同样是 0，属于该方向的极端情形。
check(
  '「⋯」排在已显示项之后（从右边开始收）',
  !!fold && fold.moreIdx >= 0 && fold.after === 0,
  JSON.stringify(fold)
)
// 左侧不留空：工具行内容从左边缘开始排
const flushLeft = await app.evaluate(`(() => {
  const right = document.querySelector('.tb__subright')
  if (!right) return null
  const first = right.firstElementChild
  if (!first) return null
  return Math.round(first.getBoundingClientRect().left - right.getBoundingClientRect().left)
})()`)
check('工具行内容贴着左侧排（消除左侧留空）', flushLeft !== null && Math.abs(flushLeft) <= 2, 'gap=' + flushLeft + 'px')
// 窗口停稳后：第一个控件吃掉剩余宽度，行尾不再留空
const fillGap = await app.evaluate(`(() => {
  const right = document.querySelector('.tb__subright')
  if (!right) return null
  const first = right.firstElementChild
  const last = right.lastElementChild
  if (!first || !last) return null
  const inner = first.querySelector('select, input') || first
  return {
    trailing: Math.round(right.getBoundingClientRect().right - last.getBoundingClientRect().right),
    firstWidth: Math.round(inner.getBoundingClientRect().width),
    filled: right.classList.contains('tb__subright--fill'),
    sel: (inner.tagName || '').toLowerCase(),
  }
})()`)
check(
  '第一个控件占满剩余宽度（行尾无留白）',
  !!fillGap && fillGap.trailing <= 2 && fillGap.sel !== 'button',
  JSON.stringify(fillGap)
)
await shoot('ui-toolbar-fold.png')
await app.send('Emulation.clearDeviceMetricsOverride')
await sleep(900)
await shoot('ui-toolbar-wide.png')

// 工作流：第一个控件是「启动策略」下拉，包裹层级是 span > label > select ——
// 只拉外层容器会让「布局宽了、下拉没变」
await app.evaluate("document.querySelector('[data-nav-item=workflow]').click()")
await sleep(1600)
const wfFill = await app.evaluate(`(() => {
  const right = document.querySelector('.tb__subright')
  if (!right) return null
  const first = right.firstElementChild
  const sel = first.querySelector('select') || first
  return {
    hasFill: right.classList.contains('tb__subright--fill'),
    wrapW: Math.round(first.getBoundingClientRect().width),
    selW: Math.round(sel.getBoundingClientRect().width),
  }
})()`)
check(
  '工作流：策略下拉本身被拉宽（不是只有外层容器变宽）',
  !!wfFill && wfFill.selW > 250,
  JSON.stringify(wfFill)
)
// 拉伸控件不能把前缀文字挤成两行
const wfLabel = await app.evaluate(`(() => {
  const right = document.querySelector('.tb__subright')
  const span = right?.firstElementChild?.querySelector('span')
  if (!span) return null
  const r = span.getBoundingClientRect()
  return { text: span.textContent.trim(), h: Math.round(r.height), w: Math.round(r.width) }
})()`)
check(
  '「启动策略」文字仍是单行（没被压成两行）',
  !!wfLabel && wfLabel.text.includes('启动策略') && wfLabel.h <= 24,
  JSON.stringify(wfLabel)
)
await shoot('ui-toolbar-workflow.png')

await sleep(500)

await app.close()
process.exit(finish())