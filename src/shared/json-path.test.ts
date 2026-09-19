import { describe, expect, it } from 'vitest'
import { getByPath } from './json-path'

describe('JSON 路径取值', () => {
  const data = {
    id: 1,
    data: { rows: [{ attributes: { name: 'A', tags: ['x', 'y'] } }, { attributes: { name: 'B' } }] },
    list: [1, 2, 3],
  }

  it('空路径 / $ 返回原对象', () => {
    expect(getByPath(data, '')).toBe(data)
    expect(getByPath(data, '$')).toBe(data)
    expect(getByPath(data, '.')).toBe(data)
  })

  it('点号与方括号都能走', () => {
    expect(getByPath(data, 'id')).toBe(1)
    expect(getByPath(data, 'data.rows[0].attributes.name')).toBe('A')
    expect(getByPath(data, 'data.rows[1].attributes.name')).toBe('B')
    expect(getByPath(data, 'data.rows')).toHaveLength(2)
    expect(getByPath(data, 'list[2]')).toBe(3)
    expect(getByPath(data, "data.rows[0].attributes.tags[1]")).toBe('y')
  })

  it('走不通一律返回 undefined，不抛', () => {
    expect(getByPath(data, 'nope.deep')).toBeUndefined()
    expect(getByPath(data, 'id.x')).toBeUndefined()
    expect(getByPath(data, 'list[9]')).toBeUndefined()
    expect(getByPath(null, 'a')).toBeUndefined()
  })
})
