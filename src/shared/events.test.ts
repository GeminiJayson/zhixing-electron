import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindHostEvents, emitDataChanged, subscribeDataChanged, subscribeDomain, type DataDomain } from './events'

// listeners 是模块级状态：每个用例结束必须退订，否则会串到下一个用例
const offs: (() => void)[] = []
afterEach(() => {
  while (offs.length) offs.pop()!()
})

describe('subscribeDataChanged', () => {
  it('收到任意域的通知，并带上域', () => {
    const seen: DataDomain[] = []
    offs.push(subscribeDataChanged((d) => seen.push(d)))
    emitDataChanged('task')
    emitDataChanged('note')
    expect(seen).toEqual(['task', 'note'])
  })

  it('退订之后不再收到', () => {
    const fn = vi.fn()
    const off = subscribeDataChanged(fn)
    emitDataChanged('task')
    off()
    emitDataChanged('task')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('同一个函数订阅两次只收一次 —— 订阅表是 Set，按引用去重', () => {
    // 这条是**行为契约**：同一引用重复订阅不会让回调跑多次。
    // 代价是「同一个函数需要两份独立订阅」做不到（要包一层箭头函数）。
    const fn = vi.fn()
    offs.push(subscribeDataChanged(fn), subscribeDataChanged(fn))
    emitDataChanged('flash')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('subscribeDomain', () => {
  it('只在自己关心的域上回调', () => {
    const fn = vi.fn()
    offs.push(subscribeDomain(['note'], fn))
    emitDataChanged('task')
    expect(fn).not.toHaveBeenCalled()
    emitDataChanged('note')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('多个域都算命中', () => {
    const fn = vi.fn()
    offs.push(subscribeDomain(['task', 'flash'], fn))
    emitDataChanged('task')
    emitDataChanged('flash')
    emitDataChanged('workflow')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('空域数组等于不订阅任何东西', () => {
    const fn = vi.fn()
    offs.push(subscribeDomain([], fn))
    emitDataChanged('task')
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('emitDataChanged', () => {
  it('遍历的是快照 —— 回调里退订不会漏掉或重复本轮的其他订阅者', () => {
    const calls: string[] = []
    const offA = subscribeDataChanged(() => {
      calls.push('a')
      offB() // 在 a 的回调里把 b 退掉
    })
    const offB = subscribeDataChanged(() => calls.push('b'))
    offs.push(offA, offB)
    emitDataChanged('task')
    // 本轮用的是 emit 开始时的副本，所以 b 仍然收到这一次
    expect(calls).toEqual(['a', 'b'])
    calls.length = 0
    emitDataChanged('task')
    expect(calls).toEqual(['a'])
  })

  it('没有订阅者时静默返回', () => {
    expect(() => emitDataChanged('settings')).not.toThrow()
  })
})

describe('bindHostEvents', () => {
  it('把主进程的域字符串转成类型化事件转发出去', () => {
    const seen: DataDomain[] = []
    offs.push(subscribeDataChanged((d) => seen.push(d)))
    bindHostEvents({ onDataChanged: (cb) => cb('task') })
    expect(seen).toEqual(['task'])
  })

  it('只接桥、不自己留引用 —— 主进程侧编译不需要 window', () => {
    const bridge = { onDataChanged: vi.fn() }
    bindHostEvents(bridge)
    expect(bridge.onDataChanged).toHaveBeenCalledTimes(1)
    expect(typeof bridge.onDataChanged.mock.calls[0][0]).toBe('function')
  })
})
