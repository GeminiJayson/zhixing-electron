/**
 * 笔记多标签页（tab）的回归检查。
 *
 * 守这几件事（设计与拍板见 docs/note-tabs-plan.md）：
 *   1. **打开即留存**：打开过的笔记留在 tab 条里；只有 1 篇时整条不渲染（不占位）。
 *   2. **去重激活**：已打开的笔记再点只激活，不重复开一枚。
 *   3. **切换**：点 tab 换正文，标题与笔记树上的高亮一起跟着走。
 *   4. **关闭顺序**：关当前 → 右邻 → 左邻；中键点击也能关。
 *   5. **先落盘再切走**：切换前 <800ms 的未落盘编辑不能丢（flushPending）。
 *   6. **上限 12**：第 13 篇进来时，最久未使用的那个被挤出去。
 *   7. **收敛**：笔记被删掉后，它的 tab 不再留着（不留死标签）。
 *   8. **跨页恢复**：离开笔记页再回来，列表与激活项都还在（localStorage）。
 *
 * 观察方式上的一个坑（写在这里免得下次又踩）：
 *   **≤1 枚 tab 时整条不渲染**，所以「当前是哪一篇」不能只看 `.note-tab--active`
 *   —— 那在只剩一枚时是空的。凡是判断激活项，一律读**笔记树高亮**
 *   （`.ntree__note--on`，它永远反映 selectedId）或编辑区标题。
 *
 * 用法：node scripts/notetabcheck.mjs（需先 npm run build）
 */
import { join } from 'node:path'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

const tmpHome = join(ROOT, '.screenshots', 'notetab-home')
const PORT = 9396
/** 与 NotesPage 的 TAB_MAX 保持一致：改了那边这里也要改 */
const TAB_MAX = 12

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()

const ev = (expr) => app.evaluate(expr)
const tabTitles = () => ev(`[...document.querySelectorAll('.note-tab__title')].map((x) => x.textContent.trim())`)
const activeTab = () => ev(`(document.querySelector('.note-tab--active .note-tab__title') || {}).textContent || null`)
const editorTitle = () => ev(`(document.querySelector('.editor__title') || {}).value || null`)
const treeOn = () => ev(`(document.querySelector('.ntree__note--on .ntree__title') || {}).textContent || null`)

const titleOf = (i) => 'TB' + String(i).padStart(2, '0') + ' 标签验证'

/** 在笔记树上点开某一篇 */
const clickTree = (title) =>
  ev(`(() => {
     const b = [...document.querySelectorAll('.ntree__note')].find((x) => (x.querySelector('.ntree__title') || {}).textContent === ${J(title)})
     if (!b) return false
     b.click()
     return true
   })()`)

const clickTab = (i) =>
  ev(`(() => {
     const t = document.querySelectorAll('.note-tab')[${i}]
     if (!t) return false
     t.click()
     return true
   })()`)

const closeTab = (i) =>
  ev(`(() => {
     const all = document.querySelectorAll('.note-tab')
     const b = all[${i}] && all[${i}].querySelector('.note-tab__close')
     if (!b) return false
     b.click()
     return true
   })()`)

const nav = async (item) => {
  await ev(`document.querySelector('[data-nav-item="${item}"]').click()`)
  await sleep(900)
}

/** 把 tab 列表清空并重新挂载：清 localStorage + 切页往返（笔记页会重新读一次） */
const resetTabs = async () => {
  await ev(`localStorage.removeItem('zhixing.noteTabs')`)
  await nav('today')
  await nav('notes')
  await sleep(500)
}

/** 点一下某个输入框、全选、再打字（走真实鼠标 + Ctrl+A，避免插进标题中间） */
const retype = async (sel, text) => {
  const pt = JSON.parse(
    await ev(`JSON.stringify((() => {
       const el = document.querySelector(${J(sel)})
       if (!el) return null
       const r = el.getBoundingClientRect()
       return { x: Math.round(r.x + 30), y: Math.round(r.y + r.height / 2) }
     })())`)
  )
  if (!pt) return false
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(150)
  // modifiers: 2 = Ctrl（全选，替换而不是插进中间）
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await sleep(80)
  await app.send('Input.insertText', { text })
  return true
}

try {
  // ---------------------------------------------------------- 0. 备料：13 篇笔记
  const ids = await ev(`(async () => {
     const out = []
     for (let i = 1; i <= ${TAB_MAX + 1}; i++) {
       const t = 'TB' + String(i).padStart(2, '0') + ' 标签验证'
       const n = await window.zhixing.db.createNote(t, null)
       out.push(n && n.id)
     }
     return out
   })()`)
  check('造出 13 篇待验证笔记', Array.isArray(ids) && ids.filter(Boolean).length === TAB_MAX + 1, J({ made: ids && ids.length }))
  // 新建笔记不会自动刷新笔记树：切页往返一次，走笔记页的 load()
  await nav('today')
  await nav('notes')
  await resetTabs()

  // ---------------------------------------------------------- 1. 打开即留存
  await clickTree(titleOf(1))
  await sleep(900)
  check('只打开一篇时 tab 条不渲染（≤1 枚不占位）',
    (await tabTitles()).length === 0 && String(await editorTitle()).includes('TB01'),
    J({ tabs: await tabTitles(), editor: await editorTitle() }))

  await clickTree(titleOf(2))
  await sleep(900)
  const two = await tabTitles()
  check('打开第二篇 → tab 条出现，两枚按打开顺序排列',
    two.length === 2 && two[0].includes('TB01') && two[1].includes('TB02'), J(two))
  check('两枚装得下 → 不出现「选择」入口',
    (await ev(`!!document.querySelector('.note-tabs__pick')`)) === false, '')

  // ---------------------------------------------------------- 2. 去重激活
  await clickTree(titleOf(1))
  await sleep(800)
  const dedup = await tabTitles()
  const dedupActive = await activeTab()
  check('再点已打开的笔记 → 只激活、不重复开',
    dedup.length === 2 && String(dedupActive).includes('TB01'), J({ tabs: dedup, active: dedupActive }))

  // ---------------------------------------------------------- 3. 切换：正文 / 树上高亮一起走
  await clickTab(1)
  await sleep(800)
  const swapped = { editor: await editorTitle(), tree: await treeOn(), active: await activeTab() }
  check('点 tab 切到那一篇：编辑区标题与笔记树高亮同步',
    String(swapped.editor).includes('TB02') && String(swapped.tree).includes('TB02') && String(swapped.active).includes('TB02'),
    J(swapped))

  // ---------------------------------------------------------- 4. 关闭顺序
  await clickTree(titleOf(3))
  await sleep(900)
  check('第三篇进来后是三枚 tab', (await tabTitles()).length === 3, J(await tabTitles()))

  await clickTab(0)
  await sleep(700)
  await closeTab(0)
  await sleep(800)
  check('关闭当前 tab → 激活右邻（关 TB01 后到 TB02）',
    String(await treeOn()).includes('TB02') && (await tabTitles()).length === 2,
    J({ tree: await treeOn(), tabs: await tabTitles() }))

  await clickTab(1)
  await sleep(700)
  await closeTab(1)
  await sleep(800)
  check('关闭最右的 tab → 激活左邻（关 TB03 后回到 TB02）', String(await treeOn()).includes('TB02'), J({ tree: await treeOn() }))
  check('只剩一枚时 tab 条整条消失（不占位），笔记仍然开着',
    (await tabTitles()).length === 0 && String(await editorTitle()).includes('TB02'),
    J({ tabs: await tabTitles(), editor: await editorTitle() }))

  // ---------------------------------------------------------- 5. 上限 12
  await resetTabs()
  for (let i = 1; i <= TAB_MAX + 1; i++) {
    await clickTree(titleOf(i))
    await sleep(300)
  }
  await sleep(600)
  const capped = await tabTitles()
  check('打开 13 篇 → 只留 12 枚，最久未使用的 TB01 被挤出',
    capped.length === TAB_MAX && !capped.some((t) => t.includes('TB01')) && capped[TAB_MAX - 1].includes('TB13'),
    J({ n: capped.length, first: capped[0], last: capped[TAB_MAX - 1] }))

  // ---------------------------------------------------------- 5b. 装不下时的「选择」入口
  // 横向滚动是个不可见的手势：装不下时必须给一个看得见的入口，否则被推到视口外的
  // 那几篇等于没有入口。
  check('12 枚装不下 → 出现「选择」入口',
    (await ev(`!!document.querySelector('.note-tabs__pick')`)) === true, '')

  const menuOpened = await ev(`(() => {
     const b = document.querySelector('.note-tabs__pick')
     if (!b) return false
     b.click()
     return true
   })()`)
  await sleep(450)
  const menuItems = await ev(`[...document.querySelectorAll('.popmenu__item')].map((x) => x.textContent.trim())`)
  const ticked = await ev(`document.querySelectorAll('.popmenu__tick--on').length`)
  check('选择入口列出全部已打开的笔记（12 项），当前那枚带勾',
    menuOpened === true && Array.isArray(menuItems) && menuItems.length === TAB_MAX && ticked === 1,
    J({ opened: menuOpened, n: menuItems && menuItems.length, ticked }))

  const pickTarget = String((menuItems && menuItems[2]) || '')
  await ev(`(() => {
     const it = document.querySelectorAll('.popmenu__item')[2]
     if (it) it.click()
   })()`)
  await sleep(900)
  check('从列表里选一篇 → 立刻切过去',
    pickTarget !== '' && String(await treeOn()).includes(pickTarget.slice(0, 4)),
    J({ pickTarget, tree: await treeOn() }))

  // ---------------------------------------------------------- 6. 中键关闭
  const beforeMid = (await tabTitles()).length
  const midPt = JSON.parse(
    await ev(`JSON.stringify((() => {
       const t = document.querySelector('.note-tab')
       if (!t) return null
       const r = t.getBoundingClientRect()
       return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
     })())`)
  )
  if (midPt) {
    // buttons: 4 是中键位掩码；不带它 Chromium 不会派发 auxclick
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: midPt.x, y: midPt.y, button: 'middle', buttons: 4, clickCount: 1 })
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: midPt.x, y: midPt.y, button: 'middle', buttons: 0, clickCount: 1 })
    await sleep(600)
  }
  if ((await tabTitles()).length === beforeMid && midPt) {
    // 仍没关掉：退回合成事件（React 的 onAuxClick 委托在 root 上，bubbles 就能收到）
    await ev(`(() => {
       const t = document.querySelector('.note-tab')
       if (t) t.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))
     })()`)
    await sleep(800)
  }
  check('中键点击关闭那枚 tab', (await tabTitles()).length === beforeMid - 1,
    J({ before: beforeMid, after: (await tabTitles()).length }))

  // ---------------------------------------------------------- 7. 跨页恢复
  const beforeNav = { tabs: await tabTitles(), active: await activeTab() }
  await nav('today')
  await sleep(400)
  await nav('notes')
  await sleep(1400)
  const afterNav = { tabs: await tabTitles(), active: await activeTab() }
  check('离开笔记页再回来：列表与激活项都恢复',
    afterNav.tabs.length === beforeNav.tabs.length &&
      afterNav.active === beforeNav.active &&
      afterNav.tabs[0] === beforeNav.tabs[0],
    J({ before: beforeNav, after: afterNav }))

  // ---------------------------------------------------------- 8. 删除收敛
  const victim = await ev(`window.zhixing.db.notes().then((ns) => {
     const n = ns.find((x) => x.title === ${J(titleOf(TAB_MAX + 1))})
     return n ? n.id : null
   })`)
  const hadVictim = (await tabTitles()).some((t) => t.includes('TB13'))
  await ev(`window.zhixing.db.deleteNote(${victim})`)
  await nav('today')
  await nav('notes')
  await sleep(900)
  check('笔记被删掉后，它的 tab 随之收敛（不留死标签）',
    hadVictim === true && !(await tabTitles()).some((t) => t.includes('TB13')),
    J({ victim, hadVictim, tabs: await tabTitles() }))

  // ---------------------------------------------------------- 9. 切走前先落盘
  // 改标题后立刻切走（不等 800ms 自动保存），切回来内容必须还在。
  // 注意这里不能假设「当前就是最后一枚」—— 上面从列表选过一篇，激活项已经换了，
  // 所以要按当前那枚的**下标**切走再切回同一枚。
  const stayTitle = String(await treeOn())
  const stayIdx = (await tabTitles()).findIndex((t) => t.includes(stayTitle.slice(0, 4)))
  const awayIdx = stayIdx === 0 ? 1 : 0
  await retype('.editor__title', '落盘验证')
  await sleep(120)
  await clickTab(awayIdx)
  await sleep(600)
  await clickTab(stayIdx)
  await sleep(1000)
  const kept = await editorTitle()
  check('切走前 <800ms 的未落盘编辑会先落盘（切回来还在）',
    stayIdx >= 0 && String(kept).includes('落盘验证'), J({ stayIdx, editor: kept }))
} catch (err) {
  check('脚本执行完成', false, err instanceof Error ? err.message : String(err))
}

await ev(`document.querySelector('[data-nav-item="notes"]').click()`).catch(() => {})
await app.close()
process.exit(finish())
