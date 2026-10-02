import { execFileSync } from 'node:child_process'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { availableBrowsers, decryptPassword, listProfiles } from './chrome'

/**
 * 这里**只测纯函数**。
 *
 * 读 Login Data 那一段要用 better-sqlite3，而它是按 Electron 的 ABI 编译的 ——
 * 在 vitest 的 Node 里直接加载会失败（项目里现有测试也全是纯逻辑，同一个原因）。
 * 所以"整个导入链路"改用 Electron 端到端验证（真 DPAPI + 真 SQLite + 真 AES-GCM），
 * 这里覆盖的是最容易写错、又不需要数据库的那部分：密文的字节布局。
 */

const KEY = randomBytes(32)

/** 按 Chrome 的格式加密：前缀(3B) + nonce(12B) + 密文 + tag(16B) */
function encryptLikeChrome(key: Buffer, plain: string, prefix = 'v10'): Buffer {
  const nonce = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final(), c.getAuthTag()])
  return Buffer.concat([Buffer.from(prefix, 'latin1'), nonce, ct])
}

describe('Chrome 密码密文的字节布局', () => {
  it('v10 能解出明文', () => {
    expect(decryptPassword(KEY, encryptLikeChrome(KEY, 'ExamplePass!1'))).toBe('ExamplePass!1')
  })

  it('v11 同样能解出（前缀不同，布局一样）', () => {
    expect(decryptPassword(KEY, encryptLikeChrome(KEY, 'OldPass99', 'v11'))).toBe('OldPass99')
  })

  it('非 ASCII 密码正确往返', () => {
    expect(decryptPassword(KEY, encryptLikeChrome(KEY, '银行密码#2026🔐'))).toBe('银行密码#2026🔐')
  })

  it('v20（App-Bound Encryption）返回 null —— 明确跳过而不是解出乱码', () => {
    expect(decryptPassword(KEY, encryptLikeChrome(KEY, 'NewPass2026', 'v20'))).toBeNull()
  })

  it('未知前缀返回 null', () => {
    expect(decryptPassword(KEY, encryptLikeChrome(KEY, 'x', 'v99'))).toBeNull()
  })

  it('密文被改动一个字节就解不出（GCM 认证）', () => {
    const blob = encryptLikeChrome(KEY, 'Tampered1')
    blob[blob.length - 1] ^= 0xff
    expect(decryptPassword(KEY, blob)).toBeNull()
  })

  it('用别的密钥解不出', () => {
    expect(decryptPassword(randomBytes(32), encryptLikeChrome(KEY, 'secret'))).toBeNull()
  })

  it('长度不足的 blob 返回 null，不抛异常', () => {
    expect(() => decryptPassword(KEY, Buffer.alloc(10))).not.toThrow()
    expect(decryptPassword(KEY, Buffer.alloc(10))).toBeNull()
    expect(decryptPassword(KEY, Buffer.alloc(0))).toBeNull()
  })

  it('空密码能解出空串（调用方据此决定跳过）', () => {
    expect(decryptPassword(KEY, encryptLikeChrome(KEY, ''))).toBe('')
  })
})

describe('profile 扫描', () => {
  let root: string
  let original: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zhixing-profiles-'))
    original = process.env.LOCALAPPDATA
    process.env.LOCALAPPDATA = root
  })

  afterEach(() => {
    if (original === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = original
    rmSync(root, { recursive: true, force: true })
  })

  function touchProfile(name: string): void {
    const dir = join(root, 'Google', 'Chrome', 'User Data', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Login Data'), '')
  }

  it('目录不存在时返回空列表，不抛异常', () => {
    expect(() => listProfiles('chrome')).not.toThrow()
    expect(listProfiles('chrome')).toEqual([])
    expect(availableBrowsers()).toEqual([])
  })

  it('只把含 Login Data 的目录算作 profile', () => {
    touchProfile('Default')
    touchProfile('Profile 2')
    // 这个目录存在但没有 Login Data，不该被列出来
    mkdirSync(join(root, 'Google', 'Chrome', 'User Data', 'Profile 3'), { recursive: true })
    expect(listProfiles('chrome').map((p) => p.name)).toEqual(['Default', 'Profile 2'])
  })

  it('availableBrowsers 反映各浏览器的 profile 数', () => {
    touchProfile('Default')
    const list = availableBrowsers()
    expect(list).toHaveLength(1)
    expect(list[0].key).toBe('chrome')
    expect(list[0].profiles).toEqual(['Default'])
  })
})
