import { describe, expect, it } from 'vitest'
import {
  CONDITION_KIND,
  CONDITION_SOURCES,
  describeCondition,
  judgePrevLog,
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
    expect(CONDITION_SOURCES.map((s) => s.value).sort()).toEqual([
      'confirm',
      'prev',
      'prevLog',
      'script',
      'task',
    ])
    for (const s of CONDITION_SOURCES) expect(s.label.length).toBeGreaterThan(0)
  })
})

/**
 * 上一步日志（prevLog）：拿日志当关卡。
 *
 * 日志本身不另存 —— 它就在上一步的 NodeRunResult.output 里（截尾保存的那份），
 * 再存一份只会带来"两份日志不一致"的新问题。
 */
describe('条件 · 上一步日志', () => {
  const last = (over: Partial<NodeRunResult> = {}): NodeRunResult => ({
    nodeId: 1,
    kind: 'command',
    state: 'ok',
    code: 0,
    output: '',
    message: '',
    at: '2026-01-01 00:00:00',
    ...over,
  })

  it('包含关键字即成立（不区分大小写）', () => {
    const r = judgePrevLog({ kind: 'prevLog', pattern: 'build success' }, last({ output: 'BUILD SUCCESS!' }))
    expect(r.ok).toBe(true)
    expect(r.message).toContain('命中')
  })

  it('不包含时不成立，并说明期望', () => {
    const r = judgePrevLog({ kind: 'prevLog', pattern: 'ERROR' }, last({ output: 'all good' }))
    expect(r.ok).toBe(false)
    expect(r.message).toContain('未命中')
    expect(r.message).toContain('期望命中')
  })

  it('expectHit=false 时反过来：不出现才算成立', () => {
    expect(
      judgePrevLog({ kind: 'prevLog', pattern: 'ERROR', expectHit: false }, last({ output: 'ok' })).ok
    ).toBe(true)
    expect(
      judgePrevLog({ kind: 'prevLog', pattern: 'ERROR', expectHit: false }, last({ output: 'ERROR!' })).ok
    ).toBe(false)
  })

  it('regex 模式按正则匹配', () => {
    const cfg = { kind: 'prevLog' as const, pattern: 'code=\\d+', matchMode: 'regex' as const }
    expect(judgePrevLog(cfg, last({ output: 'exit code=42!' })).ok).toBe(true)
    expect(judgePrevLog(cfg, last({ output: 'exit code=none' })).ok).toBe(false)
  })

  it('正则写坏时说清楚，而不是含糊判否', () => {
    const r = judgePrevLog({ kind: 'prevLog', pattern: '([', matchMode: 'regex' }, last({ output: 'x' }))
    expect(r.ok).toBe(false)
    expect(r.message).toContain('不是合法的正则')
  })

  it('上一步没有日志（人工任务）时明确提示', () => {
    const r = judgePrevLog({ kind: 'prevLog', pattern: 'x' }, last({ output: '', kind: 'task' }))
    expect(r.ok).toBe(false)
    expect(r.message).toContain('没有留下日志')
  })

  it('还没跑完 / 没有结果时都不成立', () => {
    expect(judgePrevLog({ kind: 'prevLog', pattern: 'x' }, last({ state: 'running' })).message).toContain(
      '还在运行中'
    )
    expect(judgePrevLog({ kind: 'prevLog', pattern: 'x' }, null).message).toContain('还没有可用')
  })

  it('没写关键字时提示配置缺失', () => {
    expect(judgePrevLog({ kind: 'prevLog', pattern: '  ' }, last({ output: 'x' })).message).toContain(
      '没有配置'
    )
  })

  it('往返一致（parse 认得这个来源）', () => {
    const cfg = { kind: 'prevLog' as const, pattern: 'DONE', matchMode: 'contains' as const, expectHit: true }
    expect(parseCondition(serializeCondition(cfg))).toEqual(cfg)
  })

  it('描述里带关键字与口径', () => {
    const d = describeCondition(serializeCondition({ kind: 'prevLog', pattern: 'DONE', matchMode: 'regex' }))
    expect(d).toContain('DONE')
    expect(d).toContain('正则')
    expect(d).toContain('包含')
  })

  it('未知来源仍然解析失败（不会把脏数据当条件用）', () => {
    expect(parseCondition(JSON.stringify({ kind: 'nope' }))).toBeNull()
  })
})
