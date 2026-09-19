import { describe, expect, it } from 'vitest'
import { filterTasks, parseQuery, resolveDueToken } from './query'

const TODAY = '2026-10-08'
const tasks = [
  { title: '写周报', notes_md: '含数据', status: 'todo', priority: 5, due_date: '2026-10-08', list_id: 1 },
  { title: '读论文', notes_md: '', status: 'todo', priority: 2, due_date: '2026-10-20', list_id: 2 },
  { title: '交房租', notes_md: '', status: 'done', priority: 8, due_date: '2026-10-01', list_id: null },
  { title: '无截止的事', notes_md: '', status: 'todo', priority: 0, due_date: null, list_id: null },
]
const ctx = { today: TODAY, listNames: { 1: '工作', 2: '学习' } }

describe('保存的查询', () => {
  it('解析各类 token', () => {
    const q = parseQuery('!done text:周报 tag:重要 list:工作 priority>=3 due<=today')
    expect(q.notDone).toBe(true)
    expect(q.text).toBe('周报')
    expect(q.tag).toBe('重要')
    expect(q.list).toBe('工作')
    expect(q.priority).toEqual({ op: '>=', value: 3 })
    expect(q.due).toEqual({ op: '<=', value: 'today' })
    expect(q.unknown).toEqual([])
  })

  it('无法识别的片段会被记下来而不是静默忽略', () => {
    const q = parseQuery('foo:bar !whatever')
    expect(q.unknown).toEqual(['foo:bar', '!whatever'])
  })

  it('裸词当全文搜索', () => {
    const q = parseQuery('论文')
    expect(q.text).toBe('论文')
  })

  it('due 关键字折算成日期', () => {
    expect(resolveDueToken('today', TODAY)).toBe('2026-10-08')
    expect(resolveDueToken('tomorrow', TODAY)).toBe('2026-10-09')
    expect(resolveDueToken('2026-01-02', TODAY)).toBe('2026-01-02')
    expect(resolveDueToken('none', TODAY)).toBe('')
    expect(resolveDueToken('瞎写', TODAY)).toBeNull()
  })

  it('按未完成 + 优先级过滤', () => {
    const out = filterTasks(tasks, '!done priority>=3', ctx)
    expect(out.map((t) => t.title)).toEqual(['写周报'])
  })

  it('按清单名过滤', () => {
    expect(filterTasks(tasks, 'list:工作', ctx).map((t) => t.title)).toEqual(['写周报'])
  })

  it('按截止过滤（含 overdue）', () => {
    expect(filterTasks(tasks, 'due<=today', ctx).map((t) => t.title)).toEqual(['写周报', '交房租'])
    expect(filterTasks(tasks, 'due=overdue', ctx).map((t) => t.title)).toEqual(['交房租'])
    expect(filterTasks(tasks, 'due=none', ctx).map((t) => t.title)).toEqual(['无截止的事'])
  })

  it('全文与标签', () => {
    expect(filterTasks(tasks, 'text:数据', ctx).map((t) => t.title)).toEqual(['写周报'])
    expect(filterTasks(tasks, 'tag:重要', { ...ctx, tags: ['重要'] }).length).toBe(tasks.length)
    expect(filterTasks(tasks, 'tag:重要', { ...ctx, tags: [] }).length).toBe(0)
  })

  it('多个条件是与关系', () => {
    expect(filterTasks(tasks, '!done list:工作 due<=today', ctx).map((t) => t.title)).toEqual(['写周报'])
    expect(filterTasks(tasks, '!done list:学习 due<=today', ctx)).toEqual([])
  })

  it('空表达式返回全部', () => {
    expect(filterTasks(tasks, '', ctx)).toHaveLength(tasks.length)
  })
})
