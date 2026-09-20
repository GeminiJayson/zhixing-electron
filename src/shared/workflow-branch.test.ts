import { describe, expect, it } from 'vitest'
import {
  BRANCH_FIELD,
  BRANCH_SLOTS,
  branchSlotLabel,
  branchTarget,
  findBranchCycle,
  nextNodeOf,
  withBranchTarget,
  type BranchNode,
} from './workflow-branch'

/** 造一个只带出边的最小节点。 */
const n = (id: number, t: number | null = null, f: number | null = null): BranchNode => ({
  id,
  branch_node_id: t,
  branch_false_node_id: f,
})

describe('条件节点的两条出边', () => {
  it('槽位与列名一一对应，且都有界面文案', () => {
    expect(BRANCH_FIELD).toEqual({ true: 'branch_node_id', false: 'branch_false_node_id' })
    expect(BRANCH_SLOTS.map((s) => s.value)).toEqual(['true', 'false'])
    expect(branchSlotLabel('true')).toBe('满足')
    expect(branchSlotLabel('false')).toBe('不满足')
  })

  it('读槽位：没配就是 null', () => {
    expect(branchTarget(n(1, 2, 3), 'true')).toBe(2)
    expect(branchTarget(n(1, 2, 3), 'false')).toBe(3)
    expect(branchTarget(n(1), 'true')).toBeNull()
    expect(branchTarget(n(1), 'false')).toBeNull()
  })

  it('改槽位是不可变的，只动那一条边', () => {
    const before = n(1, 2, 3)
    const after = withBranchTarget(before, 'false', 9)
    expect(after).toEqual({ id: 1, branch_node_id: 2, branch_false_node_id: 9 })
    expect(before.branch_false_node_id).toBe(3)
    expect(withBranchTarget(before, 'true', null).branch_node_id).toBeNull()
  })
})

describe('nextNodeOf —— 求值后往哪走', () => {
  const ordered = [n(1, 3, 2), n(2), n(3)]

  it('条件成立走「满足」边，不成立走「不满足」边', () => {
    expect(nextNodeOf(ordered, ordered[0], true)?.id).toBe(3)
    expect(nextNodeOf(ordered, ordered[0], false)?.id).toBe(2)
  })

  it('那条边没配 / 目标不存在时按 order_index 走下一个（历史行为不变）', () => {
    expect(nextNodeOf(ordered, n(2), false)?.id).toBe(3)
    // 指向已删除的节点：当作没配，退回顺序下一个
    expect(nextNodeOf(ordered, n(2, 99), true)?.id).toBe(3)
  })

  it('最后一步没有下一个节点', () => {
    expect(nextNodeOf(ordered, ordered[2], true)).toBeNull()
  })

  it('自环不参与「出边优先」，仍旧走顺序下一个', () => {
    expect(nextNodeOf(ordered, n(2, 2), true)?.id).toBe(3)
  })
})

describe('findBranchCycle —— 两条出边一起判环', () => {
  it('无环返回 null', () => {
    expect(findBranchCycle([n(1, 2, 3), n(2), n(3)])).toBeNull()
  })

  it('单条边成环能查到', () => {
    expect(findBranchCycle([n(1, 2), n(2, 3), n(3, 1)])).toBe(1)
  })

  it('只有「不满足」边成环也要查到（旧实现只看一条边会漏）', () => {
    expect(findBranchCycle([n(1, null, 2), n(2, null, 1)])).toBe(1)
  })

  it('两条边合作成环：1 满足→2、2 不满足→1', () => {
    expect(findBranchCycle([n(1, 2, null), n(2, null, 1)])).toBe(1)
  })

  it('自环不算环（字段校验里另有更准确的说法，避免重复报错）', () => {
    expect(findBranchCycle([n(1, 1, 1)])).toBeNull()
  })
})
