/**
 * 工作流连线的**端口与锚点**几何 —— 纯函数，与渲染无关。
 *
 * 从 `WorkflowPage` 搬出来，理由与 `workflow-node-box` 一样：换成 G6 之后画布也要用同一套
 * 锚点规则。**端口位置是业务约定，不是画法** —— 条件节点的左右尖角表达「满足 / 不满足」，
 * 换成别的落点这两条线的语义就没了。
 */
import { CONDITION_KIND } from '@shared/workflow-condition'
import type { WorkflowNodePayload } from '@shared/types'
import type { Anchor, AnchorSide } from './edge-path'
import type { BranchSlot } from '@shared/workflow-branch'
import { directedAnchors } from './workflow-layout'
import { NODE_H, NODE_W } from './workflow-node-box'

/**
 * 一个节点的出线端口 —— 画布上每个节点都能**主动**拉一条线到别的节点，
 * 不必先有连线才谈得上改挂（用户反馈过这一点）。
 *
 * 条件节点：菱形左右两个尖角，右 = 满足、左 = 不满足。选尖角而不是下方，
 *          是为了避开贴在菱形下方的条件内容条（从下缘出线会横穿内容条）。
 * 普通步骤：右边中点一个「跳到」口。放在右边是为了不跟底部的顺序出边打架。
 */
export function nodePort(
  node: Pick<WorkflowNodePayload, 'action_kind'>,
  a: { x: number; y: number },
  slot: BranchSlot
): { x: number; y: number; side: AnchorSide } {
  if (node.action_kind === CONDITION_KIND && slot === 'false') {
    return { x: a.x, y: a.y + NODE_H / 2, side: 'left' }
  }
  return { x: a.x + NODE_W, y: a.y + NODE_H / 2, side: 'right' }
}

/**
 * 一条分支出边的两端锚点。
 *
 * 出边一律从**端口**走（条件节点是尖角、普通步骤是右边中点），落点仍按相对位置挑边；
 * 两端都带上「这是哪条边」，交给 orthogonalPath 折线 —— 于是首段、末段都垂直于
 * 节点的边，中间的过渡段落在节点之外。
 *
 * 早先为了绕开被跳过的中间节点，硬把落点放到目标**同侧**的边上：那样末段是竖直的
 * 却落在目标的左右边框上，等于**和节点的边重合**了（用户实测就是这样）。
 */
export function branchAnchors(
  from: WorkflowNodePayload,
  a: { x: number; y: number },
  slot: BranchSlot,
  to: { x: number; y: number }
): { from: Anchor; to: Anchor } {
  const anchors = directedAnchors(a, to, NODE_W, NODE_H)
  return { from: nodePort(from, a, slot), to: anchors.to }
}
