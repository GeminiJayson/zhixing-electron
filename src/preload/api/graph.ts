import { ipcRenderer } from 'electron'
import type { GraphDelta, GraphNodePayload, GraphPayload, GraphQuery, WorkflowTemplateSummary } from '../../shared/types'
/**
 * graph 域的渲染进程 API（12 项）。
 *
 * 从 preload/index.ts 拆出来：db 一个对象原有 600 行 / 173 个方法，
 * 找一处调用要先在六百行里翻。index.ts 现在只负责拼装与暴露。
 */
export const graphApi = {
    graphConnectionAllowed: (srcKind: string, dstKind: string): Promise<string | null> =>
      ipcRenderer.invoke('db:graphConnectionAllowed', srcKind, dstKind),
    connectGraphNodes: (
      srcKind: string,
      srcRef: number,
      dstKind: string,
      dstRef: number,
      edgeKind: 'ownership' | 'reference'
    ): Promise<boolean> =>
      ipcRenderer.invoke('db:connectGraphNodes', srcKind, srcRef, dstKind, dstRef, edgeKind),
    /** 删除一条连线：按「边类 + 端点类型」分派到真数据操作 */
    removeGraphEdge: (
      srcKind: string,
      srcRef: number,
      dstKind: string,
      dstRef: number,
      edgeKind: 'ownership' | 'reference'
    ): Promise<boolean> =>
      ipcRenderer.invoke('db:removeGraphEdge', srcKind, srcRef, dstKind, dstRef, edgeKind),
    /** 改挂连线的一端：先建新关系、成功后再删旧关系 */
    rewireGraphEdge: (params: {
      keepKind: string
      keepRef: number
      fromKind: string
      fromRef: number
      toKind: string
      toRef: number
      edgeKind: 'ownership' | 'reference'
    }): Promise<boolean> => ipcRenderer.invoke('db:rewireGraphEdge', params),
    /** 自动备份列表（数据目录 backups/，最新在前） */
    graph: (query?: GraphQuery): Promise<GraphPayload> =>
      ipcRenderer.invoke('db:graph', query ?? {}),
    /** 笔记邻域子图：仅沿 note_link 做 1~2 度 BFS */
    graphNeighborhood: (noteId: number, degree = 1): Promise<GraphPayload> =>
      ipcRenderer.invoke('db:graphNeighborhood', noteId, degree),
    /** 选中节点预览文本 */
    graphPreview: (node: GraphNodePayload): Promise<string> =>
      ipcRenderer.invoke('db:graphPreview', node),
    /** 图页开关图谱增量推送；返回后主进程才会在图谱相关写入时推 graph:delta */
    graphWatch: (active: boolean): Promise<boolean> =>
      ipcRenderer.invoke('db:graphWatch', active),
    /** 图页双击跨页跳转：经深链通道交给 App 的路由分支 */
    graphOpenNode: (kind: string, id: number): Promise<boolean> =>
      ipcRenderer.invoke('db:graphOpenNode', kind, id),
    /** 图谱增量：消费端按节点/边定点增删、保留坐标与 pinned */
    onGraphDelta: (cb: (delta: GraphDelta) => void): (() => void) => {
      const handler = (_e: unknown, delta: GraphDelta): void => cb(delta)
      ipcRenderer.on('graph:delta', handler)
      return () => ipcRenderer.removeListener('graph:delta', handler)
    },
    /** 模板分类 */
  workflowGroups: (): Promise<{ id: number; parent_id: number | null; name: string; sort_key: string }[]> =>
    ipcRenderer.invoke('db:workflowGroups'),
  workflowTemplateGroups: (): Promise<{ id: number; group_id: number | null }[]> =>
    ipcRenderer.invoke('db:workflowTemplateGroups'),
  saveWorkflowGroup: (input: {
    id?: number
    name: string
    parentId?: number | null
  }): Promise<{ ok: boolean; id?: number; problems: string[] }> =>
    ipcRenderer.invoke('db:saveWorkflowGroup', input),
  deleteWorkflowGroup: (id: number): Promise<boolean> => ipcRenderer.invoke('db:deleteWorkflowGroup', id),
  moveWorkflowTemplate: (id: number, groupId: number | null): Promise<boolean> =>
    ipcRenderer.invoke('db:moveWorkflowTemplate', id, groupId),
  renameWorkflowInstance: (id: number, title: string): Promise<boolean> =>
    ipcRenderer.invoke('db:renameWorkflowInstance', id, title),
  workflowTemplates: (): Promise<WorkflowTemplateSummary[]> =>
      ipcRenderer.invoke('db:workflowTemplates'),
    updateWorkflowNodePos: (id: number, x: number, y: number): Promise<number> =>
      ipcRenderer.invoke('db:updateWorkflowNodePos', id, x, y),
    /**
     * 设置 / 清除条件节点某条分支的目标（分支连线编辑用）。
     * slot：'true' = 满足（默认）/'false' = 不满足。
     */
    batchUpdateNodePos: (items: { id: number; x: number; y: number }[]): Promise<number> =>
      ipcRenderer.invoke('db:batchUpdateNodePos', items),
    /** 清空三类回收站（一个事务） */
}
