import { contextBridge, ipcRenderer } from 'electron'
import type { DeepLink } from '../shared/deep-link'
import type { AiLibraryOutcome, AiLibraryProgress, AiOrganizeOutcome } from '../shared/ai-note'
import type {
  AppInfo,
  Backlink,
  Flash,
  GraphDelta,
  GraphNodePayload,
  GraphPayload,
  GraphQuery,
  Note,
  NoteFolder,
  NoteLink,
  NoteRevision,
  Overview,
  ReviewStats,
  Task,
  TaskNoteContext,
  TodayTasks,
  TaskStatus,
  WorkflowInstancePayload,
  WorkflowTemplatePayload,
  WorkflowTemplateSummary,
} from '../shared/types'

/** 渲染进程唯一的特权入口：只暴露显式列出的调用，不透传 ipcRenderer。 */
const api = {
  /** 渲染进程判断 macOS 红绿灯让位等平台差异用，避免靠 UA 嗅探。 */
  platform: process.platform as 'darwin' | 'win32' | 'linux',
  db: {
    /** ready=库已打开；readonly 非空=迁移失败进入只读模式（显示横幅）；error=完全打不开的原因 */
    info: (): Promise<{ path: string; ready: boolean; readonly: string; error: string }> =>
      ipcRenderer.invoke('db:info'),
    overview: (): Promise<Overview> => ipcRenderer.invoke('db:overview'),
    tasks: (limit?: number): Promise<Task[]> => ipcRenderer.invoke('db:tasks', limit),
    todayTasks: (): Promise<TodayTasks> => ipcRenderer.invoke('db:todayTasks'),
    recentNotes: (limit?: number): Promise<Note[]> => ipcRenderer.invoke('db:recentNotes', limit),
    notes: (limit?: number): Promise<Note[]> => ipcRenderer.invoke('db:notes', limit),
    flashes: (status: string | null = 'inbox'): Promise<Flash[]> =>
      ipcRenderer.invoke('db:flashes', status),
    inboxTasks: (): Promise<Task[]> => ipcRenderer.invoke('db:inboxTasks'),
    addFlash: (
      content: string,
      remark?: string,
      sourceApp?: string,
      sourceUrl?: string
    ): Promise<Flash | null> =>
      ipcRenderer.invoke('db:addFlash', content, remark ?? '', sourceApp ?? '', sourceUrl ?? ''),
    updateFlashRemark: (id: number, remark: string): Promise<Flash | null> =>
      ipcRenderer.invoke('db:updateFlashRemark', id, remark),
    tagFlash: (id: number, tags: string[]): Promise<number> =>
      ipcRenderer.invoke('db:tagFlash', id, tags),
    mergeFlashes: (ids: number[]): Promise<number | null> =>
      ipcRenderer.invoke('db:mergeFlashes', ids),
    flashToSubtask: (id: number, parentTaskId: number): Promise<number | null> =>
      ipcRenderer.invoke('db:flashToSubtask', id, parentTaskId),
    archiveFlash: (id: number): Promise<Flash | null> => ipcRenderer.invoke('db:archiveFlash', id),
    unarchiveFlash: (id: number): Promise<Flash | null> => ipcRenderer.invoke('db:unarchiveFlash', id),
    deleteFlash: (id: number): Promise<number> => ipcRenderer.invoke('db:deleteFlash', id),
    flashToTask: (id: number): Promise<number | null> => ipcRenderer.invoke('db:flashToTask', id),
    flashToNote: (id: number, folderId?: number | null): Promise<number | null> =>
      ipcRenderer.invoke('db:flashToNote', id, folderId ?? null),
    noteCounts: (): Promise<{ task_id: number; c: number }[]> => ipcRenderer.invoke('db:noteCounts'),
    taskTags: (): Promise<{ task_id: number; id: number; name: string; color: string }[]> =>
      ipcRenderer.invoke('db:taskTags'),
    toggleTask: (id: number): Promise<Task | null> => ipcRenderer.invoke('db:toggleTask', id),
    setPriority: (id: number, priority: number): Promise<Task | null> =>
      ipcRenderer.invoke('db:setPriority', id, priority),
    setTitle: (id: number, title: string): Promise<Task | null> =>
      ipcRenderer.invoke('db:setTitle', id, title),
    setStatus: (id: number, status: TaskStatus): Promise<Task | null> =>
      ipcRenderer.invoke('db:setStatus', id, status),
    setDueDate: (id: number, due: string | null): Promise<Task | null> =>
      ipcRenderer.invoke('db:setDueDate', id, due),
    createTask: (
      title: string,
      parentId?: number | null,
      listId?: number | null
    ): Promise<Task | null> => ipcRenderer.invoke('db:createTask', title, parentId ?? null, listId ?? null),
    settings: (): Promise<Record<string, string>> => ipcRenderer.invoke('db:settings'),
    setSetting: (key: string, value: string): Promise<number> =>
      ipcRenderer.invoke('db:setSetting', key, value),
    setSettings: (entries: Record<string, string>): Promise<number> =>
      ipcRenderer.invoke('db:setSettings', entries),
    backupDatabase: (dir: string): Promise<{ path: string; bytes: number } | null> =>
      ipcRenderer.invoke('db:backupDatabase', dir),
    listFolders: (): Promise<unknown[]> => ipcRenderer.invoke('db:listFolders'),
  /** 用系统默认应用打开本地文件；Word / Excel 笔记的正文就是这个文件 */
  openPath: (target: string): Promise<string> => ipcRenderer.invoke('shell:openPath', target),
  /** 保存的查询（智能清单）：存的是「名称 + 表达式」，求值在渲染层 */
  savedQueries: (): Promise<{ id: number; name: string; kind: string; expr: string }[]> =>
    ipcRenderer.invoke('db:savedQueries'),
  saveSavedQuery: (input: { id?: number; name: string; kind?: string; expr: string }): Promise<{
    ok: boolean
    id?: number
    problems: string[]
  }> => ipcRenderer.invoke('db:saveSavedQuery', input),
  deleteSavedQuery: (id: number): Promise<boolean> => ipcRenderer.invoke('db:deleteSavedQuery', id),
  /** 附件：列表 / 统计 / 导入 / 删除 / 清理 */
  attachments: (): Promise<
    { id: number; note_id: number; note_title: string; path: string; kind: string; size: number; missing: boolean }[]
  > => ipcRenderer.invoke('db:attachments'),
    /** 把一段二进制（base64）存成本笔记的附件，返回落盘路径 */
    saveAttachmentData: (
      noteId: number,
      fileName: string,
      base64: string
    ): Promise<{ ok: boolean; path?: string; message: string }> =>
      ipcRenderer.invoke('attachment:saveData', noteId, fileName, base64),
    /** 多图上传：一次 IPC 存一批，逐张回结果（替代渲染层的 for + saveAttachmentData） */
    saveAttachmentsBatch: (
      noteId: number,
      files: { fileName: string; base64: string }[]
    ): Promise<{ fileName: string; ok: boolean; path?: string; message: string }[]> =>
      ipcRenderer.invoke('attachment:saveDataBatch', noteId, files),
  attachmentStats: (): Promise<{ count: number; bytes: number; missing: number; dir: string }> =>
    ipcRenderer.invoke('db:attachmentStats'),
  importAttachment: (noteId: number, srcPath: string): Promise<{ ok: boolean; path?: string; message: string }> =>
    ipcRenderer.invoke('db:importAttachment', noteId, srcPath),
  deleteAttachment: (id: number): Promise<boolean> => ipcRenderer.invoke('db:deleteAttachment', id),
  pruneAttachments: (): Promise<{ removedRows: number; removedFiles: number }> =>
    ipcRenderer.invoke('db:pruneAttachments'),
  /** 弹系统文件选择框并归档到指定笔记，返回归档后的路径 */
  pickAttachment: (noteId: number): Promise<{ ok: boolean; message: string; paths: string[] }> =>
    ipcRenderer.invoke('attachment:pick', noteId),
    tasksByList: (listId: number | null): Promise<unknown[]> =>
      ipcRenderer.invoke('db:tasksByList', listId),
    createListFolder: (
      name: string,
      kind: 'group' | 'list',
      parentId: number | null
    ): Promise<unknown> => ipcRenderer.invoke('db:createListFolder', name, kind, parentId),
    renameListFolder: (id: number, name: string): Promise<number> =>
      ipcRenderer.invoke('db:renameListFolder', id, name),
    deleteListFolder: (id: number): Promise<number> => ipcRenderer.invoke('db:deleteListFolder', id),
    moveTaskToList: (taskId: number, listId: number | null): Promise<number> =>
      ipcRenderer.invoke('db:moveTaskToList', taskId, listId),
    attachTaskNote: (taskId: number, noteId: number): Promise<number> =>
      ipcRenderer.invoke('db:attachTaskNote', taskId, noteId),
    detachTaskNote: (taskId: number, noteId: number): Promise<number> =>
      ipcRenderer.invoke('db:detachTaskNote', taskId, noteId),
    linkedNotes: (taskId: number): Promise<unknown[]> => ipcRenderer.invoke('db:linkedNotes', taskId),
    /** 命令面板统一搜索（前缀 + 过滤语法 + 命令注入 + MRU，与 Python 的 global_search 对齐） */
    globalSearch: (q: string): Promise<unknown> => ipcRenderer.invoke('db:globalSearch', q),
    /** 记一次命中（MRU）：命令面板选中 task/note/flash 条目时调用 */
    searchTouch: (kind: string, id: number): Promise<boolean> =>
      ipcRenderer.invoke('db:searchTouch', kind, id),
    /** 拖拽连线是否允许（返回 'ownership' | 'reference' | 'either' | null） */
    graphConnectionAllowed: (srcKind: string, dstKind: string): Promise<string | null> =>
      ipcRenderer.invoke('db:graphConnectionAllowed', srcKind, dstKind),
    linkNotes: (srcId: number, dstId: number): Promise<boolean> =>
      ipcRenderer.invoke('db:linkNotes', srcId, dstId),
    linkTaskNoteRef: (taskId: number, noteId: number): Promise<boolean> =>
      ipcRenderer.invoke('db:linkTaskNoteRef', taskId, noteId),
    unlinkTaskNoteRef: (taskId: number, noteId: number): Promise<boolean> =>
      ipcRenderer.invoke('db:unlinkTaskNoteRef', taskId, noteId),
    /** 解除笔记↔笔记引用（linkNotes 是双向写的，这里对称删两侧） */
    unlinkNotes: (srcId: number, dstId: number): Promise<boolean> =>
      ipcRenderer.invoke('db:unlinkNotes', srcId, dstId),
    /** 按端点类型 + 边类建立连接（图谱连线逻辑下沉到主进程） */
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
    listBackups: (): Promise<{ name: string; path: string; bytes: number; mtime: number }[]> =>
      ipcRenderer.invoke('db:listBackups'),
    /** 用某个备份覆盖当前库（会先自动备份当前库） */
    restoreBackup: (file: string): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('db:restoreBackup', file),
    reviewStats: (): Promise<ReviewStats> => ipcRenderer.invoke('db:reviewStats'),
    /** 图谱构建：includeTasks / 文件夹 / 标签（G7，默认纳入任务节点） */
    graph: (query?: GraphQuery): Promise<GraphPayload> =>
      ipcRenderer.invoke('db:graph', query ?? {}),
    /** 笔记邻域子图：仅沿 note_link 做 1~2 度 BFS（G8） */
    graphNeighborhood: (noteId: number, degree = 1): Promise<GraphPayload> =>
      ipcRenderer.invoke('db:graphNeighborhood', noteId, degree),
    /** 选中节点预览文本（G9） */
    graphPreview: (node: GraphNodePayload): Promise<string> =>
      ipcRenderer.invoke('db:graphPreview', node),
    /** 图页开关图谱增量推送（G5）；返回后主进程才会在图谱相关写入时推 graph:delta */
    graphWatch: (active: boolean): Promise<boolean> =>
      ipcRenderer.invoke('db:graphWatch', active),
    /** 图页双击跨页跳转（G10）：经深链通道交给 App 的路由分支 */
    graphOpenNode: (kind: string, id: number): Promise<boolean> =>
      ipcRenderer.invoke('db:graphOpenNode', kind, id),
    /** 图谱增量（G5/G6）：消费端按节点/边定点增删、保留坐标与 pinned */
    onGraphDelta: (cb: (delta: GraphDelta) => void): (() => void) => {
      const handler = (_e: unknown, delta: GraphDelta): void => cb(delta)
      ipcRenderer.on('graph:delta', handler)
      return () => ipcRenderer.removeListener('graph:delta', handler)
    },
    /** 模板分类（对齐笔记树的「文件夹 → 笔记」两层） */
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
    workflowTemplate: (id: number): Promise<WorkflowTemplatePayload | null> =>
      ipcRenderer.invoke('db:workflowTemplate', id),
    saveWorkflowTemplate: (tpl: {
      id?: number | null
      name: string
      description?: string
      start_policy?: string
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
    /** 某任务启动/关联的流程实例（对齐 instances_of_task） */
    workflowInstancesOfTask: (taskId: number): Promise<WorkflowInstancePayload[]> =>
      ipcRenderer.invoke('db:workflowInstancesOfTask', taskId),
    updateWorkflowNodePos: (id: number, x: number, y: number): Promise<number> =>
      ipcRenderer.invoke('db:updateWorkflowNodePos', id, x, y),
    /**
     * 设置 / 清除条件节点某条分支的目标（分支连线编辑用）。
     * slot：'true' = 满足（默认）/'false' = 不满足。
     */
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
    noteFolders: (): Promise<NoteFolder[]> => ipcRenderer.invoke('db:noteFolders'),
    note: (id: number): Promise<Note | null> => ipcRenderer.invoke('db:note', id),
    resolveNoteTitle: (title: string): Promise<number | null> =>
      ipcRenderer.invoke('db:resolveNoteTitle', title),
    outLinks: (id: number): Promise<NoteLink[]> => ipcRenderer.invoke('db:outLinks', id),
    backlinks: (id: number): Promise<Backlink[]> => ipcRenderer.invoke('db:backlinks', id),
    saveNote: (
      id: number,
      fields: {
        title?: string
        content_md?: string
        folder_id?: number | null
        pinned?: boolean
        /** N3：改笔记格式（markdown/richtext/word/excel/link） */
        format?: string
        /** 结构化属性（JSON 对象字符串：{ "来源": "书籍" }） */
        props?: string | null
      }
    ): Promise<Note | null> => ipcRenderer.invoke('db:saveNote', id, fields),
    createNote: (
      title: string,
      folderId: number | null,
      content?: string,
      format?: string
    ): Promise<Note | null> =>
      ipcRenderer.invoke('db:createNote', title, folderId, content ?? '', format ?? 'markdown'),
    deleteNote: (id: number): Promise<number> => ipcRenderer.invoke('db:deleteNote', id),
    /**
     * 关窗/刷新前的同步落盘（N1）：beforeunload 里没有 await 的机会，
     * 只有 sendSync 能保证写入真正发生（对齐 Python 关窗前 commit 编辑器）。
     */
    flushNoteSync: (
      id: number,
      fields: { title?: string; content_md?: string }
    ): boolean => ipcRenderer.sendSync('db:flushNote', id, fields),
    materializeDangling: (srcId: number, title: string): Promise<number | null> =>
      ipcRenderer.invoke('db:materializeDangling', srcId, title),
    /** 手动试跑一个步骤（命令 / 脚本会等待退出并核对退出码） */
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
    /** reason：手动中断专注时记录的中断原因（D18，对齐 PomodoroRepository.add 的第 5 参） */
    recordPomodoro: (
      taskId: number | null,
      minutes: number,
      completed: boolean,
      reason?: string
    ): Promise<number> =>
      ipcRenderer.invoke('db:recordPomodoro', taskId, minutes, completed, reason ?? null),
    pomodoroToday: (): Promise<{ minutes: number; sessions: number }> =>
      ipcRenderer.invoke('db:pomodoroToday'),
    dueReminders: (): Promise<Task[]> => ipcRenderer.invoke('db:dueReminders'),
    dismissReminder: (id: number): Promise<Task | null> => ipcRenderer.invoke('db:dismissReminder', id),
    snoozeReminder: (id: number, minutes: number): Promise<Task | null> =>
      ipcRenderer.invoke('db:snoozeReminder', id, minutes),
    exportPreview: (kind: 'json' | 'csv' | 'markdown'): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke('db:exportPreview', kind),
    importData: (): Promise<{
      ok: boolean
      message: string
      rows?: number
      tasks?: number
      notes?: number
      backup?: string
    }> => ipcRenderer.invoke('db:importData'),
    importFromPath: (path: string): Promise<{
      ok: boolean
      message: string
      rows?: number
      tasks?: number
      notes?: number
      backup?: string
    }> => ipcRenderer.invoke('db:importFromPath', path),
    /** 导入 Markdown 文件夹（D25）：选目录，递归 *.md 建笔记 */
    importMarkdownFolder: (): Promise<{ ok: boolean; count: number; message: string }> =>
      ipcRenderer.invoke('db:importMarkdownFolder'),
    /** 按路径导入 Markdown 文件夹（自动化脚本用，等价于在对话框里选同一目录） */
    importMarkdownFromPath: (path: string): Promise<{ ok: boolean; count: number; message: string }> =>
      ipcRenderer.invoke('db:importMarkdownFromPath', path),
    openNoteFile: (id: number): Promise<{ ok: boolean; message: string; path: string }> =>
      ipcRenderer.invoke('db:openNoteFile', id),
    previewNote: (id: number): Promise<{ kind: string; html: string; message: string }> =>
      ipcRenderer.invoke('db:previewNote', id),
    /** N-§1.3#5：Word/Excel 可编辑内容（Word→HTML，Excel→单元格网格） */
    officeDoc: (
      id: number
    ): Promise<{ kind: string; html: string; rows: string[][]; message: string }> =>
      ipcRenderer.invoke('db:officeDoc', id),
    /** 把富文本 HTML 写回关联的 .docx */
    saveWordNote: (id: number, html: string): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('db:saveWordNote', id, html),
    /** 把单元格网格写回关联的 .xlsx */
    saveExcelNote: (id: number, rows: string[][]): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('db:saveExcelNote', id, rows),
    /** N3：Word/Excel 未指定文件时自动新建空白文件 */
    createBlankOffice: (
      format: string,
      title: string
    ): Promise<{ ok: boolean; path: string; message: string }> =>
      ipcRenderer.invoke('db:createBlankOffice', format, title),
    exportData: (
      kind: 'json' | 'csv' | 'markdown' | 'markdown-zip'
    ): Promise<{ path: string; count: number } | null> => ipcRenderer.invoke('db:exportData', kind),
    rollRecurringToday: (): Promise<number> => ipcRenderer.invoke('db:rollRecurringToday'),
    resumeDueToday: (): Promise<number> => ipcRenderer.invoke('db:resumeDueToday'),
    trashItems: (kind: 'task' | 'note' | 'flash'): Promise<{ id: number; label: string; deleted_at: string }[]> =>
      ipcRenderer.invoke('db:trashItems', kind),
    restoreTrash: (kind: 'task' | 'note' | 'flash', id: number): Promise<number> =>
      ipcRenderer.invoke('db:restoreTrash', kind, id),
    purgeTrash: (kind: 'task' | 'note' | 'flash', id: number): Promise<number> =>
      ipcRenderer.invoke('db:purgeTrash', kind, id),
    emptyTrash: (kind: 'task' | 'note' | 'flash'): Promise<number> =>
      ipcRenderer.invoke('db:emptyTrash', kind),
    purgeTrashOlderThan: (days: number): Promise<number> =>
      ipcRenderer.invoke('db:purgeTrashOlderThan', days),
    tagsWithUsage: (): Promise<{ id: number; name: string; color: string; count: number }[]> =>
      ipcRenderer.invoke('db:tagsWithUsage'),
    createTag: (name: string, color?: string): Promise<number | null> =>
      ipcRenderer.invoke('db:createTag', name, color),
    renameTag: (id: number, name: string): Promise<void> => ipcRenderer.invoke('db:renameTag', id, name),
    deleteTag: (id: number): Promise<number> => ipcRenderer.invoke('db:deleteTag', id),
    mergeTags: (target: number, sources: number[]): Promise<number> =>
      ipcRenderer.invoke('db:mergeTags', target, sources),
    /** 主进程写入后广播的数据变更（O3）：domain 取值见 shared/events.ts */
    onDataChanged: (cb: (domain: string) => void): (() => void) => {
      const handler = (_e: unknown, domain: string): void => cb(domain)
      ipcRenderer.on('data:changed', handler)
      return () => ipcRenderer.removeListener('data:changed', handler)
    },

    noteRevisions: (id: number): Promise<NoteRevision[]> =>
      ipcRenderer.invoke('db:noteRevisions', id),
    restoreNoteRevision: (noteId: number, revId: number): Promise<Note | null> =>
      ipcRenderer.invoke('db:restoreNoteRevision', noteId, revId),
    orphanNotes: (): Promise<Note[]> => ipcRenderer.invoke('db:orphanNotes'),
    brokenLinks: (): Promise<{ src_note_id: number; src_title: string; dst_title: string }[]> =>
      ipcRenderer.invoke('db:brokenLinks'),
    noteTemplates: (): Promise<string[]> => ipcRenderer.invoke('db:noteTemplates'),
    createNoteFromTemplate: (kind: string, folderId: number | null): Promise<Note | null> =>
      ipcRenderer.invoke('db:createNoteFromTemplate', kind, folderId),
    bindDanglingByTitle: (title: string): Promise<number> =>
      ipcRenderer.invoke('db:bindDanglingByTitle', title),
    createNoteFolder: (name: string, parentId: number | null): Promise<NoteFolder | null> =>
      ipcRenderer.invoke('db:createNoteFolder', name, parentId),
    renameNoteFolder: (id: number, name: string): Promise<NoteFolder | null> =>
      ipcRenderer.invoke('db:renameNoteFolder', id, name),
    deleteNoteFolder: (id: number): Promise<number> => ipcRenderer.invoke('db:deleteNoteFolder', id),
    moveNoteFolder: (id: number, parentId: number | null): Promise<NoteFolder | null> =>
      ipcRenderer.invoke('db:moveNoteFolder', id, parentId),
    /** 笔记文件夹为空时补一个默认文件夹（对齐 ensure_default_folder） */
    ensureDefaultFolder: (): Promise<NoteFolder | null> =>
      ipcRenderer.invoke('db:ensureDefaultFolder'),
    /** 主动建引用链（对齐 add_reference_link），返回状态串 */
    addReferenceLink: (srcId: number, target: number | string): Promise<string> =>
      ipcRenderer.invoke('db:addReferenceLink', srcId, target),
    /** 追加正文（完成任务写「复盘/结论」用，对齐 note_service.append） */
    appendNote: (id: number, text: string): Promise<Note | null> =>
      ipcRenderer.invoke('db:appendNote', id, text),
    /** 选文转任务时落「段落定位锚」（对齐 TaskRepository.link_context） */
    attachNoteBlock: (
      taskId: number,
      noteId: number,
      blockKey: string,
      snippet: string
    ): Promise<number> => ipcRenderer.invoke('db:attachNoteBlock', taskId, noteId, blockKey, snippet),
    noteBlockContexts: (noteId: number): Promise<unknown[]> =>
      ipcRenderer.invoke('db:noteBlockContexts', noteId),
    /** 本笔记归属的任务（笔记页「归属」分组） */
    noteAttachedTasks: (noteId: number): Promise<{ id: number; title: string }[]> =>
      ipcRenderer.invoke('db:noteAttachedTasks', noteId),
    /** 「归属 → 选任务」候选：非删非终态任务（对齐 task_candidates） */
    noteTaskCandidates: (q: string, limit?: number): Promise<{ id: number; title: string }[]> =>
      ipcRenderer.invoke('db:noteTaskCandidates', q, limit ?? 30),
    quickAdd: (text: string, defaultListId?: number | null): Promise<Task | null> =>
      ipcRenderer.invoke('db:quickAdd', text, defaultListId ?? null),
    /** 等待中（暂停）：可选恢复日期（对齐 task_service.pause） */
    pauseTask: (id: number, resumeAt?: string | null): Promise<Task | null> =>
      ipcRenderer.invoke('db:pauseTask', id, resumeAt ?? null),
    /** 恢复：默认回待办并清恢复日期（对齐 task_service.resume） */
    resumeTask: (id: number, status?: TaskStatus): Promise<Task | null> =>
      ipcRenderer.invoke('db:resumeTask', id, status ?? 'todo'),
    /** 段落级上下文（T3）：挂载 / 解除 / 查询 */
    attachBlock: (
      taskId: number,
      noteId: number,
      blockKey: string,
      snippet?: string
    ): Promise<Task | null> =>
      ipcRenderer.invoke('db:attachBlock', taskId, noteId, blockKey, snippet ?? ''),
    detachBlock: (taskId: number, noteId: number, blockKey?: string): Promise<number> =>
      ipcRenderer.invoke('db:detachBlock', taskId, noteId, blockKey ?? ''),
    linkedContexts: (taskId: number): Promise<TaskNoteContext[]> =>
      ipcRenderer.invoke('db:linkedContexts', taskId),
    contextsForNote: (noteId: number): Promise<TaskNoteContext[]> =>
      ipcRenderer.invoke('db:contextsForNote', noteId),
    noteContextMap: (taskIds: number[]): Promise<Record<number, TaskNoteContext[]>> =>
      ipcRenderer.invoke('db:noteContextMap', taskIds),
    /** 完成任务写复盘/结论回写（对齐 app_controller._write_note_after_done） */
    writeNoteAfterDone: (
      taskId: number,
      title: string
    ): Promise<{ noteId: number; blockKey: string } | null> =>
      ipcRenderer.invoke('db:writeNoteAfterDone', taskId, title),
    /** 捕获目标选择器候选（对齐 TaskService.task_candidates，T17） */
    taskCandidates: (q?: string, limit?: number): Promise<Task[]> =>
      ipcRenderer.invoke('db:taskCandidates', q ?? '', limit ?? 20),
    reorderTask: (id: number, anchorId: number, below?: boolean): Promise<Task | null> =>
      ipcRenderer.invoke('db:reorderTask', id, anchorId, below ?? true),
    moveTaskRelative: (id: number, delta: number): Promise<boolean> =>
      ipcRenderer.invoke('db:moveTaskRelative', id, delta),
    reparentTask: (id: number, parentId: number | null): Promise<Task | null> =>
      ipcRenderer.invoke('db:reparentTask', id, parentId),
    batchComplete: (ids: number[]): Promise<number> => ipcRenderer.invoke('db:batchComplete', ids),
    batchMove: (ids: number[], listId: number | null): Promise<number> =>
      ipcRenderer.invoke('db:batchMove', ids, listId),
    batchSetDue: (ids: number[], due: string | null): Promise<number> =>
      ipcRenderer.invoke('db:batchSetDue', ids, due),
    /** 批量软删除任务（级联子树，一个事务）—— 替代渲染层的 for + deleteTask */
    batchDeleteTasks: (ids: number[]): Promise<number> =>
      ipcRenderer.invoke('db:batchDeleteTasks', ids),
    /** 批量删除标签（一个事务）—— 替代渲染层的 for + deleteTag */
    batchDeleteTags: (ids: number[]): Promise<number> =>
      ipcRenderer.invoke('db:batchDeleteTags', ids),
    /** 撤销一步（完成 / 取消完成 / 删除恢复）整批一个事务 */
    batchUndoLast: (
      ids: number[],
      action: 'toggle' | 'restore',
      prevStatus: string | null
    ): Promise<number> => ipcRenderer.invoke('db:batchUndoLast', ids, action, prevStatus),
    /** 自动布局：一次提交全部节点坐标 */
    batchUpdateNodePos: (items: { id: number; x: number; y: number }[]): Promise<number> =>
      ipcRenderer.invoke('db:batchUpdateNodePos', items),
    /** 清空三类回收站（一个事务） */
    emptyAllTrash: (): Promise<number> => ipcRenderer.invoke('db:emptyAllTrash'),
    tags: (): Promise<{ id: number; name: string; color: string }[]> => ipcRenderer.invoke('db:tags'),
    setTaskTags: (id: number, names: string[]): Promise<void> =>
      ipcRenderer.invoke('db:setTaskTags', id, names),
    updateTask: (
      id: number,
      fields: Record<string, string | number | null>
    ): Promise<Task | null> => ipcRenderer.invoke('db:updateTask', id, fields),
    /** 把已完成的任务释放回待执行（连带恢复仍是终态的祖先，层级因此得以保留） */
    /** 把编辑区的 HTML 导出成 .docx（写到原文件同目录的新文件，不覆写原件） */
    exportDocx: (
      srcPath: string,
      html: string,
      title: string
    ): Promise<{ ok: boolean; path?: string; message?: string }> =>
      ipcRenderer.invoke('word:exportDocx', srcPath, html, title),
    /** 取单个任务（含 parent_id / status），断言与调试都用得上 */
    getTask: (id: number): Promise<Task | null> => ipcRenderer.invoke('db:getTask', id),
    restoreCompleted: (id: number, listId?: number | null): Promise<Task | null> =>
      ipcRenderer.invoke('db:restoreCompleted', id, listId ?? null),
    deleteTask: (id: number): Promise<number> => ipcRenderer.invoke('db:deleteTask', id),
  },
  /**
   * 全局热键唤出的捕获面板（独立小窗口）：主进程推 payload、渲染层回执。
   * 与条件确认窗同一套协议 —— 渲染层应用完主题发 ready，主进程才把窗口显示出来。
   */
  capture: {
    onOpen: (
      cb: (payload: { mode: 'quick' | 'capture'; seed: { text: string; html: string } }) => void
    ): (() => void) => {
      const handler = (
        _e: unknown,
        payload: { mode: 'quick' | 'capture'; seed: { text: string; html: string } }
      ): void => cb(payload)
      ipcRenderer.on('capture:open', handler)
      return () => ipcRenderer.removeListener('capture:open', handler)
    },
    /** 应用内入口（快捷键 / 浮条）主动开一个捕获窗口 */
    open: (mode: 'quick' | 'capture'): Promise<boolean> =>
      ipcRenderer.invoke('capture:open', mode),
    ready: (): void => ipcRenderer.send('capture:ready'),
    close: (): void => ipcRenderer.send('capture:close'),
    done: (message: string): void => ipcRenderer.send('capture:done', message),
  },
  /**
   * 外部任务源：设置页手动同步 / 读状态 / 改完设置后重排定时器。
   * 类型与主进程 src/main/task-sync.ts 对齐（preload 不便 import 主进程代码）。
   */
  taskSync: {
    now: (): Promise<{ ok: boolean; message: string; total: number; created: number; updated: number; unchanged: number; skipped: number }> =>
      ipcRenderer.invoke('taskSync:now'),
    status: (): Promise<{ enabled: boolean; url: string; intervalMin: number; lastAt: string; lastResult: string }> =>
      ipcRenderer.invoke('taskSync:status'),
    reload: (): Promise<boolean> => ipcRenderer.invoke('taskSync:reload'),
  },
  /**
   * 工作流条件节点的人工确认（「提示确认」来源）：
   * 主进程发起询问 → 渲染层弹应用内对话框 → 回传成立 / 不成立。
   * 判定逻辑与原先一致，只是把原生模态换成了自绘弹框。
   */
  condition: {
    onAsk: (cb: (ask: { id: string; prompt: string }) => void): (() => void) => {
      const handler = (_e: unknown, ask: { id: string; prompt: string }): void => cb(ask)
      ipcRenderer.on('condition:confirm', handler)
      return () => ipcRenderer.removeListener('condition:confirm', handler)
    },
    answer: (id: string, ok: boolean): void => {
      ipcRenderer.send('condition:answer', id, ok)
    },
    /** 主题应用完毕：主进程收到后才把窗口显示出来，避免先闪一下默认配色 */
    ready: (): void => {
      ipcRenderer.send('condition:ready')
    },
  },
  /**
   * 笔记的「大模型解读整理归纳」。
   * 请求本身在主进程发出（渲染层不该拿到 API Key，也不该被 CORS 拦住）。
   */
  ai: {
    organizeNote: (noteId: number): Promise<AiOrganizeOutcome> =>
      ipcRenderer.invoke('ai:organizeNote', noteId),
    testConnection: (): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('ai:testConnection'),
    /** 逐篇整理整个笔记库（串行，可停止；只处理 Markdown / 富文本） */
    organizeLibrary: (): Promise<AiLibraryOutcome> => ipcRenderer.invoke('ai:organizeLibrary'),
    /** 停止整库整理；返回可读说明，便于区分「没任务在跑」与「已请求停止」 */
    cancelLibrary: (): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('ai:cancelLibrary'),
    /** 挂载时问一次当前进度（比如切页回来时任务还在跑） */
    libraryProgress: (): Promise<AiLibraryProgress | null> => ipcRenderer.invoke('ai:libraryProgress'),
    /** 整库整理的进度推送；返回值是取消订阅 */
    onLibraryProgress: (cb: (p: AiLibraryProgress) => void): (() => void) => {
      const handler = (_e: unknown, p: AiLibraryProgress): void => cb(p)
      ipcRenderer.on('ai:libraryProgress', handler)
      return () => ipcRenderer.removeListener('ai:libraryProgress', handler)
    },
  },
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
    setTheme: (theme: 'light' | 'dark' | 'system'): Promise<void> =>
      ipcRenderer.invoke('theme:set', theme),
    /** 云母材质开关（仅 win32 生效，其他平台为空操作） */
    /** 首屏数据就绪：主进程据此关闭欢迎页并显示主窗（splash 流程） */
    ready: (): Promise<void> => ipcRenderer.invoke('app:ready'),
    /** 托盘图标按当前主题重建 */
    refreshTray: (): Promise<void> => ipcRenderer.invoke('app:refreshTray'),
    /** 热键注册状态（settings 键 → 中文状态串），对齐 Python 的 hotkey_status */
    hotkeyStatus: (): Promise<Record<string, string>> => ipcRenderer.invoke('app:hotkeyStatus'),
    /** 应用内触发一次全局动作（与全局热键走同一条分发函数） */
    hotkeyAction: (action: string): Promise<void> =>
      ipcRenderer.invoke('app:hotkeyAction', action),
    /** 探测组合键当前能否注册（注册成功立刻注销）；改键浮层用它当场给结果 */
    probeHotkey: (combo: string): Promise<boolean> =>
      ipcRenderer.invoke('app:probeHotkey', combo),
    /** 进入改键捕获态：先注销全部热键，避免组合键被系统层拦截 */
    suspendHotkeys: (): Promise<void> => ipcRenderer.invoke('app:suspendHotkeys'),
    /** 改键完成/取消后重注册全部热键，返回最新状态 */
    rebindHotkeys: (): Promise<Record<string, string>> => ipcRenderer.invoke('app:rebindHotkeys'),
    /**
     * 深链跳转（zhixing:// …）。
     * 载荷形状用 shared/deep-link 的 DeepLink：图页双击跨页跳转也复用这条通道，
     * 因此 kind 只可能是 task / note / flash / folder。
     */
    onDeepLink: (cb: (link: DeepLink) => void): (() => void) => {
      const handler = (_e: unknown, link: DeepLink): void => cb(link)
      ipcRenderer.on('app:deeplink', handler)
      return () => ipcRenderer.removeListener('app:deeplink', handler)
    },
    /**
     * 托盘 / 全局热键触发的应用动作。
     * 「划词捕获 / 读取选中并速记 / 快速任务」这三个会带上主进程刚取到的**当前选中文字**
     * （文本 + HTML，HTML 用于解析来源 URL）。
     */
    onAction: (
      cb: (action: string, payload?: { text: string; html: string }) => void
    ): (() => void) => {
      const handler = (
        _e: unknown,
        action: string,
        payload?: { text: string; html: string }
      ): void => cb(action, payload || undefined)
      ipcRenderer.on('app:action', handler)
      return () => ipcRenderer.removeListener('app:action', handler)
    },
    /** 独立弹窗（无边框）把窗口高度贴合卡片内容 */
    fitHeight: (height: number): void => ipcRenderer.send('window:fitHeight', height),
  },
  widget: {
    toggle: (): Promise<boolean> => ipcRenderer.invoke('widget:toggle'),
    close: (): Promise<void> => ipcRenderer.invoke('widget:close'),
    setOpacity: (value: number): Promise<void> => ipcRenderer.invoke('widget:setOpacity', value),
    setClickThrough: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke('widget:setClickThrough', enabled),
    undock: (): Promise<void> => ipcRenderer.invoke('widget:undock'),
    /** 悬浮球拖动：只报告「正在拖」，位移由主进程按屏幕光标重算 */
    dragStart: (): Promise<void> => ipcRenderer.invoke('widget:dragStart'),
    dragTo: (): Promise<void> => ipcRenderer.invoke('widget:dragTo'),
    dragEnd: (moved: boolean): Promise<void> => ipcRenderer.invoke('widget:dragEnd', moved),
    /** 改悬浮球大小（球体边长，主进程钳在 88~160） */
    setBallSize: (size: number): Promise<void> => ipcRenderer.invoke('widget:setBallSize', size),
    /** 当前形态：'ball' 贴边收缩成悬浮球 / 'full' 完整卡片 */
    getMode: (): Promise<'full' | 'ball'> => ipcRenderer.invoke('widget:mode'),
    /** 悬浮球当前体型（bloub 的形状 id） */
    ballShape: (): Promise<string> => ipcRenderer.invoke('widget:ballShape'),
    /** 改悬浮球体型（bloub 的形状 id）；与右键菜单同一个入口 */
    setBallShape: (id: string): Promise<void> =>
      ipcRenderer.invoke('widget:setBallShape', id),
    /** 主进程改了体型后推一次（右键菜单选形状） */
    onBallShape: (cb: (shape: string) => void): (() => void) => {
      const handler = (_e: unknown, shape: string): void => cb(shape)
      ipcRenderer.on('widget:ballShape', handler)
      return () => ipcRenderer.removeListener('widget:ballShape', handler)
    },
    /** 主进程切换形态时推送（贴边收缩 / 展开 / 启动时恢复贴边态） */
    onMode: (cb: (mode: 'full' | 'ball') => void): (() => void) => {
      const handler = (_e: unknown, mode: 'full' | 'ball'): void => cb(mode)
      ipcRenderer.on('widget:mode', handler)
      return () => ipcRenderer.removeListener('widget:mode', handler)
    },
    /** 边缘缩放（S17）：渲染层判定命中的边后交给主进程按屏幕光标重算尺寸 */
    resizeStart: (edges: string): Promise<void> => ipcRenderer.invoke('widget:resizeStart', edges),
    resizeTo: (): Promise<void> => ipcRenderer.invoke('widget:resizeTo'),
    resizeEnd: (): Promise<void> => ipcRenderer.invoke('widget:resizeEnd'),
    contextMenu: (): Promise<void> => ipcRenderer.invoke('widget:contextMenu'),
    openMain: (): Promise<void> => ipcRenderer.invoke('widget:openMain'),
    /** 主进程告知「当前有 N 条提醒」，球据此切 notify 表情（0 = 回到常规节拍） */
    onNotice: (cb: (count: number) => void): (() => void) => {
      const handler = (_e: unknown, count: number): void => cb(count)
      ipcRenderer.on('widget:notice', handler)
      return () => ipcRenderer.removeListener('widget:notice', handler)
    },
  },
  /**
   * 到点提醒。消费（清 reminder_at）已收归主进程一处，这里只剩读与「用户处理了」——
   * 渲染层不再自己查库，否则气泡窗口与主窗口会互相抢着清，反而少看到一条。
   */
  reminder: {
    /** 当前待展示的提醒（含已消费、但用户还没处理的那一份） */
    current: (): Promise<Task[]> => ipcRenderer.invoke('reminder:current'),
    dismiss: (id: number): Promise<Task[]> => ipcRenderer.invoke('reminder:dismiss', id),
    snooze: (id: number, minutes: number): Promise<Task[]> =>
      ipcRenderer.invoke('reminder:snooze', id, minutes),
    /** 气泡量完内容高度上报，主进程据此贴边定位 */
    resize: (height: number): Promise<void> => ipcRenderer.invoke('reminder:resize', height),
    /** 打开主窗口并定位到该任务 */
    openTask: (id: number): Promise<void> => ipcRenderer.invoke('reminder:openTask', id),
    onPush: (cb: (rows: Task[]) => void): (() => void) => {
      const handler = (_e: unknown, rows: Task[]): void => cb(rows)
      ipcRenderer.on('reminder:push', handler)
      return () => ipcRenderer.removeListener('reminder:push', handler)
    },
    onOpenTask: (cb: (id: number) => void): (() => void) => {
      const handler = (_e: unknown, id: number): void => cb(id)
      ipcRenderer.on('reminder:openTask', handler)
      return () => ipcRenderer.removeListener('reminder:openTask', handler)
    },
  },
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggleMaximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
  },
}

export type ZhixingApi = typeof api

contextBridge.exposeInMainWorld('zhixing', api)
