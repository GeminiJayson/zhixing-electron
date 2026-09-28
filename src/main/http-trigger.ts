/**
 * 外部触发用的本地 HTTP 端点。
 *
 * 只监听 127.0.0.1 —— 这是给"本机的另一个程序"用的（脚本、CI、手机上的快捷指令
 * 通过局域网转发等等），不是给公网用的。端口让系统分配（listen(0)），
 * 免得撞上用户机器上已经占着的端口；实际端口写进 settings，设置页会显示出来。
 *
 * 鉴权只有一个 32 位十六进制令牌，放在路径里：`POST /hook/<token>`。
 * 没有令牌的触发源在解析阶段就被丢掉了（见 shared/workflow-trigger.ts），
 * 所以这里能匹配到的一定是用户自己生成的令牌。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { conn } from './db/connection'
import { instantiateWorkflow } from './db/workflow'
import { parseTriggers } from '../shared/workflow-trigger'

/** 单次请求体上限：这个端点的 body 只是可选的说明文字，4KB 足够 */
const MAX_BODY = 4096
/** 每分钟最多接受多少次触发：本机误连成环时的兜底，正常用不可能碰到 */
const MAX_PER_MIN = 30

let server: Server | null = null
let hits: number[] = []

/** 找出持有这个令牌的模板。收尾对比用扫描而不是提前建索引：模板数量是个位数。 */
function templatesForToken(token: string): { id: number; name: string }[] {
  const rows = conn()
    .prepare("SELECT id, name, triggers FROM workflow_template WHERE triggers IS NOT NULL AND triggers != ''")
    .all() as { id: number; name: string; triggers: string }[]
  const out: { id: number; name: string }[] = []
  for (const r of rows) {
    if (parseTriggers(r.triggers).some((t) => t.kind === 'http' && t.token === token)) {
      out.push({ id: r.id, name: r.name })
    }
  }
  return out
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // 本机调用不该被任何缓存层记住
    'cache-control': 'no-store',
  })
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let size = 0
    let text = ''
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      // 超限就停止累积（连接照样读完，避免对方一直等）
      if (size <= MAX_BODY) text += chunk.toString('utf8')
    })
    req.on('end', () => resolve(text))
    req.on('error', () => resolve(''))
  })
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 只认 POST：GET 会被浏览器/爬虫顺手命中，不该有副作用
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: '只接受 POST' })
    return
  }
  const url = req.url ?? ''
  const m = /^\/hook\/([0-9a-f]{16,64})\/?$/.exec(url)
  if (!m) {
    json(res, 404, { ok: false, error: '路径应为 /hook/<token>' })
    return
  }
  const now = Date.now()
  hits = hits.filter((t) => now - t < 60_000)
  if (hits.length >= MAX_PER_MIN) {
    json(res, 429, { ok: false, error: '触发过于频繁' })
    return
  }
  hits.push(now)

  const token = m[1]
  const targets = templatesForToken(token)
  if (!targets.length) {
    // 不回显收到的令牌：日志里留下别人的令牌没有好处
    json(res, 403, { ok: false, error: '令牌无效' })
    return
  }
  await readBody(req)
  const started: { template: string; instanceId: number }[] = []
  for (const t of targets) {
    const inst = await instantiateWorkflow(t.id, null, null, undefined, 'http')
    if (inst) started.push({ template: t.name, instanceId: inst.id })
  }
  json(res, 200, { ok: true, started })
}

/**
 * 启动端点，返回实际监听的端口（失败返回 null）。
 * 端口冲突之类的问题不该拦住应用启动 —— 其余功能照常，只是外部触发用不了。
 */
export function startTriggerServer(): Promise<number | null> {
  return new Promise((resolve) => {
    if (server) {
      const addr = server.address()
      resolve(addr && typeof addr === 'object' ? addr.port : null)
      return
    }
    const s = createServer((req, res) => {
      void onRequest(req, res).catch((err) => {
        console.error('[wf] 外部触发处理失败', err)
        try {
          json(res, 500, { ok: false, error: '内部错误' })
        } catch {
          // 响应可能已经发出去了
        }
      })
    })
    s.once('error', (err) => {
      console.error('[wf] 外部触发端点启动失败', err)
      server = null
      resolve(null)
    })
    // 只绑回环：局域网里的其它机器连不上，更别说公网
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = addr && typeof addr === 'object' ? addr.port : null
      server = s
      resolve(port)
    })
  })
}

export function stopTriggerServer(): void {
  if (!server) return
  server.close()
  server = null
}
