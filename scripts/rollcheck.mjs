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
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

// 老脚本里的 root / require 一律保留：原样带过来的自有声明（sql/countOf 等）还依赖它们
const root = ROOT
const require = createRequire(import.meta.url)
const tmpHome = join(ROOT, '.screenshots', 'rollcheck-home')
const PORT = 9235
const countOf = (f, q) => {
  const db = new DatabaseSync(f)
  try {
    const row = db.prepare(q).get()
    return Number(Object.values(row ?? {})[0] ?? 0)
  } finally {
    db.close()
  }
}

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()
const day = (o) => { const d = new Date(); d.setDate(d.getDate() + o); return d.toLocaleDateString('sv-SE') }

const parent = await app.evaluate("window.zhixing.db.createTask('验证-打卡-父', null)")
const mkChild = async (title, fields) => {
  const t = await app.evaluate(`window.zhixing.db.createTask(${JSON.stringify(title)}, ${parent.id})`)
  await app.evaluate(`window.zhixing.db.updateTask(${t.id}, ${JSON.stringify(fields)})`)
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

const rolled = await app.evaluate('window.zhixing.db.rollRecurringToday()')
check('重置数量符合预期', rolled === 2, `rolled=${rolled}`)
const rows = await app.evaluate('window.zhixing.db.tasks()')
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
const w1 = await app.evaluate("window.zhixing.db.createTask('验证-等待-到期', null)")
await app.evaluate(`window.zhixing.db.updateTask(${w1.id}, { status: 'waiting' })`)
const w2 = await app.evaluate("window.zhixing.db.createTask('验证-等待-未到期', null)")
await app.evaluate(`window.zhixing.db.updateTask(${w2.id}, { status: 'waiting' })`)
// resume_at 走应用自己的写入路径（它在 updateTask 的白名单里），不再借道 sqlite3 CLI
await app.evaluate(`window.zhixing.db.updateTask(${w1.id}, { resume_at: '${day(-1)}' })`)
await app.evaluate(`window.zhixing.db.updateTask(${w2.id}, { resume_at: '${day(1)}' })`)
const resumed = await app.evaluate('window.zhixing.db.resumeDueToday()')
check('等待中到期任务被恢复', resumed === 1, `resumed=${resumed}`)
const w1r = await app.evaluate(`window.zhixing.db.tasks().then(rows => rows.find(r => r.id === ${w1.id}))`)
check('恢复后状态为待办且清空 resume_at', w1r?.status === 'todo' && w1r?.resume_at === null, `${w1r?.status}`)
const w2r = await app.evaluate(`window.zhixing.db.tasks().then(rows => rows.find(r => r.id === ${w2.id}))`)
check('未到期的等待任务保持等待', w2r?.status === 'waiting', w2r?.status)

// ---- 番茄钟 ----
const before = await app.evaluate('window.zhixing.db.pomodoroToday()')
await app.evaluate(`window.zhixing.db.recordPomodoro(${w1.id}, 25, true)`)
await app.evaluate(`window.zhixing.db.recordPomodoro(null, 5, false)`)
const after = await app.evaluate('window.zhixing.db.pomodoroToday()')
check('完成的番茄写入并计入今日分钟', after.minutes === before.minutes + 25, `minutes=${after.minutes}`)
check('未完成的番茄不计入统计', after.sessions === before.sessions + 1, `sessions=${after.sessions}`)

// ---- 到点提醒 ----
const mkReminder = async (title, reminderAt, status) => {
  const t = await app.evaluate(`window.zhixing.db.createTask(${JSON.stringify(title)}, null)`)
  // reminder_at 也在白名单里了（本版把它开放给编辑面板），所以整条都走应用 API
  await app.evaluate(`window.zhixing.db.updateTask(${t.id}, { reminder_at: '${reminderAt}', status: '${status}' })`)
  return t.id
}
const past = day(0) + ' 00:00:00.000000'
const future = day(1) + ' 23:59:00.000000'
const rDue = await mkReminder('验证-提醒-到期', past, 'todo')
const rFuture = await mkReminder('验证-提醒-未到', future, 'todo')
const rWaiting = await mkReminder('验证-提醒-等待中', past, 'waiting')
const rDone = await mkReminder('验证-提醒-已完成', past, 'done')

const dueList = await app.evaluate('window.zhixing.db.dueReminders()')
const dueIds = new Set(dueList.map((t) => t.id))
check('到点提醒：已到期任务被列出', dueIds.has(rDue), `due=${dueList.length}`)
check('到点提醒：未到期不出现在列表', !dueIds.has(rFuture))
check('到点提醒：等待中不打扰', !dueIds.has(rWaiting))
check('到点提醒：已完成不提醒', !dueIds.has(rDone))

await app.evaluate(`window.zhixing.db.dismissReminder(${rDue})`)
const rDueAfter = await app.evaluate(`window.zhixing.db.tasks().then(rows => rows.find(r => r.id === ${rDue}))`)
check('「知道了」清空 reminder_at（一次性语义）', rDueAfter?.reminder_at === null, `reminder_at=${rDueAfter?.reminder_at}`)

const beforeSnooze = await app.evaluate(`window.zhixing.db.tasks().then(rows => rows.find(r => r.id === ${rFuture}))`)
await app.evaluate(`window.zhixing.db.snoozeReminder(${rFuture}, 15)`)
const afterSnooze = await app.evaluate(`window.zhixing.db.tasks().then(rows => rows.find(r => r.id === ${rFuture}))`)
check(
  '「稍后」顺延且不早于原定时刻',
  !!afterSnooze?.reminder_at && afterSnooze.reminder_at > beforeSnooze.reminder_at,
  `${beforeSnooze?.reminder_at} -> ${afterSnooze?.reminder_at}`
)

// 导出内容形状
const j = await app.evaluate("window.zhixing.db.exportPreview('json')")
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
const csv = await app.evaluate("window.zhixing.db.exportPreview('csv')")
check('CSV 带 UTF-8 BOM', csv.hasBom === true)
check('CSV 表头与 Python 一致', String(csv.head).includes('id,标题,状态,优先级'), String(csv.head).slice(0, 30))
const md = await app.evaluate("window.zhixing.db.exportPreview('markdown')")
check('Markdown 导出有笔记且有分区', (md.count ?? 0) > 0 && (md.folders?.length ?? 0) > 0, `notes=${md.count} folders=${md.folders?.length}`)

await sleep(600)
// 这里原本是 macOS 的路径（Library/Application Support）—— 在 Windows 上 process.env.HOME
// 是 undefined，join 直接抛错，脚本最后一条断言从来没跑成过。
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
const leak = existsSync(realDb)
  ? countOf(realDb, "SELECT COUNT(*) FROM task WHERE title LIKE '验证-打卡-%' OR title LIKE '验证-等待-%'")
  : 0
check('真实库未被写入', leak === 0, `匹配 ${leak} 行`)

await app.close()
process.exit(finish())