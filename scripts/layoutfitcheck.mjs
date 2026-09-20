/**
 * 布局占位检查：行尾按钮组的「不占位」与笔记编辑区的「撑满」。
 *
 * 守两件容易随 CSS 改动回归的事：
 *   1. 工作流模板树 / 分类树行尾的编辑按钮组，**未悬浮时必须收拢为 0 宽**。
 *      只写 opacity:0 的话它仍然占着宽度，标题会一直少一截、行与行右侧也对不齐
 *      （任务项 .trow__actions 早就是这么做的，这里对齐它）。
 *   2. Word / Excel 的编辑区必须**填满**编辑区容器。
 *      .editor__office 曾在样式表里定义两次，旧块（居中的空状态）的
 *      align-items / justify-content / padding / text-align 会漏到可编辑预览上，
 *      预览被居中又内缩，看着永远填不满。
 *
 * 用法：node scripts/layoutfitcheck.mjs（需先 npm run build）
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
const tmpHome = join(root, '.screenshots', 'layoutfit-home')
const shotDir = join(root, '.screenshots')
const PORT = 9291

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
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
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

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''))
}
const J = (v) => JSON.stringify(v)
const STAMP = 'LF' + Date.now().toString(36)

const mouse = (type, x, y, buttons) =>
  conn.send('Input.dispatchMouseEvent', {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: type === 'mouseMoved' ? 'none' : 'left',
    buttons,
    clickCount: type === 'mouseMoved' ? 0 : 1,
  })

try {
  /** 测量 Office 编辑区：外层容器是否铺满父容器、内部编辑器是否吃掉剩余高度。 */
  const measureOffice = () =>
    conn.evaluate(`(() => {
       const office = document.querySelector('.editor__office')
       if (!office) return { missing: true }
       const cs = getComputedStyle(office)
       const parent = office.parentElement
       const body = office.querySelector('.editor__office-body')
       const rt = office.querySelector('.rt-editor')
       const grid = office.querySelector('.xlsx-grid')
       const r = office.getBoundingClientRect()
       return {
         alignItems: cs.alignItems,
         justifyContent: cs.justifyContent,
         paddingLeft: cs.paddingLeft,
         textAlign: cs.textAlign,
         width: Math.round(r.width),
         height: Math.round(r.height),
         parentWidth: parent ? parent.clientWidth : 0,
         parentHeight: parent ? parent.clientHeight : 0,
         bodyInner: body ? body.clientHeight - parseFloat(getComputedStyle(body).paddingTop) * 2 : 0,
         rtHeight: rt ? Math.round(rt.getBoundingClientRect().height) : null,
         gridWidth: grid ? Math.round(grid.getBoundingClientRect().width) : null,
         bodyInnerWidth: body ? body.clientWidth - parseFloat(getComputedStyle(body).paddingLeft) * 2 : 0
       }
     })()`)

  const makeNote = async (title, ext, format) => {
    const note = await conn.evaluate(
      `window.zhixing.db.createNote(${J(title)}, null, ${J('C:\\tmp\\' + STAMP + ext)}).then((n) => n && window.zhixing.db.saveNote(n.id, { format: ${J(format)} }).then((x) => x && x.id))`
    )
    return note
  }
  const wordTitle = STAMP + ' Word'
  const excelTitle = STAMP + ' Excel'
  const wordId = await makeNote(wordTitle, '.docx', 'word')
  const excelId = await makeNote(excelTitle, '.xlsx', 'excel')
  check('已建 Word / Excel 笔记', Boolean(wordId) && Boolean(excelId), J({ wordId, excelId }))

  await conn.evaluate(`document.querySelector('[data-nav-item="notes"]').click()`)
  await sleep(1200)
  const openNote = (title) =>
    conn.evaluate(`(() => {
       const btn = [...document.querySelectorAll('.ntree__note')].find((b) => b.querySelector('.ntree__title')?.textContent === ${J(title)})
       if (!btn) return false
       btn.click()
       return true
     })()`)

  // ------------------------------------------------ 1. Word 编辑区占满
  check('能在笔记树里打开 Word 笔记', await openNote(wordTitle))
  await sleep(1200)
  const word = await measureOffice()
  check(
    'Word 编辑区不再被居中/内缩（样式泄漏已修）',
    !word.missing &&
      // flex 容器的 align-items 初始值在计算样式里报 'normal'，语义上就是 stretch
      (word.alignItems === 'stretch' || word.alignItems === 'normal') &&
      word.justifyContent === 'normal' &&
      word.paddingLeft === '0px',
    J({ alignItems: word.alignItems, justifyContent: word.justifyContent, paddingLeft: word.paddingLeft })
  )
  check(
    'Word 编辑区铺满可用宽度',
    !word.missing && word.parentWidth > 0 && word.width >= word.parentWidth - 1,
    J({ width: word.width, parentWidth: word.parentWidth })
  )
  check(
    'Word 富文本编辑器吃掉剩余高度',
    !word.missing && word.rtHeight != null && word.rtHeight >= word.bodyInner - 2,
    J({ rtHeight: word.rtHeight, bodyInner: word.bodyInner })
  )

  // ------------------------------------------------ 2. Excel 编辑区占满
  check('能在笔记树里打开 Excel 笔记', await openNote(excelTitle))
  await sleep(1200)
  const excel = await measureOffice()
  check(
    'Excel 编辑区铺满可用宽度',
    !excel.missing && excel.parentWidth > 0 && excel.width >= excel.parentWidth - 1,
    J({ width: excel.width, parentWidth: excel.parentWidth })
  )
  check(
    'Excel 网格撑满正文区宽度',
    !excel.missing && excel.gridWidth != null && excel.gridWidth >= excel.bodyInnerWidth - 2,
    J({ gridWidth: excel.gridWidth, bodyInnerWidth: excel.bodyInnerWidth })
  )

  const noteShot = await conn.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shotDir, 'layoutfit-notes.png'), Buffer.from(noteShot.result.data, 'base64'))

  // ------------------------------------------------ 3. 工作流行尾按钮组不占位
  await conn.evaluate(`document.querySelector('[data-nav-item="workflow"]').click()`)
  await sleep(1400)
  const beforeWidth = await conn.evaluate(
    `(() => {
       const ops = document.querySelector('.wf-node--template .wf-node__ops')
       const label = document.querySelector('.wf-node--template .wf-node__label')
       if (!ops || !label) return null
       return {
         ops: Math.round(ops.getBoundingClientRect().width),
         label: Math.round(label.getBoundingClientRect().width),
         maxWidth: getComputedStyle(ops).maxWidth,
         buttons: [...ops.querySelectorAll('.icon-btn')].map((b) => Math.round(b.getBoundingClientRect().width))
       }
     })()`
  )
  check(
    '未悬浮时行尾按钮组宽度为 0（不占位置）',
    beforeWidth && beforeWidth.ops === 0,
    J(beforeWidth)
  )

  const rowPoint = await conn.evaluate(
    `(() => {
       const row = document.querySelector('.wf-node--template')
       if (!row) return null
       const r = row.getBoundingClientRect()
       return { x: r.x + 20, y: r.y + r.height / 2 }
     })()`
  )
  await mouse('mouseMoved', rowPoint.x, rowPoint.y, 0)
  // 展开是 max-width 的过渡动画，多等一会儿再量，免得量到动画中间态
  await sleep(600)
  const afterWidth = await conn.evaluate(
    `(() => {
       const ops = document.querySelector('.wf-node--template .wf-node__ops')
       const label = document.querySelector('.wf-node--template .wf-node__label')
       if (!ops || !label) return null
       return {
         ops: Math.round(ops.getBoundingClientRect().width),
         label: Math.round(label.getBoundingClientRect().width),
         maxWidth: getComputedStyle(ops).maxWidth,
         buttons: [...ops.querySelectorAll('.icon-btn')].map((b) => Math.round(b.getBoundingClientRect().width))
       }
     })()`
  )
  check(
    '悬浮时按钮组展开（标题相应让位）',
    // 三个 24px 的按钮 + 间距，展开后不该只有几像素
    afterWidth && afterWidth.ops >= 60 && afterWidth.label < beforeWidth.label,
    J({ before: beforeWidth, after: afterWidth })
  )

  const wfShot = await conn.evaluate(
    `(() => { const r = document.querySelector('.wf-wrap').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(Math.min(r.width, 420)), h: Math.round(Math.min(r.height, 420)) } })()`
  )
  const shot = await conn.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: wfShot.x, y: wfShot.y, width: wfShot.w, height: wfShot.h, scale: 1.6 },
  })
  writeFileSync(join(shotDir, 'layoutfit-workflow.png'), Buffer.from(shot.result.data, 'base64'))
  console.log('（截图已存 .screenshots/layoutfit-notes.png 与 layoutfit-workflow.png）')
} catch (err) {
  check('脚本执行完成', false, err instanceof Error ? err.message : String(err))
}

await conn.evaluate(`document.querySelector('[data-nav-item="notes"]').click()`).catch(() => {})

const failed = results.filter((r) => !r.ok)
console.log('\n' + (failed.length ? '✗ ' + failed.length + ' 项未通过' : '✓ 全部通过') + `（${results.length} 项）`)
child.kill()
process.exit(failed.length ? 1 : 0)
