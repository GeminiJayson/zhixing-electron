/**
 * 导入验证：覆盖式导入必须——校验外壳、导入前自动备份、整库替换、失败不动数据。
 * 用法：node scripts/importcheck.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(root, '..')
const backup = join(repoRoot, 'backups', 'electron-migration', 'zhixing-before-electron-write.db')
const tmpHome = join(root, '.screenshots', 'import-home')
const PORT = 9236
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

// 构造一个合法导出文件（只带必要表，覆盖式导入会清空其余表）
const payload = {
  app: 'zhixing',
  version: 1,
  tag: [{ id: 1, name: '导入标签', color: '#0D9488' }],
  list_folder: [],
  task: [
    { id: 1, title: '导入的任务', notes_md: '', status: 'todo', priority: 5, due_date: '2026-12-31',
      start_date: null, reminder_at: null, list_id: null, parent_id: null, repeat_period: 'none',
      repeat_rule: null, streak: 0, sort_key: 1.0, completed_at: null, deleted_at: null,
      created_at: '2026-01-01 00:00:00.000000', updated_at: '2026-01-01 00:00:00.000000',
      resume_at: null, last_reset_date: null },
  ],
  task_tag: [{ task_id: 1, tag_id: 1 }],
  note_folder: [],
  note: [{ id: 1, folder_id: null, title: '导入的笔记', content_md: '# 导入的笔记', format: 'markdown',
    pinned: 0, word_count: 5, deleted_at: null, created_at: '2026-01-01 00:00:00.000000',
    updated_at: '2026-01-01 00:00:00.000000' }],
  note_tag: [],
  note_link: [],
  task_note_link: [],
  flash: [],
  flash_tag: [],
  note_revision: [],
  attachment: [],
  pomodoro_session: [],
  settings: [{ key: 'theme_mode', value: 'dark' }],
}
const okFile = join(tmpHome, 'good.json')
writeFileSync(okFile, JSON.stringify(payload), 'utf-8')
const badFile = join(tmpHome, 'bad.json')
writeFileSync(badFile, JSON.stringify({ app: 'something-else' }), 'utf-8')
const brokenFile = join(tmpHome, 'broken.json')
writeFileSync(brokenFile, '{ not json', 'utf-8')

const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpHome, 'p')}`], {
  cwd: root, env: { ...process.env, ZHIXING_HOME: tmpHome }, stdio: ['ignore', 'pipe', 'pipe'],
})
let page = null
for (let i = 0; i < 40 && !page; i++) {
  await sleep(500)
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); page = l.find((t) => t.type === 'page') } catch {}
}
if (!page) { console.error('✗ 无法连接'); child.kill(); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const send = (m, p = {}) => new Promise((resolve) => {
  const id = Math.floor(Math.random() * 1e6)
  const h = (ev) => { const x = JSON.parse(ev.data); if (x.id !== id) return; ws.removeEventListener('message', h); resolve(x) }
  ws.addEventListener('message', h); ws.send(JSON.stringify({ id, method: m, params: p })) })
await send('Runtime.enable')
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'fail')
  return r.result?.result?.value }
await sleep(2500)
const results = []
const check = (n, ok, d = '') => { results.push([n, ok]); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`) }

const tasksBefore = await ev('window.zhixing.db.tasks().then(r => r.length)')
check('导入前副本库已有数据', tasksBefore > 1, `tasks=${tasksBefore}`)

// 1) 非本应用的文件被拒绝，且不动数据
const bad = await ev(`window.zhixing.db.importFromPath(${JSON.stringify(badFile)})`)
check('非「知行」导出文件被拒绝', bad.ok === false, bad.message)
const afterBad = await ev('window.zhixing.db.tasks().then(r => r.length)')
check('被拒绝时数据不变', afterBad === tasksBefore, `tasks=${afterBad}`)

// 2) 损坏 JSON 被拒绝
const broken = await ev(`window.zhixing.db.importFromPath(${JSON.stringify(brokenFile)})`)
check('损坏 JSON 被拒绝', broken.ok === false, broken.message)

// 3) 合法文件导入成功，并自动备份
const good = await ev(`window.zhixing.db.importFromPath(${JSON.stringify(okFile)})`)
check('合法文件导入成功', good.ok === true, good.message)
check('导入前自动生成了备份', !!good.backup && existsSync(good.backup), good.backup ?? '')

// 4) 覆盖式：旧数据被替换
const rows = await ev('window.zhixing.db.tasks()')
check('覆盖后只剩导入的任务', rows.length === 1 && rows[0].title === '导入的任务', `tasks=${rows.length}`)
check('导入任务字段完整', rows[0]?.priority === 5 && rows[0]?.due_date === '2026-12-31', `priority=${rows[0]?.priority} due=${rows[0]?.due_date}`)
const tagRows = await ev('window.zhixing.db.taskTags()')
check('关联表一并导入', tagRows.length === 1 && tagRows[0].name === '导入标签', `links=${tagRows.length}`)
const notes = await ev('window.zhixing.db.notes()')
check('笔记表一并导入', notes.length === 1 && notes[0].title === '导入的笔记', `notes=${notes.length}`)
const settings = await ev('window.zhixing.db.settings()')
check('settings 表一并替换', settings.theme_mode === 'dark', `theme_mode=${settings.theme_mode}`)

// PRAGMA foreign_keys 是连接级设置，用 sqlite3 CLI 的新连接查没有意义；
// 改为验证导入后数据仍可正常增删（说明外键与自增都没被破坏）。
const created = await ev("window.zhixing.db.createTask('导入后新增', null, null).then(t => t.id)")
const deleted = await ev(`window.zhixing.db.deleteTask(${created})`)
check('导入后仍可正常增删任务', typeof created === 'number' && deleted === 1, `created=${created}`)

ws.close()
child.kill()
await sleep(600)
const tmpDb = join(tmpHome, 'zhixing.db')
// 上面那条「导入后新增」是软删除，因此按未删除行计数
check('落库后未删除任务只有导入的 1 行', sql(tmpDb, 'SELECT COUNT(*) FROM task WHERE deleted_at IS NULL;') === '1')
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
check('真实库未被改动', sql(realDb, "SELECT COUNT(*) FROM task WHERE title = '导入的任务';") === '0')
rmSync(tmpHome, { recursive: true, force: true })
const failed = results.filter(([, ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
process.exit(failed ? 1 : 0)
