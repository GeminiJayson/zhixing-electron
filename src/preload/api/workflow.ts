import { ipcRenderer } from 'electron'
import type { WorkflowInstancePayload, WorkflowRunLogEntry, WorkflowTemplatePayload } from '../../shared/types'
/**
 * workflow 域的渲染进程 API（18 项）。
 *
 * 从 preload/index.ts 拆出来：db 一个对象原有 600 行 / 173 个方法，
 * 找一处调用要先在六百行里翻。index.ts 现在只负责拼装与暴露。
 */
export const workflowApi = {
    workflowTemplate: (id: number): Promise<WorkflowTemplatePayload | null> =>
      ipcRenderer.invoke('db:workflowTemplate', id),
    saveWorkflowTemplate: (tpl: {
      id?: number | null
      name: string
      description?: string
      start_policy?: string
      /** 定时计划（JSON 字符串，空 = 手动；见 shared/workflow-trigger.ts） */
      schedule?: string
      /** 触发条件（JSON 字符串数组，空 = 无外部触发） */
      triggers?: string
      nodes: {
        id?: number | null
        title: string
        detail?: string
        order_index?: number
        note_id?: number | null
        /** SOP 可以绑多条；写出时 note_id 会同步为它的第一条（兼容列） */
        note_ids?: number[]
        action_kind?: string
        action_value?: string
        /** 命令 / 脚本的期望退出码（文本，空 = 0） */
        action_expect?: string
        /** 脚本的运行环境：powershell / cmd / python / node（空 = powershell） */
        action_runtime?: string
        /** 日志规则（JSON 字符串，空 = 只看退出码；见 shared/workflow-log-rules.ts） */
        log_rules?: string
        condition?: string
        /** 条件成立（满足）时跳到的节点 */
        branch_node_id?: number | null
        /** 条件不成立（不满足）时跳到的节点 */
        branch_false_node_id?: number | null
        pos_x?: number | null
        pos_y?: number | null
      }[]
    }): Promise<{ ok: boolean; problems: string[]; templateId?: number }> =>
      ipcRenderer.invoke('db:saveWorkflowTemplate', tpl),
    deleteWorkflowTemplate: (id: number): Promise<number> =>
      ipcRenderer.invoke('db:deleteWorkflowTemplate', id),
    /** 复制模板（名称加「 副本」，节点与分支整体复制，不含坐标） */
    duplicateWorkflowTemplate: (id: number): Promise<WorkflowTemplatePayload | null> =>
      ipcRenderer.invoke('db:duplicateWorkflowTemplate', id),
    /** 一键对齐：按执行顺序重置为纵向网格并保存坐标 */
    autoLayoutWorkflow: (templateId: number, yGap: number): Promise<number> =>
      ipcRenderer.invoke('db:autoLayoutWorkflow', templateId, yGap),
    /** 某任务启动/关联的流程实例 */
    workflowInstancesOfTask: (taskId: number): Promise<WorkflowInstancePayload[]> =>
      ipcRenderer.invoke('db:workflowInstancesOfTask', taskId),
    setWorkflowBranch: (
      id: number,
      branchNodeId: number | null,
      slot: 'true' | 'false' = 'true'
    ): Promise<number> => ipcRenderer.invoke('db:setWorkflowBranch', id, branchNodeId, slot),
    instantiateWorkflow: (
      templateId: number,
      title?: string | null,
      originTaskId?: number | null,
      policy?: string
    ): Promise<WorkflowInstancePayload | null> =>
      ipcRenderer.invoke('db:instantiateWorkflow', templateId, title ?? null, originTaskId ?? null, policy),
    workflowInstances: (status?: string | null): Promise<WorkflowInstancePayload[]> =>
      ipcRenderer.invoke('db:workflowInstances', status ?? null),
    workflowInstance: (id: number): Promise<WorkflowInstancePayload | null> =>
      ipcRenderer.invoke('db:workflowInstance', id),
    /** 实例的执行日志：节点级时间轴（时间、结果、当前状态） */
    workflowRunLog: (instanceId: number): Promise<WorkflowRunLogEntry[]> =>
      ipcRenderer.invoke('db:workflowRunLog', instanceId),
    /** 任务活动流（速览的「活动记录」时间轴）：按时间倒序 */
    completeWorkflowStep: (taskId: number): Promise<boolean> =>
      ipcRenderer.invoke('db:completeWorkflowStep', taskId),
    /** 自动步骤失败后原地重跑（实例停在当前节点时用） */
    retryWorkflowStep: (instanceId: number): Promise<boolean> =>
      ipcRenderer.invoke('db:retryWorkflowStep', instanceId),
    abortWorkflowInstance: (id: number): Promise<boolean> =>
      ipcRenderer.invoke('db:abortWorkflowInstance', id),
    /** 删除实例的运行记录（不删模板，也不删已派生的任务） */
    deleteWorkflowInstance: (id: number): Promise<boolean> =>
      ipcRenderer.invoke('db:deleteWorkflowInstance', id),
    /** 重复运行：按同一模板再启动一个新实例，旧实例记录保留 */
    rerunWorkflowInstance: (id: number): Promise<WorkflowInstancePayload | null> =>
      ipcRenderer.invoke('db:rerunWorkflowInstance', id),
    runWorkflowAction: (
      kind: string,
      value: string,
      expect?: string,
      runtime?: string
    ): Promise<{ ok: boolean; message: string; kind: string; code: number | null; output: string }> =>
      ipcRenderer.invoke('db:runWorkflowAction', kind, value, expect ?? '', runtime ?? ''),
    describeWorkflowAction: (
      kind: string,
      value: string,
      expect?: string,
      runtime?: string
    ): Promise<string> =>
      ipcRenderer.invoke('db:describeWorkflowAction', kind, value, expect, runtime),
    /** reason：手动中断专注时记录的中断原因 */
}
