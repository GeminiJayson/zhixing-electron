/**
 * 清单设置的守门验证：改名与删除必须是两个独立动作，绝不能互相滑过去。
 *
 * 来由：1.6.0 的「清单设置」把两件事塞进一个函数 —— 改名对话框的默认值就是当前名，
 * 条件不成立（没改名、或者用户点了取消，此时 prompt resolve(null)）就继续往下走，
 * 落到 dialog.confirm「删除清单？」。取消一次 = 弹一次删除确认。
 *
 * 断言写成行为而不是实现细节：不管这里最终用的是菜单还是两个按钮，
 * 「取消重命名之后不得出现删除确认」都必须成立。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = join(root, '.screenshots', 'listguard-home')
const PORT = 9386
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db'), join(tmpHome, 'zhixing.db'))

const SYS_PATH = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem'].join(';')
console.log('【启动】拉起 Electron…')
const child = spawn(
  electronPath,
  ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(tmpHome, 'profile')],
  {
    cwd: root,
    env: { ...process.env, PATH: SYS_PATH + ';' + (process.env.PATH ?? ''), ZHIXING_HOME: tmpHome },
    stdio: ['ignore', 'pipe', 'pipe']
  }
)

const listTargets = async () => {
  try {
    return await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
  } catch {
    return []
  }
}

let main = null
for (let i = 0; i < 70 && !main; i++) {
  const all = await listTargets()
  const t = all.find((x) => x.type === 'page' && !/[?&](widget|reminder|condition|capture)=1/.test(x.url))
  if (t) {
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((res) => ws.addEventListener('open', res, { once: true }))
    const send = (m, p = {}) =>
      new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e6)
        const timer = setTimeout(() => {
          ws.removeEventListener('message', h)
          reject(new Error('CDP 超时（15s）：' + m))
        }, 15000)
        const h = (ev) => {
          const x = JSON.parse(ev.data)
          if (x.id !== id) return
          clearTimeout(timer)
          ws.removeEventListener('message', h)
          resolve(x)
        }
        ws.addEventListener('message', h)
        ws.send(JSON.stringify({ id, method: m, params: p }))
      })
    await send('Runtime.enable')
    main = {
      evaluate: async (expr, quiet) => {
        if (!quiet) console.log('  · eval ' + String(expr).replace(/\s+/g, ' ').slice(0, 66))
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
        if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval 失败')
        return r.result?.result?.value
      }
    }
  } else {
    if (i % 4 === 0) console.log('【等窗口】' + Math.round(i * 0.5) + 's')
    await sleep(500)
  }
}

const results = []
const check = (n, ok, d = '') => {
  results.push(ok)
  console.log((ok ? '✓ ' : '✗ ') + n + (d ? ' — ' + d : ''))
}
const J = (v) => JSON.stringify(v)

/** 当前弹框（如果有）的标题与是否出现删除确认。 */
const dialogState = `(() => {
  const d = document.querySelector('.modal--dialog')
  return { open: !!d, title: d ? (d.querySelector('h2')?.textContent || '') : '' }
})()`

try {
  console.log('【就绪】等界面稳定…')
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    if (i % 3 === 2) console.log('  ' + Math.round((i + 1) * 0.5) + 's')
  }

  await main.evaluate("document.querySelector('[data-nav-item=\"tasks\"]')?.click()")
  await sleep(1500)

  const listId = await main.evaluate(`(async () => {
    const folders = await window.zhixing.db.listFolders()
    const one = folders.find((f) => f.kind === 'list')
    if (one) return one.id
    const made = await window.zhixing.db.createListFolder('守门验证清单', 'list', null)
    return made && made.id
  })()`)
  check('拿到一张可操作的清单', typeof listId === 'number' && listId > 0, J(listId))

  await main.evaluate(`(() => {
    const s = document.querySelector('select[aria-label="按清单筛选"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(s, '${listId}')
    s.dispatchEvent(new Event('change', { bubbles: true }))
    return s.value
  })()`)
  await sleep(900)

  // 点「清单设置」
  const opened = await main.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '清单设置')
    if (!b) return 'no-button'
    b.click()
    return 'clicked'
  })()`)
  check('任务页有「清单设置」入口', opened === 'clicked', J(opened))
  await sleep(800)

  // 进来之后是什么？菜单（新实现）还是改名对话框（旧实现）都接受，但必须能分辨
  const first = await main.evaluate(dialogState)
  const menuItems = await main.evaluate(
    "(() => [...document.querySelectorAll('.popmenu button, .popmenu__item')].map((b) => b.textContent.trim()))()"
  )
  console.log('  首个界面：' + J({ dialog: first, menu: menuItems }))

  // 这条必须在菜单还开着的时候断言 —— 选完菜单就关了
  check(
    '清单设置里改名与删除是分开的两个独立入口',
    menuItems.includes('重命名清单') && menuItems.includes('删除清单'),
    J(menuItems)
  )

  if (first.open && first.title.includes('重命名')) {
    // 旧实现：改名对话框直接出现 —— 点取消，然后检查有没有滑向删除
    await main.evaluate(
      "[...document.querySelectorAll('.modal__foot button')].find((b) => b.textContent.trim() === '取消')?.click()"
    )
  } else {
    // 新实现：菜单。点「重命名清单」，再在对话框里取消
    await main.evaluate(
      "[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '重命名清单')?.click()"
    )
    await sleep(700)
    await main.evaluate(
      "[...document.querySelectorAll('.modal__foot button')].find((b) => b.textContent.trim() === '取消')?.click()"
    )
  }
  await sleep(900)

  const after = await main.evaluate(dialogState)
  check(
    '取消重命名之后不得出现「删除清单」确认',
    !(after.open && after.title.includes('删除')),
    J(after)
  )

} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}
const failed = results.filter((r) => !r).length
console.log('')
console.log(failed ? '✗ ' + failed + ' 项未通过' : '✓ 全部通过（' + results.length + ' 项）')
await sleep(400)
child.kill()
process.exit(failed ? 1 : 0)
