/**
 * 清单 / 标签三项改造的端到端验收：
 *
 *   1. 清单侧栏：分组与清单都看得见，含「已完成 / 已放弃」两个终态入口与未完成计数；
 *   2. 终态收归：完成任务后它从原清单消失、出现在「已完成」里，并标出原来属于哪个清单；
 *   3. 标签颜色：任务行的标签胶囊可以就地改色，色值落库；
 *   4. 笔记标签：笔记可以打标签，编辑区与左侧树都出胶囊（与任务共用一套标签）。
 *
 * 夹具是 seedIfEmpty() 造的基线：分组「工作 / 生活」+ 清单「我的清单」+ 2 条任务。
 */
import { join } from 'node:path'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

const tmpHome = join(ROOT, '.screenshots', 'taglist-home')
const PORT = 9395

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()

/** 侧栏里所有入口的名字 */
const SIDEBAR = `(() => [...document.querySelectorAll('.tasklists__row')].map((r) => r.querySelector('.tasklists__name')?.textContent?.trim()))()`
/** 当前列表里的行：标题 + 来源清单胶囊 */
const ROWS = `(() => [...document.querySelectorAll('.trow')].map((r) => ({
  title: r.querySelector('.trow__title')?.textContent?.trim() || '',
  list: r.querySelector('.chip--list')?.textContent?.trim() || '',
  tags: [...r.querySelectorAll('.chip--tag')].map((c) => c.textContent.trim())
})))()`

const clickRow = (name) => `(() => {
  const r = [...document.querySelectorAll('.tasklists__row')].find((x) => x.querySelector('.tasklists__name')?.textContent.trim() === '${name}')
  if (!r) return false
  r.click()
  return true
})()`

try {
  console.log('【就绪】等界面稳定…')
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    if (i % 3 === 2) console.log('  ' + Math.round((i + 1) * 0.5) + 's')
  }

  await app.evaluate("document.querySelector('[data-nav-item=\"tasks\"]')?.click()")
  await sleep(1800)

  // ---------------------------------------------------------------- 1. 清单侧栏
  const sidebar = await app.evaluate(SIDEBAR)
  check(
    '任务页有清单侧栏，分组（工作/生活）与两个终态入口都在',
    Array.isArray(sidebar) &&
      ['全部任务', '收件箱', '工作', '生活', '我的清单', '已完成', '已放弃'].every((n) => sidebar.includes(n)),
    J(sidebar)
  )

  // ---------------------------------------------------------------- 2. 标签改色（任务）
  const seeded = await app.evaluate(`(async () => {
    const db = window.zhixing.db
    const all = await db.tasks()
    const t = all.find((x) => x.parent_id == null && x.status !== 'done' && x.status !== 'abandoned')
    if (!t) return null
    await db.setTaskTags(t.id, ['巡检标签'])
    const tags = await db.tags()
    const tag = tags.find((x) => x.name === '巡检标签')
    return { taskId: t.id, title: t.title, tagId: tag ? tag.id : 0, color: tag ? tag.color : '' }
  })()`)
  check('拿到一条可操作的任务并给它打了标签', !!seeded && seeded.tagId > 0, J(seeded))
  await sleep(1400)

  await clickRow('全部任务')
  await sleep(400)
  const chipClicked = await app.evaluate(
    "(() => { const c = document.querySelector('.trow .chip--tag'); if (!c) return false; c.click(); return true })()"
  )
  await sleep(500)
  const menuOpen = await app.evaluate("!!document.querySelector('.tagmenu')")
  check('点行内标签胶囊打开标签弹层', chipClicked && menuOpen, J({ chipClicked, menuOpen }))

  const swatchClicked = await app.evaluate(`(() => {
    const s = document.querySelector('.tagmenu__swatch')
    if (!s) return false
    s.click()
    return true
  })()`)
  await sleep(300)
  const presetClicked = await app.evaluate(`(() => {
    const b = [...document.querySelectorAll('.tagmenu__color')].find((x) => x.getAttribute('title') === '#BE123C')
    if (!b) return false
    b.click()
    return true
  })()`)
  check('标签弹层里能展开调色板并点选颜色', swatchClicked && presetClicked, J({ swatchClicked, presetClicked }))
  await sleep(1200)

  const colorState = await app.evaluate(`(async () => {
    const tags = await window.zhixing.db.tags()
    const t = tags.find((x) => x.id === ${seeded ? seeded.tagId : 0})
    const chip = document.querySelector('.trow .chip--tag')
    return { db: t ? t.color : '', chip: chip ? (chip.style.background || chip.style.backgroundColor) : '' }
  })()`)
  const norm = (v) => String(v || '').toLowerCase().replace(/\s/g, '')
  check(
    '标签颜色写进数据库并即时反映到胶囊',
    norm(colorState.db) === '#be123c' && norm(colorState.chip) === 'rgb(190,18,60)',
    J(colorState)
  )

  // 关掉弹层，免得挡住后面的点击
  await app.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
  await sleep(300)

  // ---------------------------------------------------------------- 3. 终态收归
  await app.evaluate(`window.zhixing.db.toggleTask(${seeded ? seeded.taskId : 0})`)
  await sleep(1400)

  const stillThere = await app.evaluate(ROWS)
  const carr = (rows) => rows.map((r) => r.title)
  check(
    '完成任务后它从当前清单列表里被收走',
    !carr(stillThere).includes(seeded ? seeded.title : ''),
    J(carr(stillThere))
  )

  const opened = await app.evaluate(clickRow('已完成'))
  check('侧栏「已完成」可以点开', opened === true)
  await sleep(700)

  const doneRows = await app.evaluate(ROWS)
  const doneRow = doneRows.find((r) => r.title === (seeded ? seeded.title : ''))
  check(
    '已完成清单里能看到该任务，并标出它原来的清单',
    !!doneRow && doneRow.list === '我的清单',
    J({ doneRows: doneRows.map((r) => r.title + ' @ ' + r.list) })
  )
  check(
    '已完成的行里仍带着它的标签胶囊',
    !!doneRow && doneRow.tags.includes('巡检标签'),
    J(doneRow)
  )

  const myList = await app.evaluate(clickRow('我的清单'))
  await sleep(700)
  const myRows = await app.evaluate(ROWS)
  check(
    '回到原清单看不到这条已完成任务',
    myList === true && !carr(myRows).includes(seeded ? seeded.title : ''),
    J(carr(myRows))
  )

  // ---------------------------------------------------------------- 4. 分组
  const made = await app.evaluate(`(async () => {
    const g = await window.zhixing.db.createListFolder('验收分组', 'group', null)
    const l = await window.zhixing.db.createListFolder('验收清单', 'list', g.id)
    const ring = await window.zhixing.db.moveListFolder(g.id, g.id)
    return { groupId: g.id, listId: l.id, ring }
  })()`)
  check('新建分组 / 子清单成功，且分组不能移进自己', made && made.ring === 0, J(made))
  await sleep(1200)

  const sidebar2 = await app.evaluate(SIDEBAR)
  check(
    '新建的分组与子清单立刻出现在侧栏',
    sidebar2.includes('验收分组') && sidebar2.includes('验收清单'),
    J(sidebar2)
  )

  const moved = await app.evaluate(`(async () => {
    const folders = await window.zhixing.db.listFolders()
    const list = folders.find((f) => f.name === '验收清单')
    const group = folders.find((f) => f.name === '工作')
    if (!list || !group) return 0
    return window.zhixing.db.moveListFolder(list.id, group.id)
  })()`)
  check('清单可以移动到别的分组下', moved === 1, J(moved))
  await sleep(1100)

  // 移动之后下拉里应该按 optgroup 归类：分组是空的就不渲染（避免空标签）
  const grouped = await app.evaluate(
    "(() => [...document.querySelectorAll('select[aria-label=\"按清单筛选\"] optgroup')].map((o) => ({ label: o.label, kids: [...o.querySelectorAll('option')].map((x) => x.textContent.trim()) })))()"
  )
  check(
    '清单下拉里按分组 optgroup 归类',
    Array.isArray(grouped) &&
      grouped.some((g) => g.label === '工作' && g.kids.includes('验收清单')),
    J(grouped)
  )

  const doneCount = await app.evaluate(`(() => {
    const r = [...document.querySelectorAll('.tasklists__row')].find((x) => x.querySelector('.tasklists__name')?.textContent.trim() === '已完成')
    return r ? r.querySelector('.tasklists__count')?.textContent?.trim() : null
  })()`)
  check('侧栏「已完成」带上了计数', doneCount !== null && Number(doneCount) >= 1, J(doneCount))

  // ---------------------------------------------------------------- 5. 笔记标签
  await app.evaluate("document.querySelector('[data-nav-item=\"notes\"]')?.click()")
  await sleep(1800)

  const picked = await app.evaluate(
    "(() => { const r = document.querySelector('.ntree__note'); if (!r) return false; r.click(); return true })()"
  )
  check('笔记页能选中一篇笔记', picked === true)
  await sleep(900)

  const addClicked = await app.evaluate(
    "(() => { const b = document.querySelector('.note-tags .chip--tag-add'); if (!b) return false; b.click(); return true })()"
  )
  await sleep(500)
  const tagMenuOpen = await app.evaluate("!!document.querySelector('.tagmenu')")
  check('笔记页的「加标签」能打开标签弹层', addClicked && tagMenuOpen, J({ addClicked, tagMenuOpen }))

  const ticked = await app.evaluate(`(() => {
    const b = [...document.querySelectorAll('.tagmenu__name')].find((x) => x.textContent.includes('巡检标签'))
    if (!b) return false
    b.click()
    return true
  })()`)
  check('弹层里能勾选已有标签（任务与笔记共用一套）', ticked === true)
  await sleep(1300)

  const noteState = await app.evaluate(`(async () => {
    const nt = await window.zhixing.db.noteTags()
    return {
      linked: nt.length,
      editorChips: [...document.querySelectorAll('.note-tags .chip--tag')].map((c) => c.textContent.trim()),
      treeChips: [...document.querySelectorAll('.ntree__tags .chip')].map((c) => c.textContent.trim()),
    }
  })()`)
  check(
    '笔记标签落库，编辑区与左侧树都出胶囊',
    noteState.linked > 0 && noteState.editorChips.includes('巡检标签') && noteState.treeChips.includes('巡检标签'),
    J(noteState)
  )

  // 笔记侧改色：同一个 tag 的颜色改动要同时作用于任务与笔记
  const noteColor = await app.evaluate(`(() => {
    const chip = document.querySelector('.note-tags .chip--tag')
    if (!chip) return false
    chip.click()
    return true
  })()`)
  await sleep(400)
  await app.evaluate(`(() => {
    const s = document.querySelector('.tagmenu__swatch')
    if (s) s.click()
  })()`)
  await sleep(300)
  await app.evaluate(`(() => {
    const b = [...document.querySelectorAll('.tagmenu__color')].find((x) => x.getAttribute('title') === '#2563EB')
    if (b) b.click()
  })()`)
  await sleep(1000)
  const shared = await app.evaluate(`(async () => {
    const tags = await window.zhixing.db.tags()
    const t = tags.find((x) => x.id === ${seeded ? seeded.tagId : 0})
    const chip = document.querySelector('.note-tags .chip--tag')
    return { db: t ? t.color : '', chip: chip ? chip.style.background : '' }
  })()`)
  check(
    '在笔记侧改色同样写到共用的标签表（任务侧也会跟着变）',
    noteColor === true && norm(shared.db) === '#2563eb',
    J(shared)
  )
} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}
await app.close()
process.exit(finish())
