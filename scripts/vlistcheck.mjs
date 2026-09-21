/**
 * 长列表虚拟滚动验证（O4）：造 400 条任务，确认 DOM 行数远小于数据行数，且滚动后会换行。
 * 用法：node scripts/vlistcheck.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

// 老脚本里的 root / require 一律保留：原样带过来的自有声明（sql/countOf/dbFile 等）还依赖它们
const root = ROOT
const require = createRequire(import.meta.url)
const tmpHome = join(ROOT, '.screenshots', 'vlist-home')
const PORT = 9241
const dbFile = join(tmpHome, 'zhixing.db')
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

const { check, finish } = createChecker()
// 这个脚本必须**在启动之前**就把 400 行灌好：虚拟滚动要在一次挂载里就拿到全部数据。
// 试过「启动后灌 + reload」—— 再挂载时它会先把行全渲一遍，窗口化要等第一次滚动才生效，
// 于是「DOM 只渲染窗口内的行」那条会拿到假红。所以这里不吃夹具，手写「拷库 → 灌数据 → 再启动」。
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db'), dbFile)
sql(
  dbFile,
  `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 400)
   INSERT INTO task (title, notes_md, status, priority, repeat_period, streak, sort_key, created_at, updated_at)
   SELECT '验证-虚拟-' || x, '', 'todo', 0, 'none', 0, 1000 + x, datetime('now'), datetime('now') FROM c;`
)
const total = Number(sql(dbFile, "SELECT COUNT(*) FROM task WHERE deleted_at IS NULL AND title LIKE '验证-虚拟-%';"))

const app = await launchApp({
  port: PORT,
  home: tmpHome,
  clean: false,
  copyDb: false,
  fixture: false,
  settle: 6000
})
await app.evaluate(`document.querySelector('[data-nav-item="tasks"]')?.click()`)
await sleep(1500)

const snap = JSON.parse(await app.evaluate(`JSON.stringify({
  hasList: !!document.querySelector('.vlist'),
  hasOldTree: !!document.querySelector('.task-tree'),
  rows: document.querySelectorAll('.vlist__row').length,
  taskRows: document.querySelectorAll('.trow').length,
  innerHeight: document.querySelector('.vlist__inner')?.style.height ?? '',
})`))
check('列表视图使用虚拟容器', snap.hasList === true)
check('旧的整棵树容器已移除', snap.hasOldTree === false)
check('数据里有 400+ 行', total >= 400, `db=${total}`)
check('DOM 只渲染窗口内的行', snap.rows > 0 && snap.rows < 120, `dom=${snap.rows} db=${total}`)
check('内层撑高到总高度', parseInt(snap.innerHeight, 10) >= 400 * 30, `inner=${snap.innerHeight}`)

// 滚动后应换行
await app.evaluate(`document.querySelector('.vlist').scrollTop = 3000`, false)
await sleep(700)
const after = JSON.parse(await app.evaluate(`JSON.stringify({
  rows: document.querySelectorAll('.vlist__row').length,
  first: document.querySelector('.vlist__row .trow__title')?.textContent ?? '',
})`))
check('滚动后仍是窗口化渲染', after.rows > 0 && after.rows < 120, `dom=${after.rows}`)
check('滚动后渲染的是靠后的行', after.first !== snap.first, `first=${after.first}`)

await sleep(500)
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
check('真实库未被写入', sql(realDb, "SELECT COUNT(*) FROM task WHERE title LIKE '验证-虚拟-%';") === '0')

await app.close()
process.exit(finish())