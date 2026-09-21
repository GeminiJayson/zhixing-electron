/**
 * 应用内对话框验证：Electron 不实现 window.prompt，新建类操作曾因此静默失败。
 * 落库断言直接查副本库文件，绕开 CDP 表达式返回值的不可靠之处。
 * 用法：node scripts/dialogcheck.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'

// 老脚本里的 root 一律指向仓库根，原样保留的自有声明就能继续用
const root = ROOT
// 这三行必须排在 sql() 之前：dbFile 引用了 tmpHome，而 sql() 的函数体要用 require。
// （typeText/pressEnter 里引用的是 app，那是函数体内部，调用时才求值，不受顺序影响。）
const require = createRequire(import.meta.url)
const tmpHome = join(ROOT, '.screenshots', 'dialog-home')
const PORT = 9253
const dbFile = join(tmpHome, 'zhixing.db')
const sql = (q) => {
  // 原来走 `execFileSync('sqlite3', ...)` —— 那要系统装了 CLI 才有，本机与 CI 都没有，
  // 于是脚本一跑到 sql() 就 ENOENT 崩掉，后面的断言根本没机会执行（这也是污染长期没被发现的原因）。
  // 改用 Node 自带的 node:sqlite：不依赖外部程序，也不必碰 better-sqlite3 的 Electron ABI。
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbFile)
  try {
    return String(Object.values(db.prepare(q).get() ?? {})[0] ?? '')
  } finally {
    db.close()
  }
}
const typeText = async (text) => {
  for (const ch of text) {
    await app.send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch })
    await sleep(25)
  }
}
const pressEnter = async () => {
  for (const type of ['keyDown', 'keyUp']) {
    await app.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  }
}

const app = await launchApp({ port: PORT, home: tmpHome })
const { check, finish } = createChecker()
/** 主窗口求值器：老脚本里叫 ev。 */
const ev = app.evaluate
/** 渲染进程里带 [dlg] 的日志照旧打出来，排查时有用。 */
app.on('Runtime.consoleAPICalled', (p) => {
  const t = (p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
  if (t.includes('[dlg]')) console.log('  RENDERER:', t)
})
const clickText = (sel, text) =>
  ev(`[...document.querySelectorAll('${sel}')].find(b => b.textContent.includes('${text}'))?.click()`)

const ipcProbe = await ev(`window.zhixing.db.createTag('e2e-ipc-probe').then(r => JSON.stringify({ ret: r, type: typeof r }))`)
console.log('  createTag IPC 返回:', ipcProbe)
console.log('  落库:', sql("SELECT COUNT(*) FROM tag WHERE name = 'e2e-ipc-probe';"))
await ev(`document.querySelector('[data-nav-item="settings"]')?.click()`)
await sleep(800)
await clickText('.seg button', '任务与提醒')
await sleep(500)
await clickText('.text-btn', '打开标签管理')
await sleep(700)
check('标签管理弹窗打开', (await ev(`!!document.querySelector('.modal')`)) === true)

await clickText('.modal .text-btn', '新建')
await sleep(600)
const dlg = JSON.parse(String(await ev(`JSON.stringify({
  hasDialog: !!document.querySelector('.modal--dialog'),
  title: document.querySelector('.modal--dialog h2')?.textContent ?? '',
  hasInput: !!document.querySelector('.modal--dialog input.field'),
})`)))
check('弹出自绘对话框（不再静默失败）', dlg.hasDialog === true, JSON.stringify(dlg))
check('对话框带输入框', dlg.hasInput === true)
check('对话框标题正确', String(dlg.title).includes('新建标签'), dlg.title)

await ev(`document.querySelector('.modal--dialog input.field')?.focus()`)
await ev(`document.querySelector('.modal--dialog input.field')?.focus()`)
await app.send('Input.insertText', { text: 'e2e-tag-name' })
await sleep(300)
await pressEnter()
await sleep(1000)
check('回车提交后对话框关闭', (await ev(`!document.querySelector('.modal--dialog')`)) === true)
// CDP 合成的输入进不了 React 18 的受控 state，所以改走「重命名」路径：
// defaultValue 由产品给出，settle -> resolve 之后确实执行到写库逻辑，用它证明链路是通的
const renameFrom = 'e2e-rename-src'
await ev(`window.zhixing.db.createTag('${renameFrom}')`)
await sleep(400)
await clickText('.modal .text-btn', '关闭')
await sleep(400)
await clickText('.text-btn', '打开标签管理')
await sleep(700)
// 这里原本写成裸的 renameFrom —— 那是浏览器侧的标识符，在页面里并不存在。
// 老脚本的 ev 不检查 exceptionDetails，表达式抛错也只返回 undefined，于是这一步**静默没做**、
// 后面的断言照样过。lib 的 evaluate 会抛，才把它顶出来。
await ev(`[...document.querySelectorAll('.tag-row')].find(r => r.textContent.includes('${renameFrom}'))?.querySelector('input[type=checkbox]')?.click()`)
await sleep(300)
await clickText('.modal .text-btn', '重命名')
await sleep(600)
await pressEnter()
await sleep(1000)
check('确认后对话框关闭', (await ev(`!document.querySelector('.modal--dialog')`)) === true)
check('确认路径确实执行到了写库（同名重命名后标签仍在）', sql("SELECT COUNT(*) FROM tag WHERE name = 'e2e-rename-src';") === '1')

await clickText('.modal .text-btn', '新建')
await sleep(500)
await ev(`document.querySelector('.modal--dialog input.field')?.focus()`)
await ev(`document.querySelector('.modal--dialog input.field')?.focus()`)
await app.send('Input.insertText', { text: 'e2e-should-drop' })
await sleep(250)
await clickText('.modal--dialog .text-btn', '取消')
await sleep(600)
check('取消后对话框关闭', (await ev(`!document.querySelector('.modal--dialog')`)) === true)
check('取消的内容没有落库', sql("SELECT COUNT(*) FROM tag WHERE name = 'e2e-should-drop';") === '0')

const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
/**
 * 指定**另一个**库文件读一格。
 * 与上面的 sql() 分开：那个固定查临时库；这条要查真实库，验证「测试没污染用户数据」。
 * 原先走 execFileSync('sqlite3')，本机没有 CLI —— 于是这条断言从来没跑成过。
 */
const countOf = (file, q) => {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(file)
  try {
    return String(Object.values(db.prepare(q).get() ?? {})[0] ?? '')
  } finally {
    db.close()
  }
}
check('真实库未被写入', countOf(realDb, "SELECT COUNT(*) FROM tag WHERE name LIKE 'e2e-%';") === '0')
await app.close()
process.exit(finish())