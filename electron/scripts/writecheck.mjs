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
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

// 落库校验走 sqlite3 CLI：本机 Node 26 与 Electron 的 ABI 不同，
// 系统 Node 里 require better-sqlite3 会直接 ERR_DLOPEN_FAILED。
const sql = (file, query) => execFileSync('sqlite3', [file, query]).toString().trim()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(root, '..')
const backup = join(repoRoot, 'backups', 'electron-migration', 'zhixing-before-electron-write.db')
const tmpHome = join(root, '.screenshots', 'writecheck-home')
const PORT = 9225

if (!existsSync(backup)) {
  console.error('✗ 找不到备份库:', backup)
  process.exit(1)
}
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(backup, join(tmpHome, 'zhixing.db'))

const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpHome, 'profile')}`], {
  cwd: root,
  env: { ...process.env, ZHIXING_HOME: tmpHome },
  stdio: ['ignore', 'pipe', 'pipe'],
})

const attach = async () => {
  let page = null
  for (let i = 0; i < 40 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      page = list.find((t) => t.type === 'page')
    } catch {
      /* 等待 */
    }
    if (!page) await sleep(500)
  }
  if (!page) return null
  const ws = new WebSocket(page.webSocketDebuggerUrl)
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
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result?.result?.value
  }
  return { ws, evaluate }
}

const conn = await attach()
if (!conn) {
  console.error('✗ 无法连接渲染进程')
  child.kill()
  process.exit(1)
}
await sleep(2500)

const results = []
const check = (name, ok, detail = '') => {
  results.push([name, ok, detail])
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

// 1) 确认连的是副本库
const info = await conn.evaluate('window.zhixing.db.info()')
check('数据库指向副本库', String(info.path).startsWith(tmpHome), info.path)

// 2) 新建任务
const created = await conn.evaluate("window.zhixing.db.createTask('写链路验证-临时任务', null, null)")
check('新建任务返回记录', !!created?.id, created ? `id=${created.id} status=${created.status}` : 'null')

const id = created?.id
if (id) {
  // 3) 改优先级
  const p = await conn.evaluate(`window.zhixing.db.setPriority(${id}, 6)`)
  check('设置优先级 P6', p?.priority === 6, `priority=${p?.priority}`)

  // 4) 改标题
  const t = await conn.evaluate(`window.zhixing.db.setTitle(${id}, '写链路验证-已改名')`)
  check('修改标题', t?.title === '写链路验证-已改名', t?.title)

  // 5) 完成 / 取消完成（含 completed_at 语义）
  const done = await conn.evaluate(`window.zhixing.db.toggleTask(${id})`)
  check('勾选完成', done?.status === 'done' && !!done?.completed_at, `status=${done?.status}`)
  const undone = await conn.evaluate(`window.zhixing.db.toggleTask(${id})`)
  check('取消完成并清 completed_at', undone?.status === 'todo' && undone?.completed_at === null, `status=${undone?.status}`)

  // 6) 状态切换 + waiting 清 resume_at
  const st = await conn.evaluate(`window.zhixing.db.setStatus(${id}, 'waiting')`)
  check('状态切换为等待中', st?.status === 'waiting', st?.status)

  // 6.5) 编辑面板的批量字段更新（白名单）
  const edited = await conn.evaluate(
    `window.zhixing.db.updateTask(${id}, { notes_md: '面板写入', status: 'doing', priority: 3 })`
  )
  check(
    '编辑面板批量更新',
    edited?.status === 'doing' && edited?.priority === 3 && edited?.notes_md === '面板写入',
    `status=${edited?.status} priority=${edited?.priority}`
  )

  // 6.6) 循环任务完成后克隆推进（对齐 toggle_complete + _clone_task_tree）
  const rec = await conn.evaluate(
    "window.zhixing.db.createTask('写链路验证-循环任务', null, null).then(t => window.zhixing.db.updateTask(t.id, { repeat_period: 'daily', due_date: '2026-09-15' }))"
  )
  const recDone = await conn.evaluate(`window.zhixing.db.toggleTask(${rec.id})`)
  check('循环任务原体标记完成', recDone?.status === 'done', recDone?.status)

  const cloned = await conn.evaluate(
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
    conn.evaluate(
      `window.zhixing.db.tasks().then(rows => rows.filter(r => r.title === '${title}').length)`
    )

  const countTask = await conn.evaluate(
    "window.zhixing.db.createTask('写链路验证-COUNT循环', null, null).then(t => window.zhixing.db.updateTask(t.id, { repeat_period: 'custom', repeat_rule: 'FREQ=DAILY;COUNT=2', due_date: '2026-09-15' }))"
  )
  await conn.evaluate(`window.zhixing.db.toggleTask(${countTask.id})`)
  const clonedCount = await countOf('写链路验证-COUNT循环')
  const cloneRow = await conn.evaluate(
    "window.zhixing.db.tasks().then(rows => rows.filter(r => r.title === '写链路验证-COUNT循环' && r.id !== " +
      countTask.id +
      ").map(r => r.repeat_rule))"
  )
  check('COUNT=2 克隆一次且携带 COUNT=1', clonedCount === 2, `count=${clonedCount} rule=${cloneRow[0]}`)
  check('COUNT 递减为 1', cloneRow[0] === 'FREQ=DAILY;COUNT=1', cloneRow[0] ?? '')

  // UNTIL 超限：下一次已超过 until → 不再克隆
  const untilTask = await conn.evaluate(
    "window.zhixing.db.createTask('写链路验证-UNTIL循环', null, null).then(t => window.zhixing.db.updateTask(t.id, { repeat_period: 'custom', repeat_rule: 'FREQ=DAILY;UNTIL=20260915', due_date: '2026-09-15' }))"
  )
  await conn.evaluate(`window.zhixing.db.toggleTask(${untilTask.id})`)
  const untilCount = await countOf('写链路验证-UNTIL循环')
  check('UNTIL 超限后终止克隆', untilCount === 1, `count=${untilCount}`)

  // 6.7) 改期（日历拖拽 / 编辑面板共用）
  const moved = await conn.evaluate(`window.zhixing.db.setDueDate(${id}, '2026-12-31')`)
  check('改期写入 due_date', moved?.due_date === '2026-12-31', moved?.due_date ?? '')

  // 7) 软删除
  const n = await conn.evaluate(`window.zhixing.db.deleteTask(${id})`)
  check('软删除返回影响行数', n === 1, `rows=${n}`)
}

conn.ws.close()
child.kill()
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
const realDb = join(process.env.HOME, 'Library/Application Support/ZhiXing/zhixing.db')
const leaked = sql(realDb, "SELECT COUNT(*) FROM task WHERE title LIKE '写链路验证%';")
const total = sql(realDb, 'SELECT COUNT(*) FROM task;')
check('真实库未写入测试数据', leaked === '0', `匹配 ${leaked} 行，真实库共 ${total} 行`)

rmSync(tmpHome, { recursive: true, force: true })

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length ? 1 : 0)
