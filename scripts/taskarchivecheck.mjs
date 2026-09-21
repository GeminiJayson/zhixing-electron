import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = join(root, '.screenshots', 'archive-home')
const PORT = 9381
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db'), join(tmpHome, 'zhixing.db'))
const SYS_PATH = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem'].join(';')
const child = spawn(electronPath, ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(tmpHome, 'profile')], { cwd: root, env: { ...process.env, PATH: SYS_PATH + ';' + (process.env.PATH ?? ''), ZHIXING_HOME: tmpHome }, stdio: ['ignore', 'pipe', 'pipe'] })
const list = async () => { try { return await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json() } catch { return [] } }
let main = null
for (let i = 0; i < 60 && !main; i++) { main = (await list()).find((t) => t.type === 'page'); if (!main) await sleep(500) }
const ws = new WebSocket(main.webSocketDebuggerUrl)
await new Promise((res) => ws.addEventListener('open', res, { once: true }))
const send = (m, p = {}) => new Promise((resolve) => { const id = Math.floor(Math.random() * 1e6); const h = (ev) => { const x = JSON.parse(ev.data); if (x.id !== id) return; ws.removeEventListener('message', h); resolve(x) }; ws.addEventListener('message', h); ws.send(JSON.stringify({ id, method: m, params: p })) })
await send('Runtime.enable')
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result?.result?.value
}
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log((ok ? '✓ ' : '✗ ') + n + (d ? ' — ' + d : '')) }
const J = (v) => JSON.stringify(v)
try {
  await sleep(3200)
  // 两步：先在页面里造数据并把 id 存到全局，再用那个全局做释放 —— 全程不做字符串插值
  const setup = await evaluate(`(async () => {
    const parent = await window.zhixing.db.createTask('归档父', null, null)
    const child = await window.zhixing.db.createTask('归档子', parent.id, null)
    await window.zhixing.db.setStatus(parent.id, 'done')
    const c1 = await window.zhixing.db.setStatus(child.id, 'done')
    window.__rel = { parentId: parent.id, childId: child.id }
    return { parentId: parent.id, childId: child.id, childParent: c1 && c1.parent_id, childStatus: c1 && c1.status }
  })()`)
  check('造出父子两个任务（子挂父）并标记完成', setup.childStatus === 'done' && setup.childParent === setup.parentId, J(setup))
  const freed = await evaluate(`(async () => {
    const f = await window.zhixing.db.restoreCompleted(window.__rel.childId, null)
    const c = await window.zhixing.db.restoreCompleted(window.__rel.childId, null)
    const p = await window.zhixing.db.setStatus(window.__rel.parentId, 'done')
    const after = await window.zhixing.db.restoreCompleted(window.__rel.childId, null)
    return { freedStatus: f && f.status, freedCompleted: f && f.completed_at, freedParent: f && f.parent_id,
      againParent: c && c.parent_id, parentBackToDone: p && p.status, lastParent: after && after.parent_id }
  })()`)
  check('释放后回到待执行（status=todo 且清空完成时间）', freed.freedStatus === 'todo' && freed.freedCompleted === null, J(freed))
  check('层级原样保留（parent_id 始终是父任务）', freed.freedParent === setup.parentId && freed.againParent === setup.parentId && freed.lastParent === setup.parentId, J(freed))
  // 把父任务重新设回完成，再释放子任务，看父是否被连带恢复
  // 真正的「连带恢复祖先」验证：把父重新设回完成，再释放子，然后查父的状态
  const cascade = await evaluate(`(async () => {
    await window.zhixing.db.setStatus(window.__rel.parentId, 'done')
    const before = await window.zhixing.db.getTask(window.__rel.parentId)
    await window.zhixing.db.restoreCompleted(window.__rel.childId, null)
    const after = await window.zhixing.db.getTask(window.__rel.parentId)
    return { beforeStatus: before && before.status, afterStatus: after && after.status }
  })()`)
  check(
    '连带恢复仍是终态的祖先（父任务也回到待执行）',
    cascade.beforeStatus === 'done' && cascade.afterStatus === 'todo',
    J(cascade)
  )
} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}
const failed = results.filter((r) => !r).length
console.log('')
console.log(failed ? '✗ ' + failed + ' 项未通过' : '✓ 全部通过（' + results.length + ' 项）')
await sleep(500)
child.kill()
process.exit(failed ? 1 : 0)
