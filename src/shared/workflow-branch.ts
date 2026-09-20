/**
 * 条件节点的两条出边（满足 / 不满足）—— 主进程推进与渲染层画布共用同一份定义。
 *
 * 落点是 workflow_node 上的两个可空引用：
 *   branch_node_id        条件**成立**（满足）时跳到的节点
 *   branch_false_node_id  条件**不成立**（不满足）时跳到的节点
 *
 * 两者都可为空：空的语义与历史一致 —— 条件节点只是个「关卡」，那条边没配
 * 就继续按 order_index 走下一个节点。于是「只画一条边」的旧模板行为完全不变，
 * 想要两条明确分支的模板则各指各的。
 *
 * 为什么放在 shared：它是纯图论（谁连到谁），与 Electron / SQLite 无关，
 * 可以脱离两端单测；而推进逻辑与画布又必须用同一套定义，否则画出来的分支
 * 与真正跑的路径会不一致。
 */
/** 分支槽位：true = 条件成立（满足），false = 条件不成立（不满足）。 */
export type BranchSlot = 'true' | 'false'

/** 槽位 ↔ 列名。读写两侧共用，避免各处手抄列名写错。 */
export const BRANCH_FIELD: Record<BranchSlot, 'branch_node_id' | 'branch_false_node_id'> = {
  true: 'branch_node_id',
  false: 'branch_false_node_id',
}

/** 槽位的界面文案（画布标签、编辑弹窗共用）。 */
export const BRANCH_SLOTS: { value: BranchSlot; label: string; hint: string }[] = [
  { value: 'true', label: '满足', hint: '条件成立时走这条分支' },
  { value: 'false', label: '不满足', hint: '条件不成立时走这条分支' },
]

export function branchSlotLabel(slot: BranchSlot): string {
  return BRANCH_SLOTS.find((s) => s.value === slot)?.label ?? slot
}

/** 判环 / 找下一个节点只需要这两个出边字段（WorkflowNodePayload 结构上兼容）。 */
export interface BranchNode {
  id: number
  branch_node_id: number | null
  branch_false_node_id?: number | null
}

/** 读某个槽位的目标（空 = 没配这条边）。 */
export function branchTarget(node: BranchNode, slot: BranchSlot): number | null {
  return (slot === 'true' ? node.branch_node_id : node.branch_false_node_id) ?? null
}

/** 不可变地改一个槽位（渲染层在内存里拼草稿、主进程重映射引用时用）。 */
export function withBranchTarget<T extends BranchNode>(
  node: T,
  slot: BranchSlot,
  target: number | null
): T {
  return slot === 'true'
    ? { ...node, branch_node_id: target }
    : { ...node, branch_false_node_id: target }
}

/**
 * 一个节点的下一个节点。
 * 条件节点按 ok 选槽（成立走「满足」、不成立走「不满足」）；
 * 普通节点只有 branch_node_id 这一条历史分支概念，ok 保持默认的 true。
 * 该槽位没配目标、或目标已不存在时按 order_index 走下一个 —— 与历史行为一致。
 */
export function nextNodeOf<T extends BranchNode>(
  ordered: readonly T[],
  node: T,
  ok = true
): T | null {
  const target = branchTarget(node, ok ? 'true' : 'false')
  if (target != null && target !== node.id) {
    const hit = ordered.find((n) => n.id === target)
    if (hit) return hit
  }
  const idx = ordered.findIndex((n) => n.id === node.id)
  return idx >= 0 ? ordered[idx + 1] ?? null : null
}

/**
 * 沿两条出边走，找第一个能绕回自己的节点（返回它的 id；无环返回 null）。
 *
 * 只走 branch 边、不掺顺序边：顺序边严格递增，天然无环，掺进来只会把
 * 「顺序走到末尾」误判成环。自环（边指向自己）不算在这里 —— 它在字段校验里
 * 有更准确的说法，两边都报会变成重复提示。
 */
export function findBranchCycle(nodes: readonly BranchNode[]): number | null {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const targets = (n: BranchNode): number[] => {
    const out: number[] = []
    if (n.branch_node_id != null && n.branch_node_id !== n.id) out.push(n.branch_node_id)
    if (n.branch_false_node_id != null && n.branch_false_node_id !== n.id) {
      out.push(n.branch_false_node_id)
    }
    return out
  }
  for (const start of nodes) {
    const stack = [...targets(start)]
    const seen = new Set<number>()
    while (stack.length) {
      const id = stack.pop() as number
      if (id === start.id) return start.id
      if (seen.has(id)) continue
      seen.add(id)
      const hit = byId.get(id)
      if (hit) stack.push(...targets(hit))
    }
  }
  return null
}
