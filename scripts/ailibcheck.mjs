/**
 * 整库 AI 整理端到端验证：本地假模型端点 + 真实主进程链路。
 *
 * 覆盖：
 *   1. 只处理 Markdown / 富文本（word 笔记一个字都不能动）
 *   2. 空正文被跳过（不浪费一次请求），汇总数字对得上
 *   3. 每篇都真正落库（标题带上整理标记），图片与链接占位符都还在
 *   4. 文件夹**只新建一次**：后面几篇复用前一篇建出来的目录
 *   5. 进度事件逐篇推送，最后一条 running=false
 *   6. 可停止：第 1 篇完成后取消 → 明确 stopped 且不再继续
 *
 * 用法：node scripts/ailibcheck.mjs（需先 npm run build）
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
const tmpHome = join(root, '.screenshots', 'ailib-home')
const PORT = 9244
const AI_PORT = 9243

const realDb = join(process.env.APPDATA ?? '', 'ZhiXing', 'zhixing.db')
if (!existsSync(realDb)) {
  console.error('✗ 找不到真实库：' + realDb)
  process.exit(1)
}

// ---------------------------------------------------------------- 假模型端点
let requests = 0
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    requests += 1
    let payload = {}
    try {
      payload = JSON.parse(raw)
    } catch {
      /* 忽略坏请求 */
    }
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    const prompt = messages.map((m) => (typeof m?.content === 'string' ? m.content : '')).join('\n')
    const marker = /标题：(.*)/.exec(prompt)?.[1]?.trim() ?? '整理'
    // 通用的「守规矩」返回：提示词里出现过的占位符与链接全部原样带回去
    const tokens = [...new Set([...prompt.matchAll(/@@[A-Z]+\d+@@/g)].map((m) => m[0]))]
    const wikis = [...new Set([...prompt.matchAll(/\[\[[^\]]+\]\]/g)].map((m) => m[0]))]
    const urls = [...new Set([...prompt.matchAll(/https?:\/\/[^\s)\]，。]+/g)].map((m) => m[0]))]
    const parts = ['# ' + marker + '（已整理）', '', '## 刚才那段话', '', '内容已重排。']
    if (tokens.length) parts.push('', tokens.join(' '))
    if (wikis.length) parts.push('', '相关：' + wikis.join(' '))
    if (urls.length) parts.push('', '参考：' + urls.join(' '))
    const body = JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              folder: '整库/归档',
              title: marker + '（已整理）',
              summary: '重排结构',
              content: parts.join('\n'),
            }),
          },
        },
      ],
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
  })
})
await new Promise((r) => server.listen(AI_PORT, '127.0.0.1', r))

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
  ['.', '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(tmpHome, 'profile')],
  {
    cwd: root,
    env: { ...process.env, PATH: SYS_PATH + ';' + (process.env.PATH ?? ''), ZHIXING_HOME: tmpHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
)

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

await conn.evaluate(
  `window.zhixing.db.setSettings({ ai_base_url: ${J('http://127.0.0.1:' + AI_PORT + '/v1')}, ai_api_key: 'k', ai_protocol: 'openai', ai_model: 'mock', ai_prompt: '' })`
)

// ---------------------------------------------------------------- 造一批笔记
const PREFIX = 'LIB' + Date.now().toString(36)
const makeNote = async (title, format, md) => {
  const note = await conn.evaluate(
    `window.zhixing.db.createNote(${J(title)}, null, ${J(md)}, ${J(format)})`
  )
  return note
}
const BODY = [
  '第一段里有 [设计](docs/d.md) 与外链 https://example.com/lib',
  '',
  '第二段引用 [[另一篇]]，还有一张图 ![图](assets/p.png)',
].join('\n')
const normal = []
for (let i = 1; i <= 3; i++) normal.push(await makeNote(`${PREFIX} 笔记${i}`, 'markdown', BODY))
const emptyNote = await makeNote(`${PREFIX} 空笔记`, 'markdown', '   ')
const wordNote = await makeNote(`${PREFIX} 表格`, 'word', 'C:/tmp/whatever.docx')
check('测试笔记已建立（3 篇正文 + 1 篇空 + 1 篇 word）', normal.every((n) => n?.id) && !!emptyNote?.id && !!wordNote?.id, '')

// 进度订阅：把每一帧都收进数组（顺便记录条数）
await conn.evaluate(`(() => {
  window.__libProg = []
  window.zhixing.ai.onLibraryProgress((p) => window.__libProg.push(p))
  return true
})()`)

// ---------------------------------------------------------------- 整库整理
const res = await conn.evaluate(`window.zhixing.ai.organizeLibrary()`)
check('整库整理返回成功', res?.ok === true, res?.message)
// 副本库里本来就有用户的笔记，所以总量只能要求「不少于我造的那几篇」，
// 但**每一篇都要有交代**：ok + skipped 必须等于总数
check('总量覆盖全库 Markdown 笔记', typeof res?.total === 'number' && res.total >= 4, `total=${res?.total}`)
check(
  '空正文被跳过而不是算失败（且每篇都有交代）',
  res?.skipped >= 1 && res?.failedCount === 0 && res?.okCount + res?.skipped === res?.total,
  `ok=${res?.okCount} failed=${res?.failedCount} skipped=${res?.skipped} total=${res?.total}`
)
check('文件夹只在第一篇里新建了一次', res?.createdFolders === 2, `created=${res?.createdFolders}（整库/归档 两级）`)

const after = await conn.evaluate(`window.zhixing.db.notes(200)`)
const find = (id) => after.find((n) => n.id === id)
const updated = normal.map((n) => find(n.id))
check(
  '三篇笔记都被改写并落库',
  updated.every((n) => n && n.title.endsWith('（已整理）') && n.content_md.includes('## 刚才那段话')),
  updated.map((n) => n?.title).join('；')
)
check(
  '图片与链接在整理后都还在',
  updated.every(
    (n) => n.content_md.includes('![图](assets/p.png)') && n.content_md.includes('[[另一篇]]') && n.content_md.includes('https://example.com/lib')
  ),
  ''
)
check('都归入了同一个新建文件夹', new Set(updated.map((n) => n.folder_id)).size === 1 && updated[0].folder_id != null, `folder_id=${updated[0]?.folder_id}`)
check('空正文那篇没被动过', !find(emptyNote.id)?.title.includes('已整理'), find(emptyNote.id)?.title)
check('word 笔记一个字都没动', find(wordNote.id)?.title === `${PREFIX} 表格`, find(wordNote.id)?.title)

const prog = await conn.evaluate('window.__libProg')
const last = Array.isArray(prog) ? prog[prog.length - 1] : null
check('进度事件逐篇推送', Array.isArray(prog) && prog.length >= 8, `frames=${prog?.length}`)
check(
  '进度里的 done 单调递增到底',
  Array.isArray(prog) &&
    prog.filter((p) => p.running).every((p, i, arr) => i === 0 || p.done >= arr[i - 1].done) &&
    last?.done === res?.total,
  `last done=${last?.done} running=${last?.running}`
)
check('最后一条进度 running=false（界面据此收尾）', last?.running === false, '')

// ---------------------------------------------------------------- 停止
const cancelNotes = []
for (let i = 1; i <= 4; i++) {
  cancelNotes.push(await makeNote(`${PREFIX} 待停${i}`, 'markdown', BODY))
}
await conn.evaluate(`(() => {
  window.__libProg2 = []
  window.__cancelled = false
  window.zhixing.ai.onLibraryProgress((p) => {
    window.__libProg2.push(p)
    if (p.running && p.done >= 1 && !window.__cancelled) {
      window.__cancelled = true
      window.zhixing.ai.cancelLibrary()
    }
  })
  return true
})()`)
const res2 = await conn.evaluate(`window.zhixing.ai.organizeLibrary()`)
check('停止后明确标记 stopped', res2?.stopped === true, res2?.message)
check('停止后确实没跑完', typeof res2?.done === 'number' && res2.done < res2.total, `done=${res2?.done}/${res2?.total}`)

// ---------------------------------------------------------------- 收尾
for (const n of [...normal, emptyNote, wordNote, ...cancelNotes]) {
  await conn.evaluate(`window.zhixing.db.deleteNote(${n.id}).catch(() => 0)`)
}

conn.ws.close()
child.kill()
server.close()
await sleep(500)
rmSync(tmpHome, { recursive: true, force: true })

const failed = results.filter(([, ok]) => !ok)
console.log('')
console.log((results.length - failed.length) + '/' + results.length + ' 项通过（假端点共收到 ' + requests + ' 次请求）')
process.exit(failed.length ? 1 : 0)
