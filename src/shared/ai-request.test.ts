import { describe, expect, it } from 'vitest'
import { bareKey, resolveAiAuth } from './ai-request'

describe('bareKey', () => {
  it('去掉 Key 自带的 Bearer 前缀，不会拼成 Bearer Bearer', () => {
    expect(bareKey('Bearer sk-abc')).toBe('sk-abc')
    expect(bareKey('bearer sk-abc')).toBe('sk-abc')
    expect(bareKey('  Bearer   sk-abc  ')).toBe('sk-abc')
  })
  it('没有前缀的 Key 原样返回（只去空白）', () => {
    expect(bareKey(' sk-abc ')).toBe('sk-abc')
    expect(bareKey('')).toBe('')
    expect(bareKey(null)).toBe('')
    expect(bareKey(undefined)).toBe('')
  })
})

describe('resolveAiAuth', () => {
  it('auto 按协议推断', () => {
    expect(resolveAiAuth('auto', 'openai')).toBe('bearer')
    expect(resolveAiAuth('auto', 'anthropic')).toBe('x-api-key')
    expect(resolveAiAuth('auto', 'gemini')).toBe('query')
    expect(resolveAiAuth(undefined, 'openai')).toBe('bearer')
  })
  it('显式指定覆盖协议推断（中转服务把 Anthropic 形状配 Bearer 鉴权）', () => {
    expect(resolveAiAuth('bearer', 'anthropic')).toBe('bearer')
    expect(resolveAiAuth('bearer', 'gemini')).toBe('bearer')
    expect(resolveAiAuth('query', 'openai')).toBe('query')
    expect(resolveAiAuth('x-api-key', 'openai')).toBe('x-api-key')
  })
})
