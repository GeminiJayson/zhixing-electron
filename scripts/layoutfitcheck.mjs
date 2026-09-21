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
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

const root = ROOT
const require = createRequire(import.meta.url)
const tmpHome = join(ROOT, '.screenshots', 'layoutfit-home')
const PORT = 9291
const shotDir = join(root, '.screenshots')

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish, results } = createChecker()
const STAMP = 'LF' + Date.now().toString(36)

const mouse = (type, x, y, buttons) =>
  app.send('Input.dispatchMouseEvent', {
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
    app.evaluate(`(() => {
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
    const note = await app.evaluate(
      `window.zhixing.db.createNote(${J(title)}, null, ${J('C:\\tmp\\' + STAMP + ext)}).then((n) => n && window.zhixing.db.saveNote(n.id, { format: ${J(format)} }).then((x) => x && x.id))`
    )
    return note
  }
  const wordTitle = STAMP + ' Word'
  const excelTitle = STAMP + ' Excel'
  const wordId = await makeNote(wordTitle, '.docx', 'word')
  const excelId = await makeNote(excelTitle, '.xlsx', 'excel')
  check('已建 Word / Excel 笔记', Boolean(wordId) && Boolean(excelId), J({ wordId, excelId }))

  await app.evaluate(`document.querySelector('[data-nav-item="notes"]').click()`)
  await sleep(1200)
  const openNote = (title) =>
    app.evaluate(`(() => {
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

  const noteShot = await app.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shotDir, 'layoutfit-notes.png'), Buffer.from(noteShot.result.data, 'base64'))

  // ------------------------------------------------ 3. 工作流行尾按钮组不占位
  await app.evaluate(`document.querySelector('[data-nav-item="workflow"]').click()`)
  await sleep(1400)
  const beforeWidth = await app.evaluate(
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

  const rowPoint = await app.evaluate(
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
  const afterWidth = await app.evaluate(
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

  const wfShot = await app.evaluate(
    `(() => { const r = document.querySelector('.wf-wrap').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(Math.min(r.width, 420)), h: Math.round(Math.min(r.height, 420)) } })()`
  )
  const shot = await app.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: wfShot.x, y: wfShot.y, width: wfShot.w, height: wfShot.h, scale: 1.6 },
  })
  writeFileSync(join(shotDir, 'layoutfit-workflow.png'), Buffer.from(shot.result.data, 'base64'))
  console.log('（截图已存 .screenshots/layoutfit-notes.png 与 layoutfit-workflow.png）')
} catch (err) {
  check('脚本执行完成', false, err instanceof Error ? err.message : String(err))
}

await app.evaluate(`document.querySelector('[data-nav-item="notes"]').click()`).catch(() => {})
await app.close()
process.exit(finish())