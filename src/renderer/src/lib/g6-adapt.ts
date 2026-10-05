/**
 * 数据适配：把仓库自己的图谱数据翻译成 G6 的 `nodes` / `edges`。
 *
 * **这一层只做形状转换，不做业务判断。** 「哪些边能连」「归属还是引用」
 * 这类规则仍由主进程与 `shared` 说了算 —— 见 docs/specs/g6-migration.md 的保留清单。
 *
 * 数据形状（`shared/types.ts`）：
 *   GraphPayload { nodes: GraphNodePayload[], edges: [number, number][], edgeKinds, cycleEdges }
 *   GraphNodePayload { id, label, kind, size, degree, colorHint, refId, format, subKind?, unverified? }
 */
import type { GraphNodePayload, GraphPayload } from '@shared/types'

/** 边类别：归属（实线）/ 引用（虚线）。与 `GraphPayload.edgeKinds` 的取值一致。 */
export type GraphEdgeKind = 'ownership' | 'reference'

/** G6 节点上的自定义数据（透传原始 payload，交互回调里要用）。 */
export interface G6NodeData extends Record<string, unknown> {
  payload: GraphNodePayload
  label: string
  kind: GraphNodePayload['kind']
}

/** G6 边上的自定义数据。 */
export interface G6EdgeData extends Record<string, unknown> {
  kind: GraphEdgeKind
}

/** G6 的 NodeData / EdgeData 带字符串索引签名，适配产物要跟它对齐。 */
export interface G6Node extends Record<string, unknown> {
  id: string
  data: G6NodeData
}

export interface G6Edge extends Record<string, unknown> {
  id: string
  source: string
  target: string
  data: G6EdgeData
}

export interface G6GraphData {
  nodes: G6Node[]
  edges: G6Edge[]
}

/** 边的稳定键 —— 与主进程 `edgeKinds` 的键格式一致（"src,dst"）。 */
export const edgeKey = (source: number, target: number): string => source + ',' + target

/** 节点 id 统一成字符串：G6 内部按字符串处理，混用数字会匹配不上边。 */
export const nodeId = (id: number): string => String(id)

/**
 * `GraphPayload` → G6 data。
 *
 * `edgeKinds` 里查不到类别的边退化为 `reference` —— 宁可画成弱的虚线，
 * 也不要因为缺类别而消失（消失比画错更难发现）。
 */
export function toG6Data(payload: GraphPayload): G6GraphData {
  const known = new Set(payload.nodes.map((n) => nodeId(n.id)))

  const nodes: G6Node[] = payload.nodes.map((n) => ({
    id: nodeId(n.id),
    data: { payload: n, label: n.label, kind: n.kind },
  }))

  const edges: G6Edge[] = []
  const seen = new Set<string>()
  for (const [source, target] of payload.edges) {
    // 断头边会让 G6 直接抛错，先滤掉（真实缺陷：删除笔记后曾留下过）
    if (!known.has(nodeId(source)) || !known.has(nodeId(target))) continue
    const key = edgeKey(source, target)
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({
      id: key,
      source: nodeId(source),
      target: nodeId(target),
      data: { kind: payload.edgeKinds[key] ?? 'reference' },
    })
  }

  return { nodes, edges }
}
