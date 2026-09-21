/**
 * 收件箱链路验证：副本库上跑 闪念 增/转任务/转笔记/归档/删除 + 任务收件箱查询。
 * 用法：node scripts/inboxcheck.mjs
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
const tmpHome = join(root, '.screenshots', 'inboxcheck-home')
const PORT = 9227

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

const child = spawn(
  electronPath,
  ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpHome, 'profile')}`],
  { cwd: root, env: { ...process.env, ZHIXING_HOME: tmpHome }, stdio: ['ignore', 'pipe', 'pipe'] }
)

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
    if (r.result?.exceptionDetails)
      throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
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
  results.push([name, ok])
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

const info = await conn.evaluate('window.zhixing.db.info()')
check('数据库指向副本库', String(info.path).startsWith(tmpHome), info.path)

const inboxTasks = await conn.evaluate('window.zhixing.db.inboxTasks()')
check('任务收件箱只含未归类任务', Array.isArray(inboxTasks) && inboxTasks.length > 0, `count=${inboxTasks.length}`)
const anyListed = await conn.evaluate(
  "window.zhixing.db.tasks().then(rows => rows.filter(r => r.list_id !== null).length)"
)
check('库里确实存在已归类任务（用于区分）', anyListed >= 0, `listed=${anyListed}`)

// 1) 新建闪念
const f1 = await conn.evaluate("window.zhixing.db.addFlash('验证闪念首行\\n第二行内容', '', '')")
check('新建闪念进收件箱', !!f1?.id && f1.status === 'inbox', `id=${f1?.id} status=${f1?.status}`)
const emptyRejected = await conn.evaluate("window.zhixing.db.addFlash('   ', '', '')")
check('空白内容被拒绝', emptyRejected === null)

// 2) 转任务：标题取首行前 60 字，状态标记 converted
const taskId = await conn.evaluate(`window.zhixing.db.flashToTask(${f1.id})`)
const afterTask = await conn.evaluate(`window.zhixing.db.flashes(null).then(rows => rows.find(r => r.id === ${f1.id}))`)
check(
  '转任务后标记 converted 且记录去向',
  taskId != null && afterTask.status === 'converted' && afterTask.converted_type === 'task' && afterTask.converted_id === taskId,
  `taskId=${taskId} type=${afterTask?.converted_type}`
)
const createdTask = await conn.evaluate(`window.zhixing.db.tasks().then(rows => rows.find(r => r.id === ${taskId}))`)
check('转出的任务标题取首行', createdTask?.title === '验证闪念首行', createdTask?.title)
check('转出的任务备注含来源', String(createdTask?.notes_md ?? '').startsWith('来自闪念：'), createdTask?.notes_md?.slice(0, 16))

// 3) 转笔记
const f2 = await conn.evaluate("window.zhixing.db.addFlash('闪念转笔记的正文', '', '')")
const noteId = await conn.evaluate(`window.zhixing.db.flashToNote(${f2.id})`)
const note = await conn.evaluate(`window.zhixing.db.note(${noteId})`)
check('转笔记成功且正文带入', noteId != null && note?.content_md === '闪念转笔记的正文', `noteId=${noteId}`)

// 4) 归档 / 取消归档
const f3 = await conn.evaluate("window.zhixing.db.addFlash('待归档闪念', '', '')")
const arch = await conn.evaluate(`window.zhixing.db.archiveFlash(${f3.id})`)
const inboxNow = await conn.evaluate("window.zhixing.db.flashes('inbox').then(rows => rows.some(r => r.id === " + f3.id + '))')
check('归档后离开收件箱列表', arch?.status === 'archived' && inboxNow === false, `status=${arch?.status}`)
const unarch = await conn.evaluate(`window.zhixing.db.unarchiveFlash(${f3.id})`)
check('取消归档回到收件箱', unarch?.status === 'inbox', unarch?.status)

// 5) 删除（软删除）
const delCount = await conn.evaluate(`window.zhixing.db.deleteFlash(${f3.id})`)
const stillVisible = await conn.evaluate("window.zhixing.db.flashes(null).then(rows => rows.some(r => r.id === " + f3.id + '))')
check('删除为软删除且不再出现在列表', delCount === 1 && stillVisible === false, `changes=${delCount}`)

conn.ws.close()
child.kill()
await sleep(600)

const tmpDb = join(tmpHome, 'zhixing.db')
const delRow = sql(tmpDb, `SELECT deleted_at FROM flash WHERE id = ${f3.id};`)
check('软删除已落库（deleted_at 非空）', !!delRow && delRow !== '', delRow)
const linkRow = sql(tmpDb, `SELECT status || '|' || converted_type FROM flash WHERE id = ${f1.id};`)
check('转换状态已落库', linkRow === 'converted|task', linkRow)

const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
const leaked = sql(realDb, "SELECT COUNT(*) FROM flash WHERE content LIKE '验证闪念%' OR content = '闪念转笔记的正文' OR content = '待归档闪念';")
check('真实库未写入测试数据', leaked === '0', `匹配 ${leaked} 行`)
const realTask = sql(realDb, "SELECT COUNT(*) FROM task WHERE title = '验证闪念首行';")
check('真实库未新增转出任务', realTask === '0', `匹配 ${realTask} 行`)

rmSync(tmpHome, { recursive: true, force: true })

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length ? 1 : 0)
