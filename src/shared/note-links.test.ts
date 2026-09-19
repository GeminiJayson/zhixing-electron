import { describe, expect, it } from 'vitest'
import {
  appendLinkItems,
  describeLinkItems,
  parseLinkItems,
  sameLink,
  serializeLinkItems,
} from './note-links'

describe('链接笔记条目：解析要能吃掉三种历史形态', () => {
  it('Python 版的 [{title,target}] 数组', () => {
    expect(parseLinkItems('[{"title":"知乎","target":"https://zhihu.com"}]')).toEqual([
      { title: '知乎', target: 'https://zhihu.com' },
    ])
  })

  it('{title,url} 写法与缺标题的项都能认出来', () => {
    const items = parseLinkItems('[{"title":"A","url":"https://a.com"},{"target":"https://b.com"}]')
    expect(items).toEqual([
      { title: 'A', target: 'https://a.com' },
      { title: 'https://b.com', target: 'https://b.com' },
    ])
  })

  it('Markdown 列表与裸链接、单条链接都能还原', () => {
    expect(parseLinkItems('- [标题](https://x.com)\n- [另一个](https://y.com)')).toEqual([
      { title: '标题', target: 'https://x.com' },
      { title: '另一个', target: 'https://y.com' },
    ])
    expect(parseLinkItems('https://one.com\nhttps://two.com')).toEqual([
      { title: 'https://one.com', target: 'https://one.com' },
      { title: 'https://two.com', target: 'https://two.com' },
    ])
    expect(parseLinkItems('https://solo.com')).toEqual([{ title: 'https://solo.com', target: 'https://solo.com' }])
    expect(parseLinkItems('')).toEqual([])
    expect(parseLinkItems('[]')).toEqual([])
  })

  it('序列化后能原样读回，空目标被丢掉', () => {
    const items = [
      { title: '标题', target: 'https://x.com' },
      { title: '空', target: ' ' },
    ]
    const text = serializeLinkItems(items)
    expect(parseLinkItems(text)).toEqual([{ title: '标题', target: 'https://x.com' }])
  })

  it('追加去重：同一个 target 不会重复进列表', () => {
    const existing = [{ title: '旧', target: 'https://a.com' }]
    const { items, added } = appendLinkItems(existing, [
      { title: '重复', target: 'https://a.com' },
      { title: '新的', target: 'https://b.com' },
      { title: '空', target: '' },
    ])
    expect(added).toBe(1)
    expect(items.map((i) => i.target)).toEqual(['https://a.com', 'https://b.com'])
  })

  it('提示词清单带序号，便于模型按 url 回填', () => {
    const text = describeLinkItems([{ title: '知乎', target: 'https://zhihu.com' }])
    expect(text).toContain('1. 知乎 — https://zhihu.com')
    expect(describeLinkItems([])).toContain('还没有链接')
    expect(sameLink({ title: 'a', target: ' https://x.com ' }, { title: 'b', target: 'https://x.com' })).toBe(true)
  })
})
