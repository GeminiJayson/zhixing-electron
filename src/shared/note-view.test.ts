import { describe, expect, it } from 'vitest'
import {
  kindLabel,
  matchNoteQuery,
  parseNoteQuery,
  propColumnsOf,
  type NoteRow,
} from './note-view'

const row = (o: Partial<NoteRow> = {}): NoteRow => ({
  id: 1,
  title: '卡片笔记写作法',
  folder: '读书',
  kind: 'concept',
  format: 'markdown',
  tags: ['写作', '方法'],
  props: { 来源: '书籍', 评分: '5' },
  word_count: 1200,
  updated_at: '2026-10-04 09:00:00',
  ...o,
})

describe('parseNoteQuery', () => {
  it('空表达式 = 无条件', () => {
    const q = parseNoteQuery('   ')
    expect(q.text).toBe('')
    expect(q.props).toEqual([])
    expect(q.unknown).toEqual([])
  })

  it('裸词按 text 处理，不报"没看懂"', () => {
    const q = parseNoteQuery('卡片 笔记')
    expect(q.text).toBe('卡片 笔记')
    expect(q.unknown).toEqual([])
  })

  it('各前缀', () => {
    const q = parseNoteQuery('tag:写作 folder:读书 kind:concept text:卡片')
    expect(q.tag).toBe('写作')
    expect(q.folder).toBe('读书')
    expect(q.kind).toBe('concept')
    expect(q.text).toBe('卡片')
  })

  it('prop 带值 / 只判存在', () => {
    expect(parseNoteQuery('prop:来源=书籍').props).toEqual([{ key: '来源', value: '书籍' }])
    expect(parseNoteQuery('prop:评分').props).toEqual([{ key: '评分', value: null }])
    // 值里可以有等号（写 URL 之类）
    expect(parseNoteQuery('prop:链接=a=b').props).toEqual([{ key: '链接', value: 'a=b' }])
  })

  it('没看懂的片段进 unknown，而不是静默忽略', () => {
    const q = parseNoteQuery('priority>=3 prop: text:')
    expect(q.unknown).toContain('priority>=3')
    expect(q.unknown).toContain('prop:')
  })

  it('多个 text: 与裸词合并成一组词', () => {
    const q = parseNoteQuery('text:卡片 写作 text:方法')
    expect(q.text.split(' ').sort()).toEqual(['写作', '卡片', '方法'])
  })
})

describe('matchNoteQuery', () => {
  const r = row()

  it('空条件全过', () => {
    expect(matchNoteQuery(r, parseNoteQuery(''))).toBe(true)
  })

  it('text 命中标题或属性值，大小写不敏感', () => {
    expect(matchNoteQuery(r, parseNoteQuery('卡片'))).toBe(true)
    expect(matchNoteQuery(r, parseNoteQuery('书籍'))).toBe(true)
    expect(matchNoteQuery(r, parseNoteQuery('不存在的词'))).toBe(false)
  })

  it('多个词之间是「与」', () => {
    expect(matchNoteQuery(r, parseNoteQuery('卡片 写作'))).toBe(true)
    expect(matchNoteQuery(r, parseNoteQuery('卡片 不存在的词'))).toBe(false)
  })

  it('tag 要完全相等，不是包含', () => {
    expect(matchNoteQuery(r, parseNoteQuery('tag:写作'))).toBe(true)
    expect(matchNoteQuery(r, parseNoteQuery('tag:写'))).toBe(false)
  })

  it('folder 是包含匹配（写一半也能筛）', () => {
    expect(matchNoteQuery(r, parseNoteQuery('folder:读'))).toBe(true)
    expect(matchNoteQuery(r, parseNoteQuery('folder:工作'))).toBe(false)
  })

  it('kind 完全相等', () => {
    expect(matchNoteQuery(r, parseNoteQuery('kind:concept'))).toBe(true)
    expect(matchNoteQuery(r, parseNoteQuery('kind:note'))).toBe(false)
  })

  it('prop：有值比相等，无值只判存在', () => {
    expect(matchNoteQuery(r, parseNoteQuery('prop:来源=书籍'))).toBe(true)
    expect(matchNoteQuery(r, parseNoteQuery('prop:来源=论文'))).toBe(false)
    expect(matchNoteQuery(r, parseNoteQuery('prop:评分'))).toBe(true)
    expect(matchNoteQuery(r, parseNoteQuery('prop:作者'))).toBe(false)
  })

  it('多个条件是「与」', () => {
    expect(matchNoteQuery(r, parseNoteQuery('tag:写作 folder:读书 kind:concept'))).toBe(true)
    expect(matchNoteQuery(r, parseNoteQuery('tag:写作 kind:pitfall'))).toBe(false)
  })
})

describe('propColumnsOf', () => {
  it('出现两次以上的键才成列，按出现次数降序', () => {
    const rows = [
      row({ id: 1, props: { 来源: '书籍', 评分: '5' } }),
      row({ id: 2, props: { 来源: '论文' } }),
      row({ id: 3, props: { 孤例: 'x', 来源: '播客' } }),
    ]
    expect(propColumnsOf(rows)).toEqual(['来源'])
  })

  it('同次数按首次出现顺序，列序稳定', () => {
    const rows = [
      row({ id: 1, props: { B: '1', A: '1' } }),
      row({ id: 2, props: { B: '2', A: '2' } }),
    ]
    expect(propColumnsOf(rows)).toEqual(['B', 'A'])
  })

  it('limit 截断', () => {
    const rows = [
      row({ id: 1, props: { A: '1', B: '1', C: '1' } }),
      row({ id: 2, props: { A: '2', B: '2', C: '2' } }),
    ]
    expect(propColumnsOf(rows, 2)).toHaveLength(2)
  })

  it('没有属性时是空数组', () => {
    expect(propColumnsOf([row({ props: {} })])).toEqual([])
  })
})

describe('kindLabel', () => {
  it('已知类型给中文，未知原样', () => {
    expect(kindLabel('pitfall')).toBe('踩坑')
    expect(kindLabel('自定义')).toBe('自定义')
  })
})
