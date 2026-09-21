import { describe, expect, it } from 'vitest'
import { quietFailure } from './quiet-failure'

/**
 * 静默失败的统一出口：行为不变，但必须留下带上下文的一条记录。
 * 断言写成「日志行长什么样」，而不是去 spy console。
 */
describe('静默失败出口', () => {
  it('带范围、上下文与原因', () => {
    const line = quietFailure('删除连线', new Error('FOREIGN KEY constraint failed'), 'task#7 → note#3')
    expect(line).toContain('[静默失败]')
    expect(line).toContain('删除连线')
    expect(line).toContain('task#7 → note#3')
    expect(line).toContain('FOREIGN KEY constraint failed')
  })

  it('不是 Error 的东西也要能落成一行', () => {
    const line = quietFailure('图谱预览', '字符串原因', 'kind=note')
    expect(line).toContain('字符串原因')
    expect(line).toContain('kind=note')
  })

  it('没有上下文时不出现空括号', () => {
    const line = quietFailure('全文检索', new Error('no such table'))
    expect(line).not.toContain('（）')
    expect(line).toContain('no such table')
  })
})
