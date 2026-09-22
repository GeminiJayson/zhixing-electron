/**
 * 主题包验证：换包改变语义色、明暗两套各自生效、强调色保持正交。
 * 用法：node scripts/themecheck.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

// 老脚本里的 root 一律指向仓库根，原样保留的自有声明就能继续用
const root = ROOT
// sql() 助手内部用 require('node:sqlite')，这行不能少：
// 少了它，顶层 await + 全局 require 会让 Node 报 ERR_AMBIGUOUS_MODULE_SYNTAX
const require = createRequire(import.meta.url)
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

const tmpHome = join(ROOT, '.screenshots', 'theme-home')
const PORT = 9240

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()
/** 主窗口求值器：老脚本里叫 ev，保留这个名字少改正文。 */
const ev = app.evaluate
/** 浮窗是第二个 page target：主题检查要同时盯着主窗口和浮窗。 */
const widget = await app.attach((x) => x.type === 'page' && x.url.includes('widget=1'))
const token = (name) => ev(`getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`)
const wToken = (name) => widget.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`)

// 初始：默认包（青竹）+ light —— 默认值以 settings/theme-packs 的单一来源为准
const canvas0 = await token('--bg-canvas')
check('默认主题包（青竹）的 canvas 生效', canvas0.toLowerCase() === '#f4faf8', canvas0)
const bodyBg0 = await ev(`getComputedStyle(document.body).backgroundColor`)
check('主窗口底色由主题变量驱动（不是透明的窗口底色）', bodyBg0 === 'rgb(244, 250, 248)', bodyBg0)
const accent0 = await token('--accent')
check('强调色独立生效', accent0.toLowerCase() === '#0d9488', accent0)
const wCanvas0 = await wToken('--bg-canvas')
check('浮窗初始与主窗口同为默认主题包浅色', wCanvas0.toLowerCase() === '#f4faf8', wCanvas0)

// 切到设置页并换主题包
await ev(`document.querySelector('[data-nav-item="settings"]')?.click()`)
await sleep(700)
const switched = await ev(`(() => {
  const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === '樱花粉'))
  if (!sel) return 'NO_SELECT'
  sel.value = '樱花粉'
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return 'OK'
})()`, false)
await sleep(900)
check('设置页有主题包下拉', switched === 'OK', String(switched))

const canvas1 = await token('--bg-canvas')
check('换包后 canvas 变成樱花粉的浅色', canvas1.toLowerCase() === '#fdf3f6', canvas1)
const fg1 = await token('--fg-primary')
check('换包后前景色同步', fg1.toLowerCase() === '#5a2b3b', fg1)
const accent1 = await token('--accent')
check('换主题包不改强调色（两者正交）', accent1.toLowerCase() === accent0.toLowerCase(), `${accent0} -> ${accent1}`)

// 切深色：应取同一主题包的 dark 一套
await ev(`([...document.querySelectorAll('.seg button')].find(b => b.textContent === '深色'))?.click()`)
await sleep(900)
const canvas2 = await token('--bg-canvas')
check('深色模式取该包的 dark 配色', canvas2.toLowerCase() === '#241a1e', canvas2)
const warm = await token('--accent-warm')
check('语义色（暖色）取该包 dark 的取值', warm.toLowerCase() === '#f3b58a', warm)

// --- 桌面浮窗（?widget=1 的第二窗口）：换包 / 切明暗要跟着主窗口一起走 ---
const wSurface = await widget.evaluate(`document.documentElement.dataset.surface`)
check('浮窗连的是 widget 视图', wSurface === 'widget', String(wSurface))
const wBodyBg = await widget.evaluate(`getComputedStyle(document.body).backgroundColor`)
check('浮窗保持透明（透明窗口依赖它）', wBodyBg === 'rgba(0, 0, 0, 0)', wBodyBg)
const wCanvas1 = await wToken('--bg-canvas')
check('换主题包后浮窗同色', wCanvas1.toLowerCase() === canvas2.toLowerCase(), wCanvas1)
const wFg = await wToken('--fg-primary')
check('浮窗深色前景色取该包 dark', wFg.toLowerCase() === '#f5e7ec', wFg)

// 标题栏切浅色：只改 data-theme 不会重铺已内联的 token，必须整体重铺，浮窗同步跟上
await ev(`document.querySelector('.titlebar__actions button')?.click()`)
await sleep(900)
const canvas3 = await token('--bg-canvas')
check('标题栏切浅色：主题包的另一套配色真正重铺', canvas3.toLowerCase() === '#fdf3f6', canvas3)
const wCanvas2 = await wToken('--bg-canvas')
check('浮窗同步切回浅色', wCanvas2.toLowerCase() === '#fdf3f6', wCanvas2)

// 持久化：theme_pack 落库
await app.close()
await sleep(600)
const tmpDb = join(tmpHome, 'zhixing.db')
check('主题包已写入 settings 表', sql(tmpDb, "SELECT value FROM settings WHERE key = 'theme_pack';") === '樱花粉')
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
check('真实库的主题包未被改动', sql(realDb, "SELECT value FROM settings WHERE key = 'theme_pack';") === '墨黑')
process.exit(finish())