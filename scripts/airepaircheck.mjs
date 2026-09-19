/**
 * AI 整理：三类笔记分派 + 关联修复 的端到端验证（本地假模型端点）。
 *
 * 覆盖：
 *   1. 标题变化后，任务备注里的 [[旧标题]] 被同步成 [[新标题]]
 *   2. 正文改写后，任务关联的段落锚（block_key 指纹）按新正文重算，仍能定位到那一段
 *   3. Word 笔记：只归类（content_md 里的文件路径一个字都不动）
 *   4. 链接笔记：每条链接各有去向 —— 留下的回本笔记，归档的进已有/新建的链接笔记
 *   5. 链接笔记漏掉一条链接时，审计拦下且原笔记不变
 *
 * 用法：node scripts/airepaircheck.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = join(root, '.screenshots', 'airepair-home')
const PORT = 9246
const AI_PORT = 9245

/** 与 shared/block-fingerprint 一致（Node 侧直接用标准 sha1 算） */
const fp = (text) => {
  const norm = String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  if (!norm) return ''
  return 'fp:' + createHash('sha1').update(norm, 'utf8').digest('hex').slice(0, 12)
}

const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
if (!existsSync(realDb)) {
  console.error('✗ 找不到真实库：' + realDb)
  process.exit(1)
}

// ---------------------------------------------------------------- 假模型端点
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let payload = {}
    try {
      payload = JSON.parse(raw)
    } catch {
      /* 忽略 */
    }
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    const prompt = messages.map((m) => (typeof m?.content === 'string' ? m.content : '')).join('\n')
    const marker = /标题：(.*)/.exec(prompt)?.[1]?.trim() ?? '整理'
    const tokens = [...new Set([...prompt.matchAll(/@@[A-Z]+\d+@@/g)].map((m) => m[0]))]
    const wikis = [...new Set([...prompt.matchAll(/\[\[[^\]]+\]\]/g)].map((m) => m[0]))]
    const urls = [...new Set([...prompt.matchAll(/https?:\/\/[^\s)\]，。]+/g)].map((m) => m[0]))]

    let result
    if (marker.includes('Word')) {
      result = { folder: 'AI归档/office', title: marker + '（已改名）', summary: '只归类', content: '' }
    } else if (marker.includes('会漏')) {
      // 只给一条链接（原文有两条）→ 审计必须拦下
      result = {
        folder: '',
        title: marker,
        summary: '漏了一条',
        content: '',
        links: [{ title: '知乎', url: 'https://zhihu.com', into: '' }],
      }
    } else if (marker.includes('链接')) {
      result = {
        folder: 'AI归档/收藏',
        title: marker,
        summary: '分配链接去向',
        content: '',
        links: [
          { title: '知乎', url: 'https://zhihu.com', into: '' },
          { title: '掘金', url: 'https://juejin.cn', into: '技术阅读' },
        ],
      }
    } else {
      const parts = ['# ' + marker + '（已整理）', '', '## 重排后', '']
      if (wikis.length) parts.push('相关：' + wikis.join(' '), '')
      if (urls.length) parts.push('参考：' + urls.join(' '), '')
      if (tokens.length) parts.push(tokens.join(' '), '')
      // 故意改写被锚定的那一段（关联修复要靠相似度把它找回来）
      parts.push('第二段：计划 B（更新版）')
      result = { folder: 'AI归档/正文', title: marker + '（已整理）', summary: '重排正文', content: parts.join('\n') }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(result) } }] }))
  })
})
await new Promise((r) => server.listen(AI_PORT, '127.0.0.1', r))

rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(realDb, join(tmpHome, 'zhixing.db'))

const SYS_PATH = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\Wbem'].join(';')
const child = spawn(electronPath, ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(tmpHome, 'profile')], {
  cwd: root,
  env: { ...process.env, PATH: SYS_PATH + ';' + (process.env.PATH ?? ''), ZHIXING_HOME: tmpHome },
  stdio: ['ignore', 'pipe', 'pipe'],
})

const attach = async () => {
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
      page = list.find((t) => t.type === 'page')
    } catch {
      /* 等待 */
    }
    if (!page) await sleep(500)
  }
  if (!page) return null
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = Math.floor(Math.random() * 1e6)
      const h = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id !== id) return
        ws.removeEventListener('message', h)
        resolve(m)
      }
      ws.addEventListener('message', h)
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails)
      throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result?.result?.value
  }
  return { ws, evaluate }
}

const conn = await attach()
if (!conn) {
  console.error('✗ 无法连接渲染进程')
  child.kill()
  server.close()
  process.exit(1)
}
await sleep(3000)

const results = []
const check = (name, ok, detail = '') => {
  results.push([name, ok])
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''))
}
const J = (v) => JSON.stringify(v)
const STAMP = 'RP' + Date.now().toString(36)

await conn.evaluate(
  `window.zhixing.db.setSettings({ ai_base_url: ${J('http://127.0.0.1:' + AI_PORT + '/v1')}, ai_api_key: 'k', ai_protocol: 'openai', ai_model: 'mock', ai_prompt: '' })`
)

// ---------------------------------------------------------------- 1+2) 关联修复
const SEG_OLD = '第二段：计划 B'
const OLD_TITLE = STAMP + ' 计划笔记'
const mdBody = ['# ' + OLD_TITLE, '', '第一段：计划 A', '', SEG_OLD, '', '见 [[另一篇]] 与 https://example.com/plan'].join('\n')
const note = await conn.evaluate(`window.zhixing.db.createNote(${J(OLD_TITLE)}, null, ${J(mdBody)}, 'markdown')`)
const task = await conn.evaluate(`window.zhixing.db.createTask(${J(STAMP + ' 跟进')}, null, null)`)
await conn.evaluate(`window.zhixing.db.updateTask(${task.id}, { notes_md: ${J('参考 [[' + OLD_TITLE + ']]')} })`)
await conn.evaluate(
  `window.zhixing.db.attachBlock(${task.id}, ${note.id}, ${J(fp(SEG_OLD))}, ${J(SEG_OLD)})`
)
const ctxBefore = await conn.evaluate(`window.zhixing.db.contextsForNote(${note.id})`)
check('段落锚已建立', ctxBefore?.[0]?.block_key === fp(SEG_OLD), ctxBefore?.[0]?.block_key)

const res = await conn.evaluate(`window.zhixing.ai.organizeNote(${note.id})`)
check('正文整理成功', res?.ok === true, res?.message)

const tasks = await conn.evaluate(`window.zhixing.db.tasks(300)`)
const taskAfter = tasks.find((t) => t.id === task.id)
check(
  '任务备注里的 [[旧标题]] 同步成了 [[新标题]]',
  String(taskAfter?.notes_md ?? '').includes(`[[${OLD_TITLE}（已整理）]]`),
  taskAfter?.notes_md
)
const ctxAfter = await conn.evaluate(`window.zhixing.db.contextsForNote(${note.id})`)
check(
  '段落锚按新正文重算（不再指向旧指纹）',
  ctxAfter?.[0]?.block_key === fp('第二段：计划 B（更新版）'),
  `${ctxBefore?.[0]?.block_key} → ${ctxAfter?.[0]?.block_key}`
)
check('段落的展示文本也跟着更新', ctxAfter?.[0]?.snippet === '第二段：计划 B（更新版）', ctxAfter?.[0]?.snippet)

// ---------------------------------------------------------------- 3) Word 只归类
const wordNote = await conn.evaluate(
  `window.zhixing.db.createNote(${J(STAMP + ' Word 文档')}, null, 'C:/tmp/plan.docx', 'word')`
)
const wordRes = await conn.evaluate(`window.zhixing.ai.organizeNote(${wordNote.id})`)
const wordAfter = await conn.evaluate(`window.zhixing.db.note(${wordNote.id})`)
check('Word 笔记整理成功（只归类）', wordRes?.ok === true, wordRes?.message)
check('Word 笔记的正文（文件路径）没被动', wordAfter?.content_md === 'C:/tmp/plan.docx', wordAfter?.content_md)
check('Word 笔记按标题改了名', wordAfter?.title === `${STAMP} Word 文档（已改名）`, wordAfter?.title)
const folders = await conn.evaluate('window.zhixing.db.noteFolders()')
const officeTop = folders.find((f) => f.name === 'AI归档')
const officeSub = folders.find((f) => f.name === 'office' && f.parent_id === officeTop?.id)
check('Word 笔记归入了新建的文件夹', !!officeSub && wordAfter?.folder_id === officeSub.id, `folder_id=${wordAfter?.folder_id}`)

// ---------------------------------------------------------------- 4) 链接笔记分发
const linkNote = await conn.evaluate(
  `window.zhixing.db.createNote(${J(STAMP + ' 链接收藏')}, null, ${J(
    JSON.stringify([
      { title: '知乎', target: 'https://zhihu.com' },
      { title: '掘金', target: 'https://juejin.cn' },
    ])
  )}, 'link')`
)
const linkRes = await conn.evaluate(`window.zhixing.ai.organizeNote(${linkNote.id})`)
check('链接笔记整理成功', linkRes?.ok === true, linkRes?.message)

const linkAfter = await conn.evaluate(`window.zhixing.db.note(${linkNote.id})`)
const kept = JSON.parse(linkAfter?.content_md ?? '[]')
check(
  '留在本笔记的只剩「知乎」',
  Array.isArray(kept) && kept.length === 1 && kept[0].target === 'https://zhihu.com',
  linkAfter?.content_md
)
const allNotes = await conn.evaluate('window.zhixing.db.notes(300)')
const targetNote = allNotes.find((n) => n.title === '技术阅读')
check('归档目标不存在时新建了一篇链接笔记', !!targetNote && targetNote.format === 'link', targetNote?.title)
const targetItems = JSON.parse(
  (await conn.evaluate(`window.zhixing.db.note(${targetNote?.id ?? 0})`))?.content_md ?? '[]'
)
check(
  '归档过去的链接落在新笔记里（含标题）',
  targetItems.length === 1 && targetItems[0].target === 'https://juejin.cn' && targetItems[0].title === '掘金',
  JSON.stringify(targetItems)
)

// ---------------------------------------------------------------- 5) 漏链接 → 拦下
const leakNote = await conn.evaluate(
  `window.zhixing.db.createNote(${J(STAMP + ' 会漏的链接')}, null, ${J(
    JSON.stringify([
      { title: '知乎', target: 'https://zhihu.com' },
      { title: '掘金', target: 'https://juejin.cn' },
    ])
  )}, 'link')`
)
const leakRes = await conn.evaluate(`window.zhixing.ai.organizeNote(${leakNote.id})`)
check('漏掉一条链接时拒绝写库', leakRes?.ok === false, leakRes?.message)
check(
  '拒绝原因点出是哪条链接',
  (leakRes?.issues ?? []).some((i) => i.level === 'error' && /掘金|juejin/.test(i.message)),
  (leakRes?.issues ?? []).map((i) => i.message).join('，')
)
const leakAfter = await conn.evaluate(`window.zhixing.db.note(${leakNote.id})`)
check('被拒后原链接一条不少', JSON.parse(leakAfter?.content_md ?? '[]').length === 2, leakAfter?.content_md)

// ---------------------------------------------------------------- 收尾
for (const n of [note, wordNote, linkNote, leakNote, targetNote]) {
  if (n?.id) await conn.evaluate(`window.zhixing.db.deleteNote(${n.id}).catch(() => 0)`)
}
await conn.evaluate(`window.zhixing.db.deleteTask(${task.id}).catch(() => 0)`)

conn.ws.close()
child.kill()
server.close()
await sleep(500)
rmSync(tmpHome, { recursive: true, force: true })

const failed = results.filter(([, ok]) => !ok)
console.log('')
console.log((results.length - failed.length) + '/' + results.length + ' 项通过')
process.exit(failed.length ? 1 : 0)
