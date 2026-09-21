/**
 * 写入链路验证：在**副本库**上跑真实的 增/改/删，确认 IPC → db.ts → SQLite 正确，
 * 绝不触碰 ~/Library/Application Support/ZhiXing 下的真实数据库。
 * 用法：node scripts/writecheck.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

// 老脚本里的 root / require 一律保留：下面原样带过来的自有声明还依赖它们
const root = ROOT
const require = createRequire(import.meta.url)
const tmpHome = join(ROOT, '.screenshots', 'writecheck-home')
const PORT = 9225
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

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()
// 1) 确认连的是副本库
const info = await app.evaluate('window.zhixing.db.info()')
check('数据库指向副本库', String(info.path).startsWith(tmpHome), info.path)

// 2) 新建任务
const created = await app.evaluate("window.zhixing.db.createTask('写链路验证-临时任务', null, null)")
check('新建任务返回记录', !!created?.id, created ? `id=${created.id} status=${created.status}` : 'null')

const id = created?.id
if (id) {
  // 3) 改优先级
  const p = await app.evaluate(`window.zhixing.db.setPriority(${id}, 6)`)
  check('设置优先级 P6', p?.priority === 6, `priority=${p?.priority}`)

  // 4) 改标题
  const t = await app.evaluate(`window.zhixing.db.setTitle(${id}, '写链路验证-已改名')`)
  check('修改标题', t?.title === '写链路验证-已改名', t?.title)

  // 5) 完成 / 取消完成（含 completed_at 语义）
  const done = await app.evaluate(`window.zhixing.db.toggleTask(${id})`)
  check('勾选完成', done?.status === 'done' && !!done?.completed_at, `status=${done?.status}`)
  const undone = await app.evaluate(`window.zhixing.db.toggleTask(${id})`)
  check('取消完成并清 completed_at', undone?.status === 'todo' && undone?.completed_at === null, `status=${undone?.status}`)

  // 6) 状态切换 + waiting 清 resume_at
  const st = await app.evaluate(`window.zhixing.db.setStatus(${id}, 'waiting')`)
  check('状态切换为等待中', st?.status === 'waiting', st?.status)

  // 6.5) 编辑面板的批量字段更新（白名单）
  const edited = await app.evaluate(
    `window.zhixing.db.updateTask(${id}, { notes_md: '面板写入', status: 'doing', priority: 3 })`
  )
  check(
    '编辑面板批量更新',
    edited?.status === 'doing' && edited?.priority === 3 && edited?.notes_md === '面板写入',
    `status=${edited?.status} priority=${edited?.priority}`
  )

  // 6.6) 循环任务完成后克隆推进（对齐 toggle_complete + _clone_task_tree）
  const rec = await app.evaluate(
    "window.zhixing.db.createTask('写链路验证-循环任务', null, null).then(t => window.zhixing.db.updateTask(t.id, { repeat_period: 'daily', due_date: '2026-09-15' }))"
  )
  const recDone = await app.evaluate(`window.zhixing.db.toggleTask(${rec.id})`)
  check('循环任务原体标记完成', recDone?.status === 'done', recDone?.status)

  const cloned = await app.evaluate(
    "window.zhixing.db.tasks().then(rows => rows.filter(r => r.title === '写链路验证-循环任务'))"
  )
  const fresh = cloned.find((r) => r.id !== rec.id)
  check(
    '克隆体已生成且截止日推进一天',
    !!fresh && fresh.status === 'todo' && fresh.due_date === '2026-09-16',
    fresh ? `id=${fresh.id} status=${fresh.status} due=${fresh.due_date}` : '未克隆'
  )

  // COUNT 递减：FREQ=DAILY;COUNT=2 → 克隆携带 COUNT=1；再完成一次应终止
  const countOf = (title) =>
    app.evaluate(
      `window.zhixing.db.tasks().then(rows => rows.filter(r => r.title === '${title}').length)`
    )

  const countTask = await app.evaluate(
    "window.zhixing.db.createTask('写链路验证-COUNT循环', null, null).then(t => window.zhixing.db.updateTask(t.id, { repeat_period: 'custom', repeat_rule: 'FREQ=DAILY;COUNT=2', due_date: '2026-09-15' }))"
  )
  await app.evaluate(`window.zhixing.db.toggleTask(${countTask.id})`)
  const clonedCount = await countOf('写链路验证-COUNT循环')
  const cloneRow = await app.evaluate(
    "window.zhixing.db.tasks().then(rows => rows.filter(r => r.title === '写链路验证-COUNT循环' && r.id !== " +
      countTask.id +
      ").map(r => r.repeat_rule))"
  )
  check('COUNT=2 克隆一次且携带 COUNT=1', clonedCount === 2, `count=${clonedCount} rule=${cloneRow[0]}`)
  check('COUNT 递减为 1', cloneRow[0] === 'FREQ=DAILY;COUNT=1', cloneRow[0] ?? '')

  // UNTIL 超限：下一次已超过 until → 不再克隆
  const untilTask = await app.evaluate(
    "window.zhixing.db.createTask('写链路验证-UNTIL循环', null, null).then(t => window.zhixing.db.updateTask(t.id, { repeat_period: 'custom', repeat_rule: 'FREQ=DAILY;UNTIL=20260915', due_date: '2026-09-15' }))"
  )
  await app.evaluate(`window.zhixing.db.toggleTask(${untilTask.id})`)
  const untilCount = await countOf('写链路验证-UNTIL循环')
  check('UNTIL 超限后终止克隆', untilCount === 1, `count=${untilCount}`)

  // 6.7) 改期（日历拖拽 / 编辑面板共用）
  const moved = await app.evaluate(`window.zhixing.db.setDueDate(${id}, '2026-12-31')`)
  check('改期写入 due_date', moved?.due_date === '2026-12-31', moved?.due_date ?? '')

  // 7) 软删除
  const n = await app.evaluate(`window.zhixing.db.deleteTask(${id})`)
  check('软删除返回影响行数', n === 1, `rows=${n}`)
}

app.ws.close()
await sleep(600)

// 8) 脱离应用，直接校验落库结果与时间戳格式
const tmpDb = join(tmpHome, 'zhixing.db')
const row = sql(tmpDb, "SELECT deleted_at || '|' || updated_at FROM task WHERE title = '写链路验证-已改名' LIMIT 1;")
const [deletedAt, updatedAt] = row.split('|')
check('软删除已落库（deleted_at 非空）', !!deletedAt, `deleted_at=${deletedAt}`)
check(
  '时间戳为 Python datetime 格式（微秒 6 位）',
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(updatedAt ?? ''),
  updatedAt ?? ''
)

// 真实库未被触碰
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
const leaked = sql(realDb, "SELECT COUNT(*) FROM task WHERE title LIKE '写链路验证%';")
const total = sql(realDb, 'SELECT COUNT(*) FROM task;')
check('真实库未写入测试数据', leaked === '0', `匹配 ${leaked} 行，真实库共 ${total} 行`)

await app.close()

process.exit(finish())