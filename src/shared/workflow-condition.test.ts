import { describe, expect, it } from 'vitest'
import {
  CONDITION_KIND,
  CONDITION_SOURCES,
  describeCondition,
  parseCondition,
  serializeCondition,
} from './workflow-condition'

describe('条件节点配置 —— 解析必须对坏数据免疫', () => {
  it('kind 固定为 condition（它是 action_kind 上的一个枚举值）', () => {
    expect(CONDITION_KIND).toBe('condition')
  })

  it('往返序列化不丢字段', () => {
    const cfg = { kind: 'script' as const, command: 'check.cmd --fast', expectCode: 2 }
    expect(parseCondition(serializeCondition(cfg))).toEqual(cfg)
  })

  it('空值 / 坏 JSON / 未知 kind 一律返回 null（不抛）', () => {
    expect(parseCondition('')).toBeNull()
    expect(parseCondition(null)).toBeNull()
    expect(parseCondition('{')).toBeNull()
    expect(parseCondition('[]')).toBeNull()
    expect(parseCondition('"confirm"')).toBeNull()
    expect(parseCondition(JSON.stringify({ kind: 'nope' }))).toBeNull()
  })

  it('三种来源都有可读描述，缺参数的也说清楚', () => {
    expect(describeCondition(JSON.stringify({ kind: 'confirm', prompt: '可以吗？' }))).toContain('可以吗？')
    expect(describeCondition(JSON.stringify({ kind: 'task', taskId: 7 }))).toContain('已完成')
    expect(describeCondition(JSON.stringify({ kind: 'task', taskId: 7, expectDone: false }))).toContain('未完成')
    expect(describeCondition(JSON.stringify({ kind: 'script', command: 'a.cmd' }))).toContain('退出码 = 0')
    expect(describeCondition(JSON.stringify({ kind: 'confirm' }))).toContain('未写提示')
    expect(describeCondition('')).toBe('未配置条件')
  })

  it('来源清单与 kind 联合类型一一对应', () => {
    expect(CONDITION_SOURCES.map((s) => s.value).sort()).toEqual(['confirm', 'script', 'task'])
    for (const s of CONDITION_SOURCES) expect(s.label.length).toBeGreaterThan(0)
  })
})
