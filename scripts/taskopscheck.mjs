/**
 * 任务操作层验证：排序 / 同级移动 / 改挂（防成环）/ 批量 / 标签。
 * 用法：node scripts/taskopscheck.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

// 老脚本里的 root / require 一律保留：原样带过来的自有声明（sql/countOf 等）还依赖它们
const root = ROOT
const require = createRequire(import.meta.url)
const tmpHome = join(ROOT, '.screenshots', 'taskops-home')
const PORT = 9233
const sql = (f, q) => {
  // 原来走 `execFileSync('sqlite3', ...)` —— 那要系统装了 CLI 才有，本机与 CI 都没有，
  // 于是脚本一跑到 sql() 就 ENOENT 崩掉，后面的断言根本没机会执行（这也是污染长期没被发现的原因）。
  // 改用 Node 自带的 node:sqlite：不依赖外部程序，也不必碰 better-sqlite3 的 Electron ABI。
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(f)
  try {
    return String(Object.values(db.prepare(q).get() ?? {})[0] ?? '')
  } finally {
    db.close()
  }
}

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()
const mk = async (title, parentId) => {
  const t = await app.evaluate(`window.zhixing.db.createTask(${JSON.stringify(title)}, ${parentId ?? 'null'})`)
  return t.id
}
const orderOf = async (parentId) =>
  app.evaluate(`window.zhixing.db.tasks().then(rows => rows.filter(r => r.parent_id === ${parentId ?? 'null'}).sort((a,b) => a.sort_key - b.sort_key || a.id - b.id).map(r => r.title))`)

const a = await mk('验证-操作-A', null)
const b = await mk('验证-操作-B', null)
const c = await mk('验证-操作-C', null)
let order = await orderOf(null)
const tail = order.slice(-3)
check('三个任务按创建顺序排在末尾', tail.join(',') === '验证-操作-A,验证-操作-B,验证-操作-C', tail.join(','))

// 1) 拖到 B 上方 → A 应落在 B 之前（顺序不变，但走的是中间值算法）
await app.evaluate(`window.zhixing.db.reorderTask(${a}, ${b}, false)`)
order = await orderOf(null)
check('排序：A 放到 B 之前', order.indexOf('验证-操作-A') < order.indexOf('验证-操作-B'), order.slice(-3).join(','))

// 2) 同级下移：A +1 → 应在 B 之后
await app.evaluate(`window.zhixing.db.moveTaskRelative(${a}, 1)`)
order = await orderOf(null)
check('同级下移：A 落到 B 之后', order.indexOf('验证-操作-A') > order.indexOf('验证-操作-B'), order.slice(-3).join(','))

// 3) 同级上移：A -1 → 回到 B 之前
await app.evaluate(`window.zhixing.db.moveTaskRelative(${a}, -1)`)
order = await orderOf(null)
check('同级上移：A 回到 B 之前', order.indexOf('验证-操作-A') < order.indexOf('验证-操作-B'), order.slice(-3).join(','))

// 4) 改挂：C 挂到 A 下
await app.evaluate(`window.zhixing.db.reparentTask(${c}, ${a})`)
const kids = await orderOf(a)
check('改挂父级：C 成为 A 的子任务', kids.includes('验证-操作-C'), `children=${kids.join(',')}`)

// 5) 防成环：A 挂到 C（自己的子任务）下 → 应被拒绝
await app.evaluate(`window.zhixing.db.reparentTask(${a}, ${c})`)
const aRow = await app.evaluate(`window.zhixing.db.tasks().then(rows => rows.find(r => r.id === ${a}))`)
check('防成环：父不能挂到自己的后代下', aRow.parent_id === null, `parent_id=${aRow.parent_id}`)

// 6) 批量完成（只影响未完成的）
const n1 = await app.evaluate(`window.zhixing.db.batchComplete([${a}, ${b}])`)
const n2 = await app.evaluate(`window.zhixing.db.batchComplete([${a}, ${b}])`)
check('批量完成首次生效', n1 === 2, `changes=${n1}`)
check('批量完成幂等（已完成不再计入）', n2 === 0, `changes=${n2}`)

// 7) 批量设截止 / 清除
await app.evaluate(`window.zhixing.db.batchSetDue([${a}, ${b}], '2026-12-31')`)
const dueOk = await app.evaluate(`window.zhixing.db.tasks().then(rows => rows.filter(r => r.id === ${a} || r.id === ${b}).every(r => r.due_date === '2026-12-31'))`)
check('批量设截止', dueOk === true)
await app.evaluate(`window.zhixing.db.batchSetDue([${a}, ${b}], null)`)
const cleared = await app.evaluate(`window.zhixing.db.tasks().then(rows => rows.filter(r => r.id === ${a} || r.id === ${b}).every(r => r.due_date === null))`)
check('批量清除截止', cleared === true)

// 8) 标签：覆盖式写入 + 自动建标签
await app.evaluate(`window.zhixing.db.setTaskTags(${a}, ['验证标签一', '验证标签二'])`)
let t1 = await app.evaluate(`window.zhixing.db.taskTags().then(rows => rows.filter(r => r.task_id === ${a}).map(r => r.name).sort())`)
check('设置两个标签', t1.join(',') === '验证标签一,验证标签二', t1.join(','))
await app.evaluate(`window.zhixing.db.setTaskTags(${a}, ['验证标签二'])`)
t1 = await app.evaluate(`window.zhixing.db.taskTags().then(rows => rows.filter(r => r.task_id === ${a}).map(r => r.name))`)
check('覆盖式设置：只留一个', t1.join(',') === '验证标签二', t1.join(','))
const tagExists = await app.evaluate("window.zhixing.db.tags().then(rows => rows.some(r => r.name === '验证标签一'))")
check('标签字典里仍保留未被引用的标签', tagExists === true)

await sleep(600)

const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
const leak = sql(realDb, "SELECT COUNT(*) FROM task WHERE title LIKE '验证-操作-%';")
const tagLeak = sql(realDb, "SELECT COUNT(*) FROM tag WHERE name LIKE '验证标签%';")
check('真实库未被写入（任务与标签）', leak === '0' && tagLeak === '0', `task=${leak} tag=${tagLeak}`)


await app.close()
process.exit(finish())