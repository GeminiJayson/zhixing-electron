import { describe, expect, it } from 'vitest'
import {
  CONDITION_KIND,
  CONDITION_SOURCES,
  describeCondition,
  judgePrevResult,
  parseCondition,
  serializeCondition,
} from './workflow-condition'
import type { NodeRunResult } from './types'

/** 造一个节点执行结果（默认成功、退出码 0）。 */
const run = (patch: Partial<NodeRunResult> = {}): NodeRunResult => ({
  nodeId: 1,
  kind: 'command',
  state: 'ok',
  code: 0,
  output: '',
  message: '命令执行完成（退出码 0）',
  at: '2026-01-01 00:00:00.000000',
  ...patch,
})

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

  it('「上一步结果」可往返，也能描述', () => {
    const cfg = { kind: 'prev' as const, expectOk: false, expectCode: 3 }
    expect(parseCondition(serializeCondition(cfg))).toEqual(cfg)
    expect(describeCondition(serializeCondition(cfg))).toContain('上一步结果：失败')
    expect(describeCondition(serializeCondition(cfg))).toContain('退出码 = 3')
  })

  it('「上一步结果」的判定：没结果 / 还在跑 / 退出码 / 成功与否', () => {
    // 没有上一步：不成立，且给出原因（而不是静默当失败）
    expect(judgePrevResult({ kind: 'prev' }, null).ok).toBe(false)
    expect(judgePrevResult({ kind: 'prev' }, null).message).toContain('还没有')
    // 运行中：一律不成立 —— 结果没出来之前不该放行
    expect(judgePrevResult({ kind: 'prev' }, run({ state: 'running', code: null })).ok).toBe(false)
    // 只看成功与否（默认期望成功）
    expect(judgePrevResult({ kind: 'prev' }, run()).ok).toBe(true)
    expect(judgePrevResult({ kind: 'prev' }, run({ state: 'failed', code: 1 })).ok).toBe(false)
    expect(judgePrevResult({ kind: 'prev', expectOk: false }, run({ state: 'failed', code: 1 })).ok).toBe(
      true
    )
    // 填了退出码就按退出码判，成功与否让位（优先级只此一处）
    expect(judgePrevResult({ kind: 'prev', expectCode: 2 }, run({ state: 'failed', code: 2 })).ok).toBe(
      true
    )
    expect(judgePrevResult({ kind: 'prev', expectCode: 2 }, run({ code: 0 })).ok).toBe(false)
    // 超时没有退出码：按退出码判时不成立
    expect(judgePrevResult({ kind: 'prev', expectCode: 0 }, run({ state: 'timeout', code: null })).ok).toBe(
      false
    )
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
    expect(CONDITION_SOURCES.map((s) => s.value).sort()).toEqual(['confirm', 'prev', 'script', 'task'])
    for (const s of CONDITION_SOURCES) expect(s.label.length).toBeGreaterThan(0)
  })
})
