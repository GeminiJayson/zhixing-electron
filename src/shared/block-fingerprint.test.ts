import { describe, expect, it } from 'vitest'
import { blockFingerprint, findBestLine, normalizeBlockText, sha1Hex } from './block-fingerprint'

describe('段落指纹：必须与渲染层逐字一致', () => {
  it('sha1 用标准向量校验（换成任何别的实现都会在这里露馅）', () => {
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709')
    expect(sha1Hex('知行')).toHaveLength(40)
  })

  it('归一化：空白折叠 + 小写 + 去首尾', () => {
    expect(normalizeBlockText('  Hello   World  ')).toBe('hello world')
    expect(normalizeBlockText('A\n\tB')).toBe('a b')
  })

  it('指纹格式是 fp: + 12 位，空文本没有指纹', () => {
    expect(blockFingerprint('第一段')).toMatch(/^fp:[0-9a-f]{12}$/)
    expect(blockFingerprint('   ')).toBe('')
    // 归一化后相同的两段必须得到同一个键（换行、多余空格不影响）
    expect(blockFingerprint('Hello   World')).toBe(blockFingerprint('  hello world '))
  })
})

describe('整理后重新找回段落', () => {
  const content = ['# 标题', '', '第一段：计划 A', '', '第二段：计划 B（已改写）', '', '第三段'].join('\n')

  it('原文一字未动时精确命中', () => {
    const m = findBestLine(content, '第一段：计划 A')
    expect(m?.line).toBe('第一段：计划 A')
    expect(m?.score).toBe(1)
  })

  it('被改写过的段落按相似度找回', () => {
    const m = findBestLine(content, '第二段：计划 B')
    expect(m?.line).toContain('计划 B')
    expect(m?.score).toBeGreaterThan(0.5)
  })

  it('差得太远就判定「找不到」，绝不乱指', () => {
    expect(findBestLine(content, '完全无关的一句话：量子力学导论')).toBeNull()
    expect(findBestLine(content, '   ')).toBeNull()
  })
})
