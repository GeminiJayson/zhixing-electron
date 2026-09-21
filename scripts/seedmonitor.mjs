#!/usr/bin/env node
/**
 * 全功能冒烟：在**副本库**里造一整套测试数据（任务 / 笔记 / 工作流 / 闪念 / 设置 / AI），
 * 每一步都走真实 IPC 链路 + 真实 UI 交互，并全程监控问题。
 *
 * 产出：.screenshots/seed-report.json（结构化问题清单）+ .screenshots/seed-shots/*.png
 * 用法：node scripts/seedmonitor.mjs（先 npm run build）
 *
 * 设计：应用侧调用一律用「api 名 + JSON 参数」生成（见 db()/ai()），
 * 避免在脚本里手写表达式带来的多层转义问题。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = join(root, '.screenshots', 'seed-home')
const shotDir = join(root, '.screenshots', 'seed-shots')
const PORT = 9260
const API_PORT = 9261
const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
if (!existsSync(realDb)) { console.error('找不到真实库: ' + realDb); process.exit(1) }

// 本地假 OpenAI 兼容端点
const aiServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    const content = JSON.stringify({ folder: '', title: 'AI 整理后的标题', summary: '自动整理', content: '# 整理后正文', links: [] })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
  })
})
await new Promise((r) => aiServer.listen(API_PORT, '127.0.0.1', r))

rmSync(tmpHome, { recursive: true, force: true })
rmSync(shotDir, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
mkdirSync(shotDir, { recursive: true })
copyFileSync(realDb, join(tmpHome, 'zhixing.db'))

const SYS_PATH = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem'].join(';')
const child = spawn(electronPath, ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(tmpHome, 'profile')], {
  cwd: root,
  env: { ...process.env, PATH: SYS_PATH + ';' + (process.env.PATH ?? ''), ZHIXING_HOME: tmpHome },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const mainLog = []
child.stderr?.on('data', (b) => mainLog.push(String(b)))

const list = async () => { try { return await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json() } catch { return [] } }
let target = null
for (let i = 0; i < 80 && !target; i++) { target = (await list()).find((t) => t.type === 'page'); if (!target) await sleep(500) }
if (!target) { console.error('主窗口没起来'); child.kill(); aiServer.close(); process.exit(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
let msgId = 0
const pending = new Map()
const consoleErrors = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params?.type)) {
    const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
    if (text) consoleErrors.push({ level: m.params.type, text: text.slice(0, 300) })
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push({ level: 'exception', text: String(m.params?.exceptionDetails?.exception?.description ?? '').slice(0, 300) })
  }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}) => new Promise((resolve) => { const id = ++msgId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
await send('Runtime.enable'); await send('Page.enable')
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description ?? 'eval failed').slice(0, 300))
  return r.result?.result?.value
}
const shoot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result?.data) writeFileSync(join(shotDir, name), Buffer.from(r.result.data, 'base64')) }
const click = async (selector) => evaluate('(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return false; el.click(); return true })()')
const clickText = async (text) =>
  evaluate('(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes(' + JSON.stringify(text) + ')); if (!b) return false; b.click(); return true })()')

/** 调 window.zhixing.<ns>.<api>(...) —— 参数走 JSON，彻底避开手写表达式的转义 */
const call = (ns, api, ...args) =>
  evaluate('window.zhixing.' + ns + '.' + api + '(' + args.map((a) => JSON.stringify(a)).join(', ') + ')')
const db = (api, ...args) => call('db', api, ...args)
const ai = (api, ...args) => call('ai', api, ...args)

const results = { ok: [], problems: [], steps: 0 }
const record = (stage, what, detail, expected, actual, shot) =>
  results.problems.push({ stage, what, detail: String(detail ?? '').slice(0, 500), expected, actual, shot })
const step = async (stage, what, fn, expected = '正常完成') => {
  results.steps += 1
  try {
    const out = await fn()
    results.ok.push(stage + ' / ' + what)
    console.log('✓ ' + stage + ' | ' + what + (out !== undefined ? ' — ' + JSON.stringify(out).slice(0, 130) : ''))
    return out
  } catch (err) {
    console.log('✗ ' + stage + ' | ' + what + ' — ' + String(err.message).slice(0, 160))
    record(stage, what, err.message, expected, '抛异常/失败')
    return null
  }
}
const need = (v, msg) => { if (v === null || v === undefined || v === false) throw new Error(msg); return v }

const S = 'SEED' + Date.now().toString(36)
let uiNoteId = null
await sleep(2800)

// ============================================================ 1. 任务
const taskIds = {}
await step('任务', '新建顶层任务', async () => { taskIds.top = need(await db('createTask', S + ' 顶层任务', null, null).then((t) => t && t.id), 'createTask 没返回任务'); return taskIds.top })
await step('任务', '三层子树', async () => {
  taskIds.child = need(await db('createTask', S + ' 子任务', taskIds.top, null).then((t) => t && t.id), '子任务没建出来')
  taskIds.grand = need(await db('createTask', S + ' 孙任务', taskIds.child, null).then((t) => t && t.id), '孙任务没建出来')
  return [taskIds.child, taskIds.grand]
})
await step('任务', '快速添加（语法糖）', async () => {
  await db('createTag', '测试标签').catch(() => null)
  const created = await db('quickAdd', S + ' 语法糖任务 !3 #测试标签 明天')
  need(created, 'quickAdd 没解析出任务')
  return { priority: created.priority, due: created.due_date }
})
await step('任务', '优先级 / 截止 / 重复 / 备注', async () => {
  await db('updateTask', taskIds.top, { priority: 5, due_date: '2026-10-08', repeat_period: 'daily', notes_md: '冒烟备注' })
  const t = await db('tasks', 400).then((r) => r.find((x) => x.id === taskIds.top))
  if (!t || t.priority !== 5 || t.repeat_period !== 'daily') throw new Error('字段没写进去: ' + JSON.stringify({ p: t && t.priority, r: t && t.repeat_period }))
  return { priority: t.priority, repeat: t.repeat_period }
})
await step('任务', '暂停 / 恢复', async () => { await db('pauseTask', taskIds.child); await db('resumeTask', taskIds.child); return true })
await step('任务', '勾选完成（子任务）', async () => {
  await db('toggleTask', taskIds.child, true)
  const t = await db('tasks', 400).then((r) => r.find((x) => x.id === taskIds.child))
  if (!t || t.status !== 'done') throw new Error('勾选后状态不是 done：' + (t && t.status))
  return t.status
})
await step('任务', '软删除 → 回收站 → 恢复', async () => {
  const id = need(await db('createTask', S + ' 将被删除', null, null).then((t) => t && t.id), '建任务失败')
  await db('deleteTask', id)
  const inTrash = await db('trashItems', 'task').then((r) => r.some((x) => x.id === id))
  if (!inTrash) throw new Error('删除后没出现在回收站')
  await db('restoreTrash', 'task', id)
  return true
})
await step('任务', '批量设截止 + 批量删除', async () => {
  const a = await db('createTask', S + ' 批量A', null, null).then((t) => t && t.id)
  const b = await db('createTask', S + ' 批量B', null, null).then((t) => t && t.id)
  const n = await db('batchSetDue', [a, b], '2026-10-20')
  for (const id of [a, b]) await db('deleteTask', id)
  if (!n) throw new Error('batchSetDue 返回 0')
  return { changed: n }
})
await step('任务', 'UI：任务页渲染', async () => {
  await click('[data-nav-item=tasks]'); await sleep(1300)
  const n = await evaluate('document.querySelectorAll(".task-tree > *, [class*=task-row], .task-row").length')
  const text = await evaluate('document.body.innerText')
  await shoot('01-tasks.png')
  if (!text.includes(S + ' 顶层任务')) throw new Error('任务页正文里看不到刚建的任务')
  return { rows: n }
})
await step('任务', 'UI：打开快速捕获独立窗口', async () => {
  await call('capture', 'open', 'quick'); await sleep(1600)
  const win = (await list()).find((t) => String(t.url).includes('capture=1'))
  if (!win) throw new Error('没开出捕获窗口')
  await call('capture', 'close')
  return true
})

// ============================================================ 2. 笔记
const folderIds = {}
await step('笔记', '两层文件夹', async () => {
  folderIds.root = need(await db('createNoteFolder', S + ' 资料', null).then((f) => f && f.id), '建文件夹失败')
  folderIds.sub = need(await db('createNoteFolder', S + ' 子目录', folderIds.root).then((f) => f && f.id), '建子文件夹失败')
  return [folderIds.root, folderIds.sub]
})
const noteIds = {}
await step('笔记', '三种格式各一篇', async () => {
  noteIds.md = need(await db('createNote', S + ' Markdown 笔记', folderIds.sub, '# 标题 正文一段 要点', 'markdown').then((n) => n && n.id), 'markdown 笔记失败')
  noteIds.rt = need(await db('createNote', S + ' 富文本笔记', null, '<p>富文本正文</p>', 'richtext').then((n) => n && n.id), 'richtext 笔记失败')
  noteIds.link = need(await db('createNote', S + ' 链接笔记', null, JSON.stringify([{ title: '知乎', target: 'https://zhihu.com' }, { title: 'GitHub', target: 'https://github.com' }]), 'link').then((n) => n && n.id), 'link 笔记失败')
  return { md: noteIds.md, rt: noteIds.rt, link: noteIds.link }
})
await step('笔记', '双链 [[...]] 解析', async () => {
  await db('saveNote', noteIds.rt, { content_md: '<p>引用 [[' + S + ' Markdown 笔记]] 的内容</p>' })
  const out = await db('outLinks', noteIds.rt)
  if (!out || !out.length) throw new Error('双链没被解析（outLinks 为空）')
  return out.length
})
await step('笔记', '标签 + 钉住', async () => {
  await db('createTag', '笔记标签')
  await db('saveNote', noteIds.md, { pinned: true })
  const t = await db('tasks', 1) // 顺带确认 db 命名空间仍可用
  return { tagsOk: true, sampleTask: Array.isArray(t) }
})
await step('笔记', '两次修改产生历史版本', async () => {
  await db('saveNote', noteIds.md, { content_md: '# 标题 第二版正文' })
  await db('saveNote', noteIds.md, { content_md: '# 标题 第三版正文' })
  const revs = await db('noteRevisions', noteIds.md)
  if (!revs || !revs.length) throw new Error('没有产生历史版本')
  return revs.length
})
await step('笔记', '回滚到上一版', async () => {
  const revs = await db('noteRevisions', noteIds.md)
  const ok = await db('restoreNoteRevision', noteIds.md, revs[0].id)
  if (!ok) throw new Error('回滚返回 false')
  return true
})
await step('笔记', '链接笔记改链接项', async () => {
  const ok = await db('saveNote', noteIds.link, { content_md: JSON.stringify([{ title: 'MDN', target: 'https://developer.mozilla.org' }]) })
  if (!ok) throw new Error('保存链接笔记返回 false')
  return true
})
await step('笔记', '移动 / 重命名 / 删除文件夹', async () => {
  await db('moveNoteFolder', folderIds.sub, null)
  await db('renameNoteFolder', folderIds.sub, S + ' 改名后的目录')
  await db('deleteNoteFolder', folderIds.sub)
  return true
})
await step('笔记', '删除笔记 → 回收站 → 恢复', async () => {
  const id = await db('createNote', S + ' 待删除笔记', null, '内容', 'markdown').then((n) => n && n.id)
  await db('deleteNote', id)
  const inTrash = await db('trashItems', 'note').then((r) => r.some((x) => x.id === id))
  if (!inTrash) throw new Error('删除的笔记没出现在回收站')
  await db('restoreTrash', 'note', id)
  return true
})
await step('笔记', 'UI：笔记页 + 树', async () => {
  await click('[data-nav-item=notes]'); await sleep(1500)
  const n = await evaluate('document.querySelectorAll(".ntree__note").length')
  await shoot('02-notes.png')
  if (!n) throw new Error('笔记树没有渲染出行')
  return n
})
await step('笔记', 'UI：链接笔记表格', async () => {
  await evaluate('(() => { const r = [...document.querySelectorAll(".ntree__note")].find((e) => e.innerText.includes(' + JSON.stringify(S + ' 链接笔记') + ')); if (r) r.click() })()')
  await sleep(1300)
  const cells = await evaluate('document.querySelectorAll(".link-table__cell").length')
  await shoot('03-link-note.png')
  if (!cells) throw new Error('链接表格没渲染（.link-table__cell 为 0）')
  return cells
})

// ============================================================ 3. 工作流
const wf = {}
await step('工作流', '分类 + 子分类', async () => {
  wf.group = need(await db('saveWorkflowGroup', { name: S + ' 流程分类', parentId: null }).then((r) => r.id), '建分类失败')
  wf.subGroup = need(await db('saveWorkflowGroup', { name: S + ' 子分类', parentId: wf.group }).then((r) => r.id), '建子分类失败')
  return [wf.group, wf.subGroup]
})
await step('工作流', '模板一：两步 / 策略 first', async () => {
  wf.t1 = need(await db('saveWorkflowTemplate', { name: S + ' 简单流程', description: '', start_policy: 'first', nodes: [{ title: '第一步', order_index: 0 }, { title: '第二步', order_index: 1 }] }).then((r) => r.templateId), '建模板失败')
  await db('moveWorkflowTemplate', wf.t1, wf.group)
  return wf.t1
})
await step('工作流', '模板二：条件 + 分支', async () => {
  wf.t2 = need(await db('saveWorkflowTemplate', { name: S + ' 条件流程', description: '', start_policy: 'first', nodes: [{ title: '判断', order_index: 0, action_kind: 'condition', action_value: JSON.stringify({ kind: 'confirm', prompt: '继续吗？' }) }, { title: '顺序下一步', order_index: 1 }, { title: '分支目标', order_index: 2 }] }).then((r) => r.templateId), '建模板二失败')
  const t = await db('workflowTemplate', wf.t2)
  if (!t || t.nodes.length !== 3) throw new Error('模板二节点数不对')
  await db('setWorkflowBranch', t.nodes[0].id, t.nodes[2].id)
  wf.t2nodes = t.nodes.map((n) => n.id)
  return wf.t2
})
await step('工作流', '模板三：命令动作 + 期望退出码', async () => {
  wf.t3 = need(await db('saveWorkflowTemplate', { name: S + ' 命令流程', description: '', start_policy: 'all', nodes: [{ title: '跑个命令', order_index: 0, action_kind: 'command', action_value: 'cmd /c echo smoke', action_expect: '0' }] }).then((r) => r.templateId), '建模板三失败')
  return wf.t3
})
await step('工作流', '实例化', async () => {
  await db('instantiateWorkflow', wf.t1, null, null, 'first')
  const n = await db('workflowInstances').then((r) => r.length)
  if (!n) throw new Error('实例化后实例列表还是空的')
  return n
})
await step('工作流', '实例改名', async () => {
  const l = await db('workflowInstances')
  const ok = await db('renameWorkflowInstance', l[0].id, S + ' 改过名的实例')
  if (!ok) throw new Error('renameWorkflowInstance 返回 false')
  return true
})
await step('工作流', '完成一步 → 实例推进', async () => {
  const l = await db('workflowInstances')
  const inst = l[0]
  const pending = inst.steps.find((s) => !s.done && s.task_id)
  if (!pending) throw new Error('实例里没有待完成的步骤任务')
  await db('toggleTask', pending.task_id, true)
  await sleep(900)
  const after = await db('workflowInstance', inst.id)
  return { done: after.steps.filter((s) => s.done).length, total: after.steps.length }
})
await step('工作流', '中止实例', async () => {
  const l = await db('workflowInstances', 'running')
  if (!l.length) return { skipped: '没有 running 实例' }
  const ok = await db('abortWorkflowInstance', l[0].id)
  if (!ok) throw new Error('中止返回 false')
  return true
})
await step('工作流', 'UI：侧栏树 + 画布', async () => {
  await click('[data-nav-item=workflow]'); await sleep(1600)
  const tree = await evaluate('document.querySelectorAll(".wf-node").length')
  await shoot('05-workflow.png')
  if (!tree) throw new Error('侧栏树没有渲染')
  return tree
})
await step('工作流', 'UI：工具栏按钮齐全', async () => {
  const btns = await evaluate('[...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter((t) => /加一步|加条件|编辑|启动实例|删除步骤/.test(t))')
  if (!btns.includes('加一步') || !btns.includes('启动实例')) throw new Error('工具栏按钮缺失：' + JSON.stringify(btns))
  return btns
})

// ============================================================ 4. 闪念 / 设置 / AI / 其它页面
await step('闪念', '建闪念 + 合并', async () => {
  const a = await db('addFlash', S + ' 闪念一', '冒烟备注', '', '').then((f) => f && f.id)
  const b = await db('addFlash', S + ' 闪念二', '', '', '').then((f) => f && f.id)
  need(a && b, '闪念没建出来')
  const merged = await db('mergeFlashes', [a, b])
  need(merged, 'mergeFlashes 返回空')
  return true
})
await step('设置', 'UI：切到设置页并遍历分组', async () => {
  await click('[data-nav-item=settings]'); await sleep(1300)
  const tabs = await evaluate('[...document.querySelectorAll("[role=tab]")].map((b) => b.textContent.trim())')
  for (const t of tabs) {
    await evaluate('(() => { const b = [...document.querySelectorAll("[role=tab]")].find((x) => x.textContent.trim() === ' + JSON.stringify(t) + '); if (b) b.click() })()')
    await sleep(350)
  }
  await shoot('06-settings.png')
  return tabs
})
await step('设置', '改设置并读回', async () => {
  await db('setSettings', { clipboard_monitor: '0' })
  const s = await db('settings')
  if (!s || s.clipboard_monitor !== '0') throw new Error('设置没写进去：' + (s && s.clipboard_monitor))
  return true
})
const aiKeys = await step('AI', 'ai 命名空间接口', async () => evaluate('Object.keys(window.zhixing.ai)'))
await step('AI', '配置本地 OpenAI 兼容端点', async () => {
  await db('setSettings', { ai_protocol: 'openai', ai_base_url: 'http://127.0.0.1:' + API_PORT + '/v1', ai_api_key: 'sk-smoke', ai_model: 'smoke-model', ai_timeout_sec: '30' })
  const s = await db('settings')
  if (s.ai_model !== 'smoke-model') throw new Error('模型没写进去')
  return { protocol: s.ai_protocol, model: s.ai_model }
})
await step('AI', '测试连接', async () => {
  const keys = aiKeys ?? []
  if (!keys.includes('testConnection')) throw new Error('preload 里没有 ai.testConnection')
  return ai('testConnection')
})
await step('AI', '单篇整理（本地假端点）', async () => {
  const keys = aiKeys ?? []
  if (!keys.includes('organizeNote')) throw new Error('preload 里没有 ai.organizeNote')
  const r = await ai('organizeNote', noteIds.md)
  if (r && r.ok === false) throw new Error('整理失败：' + (r.message ?? ''))
  return r && (r.message ?? r.ok)
})
await step('AI', '全库整理：开始并取消', async () => {
  const keys = aiKeys ?? []
  if (!keys.includes('organizeLibrary')) throw new Error('preload 里没有 ai.organizeLibrary')
  await ai('organizeLibrary')
  await sleep(1500)
  const cancelled = keys.includes('cancelLibrary') ? await ai('cancelLibrary') : false
  return { cancelled }
})
await step('导航', '其余页面都能打开', async () => {
  const out = {}
  for (const [key, label] of [['inbox', '收件箱'], ['graph', '图谱'], ['review', '回顾']]) {
    const ok = await click('[data-nav-item=' + key + ']')
    await sleep(1200)
    out[label] = ok ? await evaluate('document.body.innerText.length') : 'no-nav-item'
  }
  await shoot('07-graph.png')
  return out
})
await step('回收站', 'UI：设置 → 数据 → 打开回收站', async () => {
  await click('[data-nav-item=settings]'); await sleep(1000)
  await evaluate('(() => { const b = [...document.querySelectorAll("[role=tab]")].find((x) => x.textContent.trim() === "数据"); if (b) b.click() })()')
  await sleep(800)
  const ok = await clickText('回收站')
  await sleep(1000)
  await shoot('08-recycle.png')
  if (!ok) throw new Error('设置 → 数据 里没有找到回收站入口')
  const modal = await evaluate('!!document.querySelector(".modal")')
  if (!modal) throw new Error('点了回收站没有弹出浮层')
  return true
})

// ============================================================ 5. 更多 UI 交互分支
await step('任务', 'UI：勾选行内圆点完成一条任务', async () => {
  await click('[data-nav-item=tasks]'); await sleep(1200)
  const before = await evaluate('document.querySelectorAll("[class*=task-tree] [class*=done]").length')
  const clicked = await evaluate('(() => { const row = [...document.querySelectorAll("[class*=task-tree] *")].find((e) => e.className && /check|toggle/i.test(e.className)); if (!row) return false; row.click(); return true })()')
  await sleep(900)
  return { clicked, before }
})
await step('任务', 'UI：切到四象限 / 日历 / 看板视图', async () => {
  const out = {}
  for (const label of ['四象限', '日历', '看板', '列表']) {
    const ok = await clickText(label)
    await sleep(700)
    out[label] = ok
  }
  await shoot('09-task-views.png')
  if (!out['四象限'] || !out['看板']) throw new Error('视图切换按钮缺失：' + JSON.stringify(out))
  return out
})
await step('收件箱', 'UI：闪念页渲染 + 合并按钮', async () => {
  await click('[data-nav-item=inbox]'); await sleep(1300)
  const text = await evaluate('document.body.innerText')
  await shoot('10-inbox.png')
  if (!text.includes(S + ' 闪念一') && !text.includes(S + ' 闪念二') && !text.includes('合并')) {
    throw new Error('收件箱里看不到刚建的闪念')
  }
  const hasMerge = await evaluate('[...document.querySelectorAll("button")].some((b) => /合并/.test(b.textContent || ""))')
  return { hasMerge }
})
await step('笔记', 'UI：在编辑器里输入文字', async () => {
  await click('[data-nav-item=notes]'); await sleep(1300)
  await evaluate('(() => { const r = [...document.querySelectorAll(".ntree__note")].find((e) => e.innerText.includes(' + JSON.stringify(S + ' Markdown 笔记') + ')); if (r) r.click() })()')
  await sleep(1200)
  const typed = await evaluate('(() => { const el = document.querySelector(".cm-content, textarea.md-editor, textarea"); if (!el) return false; el.focus(); document.execCommand && document.execCommand("insertText", false, " 冒烟追加"); return true })()')
  await sleep(700)
  await shoot('11-editor-typing.png')
  if (!typed) throw new Error('编辑器里没有找到可输入区域（.cm-content / textarea）')
  return typed
})
await step('AI', '全库整理：跑完一轮并观察进度', async () => {
  await ai('organizeLibrary')
  let last = null
  for (let i = 0; i < 40; i++) {
    await sleep(700)
    last = await ai('libraryProgress')
    if (last && (last.state === 'done' || last.state === 'cancelled' || last.state === 'error')) break
  }
  await shoot('12-ai-library.png')
  if (!last) throw new Error('libraryProgress 一直是空')
  if (last.state === 'error') throw new Error('全库整理报错：' + (last.message ?? ''))
  return { state: last.state, done: last.done, total: last.total }
})

// ============================================================ 6. 补齐：拖拽 / 右键 / 工具栏 / 主题包 / 条件确认窗
await step('笔记', 'UI：新建一篇专用笔记（避免受 AI 改名影响）', async () => {
  // 先把可能还在跑的整库整理等停：否则它会把这篇新笔记也改名（脚本自己踩过这个坑）
  await ai('cancelLibrary').catch(() => null)
  await sleep(2500)
  uiNoteId = await db('createNote', S + ' UI 专用笔记', null, '# 标题 正文', 'markdown').then((n) => n && n.id)
  need(uiNoteId, '专用笔记没建出来')
  await click('[data-nav-item=notes]'); await sleep(1500)
  const picked = await evaluate('(() => { const r = [...document.querySelectorAll(".ntree__note")].find((e) => e.innerText.includes(' + JSON.stringify(S + ' UI 专用笔记') + ')); if (!r) return false; r.click(); return true })()')
  await sleep(1500)
  if (!picked) throw new Error('树里找不到刚建的笔记（可能被后台整理改名）')
  const opened = await evaluate('!!document.querySelector(".cm-content, .md-editor textarea, .md-editor")')
  if (!opened) throw new Error('点了笔记但没有打开编辑器')
  return uiNoteId
})
await step('笔记', 'UI：编辑器工具栏「加粗」可用', async () => {
  const before = await evaluate('(() => { const el = document.querySelector(".cm-content"); return el ? el.innerText.length : -1 })()')
  const clicked = await evaluate('(() => { const b = document.querySelector("button[title=加粗]"); if (!b) return false; b.click(); return true })()')
  await sleep(700)
  const after = await evaluate('(() => { const el = document.querySelector(".cm-content"); return el ? el.innerText : null })()')
  await shoot('13-editor-toolbar.png')
  if (!clicked) throw new Error('编辑器工具栏里没有「加粗」按钮')
  if (after === null) throw new Error('点加粗后 .cm-content 消失了')
  return { before, hasContent: String(after).length > 0 }
})
await step('笔记', 'UI：「插入链接」弹应用内 prompt', async () => {
  await evaluate('(() => { const b = document.querySelector("button[title=插入链接]"); if (b) b.click() })()')
  await sleep(800)
  const modal = await evaluate('!!document.querySelector(".modal--dialog")')
  await shoot('14-insert-link-dialog.png')
  if (!modal) throw new Error('点「插入链接」没有弹出应用内对话框')
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
  await sleep(500)
  return true
})
await step('任务', 'UI：右键任务行弹出菜单', async () => {
  await click('[data-nav-item=tasks]'); await sleep(1300)
  const box = await evaluate('(() => { const rows = [...document.querySelectorAll("[class*=task]")]; const row = rows.find((r) => r.innerText && r.innerText.includes(' + JSON.stringify(S + ' 顶层任务') + ')); if (!row) return null; const b = row.getBoundingClientRect(); return { x: Math.round(b.x + 40), y: Math.round(b.y + b.height / 2) } })()')
  if (!box) throw new Error('任务页找不到那一行（无法右键）')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'right', clickCount: 1, buttons: 2 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'right', clickCount: 1, buttons: 0 })
  await sleep(800)
  const menu = await evaluate('document.querySelectorAll("[class*=menu] [class*=item], [role=menuitem]").length')
  await shoot('15-context-menu.png')
  if (!menu) throw new Error('右键后没有出现菜单项')
  await evaluate('document.body.click()')
  await sleep(300)
  return menu
})
await step('笔记', 'UI：笔记树拖拽（指针按住移动）', async () => {
  await click('[data-nav-item=notes]'); await sleep(1300)
  const box = await evaluate('(() => { const r = [...document.querySelectorAll(".ntree__note")].find((e) => e.innerText.includes(' + JSON.stringify(S + ' UI 专用笔记') + ')); if (!r) return null; const b = r.getBoundingClientRect(); return { x: Math.round(b.x + 30), y: Math.round(b.y + b.height / 2) } })()')
  if (!box) throw new Error('找不到可拖拽的笔记行')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 })
  for (let i = 1; i <= 6; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y + i * 14, button: 'left', buttons: 1 })
    await sleep(60)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y + 84, button: 'left', clickCount: 1, buttons: 0 })
  await sleep(800)
  await shoot('16-tree-drag.png')
  // 拖拽是否真的改变顺序由实现决定：这里只确认「拖完应用没崩、树还在」
  const still = await evaluate('document.querySelectorAll(".ntree__note").length')
  if (!still) throw new Error('拖拽后笔记树消失了')
  return { rows: still }
})
await step('设置', 'UI：切换主题包并生效', async () => {
  await click('[data-nav-item=settings]'); await sleep(1200)
  await evaluate('(() => { const b = [...document.querySelectorAll("[role=tab]")].find((x) => x.textContent.trim() === "外观"); if (b) b.click() })()')
  await sleep(700)
  const before = await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--bg-canvas")')
  const picked = await evaluate('(() => { const s = [...document.querySelectorAll("select")].find((x) => [...x.options].some((o) => /青竹|默认|墨/.test(o.textContent))); if (!s) return null; const opt = [...s.options].find((o) => o.value !== s.value); if (!opt) return null; s.value = opt.value; s.dispatchEvent(new Event("change", { bubbles: true })); return opt.value })()')
  await sleep(1200)
  const after = await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--bg-canvas")')
  await shoot('17-theme-pack.png')
  if (picked === null) throw new Error('外观页没找到主题包下拉')
  if (before === after) throw new Error('切换主题包后 --bg-canvas 没变化：' + before)
  return { picked, before: before.trim(), after: after.trim() }
})
await step('工作流', 'UI：条件确认走独立窗口并点「成立」', async () => {
  await click('[data-nav-item=workflow]'); await sleep(1400)
  const t2 = await db('workflowTemplate', wf.t2)
  await db('instantiateWorkflow', wf.t2, null, null, 'first')
  let condWin = null
  for (let i = 0; i < 30 && !condWin; i++) {
    condWin = (await list()).find((t) => String(t.url).includes('condition=1'))
    if (!condWin) await sleep(300)
  }
  if (!condWin) throw new Error('实例化条件模板后没有开出条件确认窗')
  const cws = new WebSocket(condWin.webSocketDebuggerUrl)
  await new Promise((res, rej) => { cws.addEventListener('open', res, { once: true }); cws.addEventListener('error', rej, { once: true }) })
  let cid = 0
  const cwSend = (method, params = {}) => new Promise((resolve) => { const id = ++cid; const h = (ev) => { const m = JSON.parse(ev.data); if (m.id !== id) return; cws.removeEventListener('message', h); resolve(m) }; cws.addEventListener('message', h); cws.send(JSON.stringify({ id, method, params })) })
  await cwSend('Runtime.enable')
  await sleep(1200)
  const shot2 = await cwSend('Page.captureScreenshot', { format: 'png' })
  if (shot2.result?.data) writeFileSync(join(shotDir, '18-condition-window.png'), Buffer.from(shot2.result.data, 'base64'))
  await cwSend('Runtime.evaluate', { expression: '[...document.querySelectorAll(".modal__foot button")].find((b) => b.textContent.trim() === "成立").click()', returnByValue: false, awaitPromise: false })
  await sleep(1500)
  const insts = await db('workflowInstances', 'running')
  const hit = insts.find((i) => i.current_node_id === t2.nodes[2].id)
  cws.close()
  if (!hit) throw new Error('点「成立」后没有实例走到分支目标节点')
  return { branch: hit.current_node_id }
})

// ============================================================ 7. A 三条修复的验收
await step('修复验收', 'cancelLibrary 返回可读说明（而不是裸 boolean）', async () => {
  const r = await ai('cancelLibrary')
  if (!r || typeof r !== 'object' || typeof r.message !== 'string' || typeof r.ok !== 'boolean') {
    throw new Error('返回值不是 { ok, message }：' + JSON.stringify(r))
  }
  return r
})
await step('修复验收', 'AI 改标题撞名时给出提示', async () => {
  await db('setSettings', { ai_base_url: 'http://127.0.0.1:' + API_PORT + '/v1', ai_protocol: 'openai', ai_model: 'smoke-model', ai_api_key: 'sk-smoke' })
  const n1 = await db('createNote', S + ' 撞名甲', null, '内容甲', 'markdown').then((n) => n && n.id)
  const n2 = await db('createNote', S + ' 撞名乙', null, '内容乙', 'markdown').then((n) => n && n.id)
  await ai('organizeNote', n1)
  const r2 = await ai('organizeNote', n2)
  if (!String(r2 && r2.message).includes('重复')) {
    throw new Error('第二篇整理后没有撞名提示：' + JSON.stringify(r2))
  }
  return r2.message
})
await step('修复验收', '收件箱页签存在且闪念可见（默认切换逻辑的观察）', async () => {
  await click('[data-nav-item=inbox]'); await sleep(1400)
  // 页签文案带计数（如「闪念 · 1」），必须用 includes 而不是全等
  const labels = await evaluate('[...document.querySelectorAll("[role=tab]")].map((b) => b.textContent.trim()).filter((t) => t.includes("闪念") || t.includes("任务收件箱"))')
  const flashTab = await evaluate('(() => { const b = [...document.querySelectorAll("[role=tab]")].find((x) => x.textContent.includes("闪念")); if (!b) return false; b.click(); return true })()')
  await sleep(900)
  await shoot('19-inbox-flash.png')
  if (!flashTab) throw new Error('收件箱里没有「闪念」页签')
  return labels
})

const report = {
  generatedAt: new Date().toISOString(),
  steps: results.steps,
  ok: results.ok.length,
  problems: results.problems,
  consoleErrors,
  aiKeys,
  mainLog: mainLog.join('').split('\n').filter((l) => /error|Error|warn/i.test(l)).slice(0, 60),
}
writeFileSync(join(root, '.screenshots', 'seed-report.json'), JSON.stringify(report, null, 2))
console.log('')
console.log('步骤 ' + results.steps + '，通过 ' + results.ok.length + '，问题 ' + results.problems.length + '，控制台告警 ' + consoleErrors.length)
ws.close(); child.kill(); aiServer.close()
await sleep(600)
rmSync(tmpHome, { recursive: true, force: true })

/**
 * 有失败就以非零退出。
 *
 * 这是覆盖最广的那个端到端冒烟，但它此前**只打印计数**：CI 里恒通过，问题只能靠人翻日志。
 * 其余 30+ 个检查脚本都是 process.exit(failed ? 1 : 0)，这里不该例外。
 * 控制台告警不计入失败（启动期本就有噪声），但会在上面的行里报出来。
 */
process.exit(results.problems.length ? 1 : 0)
