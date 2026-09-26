/**
 * 笔记编辑区「一张纸」重构的回归检查。
 *
 * 守这次重排的四件事（详见 docs 与提交说明）：
 *   1. **一张纸**：头部（标题 + 元信息 + 工具行）与正文同处 `.sheet`，
 *      `.editor .tb` / `.md-editor` / `.rt-editor` / `.editor__office` 这些内层容器一律不得再带边框。
 *   2. **信息条默认收起**：`.links--collapsed` 且没有 `.links__body`；正文区高度占比因此显著上升
 *      （改造前空态约 46%）。
 *   3. **展开态与改造前可见性一致**：三组（属性 / 反向链接 / 引用 / 归属）全部可见。
 *   4. **窄窗口走覆盖式抽屉**：编辑区窄于阈值时展开态是 `.links--drawer`（fixed），不挤压正文。
 *   5. 全屏编辑：`.page--zen` + `.app--zen`，侧栏与页面头让位；Esc 退出。
 *   6. **铺满纸面**：标题行 / 正文都吃满笔记纸的内容宽度（左边缘对齐）；
 *      Markdown 正文不带横向内边距（此前比标题右缩一格）；五种形态同宽，不再分「宽体 / 书写列」。
 *      2026-09 曾有一版把这三块限宽 560px 并居中（书写列），已按产品决定撤掉。
 *   7. **标题行四合一**：标题 / 保存状态胶囊 / 标签胶囊 / 归属胶囊同行，元信息行与格式下拉一并撤掉；
 *      工具行按钮不带边框，编辑区里的聚焦一律不出边框。
 *
 * 用法：node scripts/notesheetcheck.mjs（需先 npm run build）
 */
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

const tmpHome = join(ROOT, '.screenshots', 'notesheet-home')
const shotDir = join(ROOT, '.screenshots')
const PORT = 9297

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()
const STAMP = 'NS' + Date.now().toString(36)

const shot = async (name) => {
  const r = await app.send('Page.captureScreenshot', { format: 'png' })
  mkdirSync(shotDir, { recursive: true })
  writeFileSync(join(shotDir, name), Buffer.from(r.result.data, 'base64'))
}

/** 按可见文字点按钮 */
const clickByText = (selector, text) =>
  app.evaluate(`(() => {
     const b = [...document.querySelectorAll(${J(selector)})].find((x) => (x.textContent || '').includes(${J(text)}))
     if (!b) return false
     b.click()
     return true
   })()`)

const box = (selector) =>
  app.evaluate(`(() => {
     const el = document.querySelector(${J(selector)})
     if (!el) return null
     const cs = getComputedStyle(el)
     const r = el.getBoundingClientRect()
     return {
       w: Math.round(r.width),
       h: Math.round(r.height),
       border: cs.borderTopWidth,
       bg: cs.backgroundColor,
       display: cs.display,
       position: cs.position
     }
   })()`)

try {
  await app.evaluate(`document.querySelector('[data-nav-item="notes"]').click()`)
  await sleep(1000)

  // 造一篇普通 Markdown 笔记并打开
  const title = STAMP + ' 排版验证'
  const id = await app.evaluate(
    `window.zhixing.db.createNote(${J(title)}, null).then((n) => n && window.zhixing.db.saveNote(n.id, { content_md: '第一段。\\n\\n第二段，用来量正文高度。' }).then(() => n.id))`
  )
  check('已建待验证的笔记', Boolean(id), J({ id }))
  // 直接写库不会刷新笔记树，切走再回来让页面重新加载
  await app.evaluate(`document.querySelector('[data-nav-item="today"]').click()`)
  await sleep(600)
  await app.evaluate(`document.querySelector('[data-nav-item="notes"]').click()`)
  await sleep(1000)
  const opened = await app.evaluate(`(() => {
     const b = [...document.querySelectorAll('.ntree__note')].find((x) => (x.querySelector('.ntree__title')?.textContent || '') === ${J(title)})
     if (!b) return false
     b.click()
     return true
   })()`)
  check('能在笔记树里打开这篇笔记', opened)
  await sleep(900)

  // ---------------------------------------------------------- 1. 一张纸
  check('笔记纸 .sheet 存在', Boolean(await box('.sheet')))
  // 笔记树的收放：按钮在页面副标题旁边，收起后整块不渲染（宽度全给编辑区）
  const ntreeBefore = await app.evaluate("!!document.querySelector('.ntree')")
  const ntreeToggle = await app.evaluate(`(() => {
     const b = document.querySelector('.page__head-toggle')
     if (!b) return false
     b.click()
     return true
   })()`)
  await sleep(500)
  const ntreeHidden = await app.evaluate("!!document.querySelector('.ntree')")
  await app.evaluate(`document.querySelector('.page__head-toggle')?.click()`)
  await sleep(500)
  const ntreeBack = await app.evaluate("!!document.querySelector('.ntree')")
  check('笔记树能收起并再展开（收起时不占位）',
    ntreeBefore && ntreeToggle && !ntreeHidden && ntreeBack,
    J({ ntreeBefore, ntreeToggle, ntreeHidden, ntreeBack }))
  const tb = await box('.editor .tb')
  // 按当前笔记类型取对应的正文容器（Markdown / 富文本 / Word / Excel / 链接）
  const bodyBox = await app.evaluate(`(() => {
     const sel = ['.md-editor', '.rt-editor', '.editor__link', '.editor__office']
     const el = sel.map((s) => document.querySelector(s)).find(Boolean)
     if (!el) return { missing: true }
     const cs = getComputedStyle(el)
     return { cls: el.className, border: cs.borderTopWidth, bg: cs.backgroundColor }
   })()`)
  check('头部 .tb 不再是独立卡片（无边框、无底色）', tb?.border === '0px' && tb?.bg === 'rgba(0, 0, 0, 0)', J(tb))
  check('正文容器不再自带边框（纸只有一张）', !bodyBox?.missing && bodyBox.border === '0px' && bodyBox.bg === 'rgba(0, 0, 0, 0)', J(bodyBox))

  // ---------------------------------------------------------- 1b. 书写列
  // 标题 / 元信息 / 正文共处一条居中列：三者左边缘必须落在同一像素上，
  // 且正文的横向内边距归零（改造前 .cm-content 自带 16px，Markdown 正文比标题右缩一格，
  // 富文本与预览却已归零 —— 三种形态互不一致）。
  const col = await app.evaluate(`(() => {
     const q = (s) => document.querySelector(s)
     const x = (el) => (el ? Math.round(el.getBoundingClientRect().x) : null)
     const w = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null)
     const content = q('.cm-content')
     const cs = content ? getComputedStyle(content) : null
     const line = q('.cm-line')
     let lineX = null
     if (line) {
       const r = document.createRange()
       r.selectNodeContents(line)
       lineX = Math.round(r.getBoundingClientRect().x)
     }
     return {
       titleX: x(q('.editor__title')),
       bodyX: x(q('.sheet__body')),
       bodyW: w(q('.sheet__body')),
       lineX,
       padL: cs ? cs.paddingLeft : null,
       padR: cs ? cs.paddingRight : null
     }
   })()`)
  check('标题 / 正文左边缘对齐（±1px）',
    col.titleX != null && Math.abs(col.lineX - col.titleX) <= 1, J(col))
  check('Markdown 正文横向内边距归零（横向交给纸面）',
    col.padL === '0px' && col.padR === '0px', 'pad=' + col.padL + '/' + col.padR)
  // 工具栏到正文首行只该有十来像素：原先 tb 外边距 + .sheet__body 上内边距 + 编辑器上内边距
  // 三层叠加，富文本 24px、Markdown 32px，读起来就是「中间空太多」。
  const topGap = await app.evaluate(`(() => {
     const tb = document.querySelector('.editor .tb__sub')
     const line = document.querySelector('.md-editor .cm-line') || document.querySelector('.rt-editor .ProseMirror > *')
     if (!tb || !line) return null
     return Math.round(line.getBoundingClientRect().top - tb.getBoundingClientRect().bottom)
   })()`)
  check('工具栏到正文首行的间距 ≤ 14px', topGap != null && topGap <= 14, topGap + 'px')
  // 铺满：三块的宽度都等于纸的内容宽（纸的 clientWidth 减去左右内边距）
  const fill = await app.evaluate(`(() => {
     const q = (s) => document.querySelector(s)
     const sheet = q('.sheet')
     const cs = sheet ? getComputedStyle(sheet) : null
     const inner = sheet && cs
       ? Math.round(sheet.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))
       : null
     const w = (s) => { const el = q(s); return el ? Math.round(el.getBoundingClientRect().width) : null }
     return { inner, tb: w('.editor .tb'), body: w('.sheet__body') }
   })()`)
  check('标题行 / 正文都铺满纸面（等于纸的内容宽，±1px）',
    fill.inner != null && [fill.tb, fill.body].every((x) => x != null && Math.abs(x - fill.inner) <= 1), J(fill))

  // 链接笔记：表格要的是列数，不吃书写列
  const openedLink = await app.evaluate(`(() => {
     const b = [...document.querySelectorAll('.ntree__note')]
       .find((x) => (x.querySelector('.ntree__title')?.textContent || '').includes('链接'))
     if (!b) return false
     b.click()
     return true
   })()`)
  await sleep(900)
  const wide = await app.evaluate(`(() => {
     const b = document.querySelector('.sheet__body')
     return { bodyW: b ? Math.round(b.getBoundingClientRect().width) : null, table: !!document.querySelector('.editor__link') }
   })()`)
  check('链接笔记的正文与写作形态同宽（五种形态一律铺满）',
    openedLink && wide.table && wide.bodyW != null && Math.abs(wide.bodyW - fill.inner) <= 1, J(wide))
  // 回到刚才那篇 Markdown 笔记：后面的断言继续在它上面跑
  await app.evaluate(`(() => {
     const b = [...document.querySelectorAll('.ntree__note')]
       .find((x) => (x.querySelector('.ntree__title')?.textContent || '') === ${J(title)})
     if (b) b.click()
   })()`)
  await sleep(900)

  // ---------------------------------------------------------- 2. 信息条默认收起
  const links = await box('.links')
  check('信息区默认收起（.links--collapsed，无 .links__body）',
    Boolean(await box('.links--collapsed')) && (await app.evaluate("!!document.querySelector('.links__body')")) === false,
    J(links))
  check('收起态只占一行（≤ 3 倍控件高）', Boolean(links) && links.h <= 96, links ? links.h + 'px' : 'null')

  // 操作组固定在工具栏**左端**，不参与右侧折叠：6 个入口永远看得见
  const overflow = await app.evaluate(`(() => {
     const left = document.querySelector('.editor .tb .tb__subleft')
     const labels = [...document.querySelectorAll('.editor .tb .tb__subleft > button')]
       .map((b) => (b.textContent || '').trim())
     return {
       count: labels.length,
       labels: labels.join(' / '),
       inLeft: !!left && left.querySelectorAll('button').length >= 6,
       more: !!document.querySelector('.editor .tb__more')
     }
   })()`)
  check('编辑区操作组落在工具栏左端（预览 / AI 整理 / 链接 / 引用 / 模板 / 全屏）',
    overflow.count >= 6 && overflow.inLeft === true &&
      String(overflow.labels).includes('全屏') && String(overflow.labels).includes('模板'),
    J(overflow))

  // 操作组显不显示文字，按**编辑区自身宽度**判断（容器查询），与窗口宽度解耦：
  // 1280 窗口下编辑区只有 700px，文字让位给格式条；1600 下文字回来。
  const narrowLabels = await app.evaluate(
    `[...document.querySelectorAll('.editor .tb .tb__subleft .tb-label')].every((x) => getComputedStyle(x).display === 'none')`
  )
  check('编辑区窄时操作组收成纯图标（宽度让给格式条）', narrowLabels === true, 'hidden=' + narrowLabels)
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(900)
  const wideLabels = await app.evaluate(
    `[...document.querySelectorAll('.editor .tb .tb__subleft .tb-label')].every((x) => getComputedStyle(x).display !== 'none')`
  )
  check('编辑区宽时操作组显示文字（容器查询按编辑区宽度判断）', wideLabels === true, 'shown=' + wideLabels)
  await app.send('Emulation.clearDeviceMetricsOverride')
  await sleep(700)

  // ---------------------------------------------------------- 2b. 标题行四合一 + 工具栏无边框
  // 标题 / 状态 / 标签 / 归属现在同一行；笔记类型下拉与元信息行整块撤掉。
  const headRow = await app.evaluate(`(() => {
     const lead = document.querySelector('.editor .tb__lead')
     if (!lead) return { missing: true }
     const chip = document.querySelector('.chip--save')
     const btn = document.querySelector('.editor .tb .text-btn')
     const cs = btn ? getComputedStyle(btn) : null
     const clear = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent'
     return {
       kids: [...lead.children].map((c) => c.className || c.tagName).join(' | '),
       chip: chip ? (chip.textContent || '').trim() : null,
       // 干净态：文案「已保存」且不带 dirty 修饰
       chipClean: chip ? chip.className.includes('chip--save') && !chip.className.includes('chip--save-dirty') : null,
       format: !!document.querySelector('.note-format'),
       meta: !!document.querySelector('.sheet__meta'),
       btnBorder: cs ? cs.borderTopWidth + ' ' + cs.borderTopColor : null,
       btnBg: cs ? cs.backgroundColor : null,
       btnPlain: cs ? clear(cs.borderTopColor) && clear(cs.backgroundColor) : null
     }
   })()`)
  check('标题行 = 标题 + 状态胶囊 + 标签胶囊 + 归属胶囊',
    !headRow.missing && headRow.kids.includes('editor__title') && headRow.kids.includes('chip--save') &&
      headRow.kids.includes('note-tags') && headRow.kids.includes('chip--meta'), headRow.kids)
  check('保存状态是常驻胶囊（干净态显示「已保存」）',
    headRow.chip === '已保存' && headRow.chipClean === true, 'chip=' + headRow.chip)
  check('笔记类型下拉与元信息行都已撤掉',
    headRow.format === false && headRow.meta === false, J({ format: headRow.format, meta: headRow.meta }))
  check('工具行按钮不带边框、不带底色（直接嵌进工具栏）',
    headRow.btnPlain === true, J({ border: headRow.btnBorder, bg: headRow.btnBg }))

  // 未保存态：动一下标题，胶囊要立刻换成「未保存」并切到 dirty 配色。
  // 这一步会短暂改标题（临时库里跑，改完还原），所以放在按标题查找的断言之后。
  const dirtyRun = await app.evaluate(`(async () => {
     const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
     const input = document.querySelector('.editor__title')
     if (!input) return { missing: true }
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
     const original = input.value
     setter.call(input, original + '·')
     input.dispatchEvent(new Event('input', { bubbles: true }))
     await sleep(200)
     const chip = document.querySelector('.chip--save')
     const after = chip ? (chip.textContent || '').trim() : ''
     const isDirty = chip ? chip.className.includes('chip--save-dirty') : false
     const dirtyColor = chip ? getComputedStyle(chip).color : null
     setter.call(input, original)
     input.dispatchEvent(new Event('input', { bubbles: true }))
     await sleep(1400)
     const back = (document.querySelector('.chip--save') || {}).textContent || ''
     return { after, isDirty, dirtyColor, restored: input.value === original, back: back.trim() }
   })()`)
  check('编辑标题后状态胶囊切到「未保存」并换配色',
    dirtyRun.after === '未保存' && dirtyRun.isDirty === true, J(dirtyRun))
  check('停手后回到「已保存」，标题也还原',
    dirtyRun.restored === true && dirtyRun.back === '已保存', J(dirtyRun))

  // ---------------------------------------------------------- 2c. 富文本：操作组并进格式条
  // 富文本正文自带格式条，那 6 个操作挂到它的**最左侧**，两者合成一条工具栏 ——
  // 标题栏下面不再单独占一行。
  const rtTitle = STAMP + ' 富文本验证'
  const rtId = await app.evaluate(
    `window.zhixing.db.createNote(${J(rtTitle)}, null, '', 'richtext').then((n) => n && n.id)`
  )
  check('已建富文本待验证笔记', Boolean(rtId), J({ rtId }))
  await app.evaluate(`document.querySelector('[data-nav-item="today"]').click()`)
  await sleep(600)
  await app.evaluate(`document.querySelector('[data-nav-item="notes"]').click()`)
  await sleep(1000)
  const rtOpened = await app.evaluate(`(() => {
     const b = [...document.querySelectorAll('.ntree__note')].find((x) => (x.querySelector('.ntree__title')?.textContent || '') === ${J(rtTitle)})
     if (!b) return false
     b.click()
     return true
   })()`)
  check('能打开富文本笔记', rtOpened)
  await sleep(1200)
  const rtRow = await app.evaluate(`(() => {
     const sub = document.querySelector('.rt-editor .tb .tb__sub')
     if (!sub) return { missing: true }
     const left = sub.querySelector('.tb__subleft')
     const right = sub.querySelector('.tb__subright')
     const pick = (el) => [...(el ? el.querySelectorAll('button') : [])].map((x) => (x.textContent || '').trim())
     const labels = pick(left)
     return {
       left: labels.join(' / '),
       leftCount: labels.length,
       sameRow: !!left && !!right && left.parentElement === right.parentElement,
       formatCount: pick(right).length,
       subRows: document.querySelectorAll('.sheet .tb__sub').length
     }
   })()`)
  check('富文本：操作组与格式条落在同一条工具栏里（左组 ≥ 6，右组是格式按钮）',
    !rtRow.missing && rtRow.sameRow === true && rtRow.leftCount >= 6 && rtRow.formatCount > 0, J(rtRow))
  check('富文本：工具行不再单独占一行（纸上只剩这一条工具栏）',
    rtRow.subRows === 1, 'subRows=' + rtRow.subRows)

  // 焦点框：富文本的 contenteditable 在 Chromium 里**鼠标点击也会匹配 :focus-visible**，
  // 所以必须用真实鼠标事件点一次才测得出来 —— element.focus() 测不到这一条。
  const pmRect = JSON.parse((await app.evaluate(`JSON.stringify((() => {
     const pm = document.querySelector('.rt-editor .ProseMirror')
     if (!pm) return null
     const r = pm.getBoundingClientRect()
     return { x: Math.round(r.x + 90), y: Math.round(r.y + 12) }
   })())`)) || 'null')
  if (pmRect) {
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pmRect.x, y: pmRect.y, button: 'left', clickCount: 1 })
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pmRect.x, y: pmRect.y, button: 'left', clickCount: 1 })
    await sleep(400)
  }
  const pmFocus = await app.evaluate(`(() => {
     const pm = document.querySelector('.rt-editor .ProseMirror')
     if (!pm) return { missing: true }
     const cs = getComputedStyle(pm)
     return {
       focused: pm === document.activeElement,
       focusVisible: pm.matches(':focus-visible'),
       outline: cs.outlineStyle + ' ' + cs.outlineWidth
     }
   })()`)
  check('富文本正文聚焦不画焦点框（点进去只有光标）',
    !pmFocus.missing && pmFocus.focused === true && String(pmFocus.outline).startsWith('none'), J(pmFocus))

  /**
   * 点容器底部的空白，看光标能不能被接进编辑器。
   * 可编辑元素（.cm-content / .ProseMirror）默认只有内容高，正文下方的空白不属于它 ——
   * 点上去没反应，用户读作「只有第一行能编辑」。撑满之后应当照样聚焦。
   */
  const hitBlank = async (boxSel, editSel) => {
    const ptExpr =
      'JSON.stringify((() => {\n' +
      '  const box = document.querySelector(' + J(boxSel) + ')\n' +
      '  if (!box) return null\n' +
      '  const r = box.getBoundingClientRect()\n' +
      '  return { x: Math.round(r.x + 100), y: Math.round(r.bottom - 24) }\n' +
      '})())'
    const pt = JSON.parse((await app.evaluate(ptExpr)) || 'null')
    if (!pt) return { missing: true }
    await app.evaluate('document.activeElement && document.activeElement.blur()')
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(350)
    const readExpr =
      '(() => {\n' +
      '  const ed = document.querySelector(' + J(editSel) + ')\n' +
      '  const box = document.querySelector(' + J(boxSel) + ')\n' +
      '  return {\n' +
      '    focused: !!ed && ed === document.activeElement,\n' +
      '    editableH: ed ? Math.round(ed.getBoundingClientRect().height) : null,\n' +
      '    boxH: box ? Math.round(box.getBoundingClientRect().height) : null\n' +
      '  }\n' +
      '})()'
    return await app.evaluate(readExpr)
  }
  const rtCanvas = await hitBlank('.rt-editor__body', '.rt-editor .ProseMirror')
  check('富文本：点正文下方空白也能把光标接进编辑器',
    rtCanvas.focused === true && rtCanvas.editableH === rtCanvas.boxH, J(rtCanvas))

  // ---------------------------------------------------------- 2d. Word：头部并进工具栏
  // Word 原有一条只放「状态 + 导出 .docx + 用系统应用打开」的头部（40px），
  // 现在状态进工具栏的小字位、两个按钮进最右端（不参与折叠）。
  const wordTitle = STAMP + ' Word 验证'
  const wordId = await app.evaluate(
    `window.zhixing.db.createNote(${J(wordTitle)}, null, '', 'word').then((n) => n && n.id)`
  )
  check('已建 Word 待验证笔记', Boolean(wordId), J({ wordId }))
  await app.evaluate(`document.querySelector('[data-nav-item="today"]').click()`)
  await sleep(600)
  await app.evaluate(`document.querySelector('[data-nav-item="notes"]').click()`)
  await sleep(1000)
  const wordOpened = await app.evaluate(`(() => {
     const b = [...document.querySelectorAll('.ntree__note')].find((x) => (x.querySelector('.ntree__title')?.textContent || '') === ${J(wordTitle)})
     if (!b) return false
     b.click()
     return true
   })()`)
  check('能打开 Word 笔记', wordOpened)
  await sleep(1600)
  const wordRow = await app.evaluate(`(() => {
     const head = document.querySelector('.editor__office-head')
     const rt = document.querySelector('.editor__office-body .rt-editor .tb')
     const meta = rt ? rt.querySelector('.tb__meta') : null
     const labels = [...document.querySelectorAll('.editor__office-body .rt-editor .tb button')]
       .map((b) => (b.textContent || '').trim())
     return {
       headGone: head === null,
       meta: meta ? (meta.textContent || '').trim() : null,
       leftCount: document.querySelectorAll('.editor__office-body .rt-editor .tb .tb__subleft > button').length,
       hasExport: labels.includes('导出 .docx'),
       hasOpen: labels.includes('用系统应用打开'),
       subRows: document.querySelectorAll('.sheet .tb__sub').length
     }
   })()`)
  // 状态提示（「Word 可编辑（自动写回 .docx）· …」）按产品决定撤掉，只剩两个按钮。
  check('Word：两个按钮在工具栏最右端，头部与状态提示都已撤',
    wordOpened && wordRow.headGone === true && wordRow.meta === null &&
      wordRow.hasExport === true && wordRow.hasOpen === true && wordRow.subRows === 1,
    J(wordRow))

  // 保存状态走标题栏胶囊：编辑 → 「未保存」，写回完成 → 「已保存」。
  // 成功的写回不再弹 toast（每停一次手弹一条「已写回 …」是噪音），失败才提示。
  const wordPt = JSON.parse((await app.evaluate('JSON.stringify((() => {\n' +
     '  const pm = document.querySelector(".editor__office-body .ProseMirror")\n' +
     '  if (!pm) return null\n' +
     '  const r = pm.getBoundingClientRect()\n' +
     '  return { x: Math.round(r.x + 80), y: Math.round(r.y + 14) }\n' +
     '})())')) || 'null')
  if (wordPt) {
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: wordPt.x, y: wordPt.y, button: 'left', clickCount: 1 })
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: wordPt.x, y: wordPt.y, button: 'left', clickCount: 1 })
    await sleep(150)
    await app.send('Input.insertText', { text: '（改一下）' })
    await sleep(250)
  }
  const chipAfterEdit = await app.evaluate(`(() => {
     const c = document.querySelector('.chip--save')
     return c ? { text: (c.textContent || '').trim(), dirty: c.className.includes('chip--save-dirty') } : null
   })()`)
  check('Word 编辑后标题栏胶囊切到「未保存」',
    chipAfterEdit?.dirty === true && chipAfterEdit?.text === '未保存', J(chipAfterEdit))
  // 写回在 800ms 防抖之后触发；此刻检查 toast —— 成功路径不该有
  await sleep(1400)
  const toastCount = await app.evaluate(`document.querySelectorAll('.toast').length`)
  check('Word 写回成功不弹提示（改由胶囊表达）', toastCount === 0, 'toast=' + toastCount)
  const chipAfterSave = await app.evaluate(`(() => {
     const c = document.querySelector('.chip--save')
     return c ? { text: (c.textContent || '').trim(), dirty: c.className.includes('chip--save-dirty') } : null
   })()`)
  check('写回完成后胶囊回到「已保存」',
    chipAfterSave?.dirty === false && chipAfterSave?.text === '已保存', J(chipAfterSave))

  // ------------------------------------------------ Excel：出口按钮与 Word 落在同一条工具栏
  // Excel 没有格式条可挂，「用系统应用打开」挂到页面工具栏的最右端不折叠位；
  // 原先那条只装一句状态文案 + 一个按钮的头部整块撤掉 —— 与 Word 的结构一致。
  const excelTitle = STAMP + ' Excel 出口'
  const excelId = await app.evaluate(
    `window.zhixing.db.createNote(${J(excelTitle)}, null, '', 'excel').then((n) => n && n.id)`
  )
  check('已建 Excel 待验证笔记', Boolean(excelId), J({ excelId }))
  await app.evaluate(`document.querySelector('[data-nav-item="today"]').click()`)
  await sleep(600)
  await app.evaluate(`document.querySelector('[data-nav-item="notes"]').click()`)
  await sleep(1000)
  const excelOpened = await app.evaluate(`(() => {
     const b = [...document.querySelectorAll('.ntree__note')].find((x) => (x.querySelector('.ntree__title')?.textContent || '') === ${J(excelTitle)})
     if (!b) return false
     b.click()
     return true
   })()`)
  check('能打开 Excel 笔记', excelOpened)
  await sleep(2200)
  const excelRow = await app.evaluate(`(() => {
     const head = document.querySelector('.editor__office-head')
     const bar = document.querySelector('.sheet > .tb .tb__subright')
     const labels = bar ? [...bar.querySelectorAll('button')].map((b) => (b.textContent || '').trim()) : []
     return {
       headGone: head === null,
       labels,
       inBar: labels.includes('用系统应用打开'),
       openIsLast: labels[labels.length - 1] === '用系统应用打开',
       subRows: document.querySelectorAll('.sheet .tb__sub').length
     }
   })()`)
  check('Excel：出口按钮在工具栏最右端不折叠位，头部整行已撤',
    excelRow.headGone === true && excelRow.inBar === true && excelRow.openIsLast === true && excelRow.subRows === 1,
    J(excelRow))

  // 回到 Markdown 笔记：后面的断言继续在它上面跑
  await app.evaluate(`(() => {
     const b = [...document.querySelectorAll('.ntree__note')].find((x) => (x.querySelector('.ntree__title')?.textContent || '') === ${J(title)})
     if (b) b.click()
   })()`)
  await sleep(900)
  const mdCanvas = await hitBlank('.md-editor .cm-scroller', '.md-editor .cm-content')
  check('Markdown：点正文下方空白也能把光标接进编辑器',
    mdCanvas.focused === true && mdCanvas.editableH === mdCanvas.boxH, J(mdCanvas))

  const ratio = await app.evaluate(`(() => {
     const main = document.querySelector('.notes-main')
     const body = document.querySelector('.sheet__body')
     if (!main || !body) return null
     return Math.round((body.getBoundingClientRect().height / main.getBoundingClientRect().height) * 100)
   })()`)
  check('正文区占到编辑区六成以上（改造前空态约 46%）', ratio != null && ratio >= 60, ratio + '%')
  await shot('notesheet-1280.png')

  // ---------------------------------------------------------- 3. 展开态可见性
  await app.evaluate(`document.querySelector('.links__toggle').click()`)
  await sleep(500)
  const cards = await app.evaluate("document.querySelectorAll('.links__body .links__card').length")
  check('展开后三组信息全部可见', (await box('.links--open')) !== null && cards >= 3, 'cards=' + cards)
  const heads = await app.evaluate(`[...document.querySelectorAll('.links__head')].map((x) => x.textContent.split('·')[0].trim()).join(' / ')`)
  check('分组标题仍是属性 / 反向链接 / 引用 / 归属',
    String(heads).includes('属性') && String(heads).includes('反向链接') && String(heads).includes('引用') && String(heads).includes('归属'),
    heads)
  await shot('notesheet-open.png')
  await app.evaluate(`document.querySelector('.links__toggle').click()`)
  await sleep(400)

  // ---------------------------------------------------------- 4. 全屏编辑
  check('工具栏有「全屏」入口', await clickByText('.editor .tb .tb-btn, .editor .tb button', '全屏'))
  await sleep(500)
  const zen = await app.evaluate(`({
     page: !!document.querySelector('.page--zen'),
     app: !!document.querySelector('.app--zen'),
     head: getComputedStyle(document.querySelector('.page__head')).display,
     tree: getComputedStyle(document.querySelector('.ntree')).display,
     nav: getComputedStyle(document.querySelector('.sidebar')).display
   })`)
  check('全屏：页面头 / 笔记树 / 左侧导航一起让位',
    zen.page && zen.app && zen.head === 'none' && zen.tree === 'none' && zen.nav === 'none', J(zen))
  await shot('notesheet-zen.png')
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(500)
  check('Esc 退出全屏', (await app.evaluate("!!document.querySelector('.page--zen')")) === false)

  // ---------------------------------------------------------- 5. 窄窗口 → 覆盖式抽屉
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false })
  await sleep(800)
  const innerW = await app.evaluate('window.innerWidth')
  check('视口已切到 1024（用于窄窗形态）', innerW === 1024, 'innerWidth=' + innerW)
  await app.evaluate(`document.querySelector('.links__toggle').click()`)
  await sleep(500)
  const drawer = await box('.links--drawer')
  const scrim = await app.evaluate("!!document.querySelector('.links__scrim')")
  check('窄窗口展开态是覆盖式抽屉（fixed + 遮罩），不挤压正文',
    drawer !== null && drawer.position === 'fixed' && scrim, J({ drawer, scrim }))
  await shot('notesheet-1024-drawer.png')
  await app.evaluate(`document.querySelector('.links__toggle').click()`)
  await app.send('Emulation.clearDeviceMetricsOverride')
  await sleep(500)

  // ---------------------------------------------------------- 6. 链接体检入口
  const audit = await app.evaluate(`(() => {
     const b = [...document.querySelectorAll('.ntree__topbar .text-btn')].find((x) => (x.textContent || '').includes('链接体检'))
     if (!b) return false
     b.click()
     return true
   })()`)
  await sleep(400)
  const auditItems = await app.evaluate(`[...document.querySelectorAll('.popmenu__item')].map((x) => x.textContent.trim()).join(' / ')`)
  check('链接体检入口在笔记树上，菜单含孤儿 / 失效两项',
    audit && String(auditItems).includes('孤儿') && String(auditItems).includes('失效链接'), auditItems)
  await app.evaluate(`document.body.click()`)
  await sleep(200)

  console.log('（截图已存 .screenshots/notesheet-1280.png、notesheet-open.png、notesheet-zen.png、notesheet-1024-drawer.png）')
} catch (err) {
  check('脚本执行完成', false, err instanceof Error ? err.message : String(err))
}

await app.evaluate(`document.querySelector('[data-nav-item="notes"]').click()`).catch(() => {})
await app.close()
process.exit(finish())
