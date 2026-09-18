import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfo,
  Backlink,
  Flash,
  GraphPayload,
  Note,
  NoteFolder,
  NoteLink,
  NoteRevision,
  Overview,
  ReviewStats,
  Task,
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
    info: (): Promise<{ path: string; ready: boolean }> => ipcRenderer.invoke('db:info'),
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
    /** 命令面板统一搜索（前缀 + 过滤语法，与 Python 的 global_search 对齐） */
    globalSearch: (q: string): Promise<unknown> => ipcRenderer.invoke('db:globalSearch', q),
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
    graph: (includeTasks?: boolean): Promise<GraphPayload> => ipcRenderer.invoke('db:graph', includeTasks ?? false),
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
        action_kind?: string
        action_value?: string
        condition?: string
        branch_node_id?: number | null
        pos_x?: number | null
        pos_y?: number | null
      }[]
    }): Promise<{ ok: boolean; problems: string[]; templateId?: number }> =>
      ipcRenderer.invoke('db:saveWorkflowTemplate', tpl),
    deleteWorkflowTemplate: (id: number): Promise<number> =>
      ipcRenderer.invoke('db:deleteWorkflowTemplate', id),
    updateWorkflowNodePos: (id: number, x: number, y: number): Promise<number> =>
      ipcRenderer.invoke('db:updateWorkflowNodePos', id, x, y),
    /** 设置 / 清除某步骤的条件分支目标（分支连线编辑用） */
    setWorkflowBranch: (id: number, branchNodeId: number | null): Promise<number> =>
      ipcRenderer.invoke('db:setWorkflowBranch', id, branchNodeId),
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
    abortWorkflowInstance: (id: number): Promise<boolean> =>
      ipcRenderer.invoke('db:abortWorkflowInstance', id),
    noteFolders: (): Promise<NoteFolder[]> => ipcRenderer.invoke('db:noteFolders'),
    note: (id: number): Promise<Note | null> => ipcRenderer.invoke('db:note', id),
    resolveNoteTitle: (title: string): Promise<number | null> =>
      ipcRenderer.invoke('db:resolveNoteTitle', title),
    outLinks: (id: number): Promise<NoteLink[]> => ipcRenderer.invoke('db:outLinks', id),
    backlinks: (id: number): Promise<Backlink[]> => ipcRenderer.invoke('db:backlinks', id),
    saveNote: (
      id: number,
      fields: { title?: string; content_md?: string; folder_id?: number | null; pinned?: boolean }
    ): Promise<Note | null> => ipcRenderer.invoke('db:saveNote', id, fields),
    createNote: (
      title: string,
      folderId: number | null,
      content?: string,
      format?: string
    ): Promise<Note | null> =>
      ipcRenderer.invoke('db:createNote', title, folderId, content ?? '', format ?? 'markdown'),
    deleteNote: (id: number): Promise<number> => ipcRenderer.invoke('db:deleteNote', id),
    materializeDangling: (srcId: number, title: string): Promise<number | null> =>
      ipcRenderer.invoke('db:materializeDangling', srcId, title),
    runWorkflowAction: (
      kind: string,
      value: string
    ): Promise<{ ok: boolean; message: string; kind: string }> =>
      ipcRenderer.invoke('db:runWorkflowAction', kind, value),
    describeWorkflowAction: (kind: string, value: string): Promise<string> =>
      ipcRenderer.invoke('db:describeWorkflowAction', kind, value),
    recordPomodoro: (taskId: number | null, minutes: number, completed: boolean): Promise<number> =>
      ipcRenderer.invoke('db:recordPomodoro', taskId, minutes, completed),
    pomodoroToday: (): Promise<{ minutes: number; sessions: number }> =>
      ipcRenderer.invoke('db:pomodoroToday'),
    dueReminders: (): Promise<Task[]> => ipcRenderer.invoke('db:dueReminders'),
    dismissReminder: (id: number): Promise<Task | null> => ipcRenderer.invoke('db:dismissReminder', id),
    snoozeReminder: (id: number, minutes: number): Promise<Task | null> =>
      ipcRenderer.invoke('db:snoozeReminder', id, minutes),
    exportPreview: (kind: 'json' | 'csv' | 'markdown'): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke('db:exportPreview', kind),
    importData: (): Promise<{ ok: boolean; message: string; rows?: number; backup?: string }> =>
      ipcRenderer.invoke('db:importData'),
    importFromPath: (path: string): Promise<{ ok: boolean; message: string; rows?: number; backup?: string }> =>
      ipcRenderer.invoke('db:importFromPath', path),
    openNoteFile: (id: number): Promise<{ ok: boolean; message: string; path: string }> =>
      ipcRenderer.invoke('db:openNoteFile', id),
    previewNote: (id: number): Promise<{ kind: string; html: string; message: string }> =>
      ipcRenderer.invoke('db:previewNote', id),
    exportData: (kind: 'json' | 'csv' | 'markdown'): Promise<{ path: string; count: number } | null> =>
      ipcRenderer.invoke('db:exportData', kind),
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
    onDataChanged: (cb: (domain: string) => void): void => {
      ipcRenderer.on('data:changed', (_e, domain) => cb(domain))
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
    quickAdd: (text: string): Promise<Task | null> => ipcRenderer.invoke('db:quickAdd', text),
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
    tags: (): Promise<{ id: number; name: string; color: string }[]> => ipcRenderer.invoke('db:tags'),
    setTaskTags: (id: number, names: string[]): Promise<void> =>
      ipcRenderer.invoke('db:setTaskTags', id, names),
    updateTask: (
      id: number,
      fields: Record<string, string | number | null>
    ): Promise<Task | null> => ipcRenderer.invoke('db:updateTask', id, fields),
    deleteTask: (id: number): Promise<number> => ipcRenderer.invoke('db:deleteTask', id),
  },
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
    setTheme: (theme: 'light' | 'dark' | 'system'): Promise<void> =>
      ipcRenderer.invoke('theme:set', theme),
    /** 深链跳转（zhixing:// …） */
    onDeepLink: (cb: (link: { kind: string; id: number; block: string }) => void): void => {
      ipcRenderer.on('app:deeplink', (_e, link) => cb(link))
    },
    /** 托盘/全局热键触发的应用动作 */
    onAction: (cb: (action: string) => void): void => {
      ipcRenderer.on('app:action', (_e, action) => cb(action))
    },
  },
  widget: {
    toggle: (): Promise<boolean> => ipcRenderer.invoke('widget:toggle'),
    close: (): Promise<void> => ipcRenderer.invoke('widget:close'),
    setOpacity: (value: number): Promise<void> => ipcRenderer.invoke('widget:setOpacity', value),
    setClickThrough: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke('widget:setClickThrough', enabled),
    undock: (): Promise<void> => ipcRenderer.invoke('widget:undock'),
    contextMenu: (): Promise<void> => ipcRenderer.invoke('widget:contextMenu'),
    openMain: (): Promise<void> => ipcRenderer.invoke('widget:openMain'),
  },
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggleMaximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
  },
}

export type ZhixingApi = typeof api

contextBridge.exposeInMainWorld('zhixing', api)
