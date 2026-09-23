/**
 * 清单栏第二阶段改造的端到端验收：
 *   1. 第二段「智能清单」：能建、能点、能按表达式过滤、能删；
 *   2. 清单 / 分组拖拽排序（同级插入）；
 *   3. 跨分组拖拽（拖进分组 = 改 parent_id 并落到末尾）；
 *   4. 防成环：分组不能被拖进自己的子级；
 *   5. Office 夹具改由 Node 生成（不再依赖 Python 运行时）。
 */
import { join } from 'node:path'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

const app = await launchApp({ port: 9397, home: join(ROOT, '.screenshots', 'tasklistux-home') })
const { check, finish } = createChecker()

const LIST_ROWS = `(() => [...document.querySelectorAll('.tasklists__body:not(.tasklists__body--sub) .tasklists__row .tasklists__name')].map((n) => n.textContent.trim()))()`
const QUERY_ROWS = `(() => [...document.querySelectorAll('.tasklists__body--sub .tasklists__name')].map((n) => n.textContent.trim()))()`

try {
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    if (i % 3 === 2) console.log('  ' + Math.round((i + 1) * 0.5) + 's')
  }
  await app.evaluate("document.querySelector('[data-nav-item=\"tasks\"]')?.click()")
  await sleep(1800)

  // ---------------------------------------------------------------- 1. 第二段
  const heads = await app.evaluate(
    "(() => [...document.querySelectorAll('.tasklists__section .tasklists__head span')].map((s) => s.textContent.trim()))()"
  )
  check('清单栏出现「智能清单」第二段', Array.isArray(heads) && heads.includes('智能清单'), J(heads))

  // ---------------------------------------------------------------- 2. 造数据
  const made = await app.evaluate(`(async () => {
    const db = window.zhixing.db
    const folders = await db.listFolders()
    let group = folders.find((f) => f.kind === 'group')
    if (!group) group = await db.createListFolder('拖拽验收分组', 'group', null)
    const a = await db.createListFolder('拖拽A', 'list', null)
    const b = await db.createListFolder('拖拽B', 'list', null)
    const q = await db.saveSavedQuery({ name: '验收智能', expr: 'text:欢迎' })
    return { groupId: group.id, a: a.id, b: b.id, queryId: q.id }
  })()`)
  check('造出分组 / 两个清单 / 一个智能清单', !!made && made.a > 0 && made.b > 0, J(made))
  await sleep(1400)

  // ---------------------------------------------------------------- 3. 同级拖拽排序
  const before = await app.evaluate(LIST_ROWS)
  const drag = await app.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.tasklists__body:not(.tasklists__body--sub) .tasklists__row')]
    const find = (n) => rows.find((r) => r.querySelector('.tasklists__name')?.textContent.trim() === n)
    const src = find('拖拽B')
    const dst = find('拖拽A')
    if (!src || !dst) return 'no-row'
    const dt = new DataTransfer()
    const r = dst.getBoundingClientRect()
    const clientY = r.top + 2
    const clientX = r.left + 30
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientY, clientX }))
    fire(src, 'dragstart')
    fire(dst, 'dragover')
    fire(dst, 'drop')
    fire(src, 'dragend')
    return 'ok'
  })()`)
  await sleep(1300)
  const after = await app.evaluate(LIST_ROWS)
  check(
    '拖拽能把清单排到目标行之前',
    drag === 'ok' && after.indexOf('拖拽B') >= 0 && after.indexOf('拖拽B') < after.indexOf('拖拽A'),
    J({ before, after })
  )

  // ---------------------------------------------------------------- 4. 跨分组拖拽
  const intoGroup = await app.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.tasklists__body:not(.tasklists__body--sub) .tasklists__row')]
    const src = rows.find((r) => r.querySelector('.tasklists__name')?.textContent.trim() === '拖拽A')
    const group = rows.find((r) => r.classList.contains('tasklists__row--group') && r.querySelector('.tasklists__name')?.textContent.trim() === '工作')
    if (!src || !group) return 'no-row'
    const dt = new DataTransfer()
    const r = group.getBoundingClientRect()
    const clientY = r.top + r.height / 2
    const clientX = r.left + 30
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientY, clientX }))
    fire(src, 'dragstart')
    fire(group, 'dragover')
    fire(group, 'drop')
    fire(src, 'dragend')
    return 'ok'
  })()`)
  await sleep(1300)
  const parentNow = await app.evaluate(`(async () => {
    const folders = await window.zhixing.db.listFolders()
    const a = folders.find((f) => f.name === '拖拽A')
    const g = folders.find((f) => f.name === '工作')
    return { parent: a ? a.parent_id : null, groupId: g ? g.id : null }
  })()`)
  check(
    '把清单拖到分组中间 = 移入该分组',
    intoGroup === 'ok' && parentNow.parent !== null && parentNow.parent === parentNow.groupId,
    J({ intoGroup, parentNow })
  )

  // ---------------------------------------------------------------- 5. 防成环
  const ring = await app.evaluate(`(async () => {
    const db = window.zhixing.db
    const folders = await db.listFolders()
    const g = folders.find((f) => f.name === '工作')
    const child = folders.find((f) => f.parent_id === g.id)
    if (!g || !child) return -1
    return db.reorderListFolder(g.id, child.id, true)
  })()`)
  check('分组不会被拖进自己的子级（返回 0 行）', ring === 0, J(ring))

  // ---------------------------------------------------------------- 6. 智能清单第二段
  const queries = await app.evaluate(QUERY_ROWS)
  check('第二段列出了刚建的智能清单', Array.isArray(queries) && queries.includes('验收智能'), J(queries))

  const applied = await app.evaluate(`(() => {
    const row = [...document.querySelectorAll('.tasklists__body--sub .tasklists__row')].find((r) => r.querySelector('.tasklists__name')?.textContent.trim() === '验收智能')
    if (!row) return false
    row.click()
    return true
  })()`)
  await sleep(1200)
  const appliedState = await app.evaluate(`(() => ({
    meta: document.querySelector('.tb__meta, .page .u-aux')?.textContent || '',
    rows: [...document.querySelectorAll('.trow .trow__title')].map((t) => t.textContent.trim()),
    on: [...document.querySelectorAll('.tasklists__body--sub .tasklists__row--on .tasklists__name')].map((n) => n.textContent.trim()),
  }))()`)
  check(
    '点智能清单会按表达式过滤，并高亮该行',
    applied === true &&
      appliedState.on.includes('验收智能') &&
      appliedState.rows.length > 0 &&
      appliedState.rows.every((t) => t.includes('欢迎')),
    J(appliedState)
  )

  const cleared = await app.evaluate(`(() => {
    const row = [...document.querySelectorAll('.tasklists__body:not(.tasklists__body--sub) .tasklists__row')].find((r) => r.querySelector('.tasklists__name')?.textContent.trim() === '全部任务')
    if (!row) return false
    row.click()
    return true
  })()`)
  await sleep(1000)
  const afterClear = await app.evaluate(
    "(() => [...document.querySelectorAll('.tasklists__body--sub .tasklists__row--on')].length)()"
  )
  check('点回普通清单会退出智能清单模式', cleared === true && afterClear === 0, J({ cleared, afterClear }))

  const removed = await app.evaluate(`(async () => {
    const ok = await window.zhixing.db.deleteSavedQuery(${made ? made.queryId : 0})
    return ok
  })()`)
  await sleep(900)
  const queriesAfter = await app.evaluate(QUERY_ROWS)
  check(
    '删除智能清单后第二段不再列出它',
    removed !== false && !queriesAfter.includes('验收智能'),
    J({ removed, queriesAfter })
  )

  // ---------------------------------------------------------------- 7. 分组可点选中 + 整栏可收起
  const pickedGroup = await app.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.tasklists__body:not(.tasklists__body--sub) .tasklists__row')]
    const g = rows.find((r) => r.classList.contains('tasklists__row--group'))
    if (!g) return null
    const name = g.querySelector('.tasklists__name')?.textContent.trim() || ''
    g.click()
    return name
  })()`)
  await sleep(1000)
  const pickedState = await app.evaluate(`(() => ({
    on: [...document.querySelectorAll('.tasklists__body:not(.tasklists__body--sub) .tasklists__row--on .tasklists__name')].map((n) => n.textContent.trim()),
  }))()`)
  check(
    '点分组会选中它（折叠交给左侧 caret，两个动作不再抢同一次点击）',
    !!pickedGroup && pickedState.on.includes(pickedGroup),
    J({ pickedGroup, pickedState })
  )

  const railClicked = await app.evaluate(`(() => {
    const b = [...document.querySelectorAll('.tasklists__head button')].find((x) => x.title === '收起清单栏')
    if (!b) return false
    b.click()
    return true
  })()`)
  await sleep(500)
  const railState = await app.evaluate(`(() => ({
    rail: !!document.querySelector('.tasklists--rail'),
    body: !!document.querySelector('.tasklists__body'),
  }))()`)
  const railBack = await app.evaluate(`(() => {
    const b = [...document.querySelectorAll('.tasklists__head button')].find((x) => x.title === '展开清单栏')
    if (!b) return false
    b.click()
    return true
  })()`)
  await sleep(500)
  const railAfter = await app.evaluate("!!document.querySelector('.tasklists__body')")
  check(
    '清单栏能整栏收起并再展开',
    railClicked && railState.rail && !railState.body && railBack && railAfter,
    J({ railClicked, railState, railBack, railAfter })
  )
} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}
await app.close()
process.exit(finish())
