import { ipcRenderer } from 'electron'
import type { NoteFolder, Task, TaskStatus, TaskActivity, TaskActivityKind } from '../../shared/types'
/**
 * task 域的渲染进程 API（58 项）。
 *
 * 从 preload/index.ts 拆出来：db 一个对象原有 600 行 / 173 个方法，
 * 找一处调用要先在六百行里翻。index.ts 现在只负责拼装与暴露。
 */
export const taskApi = {
    tasks: (limit?: number): Promise<Task[]> => ipcRenderer.invoke('db:tasks', limit),
    inboxTasks: (): Promise<Task[]> => ipcRenderer.invoke('db:inboxTasks'),
    flashToSubtask: (id: number, parentTaskId: number): Promise<number | null> =>
      ipcRenderer.invoke('db:flashToSubtask', id, parentTaskId),
    flashToTask: (id: number): Promise<number | null> => ipcRenderer.invoke('db:flashToTask', id),
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
    /** 把清单 / 分组移动到某分组下（null = 顶层）；环形与非分组目标在主进程被拒绝 */
    moveListFolder: (id: number, parentId: number | null): Promise<number> =>
      ipcRenderer.invoke('db:moveListFolder', id, parentId),
    /** 拖拽排序 / 跨分组拖拽：放到 anchor 的上/下，父级跟随 anchor */
    reorderListFolder: (id: number, anchorId: number, below?: boolean): Promise<number> =>
      ipcRenderer.invoke('db:reorderListFolder', id, anchorId, below ?? true),
    /** 某个清单 / 分组是否在另一个的子树内（拖拽防成环，前端提示用） */
    isListDescendantOf: (ancestorId: number, nodeId: number): Promise<boolean> =>
      ipcRenderer.invoke('db:isListDescendantOf', ancestorId, nodeId),
    moveTaskToList: (taskId: number, listId: number | null): Promise<number> =>
      ipcRenderer.invoke('db:moveTaskToList', taskId, listId),
    /** 任务关联知识库文件夹：其下所有笔记（递归子文件夹）会被自动引用；null = 解除 */
  setTaskNoteFolder: (taskId: number, folderId: number | null): Promise<boolean> =>
    ipcRenderer.invoke('db:setTaskNoteFolder', taskId, folderId),
  /** AI 总结任务关联的所有笔记 */
  summarizeTaskNotes: (taskId: number): Promise<{ ok: boolean; text?: string; message?: string; basedOn?: number; skipped?: string[] }> =>
    ipcRenderer.invoke('db:summarizeTaskNotes', taskId),
  taskNoteFolder: (taskId: number): Promise<number | null> =>
    ipcRenderer.invoke('db:taskNoteFolder', taskId),
  /** 手动对齐一次自动引用（正常情况下广播链路已经覆盖） */
  syncFolderLinkedTasks: (): Promise<number> => ipcRenderer.invoke('db:syncFolderLinkedTasks'),
  linkTaskNote: (taskId: number, noteId: number): Promise<number> =>
      ipcRenderer.invoke('db:linkTaskNote', taskId, noteId),
    unlinkTaskNote: (taskId: number, noteId: number): Promise<number> =>
      ipcRenderer.invoke('db:unlinkTaskNote', taskId, noteId),
    /** 某任务关联的笔记（task_note_link 与 task_note_ref 合并去重） */
    linkTaskNoteRef: (taskId: number, noteId: number): Promise<boolean> =>
      ipcRenderer.invoke('db:linkTaskNoteRef', taskId, noteId),
    unlinkTaskNoteRef: (taskId: number, noteId: number): Promise<boolean> =>
      ipcRenderer.invoke('db:unlinkTaskNoteRef', taskId, noteId),
    /** 解除笔记↔笔记引用（linkNotes 是双向写的，这里对称删两侧） */
    taskActivity: (taskId: number, limit?: number | null): Promise<TaskActivity[]> =>
      ipcRenderer.invoke('db:taskActivity', taskId, limit ?? null),
    /** 渲染层补记一条活动（状态变更时带上原因说明） */
    pushTaskActivity: (
      taskId: number,
      kind: TaskActivityKind,
      detail?: string | null,
      reason?: string | null
    ): Promise<boolean> =>
      ipcRenderer.invoke('db:pushTaskActivity', taskId, kind, detail ?? null, reason ?? null),
    noteFolders: (): Promise<NoteFolder[]> => ipcRenderer.invoke('db:noteFolders'),
    dueReminders: (): Promise<Task[]> => ipcRenderer.invoke('db:dueReminders'),
    dismissReminder: (id: number): Promise<Task | null> => ipcRenderer.invoke('db:dismissReminder', id),
    snoozeReminder: (id: number, minutes: number): Promise<Task | null> =>
      ipcRenderer.invoke('db:snoozeReminder', id, minutes),
    resumeDueToday: (): Promise<number> => ipcRenderer.invoke('db:resumeDueToday'),
    createNoteFolder: (name: string, parentId: number | null): Promise<NoteFolder | null> =>
      ipcRenderer.invoke('db:createNoteFolder', name, parentId),
    renameNoteFolder: (id: number, name: string): Promise<NoteFolder | null> =>
      ipcRenderer.invoke('db:renameNoteFolder', id, name),
    deleteNoteFolder: (id: number): Promise<number> => ipcRenderer.invoke('db:deleteNoteFolder', id),
    moveNoteFolder: (id: number, parentId: number | null): Promise<NoteFolder | null> =>
      ipcRenderer.invoke('db:moveNoteFolder', id, parentId),
    /** 笔记文件夹为空时补一个默认文件夹 */
    ensureDefaultFolder: (): Promise<NoteFolder | null> =>
      ipcRenderer.invoke('db:ensureDefaultFolder'),
    /** 主动建引用链，返回状态串 */
    linkTaskNoteBlock: (
      taskId: number,
      noteId: number,
      blockKey: string,
      snippet: string
    ): Promise<number> => ipcRenderer.invoke('db:linkTaskNoteBlock', taskId, noteId, blockKey, snippet),
    noteLinkedTasks: (noteId: number): Promise<{ id: number; title: string }[]> =>
      ipcRenderer.invoke('db:noteLinkedTasks', noteId),
    /** 「归属 → 选任务」候选：非删非终态任务 */
    /** 「关联到任务」候选：带所属列表与列表分组，弹层据此展示层级 */
    noteTaskCandidates: (
      q: string,
      limit?: number
    ): Promise<
      { id: number; title: string; listName: string; groupName: string }[]
    > => ipcRenderer.invoke('db:noteTaskCandidates', q, limit ?? 30),
    quickAdd: (text: string, defaultListId?: number | null): Promise<Task | null> =>
      ipcRenderer.invoke('db:quickAdd', text, defaultListId ?? null),
    /** 等待中（暂停）：可选恢复日期 */
    pauseTask: (id: number, resumeAt?: string | null): Promise<Task | null> =>
      ipcRenderer.invoke('db:pauseTask', id, resumeAt ?? null),
    /** 恢复：默认回待办并清恢复日期 */
    resumeTask: (id: number, status?: TaskStatus): Promise<Task | null> =>
      ipcRenderer.invoke('db:resumeTask', id, status ?? 'todo'),
    unlinkTaskNoteBlock: (taskId: number, noteId: number, blockKey?: string): Promise<number> =>
      ipcRenderer.invoke('db:unlinkTaskNoteBlock', taskId, noteId, blockKey ?? ''),
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
    setTaskTags: (id: number, names: string[]): Promise<void> =>
      ipcRenderer.invoke('db:setTaskTags', id, names),
    /** 全部笔记的标签关联（tag 表与任务共用一套） */
    updateTask: (
      id: number,
      fields: Record<string, string | number | null>
    ): Promise<Task | null> => ipcRenderer.invoke('db:updateTask', id, fields),
    /** 把已完成的任务释放回待执行（连带恢复仍是终态的祖先，层级因此得以保留） */
    /** 把编辑区的 HTML 导出成 .docx（写到原文件同目录的新文件，不覆写原件） */
    getTask: (id: number): Promise<Task | null> => ipcRenderer.invoke('db:getTask', id),
    restoreCompleted: (id: number, listId?: number | null): Promise<Task | null> =>
      ipcRenderer.invoke('db:restoreCompleted', id, listId ?? null),
    deleteTask: (id: number): Promise<number> => ipcRenderer.invoke('db:deleteTask', id),
}
