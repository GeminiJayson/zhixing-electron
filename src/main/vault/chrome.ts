import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createDecipheriv } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

/**
 * 从 Chrome / Edge 导入已保存的密码。
 *
 * **这不是"捕获输入"，是读用户自己已经存下来的数据** —— 不需要任何钩子，
 * 不碰键盘，不碰别的进程。KeePass / 1Password / Bitwarden 用的都是这个路子。
 *
 * 加密分两层（Chrome 80 之后）：
 *   1. AES-256 密钥存在 Local State 的 os_crypt.encrypted_key 里，
 *      用 Windows DPAPI（绑当前用户账户）加密 —— 只有本账户能解开；
 *   2. 每条密码是 AES-256-GCM：v10/v11 前缀(3B) + nonce(12B) + 密文 + tag(16B)。
 *
 * **Chrome 127+ 引入了 App-Bound Encryption（v20 前缀）**：它额外绑定了应用身份，
 * 普通进程解不开。遇到 v20 我们**明确报错**，不静默跳过 —— 否则用户会以为
 * "导入成功但一条都没有"。
 */

const execFileAsync = promisify(execFile)

export interface ChromeLogin {
  origin: string
  username: string
  password: string
}

export interface ChromeProfile {
  /** 目录名，如 Default / Profile 1 */
  name: string
  /** Login Data 的完整路径 */
  loginDataPath: string
}

export interface ImportResult {
  ok: boolean
  message?: string
  logins: ChromeLogin[]
  /** 扫描到的 profile 名，用于界面展示 */
  profiles: string[]
  /** 解不开的条数（v20 / 数据损坏），0 表示全部成功 */
  skipped: number
}

const BROWSERS = [
  { key: 'chrome', label: 'Chrome', dir: 'Google\\Chrome\\User Data' },
  { key: 'edge', label: 'Edge', dir: 'Microsoft\\Edge\\User Data' },
] as const

export type BrowserKey = (typeof BROWSERS)[number]['key']

function userDataDir(key: BrowserKey): string | null {
  const local = process.env.LOCALAPPDATA
  if (!local) return null
  const b = BROWSERS.find((x) => x.key === key)
  if (!b) return null
  const p = join(local, ...b.dir.split('\\\\'))
  return existsSync(p) ? p : null
}

/** 列出某个浏览器下所有含 Login Data 的 profile。 */
export function listProfiles(key: BrowserKey): ChromeProfile[] {
  const dir = userDataDir(key)
  if (!dir) return []
  const out: ChromeProfile[] = []
  for (const name of ['Default', 'Profile 1', 'Profile 2', 'Profile 3', 'Profile 4']) {
    const p = join(dir, name, 'Login Data')
    if (existsSync(p)) out.push({ name, loginDataPath: p })
  }
  return out
}

/**
 * 用 DPAPI 解开 AES 密钥。
 *
 * **必须借 PowerShell** —— Node 没有 DPAPI 绑定，而引入原生模块会让这个项目
 * 多一条需要随 Electron ABI 重编译的依赖。一次 `execFile` 换掉一个原生依赖是划算的。
 *
 * 只在解**密钥**时走子进程；密钥拿到之后所有解密都在本进程内做，
 * 密码明文不经过子进程。
 */
async function unprotectWithDpapi(blob: Buffer): Promise<Buffer> {
  const b64 = blob.toString('base64')
  const script =
    "Add-Type -AssemblyName System.Security; " +
    `$b=[Convert]::FromBase64String('${b64}'); ` +
    "$d=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); " +
    '[Convert]::ToBase64String($d)'
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }
  )
  const text = stdout.trim()
  if (!text) throw new Error('DPAPI 解密返回空结果')
  return Buffer.from(text, 'base64')
}

/** 读 Local State 里的 os_crypt.encrypted_key 并解出 AES 密钥。 */
async function readAesKey(key: BrowserKey): Promise<Buffer> {
  const dir = userDataDir(key)
  if (!dir) throw new Error('找不到浏览器的用户数据目录')
  const statePath = join(dir, 'Local State')
  if (!existsSync(statePath)) {
    throw new Error('找不到 Local State —— 这个浏览器可能从未保存过密码')
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
    os_crypt?: { encrypted_key?: string }
  }
  const enc = state.os_crypt?.encrypted_key
  if (!enc) {
    throw new Error('Local State 里没有 encrypted_key —— 这个浏览器从未保存过密码')
  }
  const raw = Buffer.from(enc, 'base64')
  // 前缀是字面量 "DPAPI"（5 字节），DPAPI 只认后面的部分
  const body = raw.subarray(0, 5).toString('latin1') === 'DPAPI' ? raw.subarray(5) : raw
  return unprotectWithDpapi(body)
}

/**
 * 解一条 password_value。v20（App-Bound）解不开，返回 null 让调用方计数。
 *
 * 导出是为了单测 —— 这个函数是整条链路里最容易写错的地方（前缀长度、nonce 与 tag
 * 的偏移），而它恰好是纯函数，不需要数据库就能覆盖。
 */
export function decryptPassword(key: Buffer, blob: Buffer): string | null {
  if (blob.length < 3 + 12 + 16) return null
  const prefix = blob.subarray(0, 3).toString('latin1')
  if (prefix === 'v20') return null // App-Bound Encryption，普通进程解不开
  if (prefix !== 'v10' && prefix !== 'v11') return null
  try {
    const nonce = blob.subarray(3, 15)
    const tag = blob.subarray(blob.length - 16)
    const body = blob.subarray(15, blob.length - 16)
    const d = createDecipheriv('aes-256-gcm', key, nonce)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(body), d.final()]).toString('utf8')
  } catch {
    return null
  }
}

/**
 * 读取并解密某个浏览器的全部密码。
 *
 * **profile 的库文件会被复制到临时目录再读** —— 浏览器运行时会对 Login Data 加锁，
 * 直接打开会失败。复制出来读是唯一稳的做法，也顺带避免我们持有它的锁。
 */
export async function importFromBrowser(key: BrowserKey): Promise<ImportResult> {
  const profiles = listProfiles(key)
  if (profiles.length === 0) {
    return { ok: false, message: '没有找到已保存密码的浏览器配置', logins: [], profiles: [], skipped: 0 }
  }

  let aesKey: Buffer
  try {
    aesKey = await readAesKey(key)
  } catch (err) {
    // 这一句要具体 —— 它决定了用户是"去存一个密码"还是"换个账户登录"
    return { ok: false, message: (err as Error).message, logins: [], profiles: profiles.map((p) => p.name), skipped: 0 }
  }

  const tmp = mkdtempSync(join(tmpdir(), 'zhixing-import-'))
  const logins: ChromeLogin[] = []
  let skipped = 0
  try {
    const Database = (await import('better-sqlite3')).default
    for (const p of profiles) {
      const copy = join(tmp, p.name.replace(/\s+/g, '_') + '.db')
      try {
        copyFileSync(p.loginDataPath, copy)
      } catch {
        continue
      }
      let db: InstanceType<typeof Database> | null = null
      try {
        db = new Database(copy, { readonly: true })
        const rows = db
          .prepare('SELECT origin_url, username_value, password_value FROM logins')
          .all() as { origin_url: string; username_value: string; password_value: Buffer }[]
        for (const r of rows) {
          if (!r.password_value || r.password_value.length === 0) continue
          const pw = decryptPassword(aesKey, r.password_value)
          if (pw === null) {
            skipped++
            continue
          }
          // 空密码的条目没有导入价值，跳过但不算失败
          if (!pw) continue
          logins.push({
            origin: r.origin_url ?? '',
            username: r.username_value ?? '',
            password: pw,
          })
        }
      } catch {
        // 单个 profile 读失败不影响其他 profile
      } finally {
        db?.close()
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  const note =
    skipped > 0
      ? `（有 ${skipped} 条用了新版 App-Bound 加密，无法在本机解密，已跳过）`
      : ''
  return {
    ok: true,
    message: `从 ${profiles.length} 个配置里读到 ${logins.length} 条${note}`,
    logins,
    profiles: profiles.map((p) => p.name),
    skipped,
  }
}

/** 供界面用：机器上装了哪些浏览器、各自有多少 profile。 */
export function availableBrowsers(): { key: BrowserKey; label: string; profiles: string[] }[] {
  return BROWSERS.map((b) => ({ key: b.key, label: b.label, profiles: listProfiles(b.key).map((p) => p.name) })).filter(
    (b) => b.profiles.length > 0
  )
}
