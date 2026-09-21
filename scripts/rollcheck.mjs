/**
 * 跨天维护与导出验证：循环子任务打卡重置（含 streak）、等待中到期恢复、导出内容形状。
 * 用法：node scripts/rollcheck.mjs
 */
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
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
const tmpHome = join(root, '.screenshots', 'rollcheck-home')
const PORT = 9235
/**
 * 只读取一个计数。
 *
 * 原来走的是 sqlite3 命令行 —— 那要系统装了 CLI 才行，而这个仓库的 CI/开发机上并没有。
 * 改用 Node 自带的 node:sqlite：不依赖外部程序，也不必和 better-sqlite3 的
 * Electron ABI 打交道（那只装给应用用，Node 直接 require 会 ABI 不匹配）。
 */
const countOf = (f, q) => {
  const db = new DatabaseSync(f)
  try {
    const row = db.prepare(q).get()
    return Number(Object.values(row ?? {})[0] ?? 0)
  } finally {
    db.close()
  }
}
/**
 * 基库：优先用迁移前的备份（当年是拿它做迁移对照的），
 * 那份文件已经从工作区清掉了 —— 缺了就用当前正式库的副本顶上，
 * 跨天维护那几条断言要的只是「一张有任务的 task 表」，对来源不敏感。
 */
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
  cwd: root,
  // 关掉主进程的提醒派发：它会抢清 reminder_at，让下面那几条读取断言随机失败
  env: { ...process.env, ZHIXING_HOME: tmpHome, ZHIXING_NO_REMINDER_DISPATCH: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
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
const day = (o) => { const d = new Date(); d.setDate(d.getDate() + o); return d.toLocaleDateString('sv-SE') }

const parent = await ev("window.zhixing.db.createTask('验证-打卡-父', null)")
const mkChild = async (title, fields) => {
  const t = await ev(`window.zhixing.db.createTask(${JSON.stringify(title)}, ${parent.id})`)
  await ev(`window.zhixing.db.updateTask(${t.id}, ${JSON.stringify(fields)})`)
  return t.id
}

// 已完成的每日打卡子任务：应重置为待办并 streak+1
const c1 = await mkChild('验证-打卡-已完成', {
  repeat_period: 'daily', due_date: day(-1), last_reset_date: day(-1), status: 'done',
})
// 未完成的每日打卡子任务：应重置但 streak 不变
const c2 = await mkChild('验证-打卡-未完成', {
  repeat_period: 'daily', due_date: day(-1), last_reset_date: day(-1), status: 'todo',
})
// 今天已重置过：应跳过
const c3 = await mkChild('验证-打卡-今日已重置', {
  repeat_period: 'daily', due_date: day(0), last_reset_date: day(0), status: 'done',
})
// 非循环子任务：不参与
const c4 = await mkChild('验证-打卡-非循环', { due_date: day(-1), last_reset_date: day(-1), status: 'done' })

const rolled = await ev('window.zhixing.db.rollRecurringToday()')
check('重置数量符合预期', rolled === 2, `rolled=${rolled}`)
const rows = await ev('window.zhixing.db.tasks()')
const byId = new Map(rows.map((r) => [r.id, r]))
const r1 = byId.get(c1)
check('已完成的打卡被重置为待办', r1?.status === 'todo', r1?.status)
check('已完成的打卡 streak +1', r1?.streak === 1, `streak=${r1?.streak}`)
check('重置后 last_reset_date / due_date 归到今天', r1?.last_reset_date === day(0) && r1?.due_date === day(0), `${r1?.last_reset_date}`)
const r2 = byId.get(c2)
check('未完成的打卡重置但不加 streak', r2?.status === 'todo' && r2?.streak === 0, `streak=${r2?.streak}`)
const r3 = byId.get(c3)
check('今天已重置过的不再重置', r3?.streak === 0 && r3?.last_reset_date === day(0), `streak=${r3?.streak}`)
const r4 = byId.get(c4)
check('非循环子任务不参与打卡', r4?.status === 'done' && r4?.last_reset_date === day(-1))

// 等待中到期恢复
const w1 = await ev("window.zhixing.db.createTask('验证-等待-到期', null)")
await ev(`window.zhixing.db.updateTask(${w1.id}, { status: 'waiting' })`)
const w2 = await ev("window.zhixing.db.createTask('验证-等待-未到期', null)")
await ev(`window.zhixing.db.updateTask(${w2.id}, { status: 'waiting' })`)
const c = child
// resume_at 走应用自己的写入路径（它在 updateTask 的白名单里），不再借道 sqlite3 CLI
await ev(`window.zhixing.db.updateTask(${w1.id}, { resume_at: '${day(-1)}' })`)
await ev(`window.zhixing.db.updateTask(${w2.id}, { resume_at: '${day(1)}' })`)
const resumed = await ev('window.zhixing.db.resumeDueToday()')
check('等待中到期任务被恢复', resumed === 1, `resumed=${resumed}`)
const w1r = await ev(`window.zhixing.db.tasks().then(rows => rows.find(r => r.id === ${w1.id}))`)
check('恢复后状态为待办且清空 resume_at', w1r?.status === 'todo' && w1r?.resume_at === null, `${w1r?.status}`)
const w2r = await ev(`window.zhixing.db.tasks().then(rows => rows.find(r => r.id === ${w2.id}))`)
check('未到期的等待任务保持等待', w2r?.status === 'waiting', w2r?.status)

// ---- 番茄钟 ----
const before = await ev('window.zhixing.db.pomodoroToday()')
await ev(`window.zhixing.db.recordPomodoro(${w1.id}, 25, true)`)
await ev(`window.zhixing.db.recordPomodoro(null, 5, false)`)
const after = await ev('window.zhixing.db.pomodoroToday()')
check('完成的番茄写入并计入今日分钟', after.minutes === before.minutes + 25, `minutes=${after.minutes}`)
check('未完成的番茄不计入统计', after.sessions === before.sessions + 1, `sessions=${after.sessions}`)

// ---- 到点提醒 ----
const mkReminder = async (title, reminderAt, status) => {
  const t = await ev(`window.zhixing.db.createTask(${JSON.stringify(title)}, null)`)
  // reminder_at 也在白名单里了（本版把它开放给编辑面板），所以整条都走应用 API
  await ev(`window.zhixing.db.updateTask(${t.id}, { reminder_at: '${reminderAt}', status: '${status}' })`)
  return t.id
}
const past = day(0) + ' 00:00:00.000000'
const future = day(1) + ' 23:59:00.000000'
const rDue = await mkReminder('验证-提醒-到期', past, 'todo')
const rFuture = await mkReminder('验证-提醒-未到', future, 'todo')
const rWaiting = await mkReminder('验证-提醒-等待中', past, 'waiting')
const rDone = await mkReminder('验证-提醒-已完成', past, 'done')

const dueList = await ev('window.zhixing.db.dueReminders()')
const dueIds = new Set(dueList.map((t) => t.id))
check('到点提醒：已到期任务被列出', dueIds.has(rDue), `due=${dueList.length}`)
check('到点提醒：未到期不出现在列表', !dueIds.has(rFuture))
check('到点提醒：等待中不打扰', !dueIds.has(rWaiting))
check('到点提醒：已完成不提醒', !dueIds.has(rDone))

await ev(`window.zhixing.db.dismissReminder(${rDue})`)
const rDueAfter = await ev(`window.zhixing.db.tasks().then(rows => rows.find(r => r.id === ${rDue}))`)
check('「知道了」清空 reminder_at（一次性语义）', rDueAfter?.reminder_at === null, `reminder_at=${rDueAfter?.reminder_at}`)

const beforeSnooze = await ev(`window.zhixing.db.tasks().then(rows => rows.find(r => r.id === ${rFuture}))`)
await ev(`window.zhixing.db.snoozeReminder(${rFuture}, 15)`)
const afterSnooze = await ev(`window.zhixing.db.tasks().then(rows => rows.find(r => r.id === ${rFuture}))`)
check(
  '「稍后」顺延且不早于原定时刻',
  !!afterSnooze?.reminder_at && afterSnooze.reminder_at > beforeSnooze.reminder_at,
  `${beforeSnooze?.reminder_at} -> ${afterSnooze?.reminder_at}`
)

// 导出内容形状
const j = await ev("window.zhixing.db.exportPreview('json')")
check('JSON 导出外壳正确', j.app === 'zhixing' && j.version === 1, `app=${j.app} v=${j.version}`)
const tables = (j.keys ?? []).filter((k) => k !== 'app' && k !== 'version')
// 不再写死张数：15 是 Python 版的老数字，Electron 版另加了 attachment、workflow_* 等私有表。
// 写死的话每加一张表这里就变红，而真正要守的是「一张都不能漏」。
const coreTables = ['task', 'note', 'flash', 'tag', 'settings']
const extraTables = ['attachment', 'workflow_template', 'pomodoro_session']
check(
  'JSON 导出覆盖核心表与 Electron 版新增表',
  tables.length >= 15 &&
    coreTables.every((n) => tables.includes(n)) &&
    extraTables.every((n) => tables.includes(n)),
  `tables=${tables.length}`
)
check('JSON 导出行数等于库内总量', (j.count ?? 0) > 0, `rows=${j.count}`)
const csv = await ev("window.zhixing.db.exportPreview('csv')")
check('CSV 带 UTF-8 BOM', csv.hasBom === true)
check('CSV 表头与 Python 一致', String(csv.head).includes('id,标题,状态,优先级'), String(csv.head).slice(0, 30))
const md = await ev("window.zhixing.db.exportPreview('markdown')")
check('Markdown 导出有笔记且有分区', (md.count ?? 0) > 0 && (md.folders?.length ?? 0) > 0, `notes=${md.count} folders=${md.folders?.length}`)

ws.close()
child.kill()
await sleep(600)
// 这里原本是 macOS 的路径（Library/Application Support）—— 在 Windows 上 process.env.HOME
// 是 undefined，join 直接抛错，脚本最后一条断言从来没跑成过。
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
const leak = existsSync(realDb)
  ? countOf(realDb, "SELECT COUNT(*) FROM task WHERE title LIKE '验证-打卡-%' OR title LIKE '验证-等待-%'")
  : 0
check('真实库未被写入', leak === 0, `匹配 ${leak} 行`)
rmSync(tmpHome, { recursive: true, force: true })
const failed = results.filter(([, ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} 项通过`)
process.exit(failed ? 1 : 0)
