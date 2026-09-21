/**
 * 任务↔笔记关联「要能掉链」的行为验证。
 *
 * 来由：task_note_link 原先只增不减 —— 把 [[标题]] 从任务正文里删掉，行还留着，
 * 任务行的 ⇄N 计数与图谱里的任务-笔记边于是永远不消失。
 * 反过来直接清空重写又会误伤手动关联（笔记页「归属任务」、图谱拉边写入的行，
 * 它根本不出现在正文里）。所以这里两条都要断言：
 *   ① 删掉 [[标题]] 必须真的掉链；
 *   ② 手动关联不许被这次对账顺带清掉。
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
const tmpHome = join(root, '.screenshots', 'notelink-home')
const PORT = 9389
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
      evaluate: async (expr) => {
        const r = await send('Runtime.evaluate', {
          expression: expr,
          returnByValue: true,
          awaitPromise: true
        })
        if (r.result?.exceptionDetails) {
          throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval 失败')
        }
        return r.result?.result?.value
      },
      ws
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

// 浏览器侧一次性跑完，避免来回插值。只增不减这条路径必须用真库验，纯函数单测挡不住接线错误。
const BROWSER = [
  '(async () => {',
  '  const db = window.zhixing.db',
  '  const stamp = String(Date.now())',
  '  const folders = await db.listFolders()',
  '  const f = folders.find((x) => x.kind === "note") || folders[0] || null',
  '  const task = await db.createTask("掉链验证任务 " + stamp, null, null)',
  '  const n1 = await db.createNote("甲" + stamp, f ? f.id : null, "", "markdown")',
  '  const n2 = await db.createNote("乙" + stamp, f ? f.id : null, "", "markdown")',
  '  const out = { error: null }',
  '  const link = "[[" + n1.title + "]]"',
  '  const count = async () => (await db.linkedNotes(task.id)).length',
  '  try {',
  '    await db.updateTask(task.id, { notes_md: link })',
  '    out.afterAdd = await count()',
  '    await db.updateTask(task.id, { notes_md: "" })',
  '    out.afterRemove = await count()',
  '    await db.updateTask(task.id, { notes_md: link })',
  '    out.afterReAdd = await count()',
  '    await db.attachTaskNote(task.id, n2.id)',
  '    out.afterManual = await count()',
  '    await db.updateTask(task.id, { notes_md: "" })',
  '    out.afterManualThenClear = await count()',
  '    await db.detachTaskNote(task.id, n2.id)',
  '    out.afterDetach = await count()',
  '  } catch (e) {',
  '    out.error = String((e && e.message) || e)',
  '  }',
  '  try {',
  '    await db.deleteTask(task.id)',
  '    await db.deleteNote(n1.id)',
  '    await db.deleteNote(n2.id)',
  '  } catch (e) { /* 清理失败不影响判定 */ }',
  '  return out',
  '})()'
].join('\n')

try {
  console.log('【就绪】等界面稳定…')
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    if (i % 3 === 2) console.log('  ' + Math.round((i + 1) * 0.5) + 's')
  }

  const out = await main.evaluate(BROWSER)
  if (!out || out.error) {
    check('浏览器侧探针跑完', false, (out && out.error) || '无返回')
  } else {
    check('正文写入 [[标题]] 后落链', out.afterAdd === 1, 'linkedNotes=' + out.afterAdd)
    check('从正文删掉 [[标题]] 后掉链', out.afterRemove === 0, 'linkedNotes=' + out.afterRemove)
    check('正文重新写回后再次落链', out.afterReAdd === 1, 'linkedNotes=' + out.afterReAdd)
    check('手动关联与派生关联并存', out.afterManual === 2, 'linkedNotes=' + out.afterManual)
    check(
      '清空正文不得误删手动关联的那条',
      out.afterManualThenClear === 1,
      'linkedNotes=' + out.afterManualThenClear
    )
    check('解除手动关联后清空', out.afterDetach === 0, 'linkedNotes=' + out.afterDetach)
  }

  // 计数器与关联列表必须同源（⇄N 走的是 noteCounts）
  const counts = await main.evaluate(
    '(async () => { const rows = await window.zhixing.db.noteCounts(); return rows.filter((r) => r.c > 0).length })()'
  )
  check('noteCounts 可读（⇄N 计数同源）', typeof counts === 'number', '非零计数行=' + counts)
} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}

const failed = results.filter((r) => !r).length
console.log('')
console.log(failed ? '✗ ' + failed + ' 项未通过' : '✓ 全部通过（' + results.length + ' 项）')
await sleep(400)
child.kill()
process.exit(failed ? 1 : 0)
