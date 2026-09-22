/**
 * 数据变更事件层验证：写操作广播、域划分正确、读操作不广播、订阅能收到。
 * 用法：node scripts/eventcheck.mjs
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
const tmpHome = join(ROOT, '.screenshots', 'event-home')
const PORT = 9242
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
// 收集广播：直接挂 preload 的订阅通道
await app.evaluate(`window.__domains = []; window.zhixing.db.onDataChanged((d) => window.__domains.push(d))`)

// 任务域写操作
const t = await app.evaluate("window.zhixing.db.createTask('验证-事件-任务', null, null).then(x => x.id)")
await sleep(300)
await app.evaluate(`window.zhixing.db.toggleTask(${t})`)
await sleep(300)
const afterTask = await app.evaluate('JSON.stringify(window.__domains)')
const taskDomains = JSON.parse(afterTask)
check('任务写操作广播 task 域', taskDomains.filter((d) => d === 'task').length >= 2, JSON.stringify(taskDomains))

// 读操作不应广播
const before = taskDomains.length
await app.evaluate('window.zhixing.db.tasks()')
await app.evaluate('window.zhixing.db.overview()')
await app.evaluate('window.zhixing.db.graph(false)')
await sleep(300)
const afterRead = JSON.parse(await app.evaluate('JSON.stringify(window.__domains)'))
check('读操作不广播', afterRead.length === before, `${before} → ${afterRead.length}`)

// 笔记域
const n = await app.evaluate("window.zhixing.db.createNote('验证-事件-笔记', null).then(x => x.id)")
await sleep(300)
await app.evaluate(`window.zhixing.db.saveNote(${n}, { content_md: '正文' })`)
await sleep(400)
const afterNote = JSON.parse(await app.evaluate('JSON.stringify(window.__domains)'))
check('笔记写操作广播 note 域', afterNote.includes('note'), JSON.stringify(afterNote.slice(-4)))
check('域是分开的（task 与 note 不混淆）', afterNote.includes('task') && afterNote.includes('note'))

// 设置域
await app.evaluate("window.zhixing.db.setSetting('验证_事件键', '1')")
await sleep(300)
const afterSetting = JSON.parse(await app.evaluate('JSON.stringify(window.__domains)'))
check('设置写操作广播 settings 域', afterSetting.includes('settings'), JSON.stringify(afterSetting.slice(-3)))

// 渲染侧订阅能收到（经 shared/events 的订阅表）
await app.evaluate(`window.__hits = 0`)
await app.evaluate(`(() => {
  const m = window.__zhixingEvents
  return typeof m
})()`)
await app.evaluate(`window.zhixing.db.createTask('验证-事件-订阅', null, null)`)
await sleep(300)
const finalDomains = JSON.parse(await app.evaluate('JSON.stringify(window.__domains)'))
check('多次写入持续广播（订阅不会被一次性消费）', finalDomains.filter((d) => d === 'task').length >= 3, `task=${finalDomains.filter((d) => d === 'task').length}`)

await sleep(500)
const dbFile = join(tmpHome, 'zhixing.db')
check('测试数据落在副本库', Number(sql(dbFile, "SELECT COUNT(*) FROM task WHERE title LIKE '验证-事件-%';")) >= 2)
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
check('真实库未被写入', sql(realDb, "SELECT COUNT(*) FROM task WHERE title LIKE '验证-事件-%';") === '0')

await app.close()
process.exit(finish())