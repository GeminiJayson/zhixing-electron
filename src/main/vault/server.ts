import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { conn } from '../db/connection'
import { addFlash } from '../db/inbox'
import { listSettings, setSetting } from '../db/settings'
import { randomBytes } from 'node:crypto'
import * as store from './store'

/**
 * 给浏览器扩展用的本地 HTTP 端点。
 *
 * **这是浏览器插件那条路，不是键盘钩子**：扩展的 content script 在页面里
 * 读自己所在页面的登录表单，再把结果发到这里。它看不到别的标签页、别的应用，
 * 也不需要任何系统级权限 —— 这是所有密码管理器的通行做法。
 *
 * 与 workflow 的触发端点（http-trigger.ts）有三处不同，都是被"对面是浏览器扩展"
 * 这个前提逼出来的：
 *
 *   1. **端口必须固定**（见下），不能像那边一样 listen(0) —— 扩展没法知道随机端口；
 *   2. **要带 CORS 头**，否则扩展的 fetch 读不到响应；
 *   3. **需要 GET /vault/ping** 供扩展探测端口，这个端点不带令牌（只回一句"我是知行"，
 *      不含任何用户数据）。
 *
 * 安全边界：只监听 127.0.0.1；写入类端点必须要令牌，而令牌只显示在设置页里，
 * 用户手动粘进扩展。恶意网页即使猜到端口，没有令牌也只能拿到 401。
 */

/** 默认端口。固定值的唯一目的是让扩展能找过来；被占用时会在这一段里顺延。 */
const DEFAULT_PORT = 47821
/** 顺延范围：扩展会依次探测这一段 */
const PORT_SPAN = 10
/**
 * 请求体上限。
 *
 * 原来是 16KB —— 那是按"一条凭据（站点 + 账号 + 密码）"定的，完全够用。
 * 但 /clip 也走这个 readBody：**剪藏一整篇文章的 HTML 轻松上百 KB**，
 * 16KB 会在中途静默截断，JSON 直接残缺，端点报"请求体不是合法 JSON"，
 * 而用户看到的是一次莫名其妙的失败（实测踩到）。
 *
 * 4MB 足够一篇文章（addFlash 那边对 html 另有 200000 字符的落库上限），
 * 又不会让本机端点变成可以被灌爆的东西 —— 何况写入还需要令牌。
 */
const MAX_BODY = 4 * 1024 * 1024

let server: Server | null = null
let boundPort = 0

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    // 扩展有 host_permissions 时本不需要它，但留着头能让用户在 DevTools 里
    // 手动试接口时看得到响应
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-vault-token',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  })
  res.end(text)
}

interface RawBody {
  text: string
  /** 超出上限时为 true —— 调用方据此回 413，而不是拿一段残缺的 JSON 去解析 */
  tooLarge: boolean
}

function readBody(req: IncomingMessage): Promise<RawBody> {
  return new Promise((resolve) => {
    let size = 0
    let text = ''
    let tooLarge = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size <= MAX_BODY) text += c.toString('utf8')
      else tooLarge = true
    })
    req.on('end', () => resolve({ text, tooLarge }))
    req.on('error', () => resolve({ text: '', tooLarge: false }))
  })
}

/** 令牌：不存在就生成一个 32 位十六进制串并存进设置。 */
export function vaultToken(): string {
  const existing = listSettings().vault_http_token
  if (existing && existing.length >= 16) return existing
  const t = randomBytes(16).toString('hex')
  setSetting('vault_http_token', t)
  return t
}

/** 重新生成令牌（设置页的「重新生成」按钮）。已配好的扩展需要重新粘一次。 */
export function rotateVaultToken(): string {
  const t = randomBytes(16).toString('hex')
  setSetting('vault_http_token', t)
  return t
}

export function vaultPort(): number {
  const raw = Number.parseInt(listSettings().vault_http_port ?? '', 10)
  return Number.isFinite(raw) && raw > 1024 && raw < 65536 ? raw : DEFAULT_PORT
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers['x-vault-token']
  const fromHeader = Array.isArray(header) ? header[0] : header
  if (fromHeader && fromHeader === vaultToken()) return true
  // 也允许放在查询串里，方便用户用 curl 手测
  const q = (req.url ?? '').split('?')[1] ?? ''
  const params = new URLSearchParams(q)
  return params.get('token') === vaultToken()
}

interface CaptureBody {
  url?: string
  title?: string
  username?: string
  password?: string
}

/** 从网址里取主机名当条目标题。解不出来就用扩展传来的标题。 */
function titleFor(b: CaptureBody): string {
  try {
    const h = new URL(b.url ?? '').hostname
    if (h) return h
  } catch {
    // 不是合法 URL（扩展可能只给了域名），走下面的兜底
  }
  const t = (b.title ?? '').trim()
  return t || '(未知站点)'
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '').split('?')[0]

  // 预检：扩展在带自定义头时会先发 OPTIONS
  if (req.method === 'OPTIONS') {
    json(res, 204, {})
    return
  }

  /**
   * 探活。**不带令牌**，因为扩展得先找到端口才能带令牌。
   * 它只回应用身份，不含任何用户数据；锁定状态下也照常回应 ——
   * 扩展需要据此告诉用户"应用开着，只是保险箱锁着"。
   */
  if (path === '/vault/ping') {
    json(res, 200, {
      ok: true,
      app: 'zhixing',
      vault: store.status(),
    })
    return
  }

  /**
   * 剪藏：浏览器扩展把当前页面的正文发过来。
   *
   * **这里不检查保险箱是否解锁** —— 剪藏和密码保险箱是两件不相干的事，
   * 它只是共用了同一个本地端点与令牌。
   *
   * 落库位置是 **flash（收件箱）**，不是知识条目：抓下来的东西还没经过提炼，
   * 按方案 §2 的分层，它属于"原始资料"那一层。
   */
  if (path === '/clip') {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: '只接受 POST' })
      return
    }
    if (!authorized(req)) {
      json(res, 401, { ok: false, error: 'unauthorized' })
      return
    }
    const raw = await readBody(req)
    if (raw.tooLarge) {
      // 明确回 413 而不是让 JSON.parse 去解析一段残缺内容 ——
      // 后者会报"请求体不是合法 JSON"，把"太大了"说成"格式不对"，误导排查方向
      json(res, 413, { ok: false, error: '内容太大，超出端点上限（4MB）' })
      return
    }
    let b: { url?: string; title?: string; text?: string; html?: string; mode?: string }
    try {
      b = JSON.parse(raw.text) as typeof b
    } catch {
      json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    const text = (b.text ?? '').trim()
    if (!text) {
      json(res, 400, { ok: false, error: '没有正文' })
      return
    }
    const url = (b.url ?? '').trim()
    const html = (b.html ?? '').trim()
    const useHtml = b.mode !== 'fallback' && html.length > 200
    const payload = useHtml ? html : text

    /**
     * 查重的口径取决于剪藏方式 —— 这一条是踩出来的：
     *
     * **整页剪藏** 按 URL 去重：同一篇文章反复点图标不该堆出一串重复。
     *
     * **选区剪藏** 不能按 URL —— 同一页上"那个表格"和"那段结论"是两块不同的内容，
     * 按 URL 去重会让第二次选区直接被判成重复而**悄悄丢掉**（实测就是这个现象：
     * 先整页剪藏一页，再对同一页做选区剪藏，返回 duplicated，收件箱里什么都没进）。
     * 改用内容指纹（正文前 200 字）去重：同一块选两次仍然只存一条，
     * 而同一页选两块不同的内容会各存一条。
     */
    if (b.mode === 'selection') {
      const fp = payload.slice(0, 200)
      const dup = conn()
        .prepare('SELECT id FROM flash WHERE substr(content, 1, 200) = ? LIMIT 1')
        .get(fp)
      if (dup) {
        json(res, 200, { ok: true, action: 'duplicated' })
        return
      }
    } else if (url) {
      const dup = conn().prepare('SELECT id FROM flash WHERE source_url = ? LIMIT 1').get(url)
      if (dup) {
        json(res, 200, { ok: true, action: 'duplicated' })
        return
      }
    }
    /*
      remark 存标题：收件箱列表按它显示，正文太长不适合当标签。

      mode 为 readability 时 html 是清理过的正文 HTML（保留段落、标题、表格、图片），
      **存它而不是纯文本，剪藏才有意义** —— 否则存下来的是一坨没有结构的文字。
      回退模式没有可信的 HTML（那是整页 innerText），老实存纯文本。
    */
    addFlash(
      useHtml ? html : text,
      (b.title ?? '').trim(),
      '浏览器扩展',
      url,
      useHtml ? 'html' : 'text'
    )
    json(res, 200, { ok: true, action: 'created', mode: b.mode ?? 'readability' })
    return
  }

  if (path !== '/vault/capture') {
    json(res, 404, { ok: false, error: '未知端点' })
    return
  }

  if (req.method === 'POST' && !authorized(req)) {
    // 401 之外什么都不说：不区分"没带令牌"和"令牌不对"
    json(res, 401, { ok: false, error: 'unauthorized' })
    return
  }

  if (req.method === 'GET') {
    // 给扩展一个"待保存列表"的读口：目前只回状态，够扩展决定要不要提示用户
    json(res, 200, { ok: true, vault: store.status() })
    return
  }

  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: '只接受 GET / POST' })
    return
  }

  const body = await readBody(req)
  if (body.tooLarge) {
    json(res, 413, { ok: false, error: '内容太大，超出端点上限（4MB）' })
    return
  }
  let parsed: CaptureBody
  try {
    parsed = JSON.parse(body.text) as CaptureBody
  } catch {
    json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
    return
  }

  if (!parsed.password) {
    json(res, 400, { ok: false, error: '缺少 password' })
    return
  }

  if (store.status() !== 'unlocked') {
    // 锁定时不接收任何凭据 —— 否则等于绕过了主密码
    json(res, 423, { ok: false, error: 'locked', message: '保险箱已锁定，请先在应用里解锁' })
    return
  }

  const title = titleFor(parsed)
  const existing = store.list().find((e) => e.title === title)
  if (existing) {
    // 同一个站点已存在：更新它的账号密码，而不是新建一条重复的
    store.update(existing.id, {
      title,
      username: parsed.username ?? existing.username,
      password: parsed.password,
      url: parsed.url ?? existing.url,
      notes: existing.notes,
      tags: existing.tags.includes('插件') ? existing.tags : [...existing.tags, '插件'],
    })
    json(res, 200, { ok: true, action: 'updated', title })
    return
  }

  store.create({
    title,
    username: parsed.username ?? '',
    password: parsed.password,
    url: parsed.url ?? '',
    notes: '',
    tags: ['插件'],
  })
  json(res, 200, { ok: true, action: 'created', title })
}

/** 在 127.0.0.1 上找个能用的端口起服务。扩展会依次探测这一段。 */
export function startVaultServer(onCaptured?: (title: string) => void): number {
  if (server) return boundPort
  const wanted = vaultPort()

  const s = createServer((req, res) => {
    void onRequest(req, res).catch(() => {
      // 单次请求出错不该让整个端点挂掉
      if (!res.headersSent) json(res, 500, { ok: false, error: '内部错误' })
    })
  })
  server = s

  /**
   * 依次试 wanted..wanted+SPAN-1。
   * 端口被别的程序占着是很常见的事（尤其用户同时开了两个版本），
   * 顺延一个比直接失败好 —— 扩展本来就要扫描这一段。
   */
  const tryListen = (port: number, attempt: number): void => {
    s.once('error', () => {
      if (attempt < PORT_SPAN) tryListen(port + 1, attempt + 1)
    })
    s.listen(port, '127.0.0.1', () => {
      boundPort = port
      setSetting('vault_http_port', String(port))
      onCaptured?.(String(port))
    })
  }
  tryListen(wanted, 0)

  return wanted
}

export function stopVaultServer(): void {
  server?.close()
  server = null
  boundPort = 0
}

export function vaultServerPort(): number {
  return boundPort
}
