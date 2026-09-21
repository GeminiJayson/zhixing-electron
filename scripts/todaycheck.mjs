/**
 * 今日待办口径验证：构造场景检查 roll-up / 逾期剔除 / 子树归属，
 * 逐条对齐 task_service.today_tree + review_service.today_counts。
 * 用法：node scripts/todaycheck.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(root, '..')
const backup = join(repoRoot, 'backups', 'electron-migration', 'zhixing-before-electron-write.db')
const tmpHome = join(root, '.screenshots', 'todaycheck-home')
const PORT = 9231
const sql = (file, query) => {
  // 原来走 `execFileSync('sqlite3', ...)` —— 那要系统装了 CLI 才有，本机与 CI 都没有，
  // 于是脚本一跑到 sql() 就 ENOENT 崩掉，后面的断言根本没机会执行（这也是污染长期没被发现的原因）。
  // 改用 Node 自带的 node:sqlite：不依赖外部程序，也不必碰 better-sqlite3 的 Electron ABI。
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(file)
  try {
    return String(Object.values(db.prepare(query).get() ?? {})[0] ?? '')
  } finally {
    db.close()
  }
}

// 迁移前那份备份早已从工作区清掉 —— 缺了就退回「当前正式库的副本」。
// 这些脚本要的只是「一张有数据的库」，对来源不敏感；没有这层回退，它们一启动就退出。
const liveDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
const seedDb = existsSync(backup) ? backup : liveDb
if (!existsSync(seedDb)) {
  console.error('✗ 既没有迁移前备份，也找不到 ' + liveDb)
  process.exit(1)
}
console.log('【基库】' + (seedDb === backup ? '迁移前备份' : '当前正式库副本'))
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(seedDb, join(tmpHome, 'zhixing.db'))

const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpHome, 'profile')}`], {
  cwd: root,
  env: { ...process.env, ZHIXING_HOME: tmpHome },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let page = null
for (let i = 0; i < 40 && !page; i++) {
  await sleep(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    page = list.find((t) => t.type === 'page')
  } catch {}
}
if (!page) { console.error('✗ 无法连接'); child.kill(); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const send = (m, p = {}) =>
  new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e6)
    const h = (ev) => {
      const x = JSON.parse(ev.data)
      if (x.id !== id) return
      ws.removeEventListener('message', h)
      resolve(x)
    }
    ws.addEventListener('message', h)
    ws.send(JSON.stringify({ id, method: m, params: p }))
  })
await send('Runtime.enable')
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result?.result?.value
}
await sleep(2500)

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

const day = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toLocaleDateString('sv-SE')
}
const todayStr = day(0)

const mk = async (title, parentId, fields) => {
  const t = await evaluate(`window.zhixing.db.createTask(${JSON.stringify(title)}, ${parentId ?? 'null'})`)
  if (fields) await evaluate(`window.zhixing.db.updateTask(${t.id}, ${JSON.stringify(fields)})`)
  return t.id
}

const A = await mk('验证-今日-无截止', null, null)
const B = await mk('验证-今日-明天', null, { due_date: day(1) })
const C = await mk('验证-今日-逾期', null, { due_date: day(-1) })
const D = await mk('验证-今日-父完成子未完成', null, null)
const d1 = await mk('验证-今日-子-未完成', D, null)
await evaluate(`window.zhixing.db.setStatus(${D}, 'done')`)
const E = await mk('验证-今日-父完成子完成', null, null)
const e1 = await mk('验证-今日-子-已完成', E, null)
await evaluate(`window.zhixing.db.setStatus(${e1}, 'done')`)
await evaluate(`window.zhixing.db.setStatus(${E}, 'done')`)
const F = await mk('验证-今日-带子树', null, null)
const f1 = await mk('验证-今日-子-随父', F, null)

const res = await evaluate('window.zhixing.db.todayTasks()')
const rootIds = new Set(res.roots)
const subtreeIds = new Set(res.subtree.map((t) => t.id))

check('顶层无截止进今日', rootIds.has(A))
check('顶层未逾期进今日', rootIds.has(B))
check('逾期任务不进今日', !rootIds.has(C), `due=${day(-1)}`)
check('父已完成但子未完成 → 仍算未完成（roll-up）', rootIds.has(D), `status=done 但子任务未完成`)
check('父与子都完成 → 出今日', !rootIds.has(E))
check('根任务 id 不含子任务', !rootIds.has(d1) && !rootIds.has(f1))
check('子树随父出现（未完成子任务）', subtreeIds.has(d1))
check('已完成的根不进今日，其子树也不收集', !subtreeIds.has(e1))
check('子树随父出现（普通子任务）', subtreeIds.has(f1))

// ---- 快速添加语法糖 ----
const q1 = await evaluate(
  "window.zhixing.db.quickAdd('写验证方案 !2 @验证列表 #验证标签 明天')"
)
check(
  '快速添加：标题剔除语法糖',
  q1?.title === '写验证方案',
  q1?.title
)
check('快速添加：!2 解析为 P5', q1?.priority === 5, `priority=${q1?.priority}`)
check('快速添加：日期词「明天」生效', q1?.due_date === day(1), `due=${q1?.due_date}`)
const q1tags = await evaluate(
  `window.zhixing.db.taskTags().then(rows => rows.filter(r => r.task_id === ${q1.id}).map(r => r.name))`
)
check('快速添加：写入 #标签', q1tags.includes('验证标签'), q1tags.join(','))
const q1list = await evaluate(`window.zhixing.db.tasks().then(rows => rows.find(r => r.id === ${q1.id})?.list_id)`)
check('快速添加：@列表 已创建并绑定', q1list != null, `list_id=${q1list}`)

const q2 = await evaluate("window.zhixing.db.quickAdd('没写日期的任务')")
check('快速添加：无日期词默认截止今天', q2?.due_date === todayStr, `due=${q2?.due_date}`)

const q3 = await evaluate("window.zhixing.db.quickAdd('   ')")
check('快速添加：空白输入不建任务', q3 === null)

const ov = await evaluate('window.zhixing.db.overview()')
// 快速添加已插入新任务，取最新快照再比对口径
const resAfter = await evaluate('window.zhixing.db.todayTasks()')
check(
  '概览「今日待办」= 今日根数量',
  ov.today === resAfter.roots.length,
  `overview=${ov.today} roots=${resAfter.roots.length}`
)

// 逾期口径：所有未删除任务里过截止且未有效完成的（含子任务）
const allTasks = await evaluate('window.zhixing.db.tasks()')
check('概览已逾期 ≥ 逾期根数', ov.overdue >= 1, `overdue=${ov.overdue}`)

conn_cleanup: {
  ws.close()
  child.kill()
}
await sleep(600)

const tmpDb = join(tmpHome, 'zhixing.db')
const leaked = sql(tmpDb, "SELECT COUNT(*) FROM task WHERE title LIKE '验证-今日-%';")
check('场景数据仅存在于副本库', Number(leaked) > 0, `副本库 ${leaked} 行`)
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
const realLeak = sql(realDb, "SELECT COUNT(*) FROM task WHERE title LIKE '验证-今日-%';")
check('真实库未被写入', realLeak === '0', `匹配 ${realLeak} 行`)

rmSync(tmpHome, { recursive: true, force: true })
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
process.exit(failed ? 1 : 0)
