/**
 * 提醒卡片的样式一致性验证。
 *
 * 要证明的事：主窗口提醒卡片与悬浮表情气泡，用的是与应用弹框（含独立窗口里的
 * 捕获 / 条件确认）**同一张卡片** —— 圆角、描边、底色三项计算值必须完全相同，
 * 主题换了两边一起变。气泡另有一条硬性差异：透明窗口里不能有投影。
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

const tmpHome = join(ROOT, '.screenshots', 'reminderstyle-home')
const PORT = 9390

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()
try {

/** 读一张卡片的计算样式（只看真正决定「长得一样」的那几项）。 */
const cardStyle = `(sel) => {
  const el = document.querySelector(sel)
  if (!el) return null
  const s = getComputedStyle(el)
  return { radius: s.borderRadius, border: s.borderColor + ' ' + s.borderWidth + ' ' + s.borderStyle, bg: s.backgroundColor, shadow: s.boxShadow === 'none' ? 'none' : 'has-shadow' }
}`

  for (let i = 0; i < 8; i++) { await sleep(500); if (i % 3 === 2) console.log('  ' + Math.round((i + 1) * 0.5) + 's') }

  // 关掉浮窗 → 提醒走主窗口卡片
  await app.evaluate("window.zhixing.db.setSetting('widget_enabled', '0')", true)
  await app.evaluate("window.zhixing.db.createTask('样式验证任务', null, null).then((t) => window.zhixing.db.updateTask(t.id, { reminder_at: '2020-01-01 09:00:00.000000' }))")
  console.log('【等待】主进程派发（30 秒周期）…')
  let got = null
  for (let i = 0; i < 22; i++) {
    await sleep(2000)
    console.log('  ' + (i + 1) * 2 + 's')
    got = await app.evaluate(`(${cardStyle})('.modal--reminder')`, true)
    if (got) break
  }
  check('主窗口出现了提醒卡片', !!got, J(got))

  // 打开一个应用弹框作对照（「＋ 清单」在任务页工具栏里，得先切过去）
  await app.evaluate("document.querySelector('[data-nav-item=\"tasks\"]')?.click()")
  await sleep(1500)
  const opened = await app.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '＋ 清单')
    if (!b) return false
    b.click()
    return true
  })()`)
  await sleep(700)
  const dialog = await app.evaluate(`(${cardStyle})('.modal--dialog')`, true)
  check('打开了对照用的应用弹框', !!dialog, J({ opened, dialog }))

  if (got && dialog) {
    check('圆角一致', got.radius === dialog.radius, J({ reminder: got.radius, dialog: dialog.radius }))
    check('描边一致', got.border === dialog.border, J({ reminder: got.border, dialog: dialog.border }))
    /**
     * 底色**不再要求与弹框逐字相同**：玻璃拟态只给"带遮罩的模态"上玻璃
     * （.modal-mask .modal，见 global.css 的注释）—— 那时背后才有可模糊的页面内容。
     * 主窗口的提醒卡不在遮罩里（它是浮在页面上的独立卡），所以它与弹框本来就该不同：
     * 弹框半透明、提醒卡不透明。这里改成断言"两者都**不是**透明底"——
     * 真正要守的是"卡片读得清"，而不是"两个不相干的层用了同一个色值"。
     */
    check(
      '主窗口提醒卡是不透明底（它不在遮罩里，背后是可滚动的页面）',
      !got.bg.startsWith('rgba'),
      got.bg
    )
    check('对照弹框走玻璃（半透明 + 遮罩）', dialog.bg.startsWith('rgba'), dialog.bg)
    check('主窗口提醒卡片可保留投影', got.shadow !== 'none', got.shadow)
  }
  await app.evaluate("[...document.querySelectorAll('.modal__foot button')].find((b) => b.textContent.trim() === '取消')?.click()")
  await sleep(500)

  // 打开浮窗 → 提醒改走气泡；气泡卡片要和应用弹框一致，但去掉投影
  await app.evaluate("window.zhixing.db.setSetting('widget_enabled', '1')", true)
  await app.evaluate("window.zhixing.widget.toggle()")
  await sleep(900)
  await app.evaluate("window.zhixing.widget.toggle()")
  await sleep(900)
  await app.evaluate("window.zhixing.db.createTask('样式验证任务2', null, null).then((t) => window.zhixing.db.updateTask(t.id, { reminder_at: '2020-01-01 10:00:00.000000' }))")
  console.log('【等待】第二轮派发（气泡）…')
  let bubble = null
  for (let i = 0; i < 24; i++) {
    await sleep(2000)
    console.log('  ' + (i + 1) * 2 + 's')
    if (!bubble) {
      try {
        bubble = await app.attach((x) => x.type === 'page' && x.url.includes('reminder=1'))
      } catch {
        continue
      }
    }
    const s = await bubble.evaluate(`(${cardStyle})('.modal--reminder')`, true)
    if (s) { bubble.__style = s; break }
  }
  const bs = bubble?.__style ?? null
  check('气泡里出现了提醒卡片', !!bs, J(bs))
  if (bs && dialog) {
    check('气泡圆角与弹框一致', bs.radius === dialog.radius, J({ bubble: bs.radius, dialog: dialog.radius }))
    check('气泡描边与弹框一致', bs.border === dialog.border, J({ bubble: bs.border, dialog: dialog.border }))
    // 气泡窗是**透明窗口**：卡片必须自备不透明底，否则会直接透出桌面；
    // 它也不能用 backdrop-filter（透明窗口里会在窗口边界留残影），所以刻意不上玻璃。
    check('气泡卡自带不透明底（不依赖窗口）', !bs.bg.startsWith('rgba'), bs.bg)
    check('气泡里没有投影（透明窗口会被裁成方角残影）', bs.shadow === 'none', bs.shadow)
  }
} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}
await app.close()
process.exit(finish())