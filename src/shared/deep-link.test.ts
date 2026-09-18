import { describe, expect, it } from 'vitest'
import { extractDeepLink, parseDeepLink, toAccelerator } from '@shared/deep-link'

describe('深链解析', () => {
  it('四类路由', () => {
    expect(parseDeepLink('zhixing://task/12')).toEqual({ kind: 'task', id: 12, block: '' })
    expect(parseDeepLink('zhixing://note/3')?.kind).toBe('note')
    expect(parseDeepLink('zhixing://flash/7')?.id).toBe(7)
    expect(parseDeepLink('zhixing://folder/2')?.kind).toBe('folder')
  })

  it('block 查询参数与写法兼容', () => {
    expect(parseDeepLink('zhixing://note/5?block=abc123')?.block).toBe('abc123')
    expect(parseDeepLink('zhixing:note/9')?.id).toBe(9)
    expect(parseDeepLink('zhixing:///task/8')?.id).toBe(8)
  })

  it('非本协议 / 未知类型 / 非法 id 一律拒绝', () => {
    expect(parseDeepLink('https://example.com')).toBeNull()
    expect(parseDeepLink('zhixing://tag/3')).toBeNull()
    expect(parseDeepLink('zhixing://task/0')).toBeNull()
    expect(parseDeepLink('zhixing://task/abc')).toBeNull()
  })

  it('从 argv 提取深链', () => {
    expect(extractDeepLink(['/app', '--flag', 'zhixing://task/4'])).toBe('zhixing://task/4')
    expect(extractDeepLink(['/app'])).toBeNull()
  })
})

describe('热键 → Electron Accelerator', () => {
  it('常见组合', () => {
    expect(toAccelerator('ctrl+alt+n')).toBe('Control+Alt+N')
    expect(toAccelerator('shift+d')).toBe('Shift+D')
    expect(toAccelerator('ctrl+shift+d')).toBe('Control+Shift+D')
    expect(toAccelerator('cmd+option+k')).toBe('Command+Alt+K')
  })

  it('拒绝没有修饰键的裸按键（否则会抢占普通输入）', () => {
    expect(toAccelerator('d')).toBe('')
    expect(toAccelerator('')).toBe('')
  })
})
