import { describe, expect, it } from 'vitest'
import {
  PRIORITY_NONE_COLOR,
  PRIORITY_SCALE,
  clampPriority,
  isImportant,
  priorityColor,
  priorityLabel,
} from '@shared/priority'

// 8 级优先级用固定色阶（P1 绿 → P8 深红），不随主题派生 —— 契约写死在这里。
describe('优先级', () => {
  it('色阶 9 个元素：下标即档位，[0] 为中性灰、[1] 绿、[8] 深红', () => {
    expect(PRIORITY_SCALE).toHaveLength(9)
    expect(PRIORITY_SCALE[0]).toBe(PRIORITY_NONE_COLOR)
    expect(PRIORITY_SCALE[1].toLowerCase()).toBe('#2e9e5b')
    expect(PRIORITY_SCALE[8].toLowerCase()).toBe('#c81e1e')
  })

  it('越界值钳制到 0..8，小数取整（trunc）', () => {
    expect(clampPriority(-3)).toBe(0)
    expect(clampPriority(99)).toBe(8)
    expect(clampPriority(3.7)).toBe(3)
    expect(clampPriority(Number.NaN)).toBe(0)
  })

  it('标签：0 为「无」，其余 P1..P8', () => {
    expect(priorityLabel(0)).toBe('无')
    expect(priorityLabel(1)).toBe('P1')
    expect(priorityLabel(8)).toBe('P8')
  })

  it('颜色直接按下标取色阶', () => {
    expect(priorityColor(0)).toBe(PRIORITY_NONE_COLOR)
    expect(priorityColor(1)).toBe(PRIORITY_SCALE[1])
    expect(priorityColor(8)).toBe(PRIORITY_SCALE[8])
  })

  it('重要阈值：P5 及以上', () => {
    expect(isImportant(0)).toBe(false)
    expect(isImportant(4)).toBe(false)
    expect(isImportant(5)).toBe(true)
    expect(isImportant(8)).toBe(true)
  })
})
