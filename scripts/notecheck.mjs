/**
 * 笔记链路验证：在副本库上跑 笔记 CRUD + [[wiki 链接]] 管线，真实库零写入。
 * 覆盖 note_service 的 _pipeline diff 语义与 materialize_dangling。
 * 用法：node scripts/notecheck.mjs
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
const tmpHome = join(root, '.screenshots', 'notecheck-home')
const PORT = 9226

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

// 1) 建两篇笔记，A 引用 B 与一个待建标题
const a = await conn.evaluate("window.zhixing.db.createNote('链路验证-A', null)")
const b = await conn.evaluate("window.zhixing.db.createNote('链路验证-B', null)")
check('新建笔记 A/B', !!a?.id && !!b?.id, `A=${a?.id} B=${b?.id}`)

const md = '引用 [[链路验证-B]]，以及待建的 [[链路验证-待建]]。代码块不解析：\n```\n[[不该出现]]\n```'
await conn.evaluate(`window.zhixing.db.saveNote(${a.id}, { content_md: ${JSON.stringify(md)} })`)

const outLinks = await conn.evaluate(`window.zhixing.db.outLinks(${a.id})`)
check('出链解析出 2 条', outLinks.length === 2, outLinks.map((l) => l.dst_title).join(', '))
const bound = outLinks.find((l) => l.dst_title === '链路验证-B')
const dangling = outLinks.find((l) => l.dst_title === '链路验证-待建')
check('已存在的标题直接绑定', bound?.dst_note_id === b.id, `dst=${bound?.dst_note_id}`)
check('不存在的标题记为悬空', dangling && dangling.dst_note_id === null, `dst=${dangling?.dst_note_id}`)
check('代码块内的 [[..]] 不算链接', !outLinks.some((l) => l.dst_title === '不该出现'))

// 2) 反链：B 应看到来自 A 的引用
const back = await conn.evaluate(`window.zhixing.db.backlinks(${b.id})`)
check('反链含 A 且带上下文摘录', back.some((x) => x.src_note_id === a.id) && !!back[0]?.snippet, back[0]?.snippet?.slice(0, 24))

// 3) 悬空转正
const created = await conn.evaluate(`window.zhixing.db.materializeDangling(${a.id}, '链路验证-待建')`)
const afterOut = await conn.evaluate(`window.zhixing.db.outLinks(${a.id})`)
check('悬空引用转正并绑定新笔记', created != null && afterOut.every((l) => l.dst_note_id != null), `newId=${created}`)

// 4) 正文里删掉引用 → 行随之删除（pipeline diff）
await conn.evaluate(`window.zhixing.db.saveNote(${a.id}, { content_md: '只留 [[链路验证-B]]' })`)
const afterDiff = await conn.evaluate(`window.zhixing.db.outLinks(${a.id})`)
check('正文移除后链接行同步删除', afterDiff.length === 1, `count=${afterDiff.length}`)

// 5) 非 markdown 字段保存不应动链接
await conn.evaluate(`window.zhixing.db.saveNote(${a.id}, { pinned: true })`)
const afterPin = await conn.evaluate(`window.zhixing.db.outLinks(${a.id})`)
check('仅改置顶不重算链接', afterPin.length === 1, `count=${afterPin.length}`)

// 6) 反向引用：让 B 引用 A，再删 A —— B 的出链应悬空化而不是丢行
await conn.evaluate(`window.zhixing.db.saveNote(${b.id}, { content_md: '回指 [[链路验证-A]]' })`)
const bOutBefore = await conn.evaluate(`window.zhixing.db.outLinks(${b.id})`)
check('B 引用 A 已绑定', bOutBefore[0]?.dst_note_id === a.id, `dst=${bOutBefore[0]?.dst_note_id}`)

await conn.evaluate(`window.zhixing.db.deleteNote(${a.id})`)
const bOutAfter = await conn.evaluate(`window.zhixing.db.outLinks(${b.id})`)
check(
  '删除目标后入链悬空化（保留行与标题）',
  bOutAfter.length === 1 && bOutAfter[0].dst_note_id === null && bOutAfter[0].dst_title === '链路验证-A',
  `rows=${bOutAfter.length} dst=${bOutAfter[0]?.dst_note_id} title=${bOutAfter[0]?.dst_title}`
)

// 6.5) 软删除后不再作为反链来源
const backAfter = await conn.evaluate(`window.zhixing.db.backlinks(${b.id})`)
check('软删除后不再作为反链来源', !backAfter.some((x) => x.src_note_id === a.id))

// 7) 版本历史：正文变更产生快照，重复内容不重复快照，可回滚
const h = await conn.evaluate("window.zhixing.db.createNote('链路验证-历史', null, '第一版内容')")
await conn.evaluate(`window.zhixing.db.saveNote(${h.id}, { content_md: '第二版内容' })`)
const revs1 = await conn.evaluate(`window.zhixing.db.noteRevisions(${h.id})`)
check('正文变更产生版本快照', revs1.length === 1, `versions=${revs1.length}`)
check('快照内容是变更前的正文', revs1[0]?.content_md === '第一版内容', revs1[0]?.content_md)

// 再存一次相同内容：当前是「第二版」，最后快照是「第一版」，两者不同 → 仍会留一份快照
await conn.evaluate(`window.zhixing.db.saveNote(${h.id}, { content_md: '第二版内容' })`)
const revs2 = await conn.evaluate(`window.zhixing.db.noteRevisions(${h.id})`)
check('当前内容与上一快照不同则继续留档', revs2.length === 2, `versions=${revs2.length}`)

// 第三次：当前内容「第二版」== 最后快照「第二版」→ 去重跳过
await conn.evaluate(`window.zhixing.db.saveNote(${h.id}, { content_md: '第二版内容' })`)
const revs2b = await conn.evaluate(`window.zhixing.db.noteRevisions(${h.id})`)
check('当前内容与最后快照一致时去重跳过', revs2b.length === 2, `versions=${revs2b.length}`)

// 此时「当前内容」仍是第二版，与最后一份快照一致 → 仍去重跳过
await conn.evaluate(`window.zhixing.db.saveNote(${h.id}, { content_md: '第三版内容' })`)
const revs3 = await conn.evaluate(`window.zhixing.db.noteRevisions(${h.id})`)
check('保存前内容与最后快照一致则不新增版本', revs3.length === 2, `versions=${revs3.length}`)

const restored = await conn.evaluate(
  `window.zhixing.db.restoreNoteRevision(${h.id}, ${revs3[revs3.length - 1].id})`
)
check('回滚到最早版本生效', restored?.content_md === '第一版内容', restored?.content_md)
const revs4 = await conn.evaluate(`window.zhixing.db.noteRevisions(${h.id})`)
check('回滚前给当前内容留了新快照', revs4.length === 3, `versions=${revs4.length}`)

// 8) 模板
const fromTpl = await conn.evaluate("window.zhixing.db.createNoteFromTemplate('会议记录', null)")
check(
  '按模板新建（标题带 MM-DD）',
  !!fromTpl && /^会议记录 \d{2}-\d{2}$/.test(fromTpl.title) && fromTpl.content_md.includes('## 待办'),
  fromTpl?.title
)
const badTpl = await conn.evaluate("window.zhixing.db.createNoteFromTemplate('不存在的模板', null)")
check('未知模板返回 null', badTpl === null)

// 9) 孤儿笔记：既无出链也无入链
const lonely = await conn.evaluate("window.zhixing.db.createNote('链路验证-孤儿', null)")
const orphans = await conn.evaluate('window.zhixing.db.orphanNotes()')
check('无链接的笔记被判为孤儿', orphans.some((n) => n.id === lonely.id), `orphans=${orphans.length}`)
check('有链接的笔记不算孤儿', !orphans.some((n) => n.id === b.id))

// 10) 失效链接：目标已删（前面场景把 A 删了，B 的入链已悬空）
const broken = await conn.evaluate('window.zhixing.db.brokenLinks()')
check(
  '失效链接可被列出',
  broken.some((x) => x.dst_title === '链路验证-A'),
  broken.map((x) => x.dst_title).join(',')
)

conn.ws.close()
child.kill()
await sleep(600)

const tmpDb = join(tmpHome, 'zhixing.db')
const del = sql(tmpDb, `SELECT deleted_at FROM note WHERE id = ${a.id};`)
check('软删除已落库', !!del && del !== '', del)
const rows = sql(tmpDb, "SELECT COUNT(*) FROM note_link WHERE dst_title IN ('链路验证-B','链路验证-A');")
check('软删除不物理删除链接行', rows === '2', `rows=${rows}`)

const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
const leaked = sql(realDb, "SELECT COUNT(*) FROM note WHERE title LIKE '链路验证-%';")
check('真实库未写入测试数据', leaked === '0', `匹配 ${leaked} 行`)

rmSync(tmpHome, { recursive: true, force: true })

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length ? 1 : 0)
