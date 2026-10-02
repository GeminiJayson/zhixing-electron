import { describe, expect, it } from 'vitest'
import { LENGTH_MAX, LENGTH_MIN, generatePassword, strengthOf } from './generate'

describe('密码生成器', () => {
  it('长度符合要求', () => {
    for (const n of [8, 12, 20, 32, 64]) {
      expect(generatePassword({ length: n })).toHaveLength(n)
    }
  })

  it('长度被钳制在合理区间', () => {
    expect(generatePassword({ length: 1 })).toHaveLength(LENGTH_MIN)
    expect(generatePassword({ length: 999 })).toHaveLength(LENGTH_MAX)
    expect(generatePassword({ length: Number.NaN })).toHaveLength(LENGTH_MIN)
  })

  it('选中的字符类别必定出现', () => {
    for (let i = 0; i < 30; i++) {
      const p = generatePassword({ length: 16, upper: true, lower: true, digits: true, symbols: true })
      expect(/[A-Z]/.test(p)).toBe(true)
      expect(/[a-z]/.test(p)).toBe(true)
      expect(/[0-9]/.test(p)).toBe(true)
      expect(/[^A-Za-z0-9]/.test(p)).toBe(true)
    }
  })

  it('未选中的类别不出现', () => {
    for (let i = 0; i < 20; i++) {
      const p = generatePassword({ length: 24, upper: false, lower: true, digits: false, symbols: false })
      expect(/^[a-z]+$/.test(p)).toBe(true)
    }
  })

  it('一个类别都不选时退回小写字母，不返回空串', () => {
    const p = generatePassword({ length: 12, upper: false, lower: false, digits: false, symbols: false })
    expect(p).toHaveLength(12)
    expect(/^[a-z]+$/.test(p)).toBe(true)
  })

  it('不含容易看错的符号', () => {
    for (let i = 0; i < 40; i++) {
      const p = generatePassword({ length: 40 })
      expect(p).not.toMatch(/["'\\<> ]/)
    }
  })

  it('连续生成不重复', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) seen.add(generatePassword({ length: 20 }))
    expect(seen.size).toBe(50)
  })

  it('第一个字符不总是同一类（洗牌生效）', () => {
    const firsts = new Set<string>()
    for (let i = 0; i < 60; i++) {
      const c = generatePassword({ length: 20 })[0]
      firsts.add(/[A-Z]/.test(c) ? 'U' : /[a-z]/.test(c) ? 'l' : /[0-9]/.test(c) ? 'd' : 's')
    }
    expect(firsts.size).toBeGreaterThan(1)
  })
})

describe('强度提示', () => {
  it('空密码是最低档', () => {
    expect(strengthOf('').score).toBe(0)
  })

  it('短密码弱、长且混合的强', () => {
    expect(strengthOf('abc').score).toBe(1)
    expect(strengthOf(generatePassword({ length: 20 })).score).toBe(4)
  })

  it('档位单调不减（同样字符集下更长的不更弱）', () => {
    const a = strengthOf('abcdefgh').score
    const b = strengthOf('abcdefghijklmnop').score
    expect(b).toBeGreaterThanOrEqual(a)
  })
})
