/**
 * 笔记「大模型整理」端到端验证：本地起一个假的 OpenAI 兼容端点，跑真实主进程链路。
 *
 * 覆盖：
 *   1. 未配置时拒绝（给出去设置页的提示）
 *   2. 请求内容正确：Bearer Key、模型名、提示词里带上了正文 / 图片占位符 / 现有文件夹
 *   3. 整理成功：正文被改写、**图片与文件占位符原位填回**、双链与外链一个不少
 *   4. 归类：按模型给的路径找现有文件夹，没有的逐级新建，笔记真的被移过去
 *   5. 入库：正文变更前留下版本快照（可回滚）
 *   6. 审计拦截：模型丢掉一张图的占位符时**拒绝写库**，原笔记一字未动
 *
 * 用法：node scripts/aicheck.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = join(root, '.screenshots', 'aicheck-home')
const PORT = 9241
const AI_PORT = 9240

const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
if (!existsSync(realDb)) {
  console.error('✗ 找不到真实库：' + realDb)
  process.exit(1)
}

// ---------------------------------------------------------------- 假模型端点
const seen = []
/** 正常整理结果：重排结构，但保留全部链接与占位符（编号与请求里的一致）。 */
const okResult = (marker) => ({
  folder: 'AI验证/子目录',
  title: marker + '（已整理）',
  summary: '重排了标题层级',
  content: [
    '# ' + marker,
    '',
    '## 要点',
    '',
    '- 第二段被提到了前面',
    '- 参考 @@FILE1@@ 与 [官网](https://example.com/x)',
    '- 相关笔记：[[另一篇]]',
    '',
    '## 配图',
    '',
    '@@IMG1@@',
  ].join('\n'),
})
/** 坏结果：把图片占位符弄丢了 —— 审计必须拦住。 */
const badResult = (marker) => ({
  folder: '',
  title: marker,
  summary: '整理时漏了图',
  content: '# ' + marker + '\n\n只有文字，图没了。',
})
/** 模型没用占位符、而是把原始片段照抄回来 —— 内容没丢，应当放行（只记一条提醒）。 */
const rawEchoResult = (marker) => ({
  folder: '',
  title: marker,
  summary: '直接用原始写法',
  content: '# ' + marker + '\n\n原文照抄：![图](assets/x.png)',
})

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let payload = {}
    try {
      payload = JSON.parse(raw)
    } catch {
      /* 记下来当作坏请求 */
    }
    // 提示词整条走 user 消息，system 只有一句角色设定 —— 攒起全部消息再找正文，
    // 否则「标题：xxx」在 system 里找不到，marker 会退化成默认值（上一版就栽在这）。
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    const prompt =
      messages.map((m) => (typeof m?.content === 'string' ? m.content : '')).join('\n') ||
      (payload?.contents?.[0]?.parts?.[0]?.text ?? '')
    seen.push({ url: req.url, auth: req.headers.authorization ?? '', model: payload?.model ?? '', prompt })
    const isBad = prompt.includes('会丢图')
    const isRawEcho = prompt.includes('会抄原文')
    const marker = /标题：(.*)/.exec(prompt)?.[1]?.trim() ?? '整理'
    const payloadOut = isBad ? badResult(marker) : isRawEcho ? rawEchoResult(marker) : okResult(marker)
    const body = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: JSON.stringify(payloadOut) } }],
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
  })
})
await new Promise((r) => server.listen(AI_PORT, '127.0.0.1', r))
const AI_BASE = `http://127.0.0.1:${AI_PORT}/v1`

// ---------------------------------------------------------------- 启动应用
rmSync(tmpHome, { recursive: true, force: true })
mkdirSync(tmpHome, { recursive: true })
copyFileSync(realDb, join(tmpHome, 'zhixing.db'))

const SYS_PATH = [
  'C:\\Windows\\System32',
  'C:\\Windows',
  'C:\\Windows\\System32\\Wbem',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
].join(';')

const child = spawn(
  electronPath,
  ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpHome, 'profile')}`],
  {
    cwd: root,
    env: { ...process.env, PATH: `${SYS_PATH};${process.env.PATH ?? ''}`, ZHIXING_HOME: tmpHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
)

const attach = async () => {
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
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
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}
const J = (v) => JSON.stringify(v)

// ---------------------------------------------------------------- 1) 未配置时拒绝
const unconfigured = await conn.evaluate(
  `window.zhixing.db.notes(1).then((rows) => window.zhixing.ai.organizeNote(rows[0].id))`
)
check('未配置大模型时拒绝并提示去设置', unconfigured?.ok === false && /设置/.test(unconfigured.message), unconfigured?.message)

// ---------------------------------------------------------------- 造数据
await conn.evaluate(
  `window.zhixing.db.setSettings({ ai_base_url: ${J(AI_BASE)}, ai_api_key: 'test-key-123', ai_protocol: 'openai', ai_model: 'mock-model', ai_prompt: '' })`
)
// 正文一律用 J() 注入：在表达式里手写换行转义极易变成真正的换行，evaluate 会直接报语法错误
const GOOD_MD = [
  '这是标题',
  '',
  '第二段里提到 [设计文档](docs/design.md) 和 [官网](https://example.com/x)，还引用了 [[另一篇]]。',
  '',
  '配图：![架构图](assets/arch.png)',
].join('\n')
const BAD_MD = '正文里有一张 ![草图](assets/sketch.png) 以及 [附件](files/a.zip)'

await conn.evaluate(`window.zhixing.db.createNote('另一篇', null, '目标笔记', 'markdown')`)
await conn.evaluate(`window.zhixing.db.createNote('我的笔记', null, ${J(GOOD_MD)}, 'markdown')`)
const badNote = await conn.evaluate(
  `window.zhixing.db.createNote('会丢图的笔记', null, ${J(BAD_MD)}, 'markdown')`
)
const rawNote = await conn.evaluate(
  `window.zhixing.db.createNote('会抄原文的笔记', null, ${J('正文里有一张 ![图](assets/x.png) 收尾')}, 'markdown')`
)
const note = await conn.evaluate(
  `window.zhixing.db.notes(50).then((rows) => rows.find((n) => n.title === '我的笔记'))`
)
const beforeFolders = await conn.evaluate(`window.zhixing.db.noteFolders()`)

// ---------------------------------------------------------------- 2)+3)+4)+5) 正常整理
const res = await conn.evaluate(`window.zhixing.ai.organizeNote(${note.id})`)
check('整理成功并入库', res?.ok === true, res?.message + ' | ' + (res?.issues ?? []).map((i) => i.message).join('，'))

const after = await conn.evaluate(`window.zhixing.db.note(${note.id})`)
check(
  '正文被改写（排版变了）',
  typeof after?.content_md === 'string' && after.content_md.includes('## 要点') && after.content_md.includes('## 配图'),
  after?.content_md?.slice(0, 40)
)
check(
  '图片占位符原位填回（真实 Markdown 回来了）',
  after?.content_md?.includes('![架构图](assets/arch.png)'),
  ''
)
check(
  '文件引用也填回',
  after?.content_md?.includes('[设计文档](docs/design.md)'),
  ''
)
check('外链没丢', after?.content_md?.includes('https://example.com/x'), '')
check('双链没丢', after?.content_md?.includes('[[另一篇]]'), '')
check('没有残留 @@ 占位符', !/@@[A-Za-z]+\d+@@/.test(after?.content_md ?? ''), '')
check('标题按模型建议更新', after?.title === '我的笔记（已整理）', after?.title)

const foldersAfter = await conn.evaluate(`window.zhixing.db.noteFolders()`)
const top = foldersAfter.find((f) => f.name === 'AI验证')
const sub = foldersAfter.find((f) => f.name === '子目录' && f.parent_id === top?.id)
check('不存在的文件夹被逐级新建', !!top && !!sub, `AI验证=${top?.id} 子目录=${sub?.id}`)
check('笔记被归入该文件夹', after?.folder_id === sub?.id, `folder_id=${after?.folder_id}`)
check('只新建了这一条路径', foldersAfter.length === beforeFolders.length + 2, `${beforeFolders.length} → ${foldersAfter.length}`)

const revs = await conn.evaluate(`window.zhixing.db.noteRevisions(${note.id})`)
check('正文变更前留了版本快照（可回滚）', Array.isArray(revs) && revs.length >= 1, `revs=${revs?.length}`)

// 请求内容
const first = seen[0]
check('请求带上了 Bearer Key 与模型名', first?.auth === 'Bearer test-key-123' && first?.model === 'mock-model', `${first?.auth} / ${first?.model}`)
check('走到 /chat/completions', String(first?.url ?? '').includes('/chat/completions'), first?.url)
check('提示词里带上了正文与图片占位符', /@@IMG1@@/.test(first?.prompt ?? '') && first?.prompt.includes('架构图'), '')
// 副本库里本来就有文件夹：提示词要带上它们的路径，模型才可能复用
const existingFolderName = beforeFolders[0]?.name ?? ''
check(
  '提示词里带上了现有文件夹清单',
  !!existingFolderName && (first?.prompt ?? '').includes(existingFolderName),
  `已有文件夹：${existingFolderName}`
)
check('外链与双链留在提示词里（没有被占位吃掉）', (first?.prompt ?? '').includes('https://example.com/x') && (first?.prompt ?? '').includes('[[另一篇]]'), '')

// ---------------------------------------------------------------- 6) 审计拦截
const badRes = await conn.evaluate(`window.zhixing.ai.organizeNote(${badNote.id})`)
check('模型丢图时拒绝写库', badRes?.ok === false, badRes?.message)
check(
  '拒绝原因指向丢失的图片占位符',
  (badRes?.issues ?? []).some((i) => i.level === 'error' && /@@IMG1@@/.test(i.message)),
  (badRes?.issues ?? []).map((i) => i.message).join('，')
)
const badAfter = await conn.evaluate(`window.zhixing.db.note(${badNote.id})`)
check(
  '被拒后原笔记一字未动',
  badAfter?.content_md?.includes('![草图](assets/sketch.png)') && badAfter?.title === '会丢图的笔记',
  badAfter?.title
)
const foldersEnd = await conn.evaluate(`window.zhixing.db.noteFolders()`)
check('被拒时不会留下多余文件夹', foldersEnd.length === foldersAfter.length, `${foldersAfter.length} → ${foldersEnd.length}`)

// ---------------------------------------------------------------- 7) 模型抄回原文也算保留
const rawRes = await conn.evaluate(`window.zhixing.ai.organizeNote(${rawNote.id})`)
check('模型抄回原始片段时放行（内容确实没丢）', rawRes?.ok === true, rawRes?.message)
check(
  '并给出「下次请保留标记」的提醒',
  (rawRes?.issues ?? []).some((i) => i.level === 'warn' && /@@IMG1@@/.test(i.message)),
  (rawRes?.issues ?? []).map((i) => i.message).join('，')
)
const rawAfter = await conn.evaluate(`window.zhixing.db.note(${rawNote.id})`)
check('那张图的真实引用仍在正文里', rawAfter?.content_md?.includes('![图](assets/x.png)'), rawAfter?.content_md)

// ---------------------------------------------------------------- 收尾
await conn.evaluate(`window.zhixing.db.deleteNote(${note.id}).catch(() => 0)`)
await conn.evaluate(`window.zhixing.db.deleteNote(${badNote.id}).catch(() => 0)`)
await conn.evaluate(`window.zhixing.db.deleteNote(${rawNote.id}).catch(() => 0)`)

conn.ws.close()
child.kill()
server.close()
await sleep(500)
rmSync(tmpHome, { recursive: true, force: true })

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length ? 1 : 0)
