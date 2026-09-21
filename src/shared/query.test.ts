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

/**
 * 三处修复的共同点：解析/判定口径与界面口径不一致，而且失败方向都是「静默」。
 *
 * ① 完成态：\`!done\` 原先只认 status==='done'，把 abandoned 当未完成 —— 而列表把它显示为已完成；
 *    也没有 roll-up（子任务全完成的父任务在界面上是已完成）。同一条任务两种结论。
 * ② 无法识别的 due 值：解析期照单全收，匹配期 resolveDueToken 返回 null 就 return false，
 *    于是智能清单「突然一条不剩」，而且一声不响。
 * ③ 文档承诺的裸词 \`done\` 没实现，被当成全文搜索 —— 用户以为筛出了已完成任务，其实在搜标题。
 */
describe('完成态口径与解析校验', () => {
  const mixed = [
    { title: '放弃的活', status: 'abandoned', priority: 0, due_date: null, list_id: null },
    { title: '干完的活', status: 'done', priority: 0, due_date: null, list_id: null },
    { title: '在做的活', status: 'todo', priority: 0, due_date: null, list_id: null },
  ]

  it('abandoned 与 done 一样算终态（!done 不该把它当未完成）', () => {
    expect(filterTasks(mixed, '!done', { today: TODAY }).map((t) => t.title)).toEqual(['在做的活'])
  })

  it('裸词 done = 已完成（此前被当成全文搜索）', () => {
    const q = parseQuery('done')
    expect(q.notDone).toBe(false)
    expect(q.text).toBe('')
    expect(filterTasks(mixed, 'done', { today: TODAY }).map((t) => t.title)).toEqual(['放弃的活', '干完的活'])
  })

  it('调用方给了 doneOf 就按 roll-up 的结论判', () => {
    // 父任务自身还是 todo，但子任务都完成了 —— 列表里它显示为已完成
    const parent = { title: '父', status: 'todo', priority: 0, due_date: null, list_id: null }
    const doneOf = (t: { title: string }): boolean => t.title === '父'
    expect(filterTasks([parent], '!done', { today: TODAY, doneOf })).toEqual([])
    expect(filterTasks([parent], 'done', { today: TODAY, doneOf })).toHaveLength(1)
  })

  it('无法识别的 due 值在解析期记入 unknown，而不是匹配期滤成空集', () => {
    const q = parseQuery('due<瞎写')
    expect(q.due).toBeNull()
    expect(q.unknown).toEqual(['due<瞎写'])
    // 关键：不再把整张清单悄悄滤空
    expect(filterTasks(tasks, 'due<瞎写', ctx)).toHaveLength(tasks.length)
  })

  it('@别名同样校验', () => {
    expect(parseQuery('@today').due).toEqual({ op: '=', value: 'today' })
    expect(parseQuery('@瞎写').due).toBeNull()
    expect(parseQuery('@瞎写').unknown).toEqual(['@瞎写'])
  })

  it('合法的 due 值不受影响', () => {
    expect(parseQuery('due<=today').due).toEqual({ op: '<=', value: 'today' })
    expect(parseQuery('due=overdue').due).toEqual({ op: '=', value: 'overdue' })
    expect(parseQuery('due=none').due).toEqual({ op: '=', value: 'none' })
    expect(parseQuery('due<2026-12-31').due).toEqual({ op: '<', value: '2026-12-31' })
  })
})
