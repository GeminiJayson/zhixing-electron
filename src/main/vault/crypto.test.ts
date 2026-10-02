import { describe, expect, it } from 'vitest'
import {
  KDF_DEFAULTS,
  checkVerifier,
  decryptField,
  deriveKey,
  encryptField,
  fieldAad,
  makeVerifier,
  newSalt,
} from './crypto'

/**
 * 测试用一组**低成本**的 scrypt 参数：默认参数单次约 0.3–1 秒、128MB 内存，
 * 在测试里跑几十次会明显拖慢整个套件。参数本身是被持久化并随库读取的，
 * 所以这里换参数不影响生产路径的正确性 —— 这正是"参数入库"的意义。
 */
const FAST = { N: 1 << 12, r: 8, p: 1, keylen: 32 }

function key(password = 'correct horse battery staple'): Buffer {
  return deriveKey(password, Buffer.alloc(16, 7), FAST)
}

describe('保险箱密码学原语', () => {
  it('加解密往返一致', () => {
    const k = key()
    const aad = fieldAad(1, 'password')
    const { ct, iv } = encryptField(k, 'hunter2-测试-🔐', aad)
    expect(decryptField(k, ct, iv, aad)).toBe('hunter2-测试-🔐')
  })

  it('密文不含明文', () => {
    const k = key()
    const { ct } = encryptField(k, 'super-secret-value', fieldAad(1, 'password'))
    expect(ct.toString('utf8')).not.toContain('super-secret-value')
    expect(ct.toString('hex')).not.toContain(Buffer.from('super-secret-value').toString('hex'))
  })

  it('同一明文加密两次得到不同密文（IV 每次新生成）', () => {
    const k = key()
    const aad = fieldAad(1, 'password')
    const a = encryptField(k, 'same', aad)
    const b = encryptField(k, 'same', aad)
    expect(a.iv.equals(b.iv)).toBe(false)
    expect(a.ct.equals(b.ct)).toBe(false)
  })

  it('AAD 不匹配时解不开（密文不能挪到别的条目上）', () => {
    const k = key()
    const { ct, iv } = encryptField(k, 'secret', fieldAad(1, 'password'))
    expect(decryptField(k, ct, iv, fieldAad(2, 'password'))).toBeNull()
    expect(decryptField(k, ct, iv, fieldAad(1, 'username'))).toBeNull()
  })

  it('错误的密钥解不开，且返回 null 而不是抛异常', () => {
    const { ct, iv } = encryptField(key('right'), 'secret', fieldAad(1, 'password'))
    expect(() => decryptField(key('wrong'), ct, iv, fieldAad(1, 'password'))).not.toThrow()
    expect(decryptField(key('wrong'), ct, iv, fieldAad(1, 'password'))).toBeNull()
  })

  it('密文被改动一个字节就解不开（GCM 认证）', () => {
    const k = key()
    const { ct, iv } = encryptField(k, 'secret', fieldAad(1, 'password'))
    const tampered = Buffer.from(ct)
    tampered[0] = tampered[0] ^ 0xff
    expect(decryptField(k, tampered, iv, fieldAad(1, 'password'))).toBeNull()
  })

  it('verifier：正确密码通过、错误密码不通过', () => {
    const salt = newSalt()
    const k = deriveKey('master-pass', salt, FAST)
    const { ct, iv } = makeVerifier(k)
    expect(checkVerifier(k, ct, iv)).toBe(true)
    expect(checkVerifier(deriveKey('other-pass', salt, FAST), ct, iv)).toBe(false)
  })

  it('同一密码 + 不同盐 → 不同密钥（盐确实参与派生）', () => {
    const a = deriveKey('same', Buffer.alloc(16, 1), FAST)
    const b = deriveKey('same', Buffer.alloc(16, 2), FAST)
    expect(a.equals(b)).toBe(false)
  })

  it('派生出的密钥长度符合参数', () => {
    expect(deriveKey('x', newSalt(), { ...FAST, keylen: 32 })).toHaveLength(32)
    expect(deriveKey('x', newSalt(), { ...FAST, keylen: 16 })).toHaveLength(16)
  })

  it('默认参数是可持久化的普通对象（不含函数，能进 JSON）', () => {
    expect(JSON.parse(JSON.stringify(KDF_DEFAULTS))).toEqual(KDF_DEFAULTS)
    expect(KDF_DEFAULTS.N).toBe(1 << 17)
  })

  it('fieldAad 不会因拼接产生歧义', () => {
    expect(fieldAad(1, '2ab')).not.toBe(fieldAad(12, 'ab'))
  })
})
