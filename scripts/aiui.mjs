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
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = join(root, '.screenshots', 'aiui-home')
const shotDir = join(root, '.screenshots')
const PORT = 9242

const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
if (!existsSync(realDb)) {
  console.error('✗ 找不到真实库：' + realDb)
  process.exit(1)
}
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(realDb, join(tmpHome, 'zhixing.db'))

const SYS_PATH = [
  'C:\\Windows\\System32',
  'C:\\Windows',
  'C:\\Windows\\System32\\Wbem',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
].join(';')

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

// ---------------- 设置页
await conn.evaluate("document.querySelector('[data-nav-item=settings]').click()")
await sleep(1200)
const tabs = await conn.evaluate(
  "[...document.querySelectorAll('[role=tab]')].map((b) => b.textContent.trim()).join(',')"
)
check('设置页出现「AI 整理」分区', String(tabs).includes('AI 整理'), tabs)

await conn.evaluate(
  "[...document.querySelectorAll('[role=tab]')].filter((b) => b.textContent.trim() === 'AI 整理')[0].click()"
)
await sleep(700)

const promptSel = "textarea[aria-label='整理提示词']"
const promptValue = await conn.evaluate(
  "(document.querySelector(" + JSON.stringify(promptSel) + ") || {}).value || ''"
)
const panelText = await conn.evaluate(
  "[...document.querySelectorAll('.set-card')].map((c) => c.innerText).join(' | ')"
)
const hasKey = await conn.evaluate("!!document.querySelector('input[type=password]')")
const hasProtocol = await conn.evaluate(
  "[...document.querySelectorAll('select')].some((s) => [...s.options].some((o) => o.value === 'anthropic'))"
)
const cardCount = await conn.evaluate("document.querySelectorAll('.set-card').length")

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
const libPromptValue = await conn.evaluate(
  "(document.querySelector(" + JSON.stringify("textarea[aria-label='全库整理提示词']") + ") || {}).value ?? null"
)
check('有单独的全库整理提示词框（默认为空 = 与单篇相同）', libPromptValue === '', String(libPromptValue).slice(0, 20))

// 改动 2：提示词的两个动作行要靠右（按钮右边缘与上方 textarea 对齐）
const actionsAlign = await conn.evaluate(`(() => {
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

// ---------------- 笔记页入口
// 先用 API 造一篇链接笔记，稍后检查它的编辑器
const linkNote = await conn.evaluate(
  "window.zhixing.db.createNote('UI验证-链接笔记', null, JSON.stringify([{title:'知乎',target:'https://zhihu.com'}]), 'link')"
)
await conn.evaluate("document.querySelector('[data-nav-item=notes]').click()")
await sleep(1500)

const treeActions = await conn.evaluate(
  "[...document.querySelectorAll('.ntree__topbar button')].map((b) => b.textContent.trim()).join(' | ')"
)
check('「AI 整理全库」在笔记树里（搜索框下方）', String(treeActions).includes('AI 整理全库'), treeActions)

// 改动 1：按钮与搜索框同宽
const widthDelta = await conn.evaluate(`(() => {
  const btn = document.querySelector('.ntree__topbar button')
  const box = document.querySelector('.ntree__search-input')
  if (!btn || !box) return null
  return Math.round(Math.abs(btn.getBoundingClientRect().width - box.getBoundingClientRect().width))
})()`)
check('全库按钮与搜索框等宽（占满父布局）', widthDelta !== null && widthDelta <= 2, 'delta=' + widthDelta + 'px')
const allLibButtons = await conn.evaluate(
  "[...document.querySelectorAll('button')].filter((b) => b.textContent.includes('整理全库')).length"
)
check('全库入口只有树里这一个（编辑器工具栏已移除）', allLibButtons === 1, 'count=' + allLibButtons)
const noteTitle = await conn.evaluate(
  "window.zhixing.db.notes(1).then((rows) => (rows[0] && rows[0].title) || '')"
)
// 笔记树里的一行是 div.ntree__note（不是 button），按标题文本命中后点它
await conn.evaluate(
  "[...document.querySelectorAll('.ntree__note')].filter((el) => el.innerText.includes(" +
    JSON.stringify(noteTitle) +
    '))[0]?.click()'
)
await sleep(1500)
const toolbarText = await conn.evaluate(
  "[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).join(' | ')"
)
check('笔记工具栏有「AI 整理」入口', String(toolbarText).includes('AI 整理'), '选中：' + noteTitle)
const editorButtons = await conn.evaluate(
  "[...document.querySelectorAll('.editor button')].map((b) => b.textContent.trim()).join(' | ')"
)
check('编辑器工具栏不再有全库入口', !String(editorButtons).includes('整理全库'), '')
await shoot('ai-note-toolbar.png')

// 链接笔记：多链接可编辑
await conn.evaluate(
  "[...document.querySelectorAll('.ntree__note')].filter((el) => el.innerText.includes('UI验证-链接笔记'))[0]?.click()"
)
await sleep(1200)
const linkEditor = await conn.evaluate(
  "JSON.stringify({ titleInputs: document.querySelectorAll('input[aria-label=\\'链接标题\\']').length, targetInputs: document.querySelectorAll('input[aria-label=\\'链接地址\\']').length, hasAdd: [...document.querySelectorAll('button')].some((b) => b.textContent.includes('添加链接')) })"
)
const linkInfo = JSON.parse(String(linkEditor))
check(
  '链接笔记可编辑多链接（标题 + 地址 + 添加）',
  linkInfo.titleInputs >= 1 && linkInfo.targetInputs >= 1 && linkInfo.hasAdd,
  JSON.stringify(linkInfo)
)
await shoot('ai-link-note.png')
await conn.evaluate("window.zhixing.db.deleteNote(" + linkNote.id + ").catch(() => 0)")

// 改动 3：折叠从左边开始收 —— 「⋯」出现在已显示项的左侧，右侧那组原位不动
await conn.send('Emulation.setDeviceMetricsOverride', {
  width: 1000,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
})
await sleep(900)
await conn.evaluate("document.querySelector('[data-nav-item=notes]').click()")
await sleep(1200)
await conn.evaluate(
  "[...document.querySelectorAll('.ntree__note')].filter((el) => el.innerText.includes(" +
    JSON.stringify(noteTitle) +
    '))[0]?.click()'
)
await sleep(1200)
const fold = await conn.evaluate(`(() => {
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
const flushLeft = await conn.evaluate(`(() => {
  const right = document.querySelector('.tb__subright')
  if (!right) return null
  const first = right.firstElementChild
  if (!first) return null
  return Math.round(first.getBoundingClientRect().left - right.getBoundingClientRect().left)
})()`)
check('工具行内容贴着左侧排（消除左侧留空）', flushLeft !== null && Math.abs(flushLeft) <= 2, 'gap=' + flushLeft + 'px')
// 窗口停稳后：第一个控件吃掉剩余宽度，行尾不再留空
const fillGap = await conn.evaluate(`(() => {
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
await conn.send('Emulation.clearDeviceMetricsOverride')
await sleep(900)
await shoot('ui-toolbar-wide.png')

conn.ws.close()
child.kill()
await sleep(500)
rmSync(tmpHome, { recursive: true, force: true })

const failed = results.filter(([, ok]) => !ok)
console.log('')
console.log((results.length - failed.length) + '/' + results.length + ' 项通过')
process.exit(failed.length ? 1 : 0)
