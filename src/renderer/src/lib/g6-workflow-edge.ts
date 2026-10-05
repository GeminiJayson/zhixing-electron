/**
 * 工作流连线的自定义边类型。
 *
 * ## 为什么必须自定义
 *
 * G6 的 `EdgeStyle`（`BaseEdgeStyleProps`）**没有 `d` / `path` 字段**，内置边只会按
 * 节点**边框/中心**连直线或正交折线。而工作流的出边一律从**端口**走：
 * 条件节点是菱形左右尖角（右 = 满足、左 = 不满足），普通步骤是右边中点。
 * 用内置边，这两条分支线会从同一个点出发、语义直接没了。
 *
 * 覆写点是 `BaseEdge.getKeyPath(attributes): PathArray` —— **它是抽象的，必须实现**。
 * 锚点与路径都复用页面那套（`nodePort` / `branchAnchors` / `directedAnchors` / `orthogonalPath`），
 * 于是线形与旧 SVG 实现一致。
 *
 * ## 一个转换
 *
 * `orthogonalPath` 产出的是 **SVG 的 `d` 字符串**，而 `getKeyPath` 要 **`PathArray`**
 * （`[['M',x,y], ['L',x,y], …]`）。中间加一层解析 —— 只认 `M` / `L`，恰好是
 * `orthogonalPath` 唯一的两种指令。
 */
import { BaseEdge, register, type PathArray } from '@antv/g6'
import { CONDITION_KIND } from '@shared/workflow-condition'
import type { Anchor } from './edge-path'
import { orthogonalPath } from './edge-path'
import { branchAnchors, nodePort } from './workflow-anchors'
import { directedAnchors } from './workflow-layout'
import { NODE_H, NODE_W } from './workflow-node-box'

/** 边的语义类别 —— 对应旧实现的四个 CSS 类（`wf-edge--branch-true` 等）。 */
export type WfEdgeKind = 'seq' | 'branch-true' | 'branch-false' | 'branch-jump' | 'fallback'

/** `#rrggbb` → [r,g,b]；解析不了返回 null。 */
function hexRgb(s: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(s.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** 按比例混两个颜色：`a` 占 `pa`。任一解析不了就回退到 `a`。 */
export function mix(a: string, pa: number, b: string): string {
  const ca = hexRgb(a)
  const cb = hexRgb(b)
  if (!ca || !cb) return a
  const c = ca.map((v, i) => Math.round(v * pa + cb[i] * (1 - pa)))
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
}

/**
 * 读 token。
 *
 * **canvas 不认 `color-mix`** —— 旧实现的 `.wf-edge--branch-true` 用的就是
 * `color-mix(in srgb, var(--success) 62%, var(--graph-edge))`，直接拿来会静默失效
 * （图谱那边 `--bg-canvas` 踩过同一个坑）。所以这里读原色，再由 `mix` 现算。
 */
const tok = (name: string, fallback: string): string => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v && !/color-mix\(|calc\(/.test(v) ? v : fallback
}

/** 语义类别 → 描边与虚线。 */
export function wfEdgeStyle(kind: WfEdgeKind): { stroke: string; lineWidth: number; lineDash: number[] } {
  const edge = tok('--graph-edge', '#8a8a8a')
  switch (kind) {
    case 'branch-true':
      return { stroke: mix(tok('--success', '#16a34a'), 0.62, edge), lineWidth: 1.2, lineDash: [5, 4] }
    case 'branch-false':
      return { stroke: mix(tok('--danger', '#dc2626'), 0.58, edge), lineWidth: 1.2, lineDash: [5, 4] }
    case 'branch-jump':
      return { stroke: edge, lineWidth: 1.2, lineDash: [5, 4] }
    case 'fallback':
      return { stroke: edge, lineWidth: 1.2, lineDash: [2, 4] }
    default:
      return { stroke: edge, lineWidth: 1.2, lineDash: [] }
  }
}

/** SVG `d` 字符串 → PathArray（只认 M / L，恰好是 orthogonalPath 的全部指令）。 */
export function svgPathToArray(d: string): PathArray {
  const out: unknown[] = []
  for (const seg of d.split(/(?=[ML])/)) {
    const m = /^([ML])\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/.exec(seg.trim())
    if (m) out.push([m[1], Number(m[2]), Number(m[3])])
  }
  return out as PathArray
}

/** 节点中心 → 盒左上角（锚点函数用的是盒坐标）。 */
const toBox = (c: { x: number; y: number }): { x: number; y: number } => ({
  x: c.x - NODE_W / 2,
  y: c.y - NODE_H / 2,
})

class WorkflowEdge extends BaseEdge {
  /**
   * 从**端口**出发的正交折线。
   *
   * 边的类别与槽位走 style 上的自定义键（`wfKind` / `wfSlot` / `wfNodeKind`）——
   * `attributes` 里能拿到它们，但拿不到 `data`，所以由调用方塞进 style。
   */
  protected getKeyPath(attributes: Record<string, unknown>): PathArray {
    try {
      const src = this.sourceNode as unknown as { getCenter(): unknown }
      const dst = this.targetNode as unknown as { getCenter(): unknown }
      const center = (n: { getCenter(): unknown }): { x: number; y: number } | null => {
        const c = n.getCenter() as { x: number; y: number } | [number, number]
        if (Array.isArray(c)) return { x: c[0], y: c[1] }
        return c && typeof c.x === 'number' ? c : null
      }
      const sc = center(src)
      const dc = center(dst)
      if (sc && dc) {
        const a = toBox(sc)
        const b = toBox(dc)
        const nodeKind = attributes.wfNodeKind as string | undefined
        const slot = attributes.wfSlot as 'true' | 'false' | undefined
        let ends: { from: Anchor; to: Anchor }
        if (slot && nodeKind === CONDITION_KIND) {
          ends = branchAnchors({ action_kind: nodeKind } as never, a, slot, b)
        } else if (slot) {
          const anchors = directedAnchors(a, b, NODE_W, NODE_H)
          ends = { from: nodePort({ action_kind: nodeKind ?? '' } as never, a, slot), to: anchors.to }
        } else {
          ends = directedAnchors(a, b, NODE_W, NODE_H)
        }
        return svgPathToArray(orthogonalPath(ends.from, ends.to))
      }
    } catch {
      // 拿不到节点几何就退回直线 —— 线形差一点，但不该让整张图画不出来
    }
    // 注意：getKeyPath 是**抽象方法**，不能通过 super 调（编译不过），只能自己给兜底
    const [sp, tp] = this.getEndpoints(attributes as never) as [number[], number[]]
    return [
      ['M', sp[0], sp[1]],
      ['L', tp[0], tp[1]],
    ] as unknown as PathArray
  }
}

/** 注册成 `type: 'wf-edge'`。重复注册会抛错，所以只注册一次。 */
let registered = false
export function ensureWorkflowEdge(): void {
  if (registered) return
  registered = true
  register('edge', 'wf-edge', WorkflowEdge)
}
