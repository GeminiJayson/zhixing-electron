/**
 * 回收站 / 标签管理验证：恢复、彻底删除（含外键解除）、清空、超期清理、标签增删改合并。
 * 用法：node scripts/recyclecheck.mjs
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
const tmpHome = join(root, '.screenshots', 'recycle-home')
const PORT = 9234
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

// 1) 任务：软删除 → 回收站可见 → 恢复
const t = await ev("window.zhixing.db.createTask('验证-回收-任务', null)")
const kid = await ev(`window.zhixing.db.createTask('验证-回收-子任务', ${t.id}).then(x => x.id)`)
await ev(`window.zhixing.db.setTaskTags(${t.id}, ['验证回收标签'])`)
await ev(`window.zhixing.db.deleteTask(${t.id})`)
let trash = await ev("window.zhixing.db.trashItems('task')")
check('软删除的任务出现在回收站', trash.some((x) => x.id === t.id), `count=${trash.length}`)
check('级联删除的子任务也在回收站', trash.some((x) => x.id === kid))

await ev(`window.zhixing.db.restoreTrash('task', ${t.id})`)
trash = await ev("window.zhixing.db.trashItems('task')")
check('恢复后离开回收站', !trash.some((x) => x.id === t.id))
// 注：Task 投影不含 deleted_at 列，这里只断言它回到了未删除集合
const back = await ev(`window.zhixing.db.tasks().then(rows => rows.find(r => r.id === ${t.id}))`)
check('恢复后回到任务列表', back != null, back ? `title=${back.title}` : '未找到')

// 2) 彻底删除：子任务（自引用）与标签关联都要先解除，否则会外键报错
await ev(`window.zhixing.db.deleteTask(${t.id})`)
const purged = await ev(`window.zhixing.db.purgeTrash('task', ${t.id})`)
check('彻底删除任务成功', purged === 1, `changes=${purged}`)
// 子任务仍在回收站，要从回收站列表确认；parent_id 置空直接查库
const kidTrash = await ev("window.zhixing.db.trashItems('task')")
check('被删任务下的子任务仍在回收站', kidTrash.some((x) => x.id === kid))
const kidParent = sql(join(tmpHome, 'zhixing.db'), `SELECT COALESCE(parent_id, 'NULL') FROM task WHERE id = ${kid};`)
check('子任务 parent_id 已置空（解除自引用）', kidParent === 'NULL', `parent=${kidParent}`)

// 3) 笔记与闪念的回收站闭环
const n = await ev("window.zhixing.db.createNote('验证-回收-笔记', null)")
await ev(`window.zhixing.db.deleteNote(${n.id})`)
trash = await ev("window.zhixing.db.trashItems('note')")
check('软删除的笔记出现在回收站', trash.some((x) => x.id === n.id))
await ev(`window.zhixing.db.purgeTrash('note', ${n.id})`)
const gone = await ev(`window.zhixing.db.note(${n.id})`)
check('彻底删除后笔记不复存在', gone === null)

const f = await ev("window.zhixing.db.addFlash('验证-回收-闪念', '', '')")
await ev(`window.zhixing.db.deleteFlash(${f.id})`)
trash = await ev("window.zhixing.db.trashItems('flash')")
check('软删除的闪念出现在回收站', trash.some((x) => x.id === f.id))
await ev(`window.zhixing.db.restoreTrash('flash', ${f.id})`)
trash = await ev("window.zhixing.db.trashItems('flash')")
check('闪念恢复后离开回收站', !trash.some((x) => x.id === f.id))

// 4) 标签管理
const tg1 = await ev("window.zhixing.db.createTag('验证-标签A')")
const tg2 = await ev("window.zhixing.db.createTag('验证-标签B')")
const dup = await ev("window.zhixing.db.createTag('验证-标签A')")
check('新建标签并按名去重', tg1 != null && tg2 != null && dup === tg1, `A=${tg1} dup=${dup}`)

const n2 = await ev("window.zhixing.db.createNote('验证-回收-标签笔记', null)")
await ev(`window.zhixing.db.saveNote(${n2.id}, { title: '验证-回收-标签笔记' })`)
await ev(`window.zhixing.db.setTaskTags(${kid}, ['验证-标签A'])`)
let usage = await ev('window.zhixing.db.tagsWithUsage()')
const ua = usage.find((x) => x.id === tg1)
check('标签使用数统计正确', (ua?.count ?? 0) >= 1, `count=${ua?.count}`)

await ev(`window.zhixing.db.renameTag(${tg2}, '验证-标签B改')`)
usage = await ev('window.zhixing.db.tagsWithUsage()')
check('重命名标签', usage.some((x) => x.name === '验证-标签B改'))

await ev(`window.zhixing.db.mergeTags(${tg1}, [${tg2}])`)
usage = await ev('window.zhixing.db.tagsWithUsage()')
check('合并后来源标签被删除', !usage.some((x) => x.id === tg2))

await ev(`window.zhixing.db.deleteTag(${tg1})`)
usage = await ev('window.zhixing.db.tagsWithUsage()')
check('删除标签', !usage.some((x) => x.id === tg1))

ws.close()
child.kill()
await sleep(600)
const tmpDb = join(tmpHome, 'zhixing.db')
const orphanRef = sql(tmpDb, `SELECT COUNT(*) FROM task_tag WHERE tag_id IN (${tg1}, ${tg2});`)
check('删除标签后关联行被级联清理', orphanRef === '0', `rows=${orphanRef}`)
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
const leak = sql(realDb, "SELECT COUNT(*) FROM task WHERE title LIKE '验证-回收-%';" )
const tagLeak = sql(realDb, "SELECT COUNT(*) FROM tag WHERE name LIKE '验证-标签%';")
check('真实库未被写入', leak === '0' && tagLeak === '0', `task=${leak} tag=${tagLeak}`)
rmSync(tmpHome, { recursive: true, force: true })
const failed = results.filter(([, ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
process.exit(failed ? 1 : 0)
