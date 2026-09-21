/**
 * 提醒策略的端到端验证：提前量 / 自动提醒规则 / 重复次数。
 *
 * 关键断言是「提前量真的生效」：给一条 5 分钟后截止的任务配上 30 分钟提前量，
 * 它此刻就该提醒 —— 若提前量没生效，它要等到 5 分钟后才弹，本脚本会看到 0 条提醒。
 * 另外检查记账是否落库（reminder_fired / reminder_base），那是「提醒几次」的依据。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

// 老脚本里的 root 一律指向仓库根，原样保留的自有声明就能继续用
const root = ROOT
const live = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
const SYS = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem'].join(';')

const tmpHome = join(ROOT, '.screenshots', 'reminderpolicy-home')
const PORT = 9392

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()
try {
  for (let i = 0; i < 8; i++) { await sleep(500); if (i % 3 === 2) console.log('  ' + Math.round((i + 1) * 0.5) + 's') }

  // 设置页：三组新设置是否在
  await app.evaluate("document.querySelector('[data-nav-item=\"settings\"]')?.click()")
  await sleep(1500)
  await app.evaluate("[...document.querySelectorAll('button, [role=tab]')].find((b) => b.textContent.trim() === '任务与提醒')?.click()")
  await sleep(900)
  const ui = await app.evaluate(`(() => {
    const texts = [...document.querySelectorAll('.set-row > span:first-child')].map((s) => s.textContent.trim())
    return { texts: texts.filter((t) => t.includes('提醒') || t.includes('优先级') || t.includes('间隔')) }
  })()`)
  check('设置页出现提前量', ui.texts.includes('提前提醒'), J(ui.texts))
  check('设置页出现自动提醒规则', ui.texts.includes('有截止时刻的任务自动提醒') && ui.texts.includes('只有截止日期的任务当天提醒'), J(ui.texts))
  check('设置页出现提醒次数与间隔', ui.texts.includes('每条最多提醒') && ui.texts.includes('重复间隔'), J(ui.texts))

  // 写设置：提前 30 分钟、最多 3 次、间隔 10 分钟
  await app.evaluate(`window.zhixing.db.setSettings({
    reminder_lead_minutes: '30',
    reminder_repeat_count: '3',
    reminder_repeat_interval_minutes: '10',
    reminder_rule_due_time: '1',
    reminder_rule_due_date: '1',
    reminder_rule_priority_min: '0',
    widget_enabled: '0'
  })`)

  // 造一条 5 分钟后截止的任务（没有 reminder_at）—— 提前 30 分钟意味着此刻就该提醒
  const made = await app.evaluate(`(async () => {
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const due = new Date(now.getTime() + 5 * 60_000)
    const day = due.getFullYear() + '-' + pad(due.getMonth() + 1) + '-' + pad(due.getDate())
    const hhmm = pad(due.getHours()) + ':' + pad(due.getMinutes())
    const t = await window.zhixing.db.createTask('提前量验证', null, null)
    await window.zhixing.db.updateTask(t.id, { due_date: day, due_time: hhmm })
    window.__probe = { id: t.id, day, hhmm }
    return { id: t.id, due: day + ' ' + hhmm, nowIsBeforeDue: Date.now() < due.getTime() }
  })()`)
  check('造出一条「5 分钟后截止」的任务，且现在还没到点', made?.nowIsBeforeDue === true, J(made))

  console.log('【等待】主进程派发（30 秒周期）…')
  let card = null
  for (let i = 0; i < 22; i++) {
    await sleep(2000)
    console.log('  ' + (i + 1) * 2 + 's')
    card = await app.evaluate("document.querySelector('.modal--reminder') ? true : null", true)
    if (card) break
  }
  check('提前量生效：还没到截止时刻就已经提醒', card === true, J(card))

  const rec = await app.evaluate(`(async () => {
    const rows = await window.zhixing.db.tasks()
    const t = rows.find((x) => x.id === window.__probe.id)
    return t
      ? { fired: t.reminder_fired, base: t.reminder_base, expected: window.__probe.day + ' ' + window.__probe.hhmm + ':00' }
      : null
  })()`, true)
  check('记账落库：已提醒 1 次', rec?.fired === 1, J(rec))
  check('记账的基准就是截止时刻', rec?.base === rec?.expected, J(rec))
} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}
await app.close()
process.exit(finish())