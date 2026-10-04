import { describe, expect, it } from 'vitest'
import { shouldAutoLock, shouldClearClipboard } from './timers'

describe('保险箱 · 剪贴板清除判据', () => {
  it('内容还是我们写进去的就清', () => {
    expect(shouldClearClipboard('s3cret', 's3cret')).toBe(true)
  })

  it('用户在这期间复制了别的东西 —— 不能清', () => {
    expect(shouldClearClipboard('用户自己复制的内容', 's3cret')).toBe(false)
  })

  it('剪贴板被清空过（空串）也不动它', () => {
    expect(shouldClearClipboard('', 's3cret')).toBe(false)
  })
})

describe('保险箱 · 自动锁定判据', () => {
  it('到了设定分钟数就锁', () => {
    expect(shouldAutoLock(5, 'unlocked', 5 * 60_000)).toBe(true)
    expect(shouldAutoLock(5, 'unlocked', 6 * 60_000)).toBe(true)
  })

  it('还没到点不锁', () => {
    expect(shouldAutoLock(5, 'unlocked', 4 * 60_000)).toBe(false)
  })

  it('0 表示从不自动锁', () => {
    expect(shouldAutoLock(0, 'unlocked', 999 * 60_000)).toBe(false)
  })

  it('负数（设置被写坏）也当从不，不锁', () => {
    expect(shouldAutoLock(-1, 'unlocked', 999 * 60_000)).toBe(false)
  })

  it('本来就没解锁 —— 不需要再锁一次', () => {
    expect(shouldAutoLock(5, 'locked', 999 * 60_000)).toBe(false)
  })

  it('还没建过库（uninitialized）也不算该锁', () => {
    expect(shouldAutoLock(5, 'uninitialized', 999 * 60_000)).toBe(false)
  })
})
