import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/**
 * 密码保险箱的密码学原语。**这个文件只做纯计算，不碰数据库、不碰状态** ——
 * 这样它可以被完整地单元测试，也便于单独审阅。
 *
 * 设计取舍见 docs/specs/vault-design.md §3。
 */

/** scrypt 参数。N=2^17 约需 128MB 内存、单次 0.3–1 秒 —— 这个延迟是特性不是缺陷。 */
export interface KdfParams {
  N: number
  r: number
  p: number
  keylen: number
}

export const KDF_DEFAULTS: KdfParams = { N: 1 << 17, r: 8, p: 1, keylen: 32 }

/**
 * scrypt 的内存上限。Node 默认的 maxmem 是 32MB，而 N=2^17, r=8 需要
 * 128 * N * r ≈ 128MB —— 不显式放开会直接抛 ERR_CRYPTO_INVALID_SCRYPT_PARAMS。
 */
const SCRYPT_MAXMEM = 512 * 1024 * 1024

export const IV_LEN = 12
export const SALT_LEN = 16
const TAG_LEN = 16

/** verifier 的固定明文：能解开它即说明主密码正确（不存密码哈希，见方案 §3.3）。 */
const VERIFIER_PLAINTEXT = 'zhixing-vault-v1'

/**
 * 从主密码派生主密钥。**主密钥只在内存里存在**，绝不落库。
 * 参数一并入库，这样以后调高强度不会让旧库失效。
 */
export function deriveKey(password: string, salt: Buffer, params: KdfParams = KDF_DEFAULTS): Buffer {
  return scryptSync(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  })
}

/**
 * 加密一个字段值。
 *
 * **每次调用都新生成 IV** —— GCM 下 IV 复用会直接毁掉保密性，
 * 所以这里是"每字段每次"独立 IV，而不是每条目一个。
 *
 * `aad` 绑定"这条记录的 id + 字段名"，防止把 A 条目的密码密文挪到 B 条目上还能解开。
 * 认证标签（16 字节）追加在密文尾部，与密文一起存。
 */
export function encryptField(
  key: Buffer,
  plain: string,
  aad: string
): { ct: Buffer; iv: Buffer } {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { ct, iv }
}

/**
 * 解密一个字段。**失败返回 null 而不是抛异常** ——
 * 调用方（列表渲染）会遇到"某条解密失败"的情况，那不应该让整个页面崩掉。
 */
export function decryptField(key: Buffer, ct: Buffer, iv: Buffer, aad: string): string | null {
  if (ct.length < TAG_LEN) return null
  try {
    const tag = ct.subarray(ct.length - TAG_LEN)
    const body = ct.subarray(0, ct.length - TAG_LEN)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    // 密码不对 / 数据被改动 / AAD 不匹配，都走这里。统一返回 null，不区分原因。
    return null
  }
}

/** 生成 verifier：用主密钥加密固定明文。解锁时解得出即密码正确。 */
export function makeVerifier(key: Buffer): { ct: Buffer; iv: Buffer } {
  return encryptField(key, VERIFIER_PLAINTEXT, 'verifier')
}

/** 校验主密码。用 decryptField 的结果比对固定明文。 */
export function checkVerifier(key: Buffer, ct: Buffer, iv: Buffer): boolean {
  return decryptField(key, ct, iv, 'verifier') === VERIFIER_PLAINTEXT
}

export function newSalt(): Buffer {
  return randomBytes(SALT_LEN)
}

/**
 * 字段的 AAD：条目 id + 字段名。
 * 用分隔符拼接，避免 (id=1, field="2ab") 与 (id=12, field="ab") 撞到一起。
 */
export function fieldAad(entryId: number | string, field: string): string {
  return `vault:${entryId}:${field}`
}
