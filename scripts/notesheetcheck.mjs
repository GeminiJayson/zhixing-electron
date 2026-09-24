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

  // ---------------------------------------------------------- 2. 信息条默认收起
  const links = await box('.links')
  check('信息区默认收起（.links--collapsed，无 .links__body）',
    Boolean(await box('.links--collapsed')) && (await app.evaluate("!!document.querySelector('.links__body')")) === false,
    J(links))
  check('收起态只占一行（≤ 3 倍控件高）', Boolean(links) && links.h <= 96, links ? links.h + 'px' : 'null')

  // 工具行不该把「全屏 / 模板」藏进「⋯」：格式下拉限宽后 6 个入口都放得下
  const overflow = await app.evaluate(`(() => {
     const more = document.querySelector('.editor .tb__more')
     const labels = [...document.querySelectorAll('.editor .tb__subright > span > button')]
       .map((b) => (b.textContent || '').trim())
       .join(' / ')
     const fmt = document.querySelector('.editor .note-format')
     return { more: !!more, labels, fmt: fmt ? Math.round(fmt.getBoundingClientRect().width) : null }
   })()`)
  check('1280 窗口下工具行不折叠（全屏 / 模板 不藏进「⋯」）',
    overflow.more === false && String(overflow.labels).includes('全屏') && String(overflow.labels).includes('模板'),
    J(overflow))
  check('格式下拉不被通用填充拉宽（≤ 200px）', overflow.fmt != null && overflow.fmt <= 200, 'fmt=' + overflow.fmt + 'px')

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
