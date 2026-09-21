import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import type Database from 'better-sqlite3'

// 数据层按业务域拆分在 ./<domain>.ts，这里聚合成统一的 IPC 注册入口。
// 拆分只搬家不改逻辑：每个域仍共享 connection.ts 里的同一个数据库连接。
export * from './connection'
export * from './backup'
export * from './search'
export * from './lists'
export * from './export'
export * from './graph'
export * from './inbox'
export * from './maintenance'
export * from './notes'
export * from './preview'
export * from './review'
export * from './settings'
export * from './task-ops'
export * from './tasks'
// export * 只导出名字，不把它引进本文件作用域 —— 这里要直接调用它
import { restoreCompleted } from './tasks'
export * from './trash'
export * from './workflow'

// 显式导入供下方 IPC 注册使用（export * 不引入本地作用域）
import { APP_DIR_NAME, dataDir, dbPath, TASK_COLUMNS, open, conn, nowStamp, today, getTask, db, openedPath, dbReadonlyReason, dbOpenError } from './connection'
import { EXPORT_TABLES, buildExportJson, buildTasksCsv, buildNotesExport, importFromJsonFile, importData, importMarkdownFolder, importMarkdownFolderDialog, exportData, openNoteFile } from './export'
import { TASK_ID_OFFSET, FLASH_ID_OFFSET, FOLDER_ID_OFFSET, ANCHOR_ID_OFFSET, folderNodeId, anchorNodeId, classifyEdge, graphNodeId, buildGraphTracked, acyclicOwnershipEdges, diffGraph, graphDelta, graphNeighborhood, graphPreview, isGraphWatching, setGraphWatch, connectionAllowed, resolveEdgeKind, wouldCreateCycle, linkNotes, linkTaskNoteRef, unlinkTaskNoteRef, unlinkNotes, connectGraphNodes, removeGraphEdge, rewireGraphEdge } from './graph'
import { FLASH_COLUMNS, getFlash, listFlashesByStatus, addFlash, setFlashStatus, deleteFlash, markFlashConverted, flashToTask, flashToNote, updateFlashRemark, tagFlash, mergeFlashes, flashToSubtask } from './inbox'
import { shiftDay, rollRecurringToday, resumeDueToday, recordPomodoro, pomodoroToday, dueReminders, dismissReminder, snoozeReminder, saveWidgetGeometry, currentSettings, seedIfEmpty } from './maintenance'
import { NOTE_COLUMNS, listNoteFolders, getNote, resolveNoteTitle, syncNoteLinks, saveNote, createNote, deleteNote, listOutLinks, listBacklinks, materializeDangling, bindDanglingByTitle, createNoteFolder, renameNoteFolder, ensureDefaultFolder, moveNoteFolder, deleteNoteFolder, addReferenceLink, appendNote, attachNoteBlockContext, listNoteBlockContexts, noteAttachedTasks, noteTaskCandidates, NOTE_REVISION_LIMIT, NOTE_TEMPLATES, snapshotNote, listNoteRevisions, restoreNoteRevision, orphanNotes, brokenLinks, createNoteFromTemplate } from './notes'
import {
  previewOfficeNote,
  officeDocNote,
  saveWordNote,
  saveExcelNote,
  createBlankOfficeFile,
} from './preview'
import { dayOf, todayRoots, reviewStats } from './review'
import { listSettings, setSetting, setSettings, backupDatabase } from './settings'
import { autoBackup, listBackups, restoreBackup } from './backup'
import { globalSearch, searchTouch } from './search'
import { listFolders, listTasksByList, createListFolder, renameListFolder, deleteListFolder, moveTaskToList, defaultListId } from './lists'
import { linkTaskWikiNotes } from './task-note-links'
import { siblingsOf, isDescendantOf, reorderTask, moveTaskRelative, reparentTask, batchComplete, batchMove, batchSetDue, listTags, setTaskTags, ensureListId, quickAdd } from './task-ops'
import { listTasks, listTodayTasks, recentNotes, noteCountMap, tagMap, listNotes, overview, toggleTask, cloneTaskTree, setPriority, setTitle, setStatus, setDueDate, nextSortKey, createTask, EDITABLE_FIELDS, updateTask, softDelete, batchDeleteTasks, batchUndoLast, attachTaskNote, detachTaskNote, listLinkedNotes, pauseTask, resumeTask, attachBlock, detachBlock, listLinkedContexts, contextsForNote, noteContextMap, writeNoteAfterDone, taskCandidates } from './tasks'
import { trashItems, restoreTrash, purgeTrash, emptyTrash, emptyAllTrash, purgeTrashOlderThan, tagsWithUsage, createTag, renameTag, deleteTag, batchDeleteTags, mergeTags } from './trash'
import { attachmentStats, deleteAttachment, importAttachment, listAttachments, pruneAttachments } from './attachments'
import { deleteSavedQuery, listSavedQueries, saveSavedQuery } from './queries'
import { NODE_COLUMNS, orderedNodes, nextWorkflowNode, validateWorkflowTemplate, listWorkflowTemplates, getWorkflowTemplate, saveWorkflowTemplate, deleteWorkflowTemplate, duplicateWorkflowTemplate, autoLayoutWorkflowNodes, updateWorkflowNodePos, batchUpdateNodePos, setWorkflowBranch, spawnStepTask, instantiateWorkflow, getWorkflowInstance, listWorkflowInstances, listWorkflowInstancesByTask, completeWorkflowStep, abortWorkflowInstance, retryWorkflowStep, deleteWorkflowInstance, rerunWorkflowInstance, setWorkflowNotifier, splitCommand, describeWorkflowAction, runWorkflowAction, listWorkflowGroups, workflowTemplateGroups, saveWorkflowGroup, deleteWorkflowGroup, moveWorkflowTemplate, renameWorkflowInstance } from './workflow'
import type { EditableField } from './tasks'
import type { TrashItem } from './trash'
import type { DataDomain } from '../../shared/events'
import type { GraphNodePayload, GraphQuery, TaskStatus } from '../../shared/types'

// ---------------------------------------------------------------- 数据变更广播（O3）

/** 写操作 → 需要通知的域；只列写操作，读操作不进这张表。 */
const WRITE_DOMAINS: Record<string, DataDomain | DataDomain[]> = {
  'db:toggleTask': 'task',
  'db:setPriority': 'task',
  'db:setTitle': 'task',
  'db:setStatus': 'task',
  'db:setDueDate': 'task',
  'db:createTask': 'task',
  'db:updateTask': 'task',
  'db:restoreCompleted': 'task',
  'db:deleteTask': 'task',
  'db:reorderTask': 'task',
  'db:moveTaskRelative': 'task',
  'db:reparentTask': 'task',
  'db:batchComplete': 'task',
  'db:batchMove': 'task',
  'db:batchSetDue': 'task',
  'db:batchDeleteTasks': 'task',
  'db:batchDeleteTags': 'task',
  'db:batchUndoLast': 'task',
  'db:batchUpdateNodePos': 'workflow',
  // 清空回收站会动三类数据，声明多个域（handle 支持数组）
  'db:emptyAllTrash': ['task', 'note', 'flash'],
  'db:setTaskTags': 'task',
  'db:quickAdd': 'task',
  'db:saveNote': 'note',
  'db:createNote': 'note',
  'db:deleteNote': 'note',
  'db:restoreNoteRevision': 'note',
  'db:createNoteFromTemplate': 'note',
  'db:createNoteFolder': 'note',
  'db:renameNoteFolder': 'note',
  'db:deleteNoteFolder': 'note',
  'db:moveNoteFolder': 'note',
  'db:addReferenceLink': 'note',
  'db:saveWordNote': 'note',
  'db:saveExcelNote': 'note',
  'db:appendNote': 'note',
  // 段落锚同时改到笔记侧（定位）与任务侧（关联段落），两侧都要刷新
  'db:attachNoteBlock': ['note', 'task'],
  'db:bindDanglingByTitle': 'note',
  'db:materializeDangling': 'note',
  'db:addFlash': 'flash',
  // 真正在跑的通道是这两个；原先这里写的是 'db:setFlashStatus' —— 那个通道从未注册过，
  // 于是「归档 / 取消归档闪念」写库成功却零广播，其它视图停在旧数据（见 architecture.test.ts 的死键断言）
  'db:archiveFlash': 'flash',
  'db:unarchiveFlash': 'flash',
  'db:deleteFlash': 'flash',
  'db:flashToTask': 'flash',
  'db:flashToNote': 'flash',
  'db:updateFlashRemark': 'flash',
  'db:tagFlash': 'flash',
  'db:mergeFlashes': 'flash',
  'db:flashToSubtask': 'flash',
  'db:saveWorkflowTemplate': 'workflow',
  'db:duplicateWorkflowTemplate': 'workflow',
  'db:autoLayoutWorkflow': 'workflow',
  'db:deleteWorkflowTemplate': 'workflow',
  'db:updateWorkflowNodePos': 'workflow',
  'db:instantiateWorkflow': 'workflow',
  'db:completeWorkflowStep': 'workflow',
  'db:retryWorkflowStep': 'workflow',
  'db:abortWorkflowInstance': 'workflow',
  'db:deleteWorkflowInstance': 'workflow',
  'db:rerunWorkflowInstance': 'workflow',
  'db:linkNotes': 'note',
  'db:linkTaskNoteRef': 'task',
  'db:unlinkTaskNoteRef': 'task',
  'db:unlinkNotes': 'note',
  // 图谱连线编辑动的是两端的真数据，笔记与任务两侧都要刷新
  'db:connectGraphNodes': ['note', 'task'],
  'db:removeGraphEdge': ['note', 'task'],
  'db:rewireGraphEdge': ['note', 'task'],
  'db:setWorkflowBranch': 'workflow',
  'db:saveWorkflowGroup': 'workflow',
  'db:deleteWorkflowGroup': 'workflow',
  'db:moveWorkflowTemplate': 'workflow',
  'db:renameWorkflowInstance': 'workflow',
  'db:saveSavedQuery': 'settings',
  'db:deleteSavedQuery': 'settings',
  'db:importAttachment': 'note',
  'db:deleteAttachment': 'note',
  'db:pruneAttachments': 'note',
  'db:createListFolder': 'task',
  'db:renameListFolder': 'task',
  'db:deleteListFolder': 'task',
  'db:moveTaskToList': 'task',
  'db:pauseTask': 'task',
  'db:resumeTask': 'task',
  // 段落级上下文：任务侧「关联段落」与笔记侧反链/图谱两侧都要刷新
  'db:attachBlock': ['task', 'note'],
  'db:detachBlock': ['task', 'note'],
  // 任务↔笔记的归属关联（写 task_note_link）此前漏登记：行内 ⇄N 计数与图谱边不会跟着刷新
  'db:attachTaskNote': 'task',
  // 显式重解析任务正文的 [[链接]]（对齐 Python 的 link_wiki_notes）：
  // 新建/改名已会自动回绑，这个入口是给「修复上线前就写坏的历史数据」用的
  'db:linkTaskWikiNotes': 'task',
  'db:detachTaskNote': 'task',
  // 建默认笔记文件夹会写 note_folder
  'db:ensureDefaultFolder': 'note',
  'db:writeNoteAfterDone': ['task', 'note'],
  'db:setSetting': 'settings',
  'db:setSettings': 'settings',
  // 回收站操作按 kind 动的是三类记录之一（任务清理还会级联 workflow_step_task），
  // 逐个 kind 判断做不到就整组广播：多刷一次无害，漏刷才会让页面显示陈数据（D14）
  'db:restoreTrash': ['task', 'note', 'flash', 'workflow'],
  'db:purgeTrash': ['task', 'note', 'flash', 'workflow'],
  'db:emptyTrash': ['task', 'note', 'flash', 'workflow'],
  'db:purgeTrashOlderThan': ['task', 'note', 'flash', 'workflow'],
  'db:createTag': 'task',
  'db:renameTag': 'task',
  'db:deleteTag': 'task',
  'db:mergeTags': 'task',
  'db:rollRecurringToday': 'task',
  'db:resumeDueToday': 'task',
  'db:recordPomodoro': 'task',
  'db:dismissReminder': 'task',
  'db:snoozeReminder': 'task',
  // 导入是整库替换（对齐 Python 的 backup_restored 全量刷新）：只广播 task 会留下
  // 过期的笔记/闪念/工作流/设置视图（D14）
  'db:importFromPath': ['task', 'note', 'flash', 'workflow', 'settings'],
  'db:importData': ['task', 'note', 'flash', 'workflow', 'settings'],
  'db:importMarkdownFolder': 'note',
  'db:importMarkdownFromPath': 'note',
}

/** 数据变更后的额外通知（托盘标题等主进程侧 UI 用），由 main 注入，避免反向依赖。 */
let dataChangedHook: (() => void) | null = null
export function setDataChangedHook(fn: () => void): void {
  dataChangedHook = fn
}

/** 向所有窗口广播一次数据变更（浮窗等第二窗口也能同步）。 */
export function broadcastDataChanged(domain: DataDomain): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('data:changed', domain)
  }
  // G5/G6：笔记/任务/闪念写入后，图谱相关的域顺带推一帧增量（diff 在数据层算），
  // 图页据此定点增删并保留坐标；没有图页在看时不白算。
  if ((domain === 'note' || domain === 'task' || domain === 'flash') && isGraphWatching()) {
    try {
      broadcastGraphDelta()
    } catch (err) {
      console.error('[graph] 增量推送失败', err)
    }
  }
  try {
    dataChangedHook?.()
  } catch (err) {
    console.error('[db] 数据变更钩子失败', err)
  }
}

/** 把当前图谱增量推给所有窗口（对齐 Python 的 bus.graph_delta）。 */
function broadcastGraphDelta(): void {
  const delta = graphDelta()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('graph:delta', delta)
  }
}

/**
 * 注册 IPC：写操作完成后自动广播所属域，读操作直接返回。
 * 用包装器而不是在每个 handler 里手写广播，是为了不漏、也不重复。
 */
/**
 * 任务完成时推进它所属的工作流实例（对齐 app_controller._advance_workflow_for_task）。
 * 放在 IPC 层而不是仓储层：workflow.ts 已经依赖 tasks.ts，反向引用会形成循环。
 * 推进失败只记录 —— 流程不该把任务本身的操作拖失败。
 */
async function advanceWorkflowForTask(taskId: number): Promise<void> {
  try {
    // 推进可能要求值条件节点（人工确认 / 脚本退出码），所以是异步的
    if (await completeWorkflowStep(taskId)) broadcastDataChanged('workflow')
  } catch (err) {
    console.error('[workflow] 推进实例失败', err)
  }
}

type IpcHandler = (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown

function handle(channel: string, fn: IpcHandler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    const result = await fn(event, ...(args as never[]))
    const domain = WRITE_DOMAINS[channel]
    // 允许一个写操作声明多个域：图谱编辑会同时改到笔记与任务两侧
    if (Array.isArray(domain)) for (const d of domain) broadcastDataChanged(d)
    else if (domain) broadcastDataChanged(domain)
    return result
  })
}

export function registerDbHandlers(): void {
  // 自动步骤（命令 / 脚本）是在主进程后台推进的：跑完一步必须主动告诉渲染层刷新，
  // 否则页面上会一直显示「运行中」，直到用户手动切页。
  setWorkflowNotifier(() => broadcastDataChanged('workflow'))
  // 首次启动写入欢迎内容（对齐 Python ctx.seed_if_empty，D24）：只在空库时写，
  // 放在注册 IPC 之前，保证窗口首次取数时种子数据已就位。
  try {
    seedIfEmpty()
  } catch (err) {
    console.error('[db] 写入欢迎内容失败', err)
  }
  // 只读分支（D2）：ready=库是否打开；readonly=能打开但迁移失败（显示只读横幅+恢复备份入口）；
  // error=完全打不开时的中文原因。
  handle('db:info', () => {
    const c = open()
    return {
      path: openedPath || dbPath(),
      ready: c !== null,
      readonly: dbReadonlyReason(),
      error: c === null ? dbOpenError() : '',
    }
  })
  handle('db:overview', () => overview())
  handle('db:tasks', (_e, limit?: number) => listTasks(limit))
  handle('db:todayTasks', () => listTodayTasks())
  handle('db:quickAdd', (_e, text: string, defaultListId?: number | null) =>
    quickAdd(text, defaultListId ?? null)
  )
  handle('db:reorderTask', (_e, id: number, anchorId: number, below?: boolean) =>
    reorderTask(id, anchorId, below ?? true)
  )
  handle('db:moveTaskRelative', (_e, id: number, delta: number) => moveTaskRelative(id, delta))
  handle('db:reparentTask', (_e, id: number, parentId: number | null) =>
    reparentTask(id, parentId)
  )
  handle('db:batchComplete', (_e, ids: number[]) => {
    const n = batchComplete(ids)
    for (const id of ids) void advanceWorkflowForTask(id)
    return n
  })
  handle('db:batchMove', (_e, ids: number[], listId: number | null) => batchMove(ids, listId))
  // 批量删除：一次调用一个事务（渲染层原先在循环里逐条 IPC，见 docs/adr/0001）
  handle('db:batchDeleteTasks', (_e, ids: number[]) => batchDeleteTasks(ids))
  handle('db:batchDeleteTags', (_e, ids: number[]) => batchDeleteTags(ids))
  handle('db:batchUndoLast', (_e, ids: number[], action: 'toggle' | 'restore', prevStatus: string | null) =>
    batchUndoLast(ids, action, (prevStatus ?? null) as never)
  )
  handle('db:batchUpdateNodePos', (_e, items: { id: number; x: number; y: number }[]) =>
    batchUpdateNodePos(Array.isArray(items) ? items : [])
  )
  handle('db:emptyAllTrash', () => emptyAllTrash())
  handle('db:batchSetDue', (_e, ids: number[], due: string | null) => batchSetDue(ids, due))
  handle('db:tags', () => listTags())
  handle('db:setTaskTags', (_e, id: number, names: string[]) => setTaskTags(id, names))
  handle('db:recentNotes', (_e, limit?: number) => recentNotes(limit))
  handle(
    'db:runWorkflowAction',
    (_e, kind: string, value: string, expect?: string, runtime?: string) =>
      runWorkflowAction(kind, value, expect ?? '', runtime ?? '')
  )
  handle('db:describeWorkflowAction', (_e, kind: string, value: string, expect?: string, runtime?: string) =>
    describeWorkflowAction(kind, value, expect, runtime)
  )
  handle(
    'db:recordPomodoro',
    (_e, taskId: number | null, minutes: number, completed: boolean, reason?: string | null) =>
      recordPomodoro(taskId, minutes, completed, reason ?? null)
  )
  handle('db:pomodoroToday', () => pomodoroToday())
  /**
   * 到点提醒的**只读**查询。
   *
   * 此前它是「查 + 清」合一的，于是「谁是消费方」变成了一个隐式约定。现在消费收归主进程
   * 一处（main/index.ts 的 startReminderDispatch）：那边查出到期项、清掉 reminder_at、
   * 再把结果推给该显示的窗口。渲染层若自己调这里，只会和气泡窗口抢，反而少看到一条。
   */
  handle('db:dueReminders', () => {
    if (!currentSettings().reminder_enabled) return []
    return dueReminders()
  })
  handle('db:dismissReminder', (_e, id: number) => dismissReminder(id))
  handle('db:snoozeReminder', (_e, id: number, minutes: number) => snoozeReminder(id, minutes))
  handle('db:listFolders', () => listFolders())
  handle('db:tasksByList', (_e, listId: number | null) => listTasksByList(listId))
  handle('db:createListFolder', (_e, name: string, kind: 'group' | 'list', parentId: number | null) =>
    createListFolder(name, kind, parentId)
  )
  handle('db:renameListFolder', (_e, id: number, name: string) => renameListFolder(id, name))
  handle('db:deleteListFolder', (_e, id: number) => deleteListFolder(id))
  handle('db:moveTaskToList', (_e, taskId: number, listId: number | null) =>
    moveTaskToList(taskId, listId)
  )
  handle('db:pauseTask', (_e, id: number, resumeAt?: string | null) => pauseTask(id, resumeAt ?? null))
  handle('db:resumeTask', (_e, id: number, status?: TaskStatus) => resumeTask(id, status ?? 'todo'))
  handle(
    'db:attachBlock',
    (_e, taskId: number, noteId: number, blockKey: string, snippet?: string) =>
      attachBlock(taskId, noteId, blockKey, snippet ?? '')
  )
  handle('db:detachBlock', (_e, taskId: number, noteId: number, blockKey?: string) =>
    detachBlock(taskId, noteId, blockKey ?? '')
  )
  handle('db:linkedContexts', (_e, taskId: number) => listLinkedContexts(taskId))
  handle('db:contextsForNote', (_e, noteId: number) => contextsForNote(noteId))
  handle('db:noteContextMap', (_e, taskIds: number[]) => noteContextMap(taskIds))
  handle('db:writeNoteAfterDone', (_e, taskId: number, title: string) =>
    writeNoteAfterDone(taskId, title)
  )
  handle('db:taskCandidates', (_e, q?: string, limit?: number) => taskCandidates(q ?? '', limit ?? 20))
  handle('db:linkTaskWikiNotes', (_e, taskId: number) => linkTaskWikiNotes(taskId))

  handle('db:attachTaskNote', (_e, taskId: number, noteId: number) =>
    attachTaskNote(taskId, noteId)
  )
  handle('db:detachTaskNote', (_e, taskId: number, noteId: number) =>
    detachTaskNote(taskId, noteId)
  )
  handle('db:linkedNotes', (_e, taskId: number) => listLinkedNotes(taskId))
  handle('db:graphConnectionAllowed', (_e, srcKind: string, dstKind: string) =>
    connectionAllowed(srcKind, dstKind)
  )
  handle('db:linkNotes', (_e, srcId: number, dstId: number) => linkNotes(srcId, dstId))
  handle('db:linkTaskNoteRef', (_e, taskId: number, noteId: number) =>
    linkTaskNoteRef(taskId, noteId)
  )
  handle('db:unlinkTaskNoteRef', (_e, taskId: number, noteId: number) =>
    unlinkTaskNoteRef(taskId, noteId)
  )
  handle('db:unlinkNotes', (_e, srcId: number, dstId: number) => unlinkNotes(srcId, dstId))
  handle(
    'db:connectGraphNodes',
    (
      _e,
      srcKind: string,
      srcRef: number,
      dstKind: string,
      dstRef: number,
      edgeKind: 'ownership' | 'reference'
    ) => connectGraphNodes(srcKind, srcRef, dstKind, dstRef, edgeKind)
  )
  handle(
    'db:removeGraphEdge',
    (
      _e,
      srcKind: string,
      srcRef: number,
      dstKind: string,
      dstRef: number,
      edgeKind: 'ownership' | 'reference'
    ) => removeGraphEdge(srcKind, srcRef, dstKind, dstRef, edgeKind)
  )
  handle('db:rewireGraphEdge', (_e, params: Parameters<typeof rewireGraphEdge>[0]) =>
    rewireGraphEdge(params)
  )
  handle('db:globalSearch', (_e, q: string) => globalSearch(q))
  // G13：MRU —— 命令面板选中某条命中时记一次，后续搜索按最近访问优先
  handle('db:searchTouch', (_e, kind: string, id: number) => {
    searchTouch(kind, id)
    return true
  })
  handle('db:listBackups', () => listBackups())
  // 恢复备份会整体替换数据库：成功后把所有域都广播一遍，让各页面重新取数
  handle('db:restoreBackup', (_e, file: string) => {
    const res = restoreBackup(file)
    if (res.ok) {
      const domains: DataDomain[] = ['task', 'note', 'flash', 'workflow', 'settings']
      for (const d of domains) broadcastDataChanged(d)
    }
    return res
  })
  handle('db:exportPreview', (_e, kind: 'json' | 'csv' | 'markdown') => {
    if (kind === 'json') {
      const { data, count } = buildExportJson()
      return { count, keys: Object.keys(data), app: data.app, version: data.version }
    }
    if (kind === 'csv') {
      const { text, count } = buildTasksCsv()
      return { count, head: text.slice(0, 120), hasBom: text.charCodeAt(0) === 0xfeff }
    }
    const notes = buildNotesExport()
    return { count: notes.length, folders: [...new Set(notes.map((n) => n.folder))].slice(0, 5) }
  })
  handle('db:importData', (e) => importData(e.sender))
  // Markdown 文件夹导入（D25）：一个走系统对话框，一个供脚本按路径直接导入
  handle('db:importMarkdownFolder', (e) => importMarkdownFolderDialog(e.sender))
  handle('db:importMarkdownFromPath', (_e, path: string) => importMarkdownFolder(path))
  // 供自动化脚本直接按路径导入（等价于用户在对话框里选同一个文件）
  handle('db:importFromPath', (_e, path: string) => importFromJsonFile(path))
  handle('db:openNoteFile', (_e, id: number) => openNoteFile(id))
  handle('db:previewNote', (_e, id: number) => previewOfficeNote(id))
  // N-§1.3#5：Word/Excel 可编辑写回（对齐 WordEditView / ExcelEditView）
  handle('db:officeDoc', (_e, id: number) => officeDocNote(id))
  handle('db:saveWordNote', (_e, id: number, html: string) => saveWordNote(id, html))
  handle('db:saveExcelNote', (_e, id: number, rows: string[][]) => saveExcelNote(id, rows))
  // N3：Word/Excel 未指定文件时自动新建空白文件
  handle('db:createBlankOffice', (_e, format: string, title: string) =>
    createBlankOfficeFile(format, title)
  )
  handle('db:exportData', (e, kind: 'json' | 'csv' | 'markdown' | 'markdown-zip') =>
    exportData(e.sender, kind)
  )
  handle('db:rollRecurringToday', () => rollRecurringToday())
  handle('db:resumeDueToday', () => resumeDueToday())
  handle('db:trashItems', (_e, kind: 'task' | 'note' | 'flash') => trashItems(kind))
  handle('db:restoreTrash', (_e, kind: 'task' | 'note' | 'flash', id: number) =>
    restoreTrash(kind, id)
  )
  handle('db:purgeTrash', (_e, kind: 'task' | 'note' | 'flash', id: number) =>
    purgeTrash(kind, id)
  )
  handle('db:emptyTrash', (_e, kind: 'task' | 'note' | 'flash') => emptyTrash(kind))
  handle('db:purgeTrashOlderThan', (_e, days: number) => purgeTrashOlderThan(days))
  handle('db:tagsWithUsage', () => tagsWithUsage())
  handle('db:createTag', (_e, name: string, color?: string) => createTag(name, color))
  handle('db:renameTag', (_e, id: number, name: string) => renameTag(id, name))
  handle('db:deleteTag', (_e, id: number) => deleteTag(id))
  handle('db:mergeTags', (_e, target: number, sources: number[]) => mergeTags(target, sources))
  handle('db:noteRevisions', (_e, id: number) => listNoteRevisions(id))
  handle('db:restoreNoteRevision', (_e, noteId: number, revId: number) =>
    restoreNoteRevision(noteId, revId)
  )
  handle('db:orphanNotes', () => orphanNotes())
  handle('db:brokenLinks', () => brokenLinks())
  handle('db:noteTemplates', () => Object.keys(NOTE_TEMPLATES))
  handle('db:createNoteFromTemplate', (_e, kind: string, folderId: number | null) =>
    createNoteFromTemplate(kind, folderId)
  )
  // N17：对齐 NoteRepository.all()（无 LIMIT）。listNotes 自身默认 300，
  // 这里在没有显式 limit 时传 -1（SQLite 的「不限量」），笔记页不再被截断。
  handle('db:notes', (_e, limit?: number) => listNotes(limit ?? -1))
  handle('db:flashes', (_e, status?: string | null) =>
    listFlashesByStatus(status === undefined ? 'inbox' : status)
  )
  // 收件箱 = list_tree(None)：只以「顶层且 list_id 为空」的任务为根 + 完整子树闭包，
  // 不能按 list_id IS NULL 平铺（否则子任务会同时出现在收件箱，T6）。
  handle('db:inboxTasks', () => listTasksByList(null))
  handle(
    'db:updateFlashRemark',
    (_e, id: number, remark: string) => updateFlashRemark(id, remark)
  )
  handle('db:tagFlash', (_e, id: number, tags: string[]) => {
    tagFlash(id, tags)
    return 1
  })
  handle('db:mergeFlashes', (_e, ids: number[]) => mergeFlashes(ids)?.id ?? null)
  handle('db:flashToSubtask', (_e, id: number, parentTaskId: number) =>
    flashToSubtask(id, parentTaskId)
  )
  handle('db:addFlash', (_e, content: string, remark?: string, sourceApp?: string, sourceUrl?: string) =>
    addFlash(content, remark ?? '', sourceApp ?? '', sourceUrl ?? '')
  )
  handle('db:archiveFlash', (_e, id: number) => setFlashStatus(id, 'archived'))
  handle('db:unarchiveFlash', (_e, id: number) => setFlashStatus(id, 'inbox'))
  handle('db:deleteFlash', (_e, id: number) => deleteFlash(id))
  handle('db:flashToTask', (_e, id: number) => flashToTask(id))
  handle('db:flashToNote', (_e, id: number, folderId?: number | null) =>
    flashToNote(id, folderId ?? null)
  )
  handle('db:noteCounts', () => noteCountMap())
  handle('db:taskTags', () => tagMap())

  handle('db:settings', () => listSettings())
  handle('db:setSetting', (_e, key: string, value: string) => setSetting(key, value))
  handle('db:setSettings', (_e, entries: Record<string, string>) => setSettings(entries))
  handle('db:backupDatabase', (_e, dir: string) => backupDatabase(dir))
  handle('db:reviewStats', () => reviewStats())
  handle('db:workflowTemplates', () => listWorkflowTemplates())
  handle('db:workflowTemplate', (_e, id: number) => getWorkflowTemplate(id))
  handle('db:saveWorkflowTemplate', (_e, tpl: Parameters<typeof saveWorkflowTemplate>[0]) =>
    saveWorkflowTemplate(tpl)
  )
  handle('db:deleteWorkflowTemplate', (_e, id: number) => deleteWorkflowTemplate(id))
  // 复制模板（对齐 duplicate_template）：名称加「 副本」，节点整体复制
  handle('db:duplicateWorkflowTemplate', (_e, id: number) => duplicateWorkflowTemplate(id))
  // 一键对齐：pos_x=0、pos_y=i*yGap（对齐 _auto_layout 的纵向网格）
  handle('db:autoLayoutWorkflow', (_e, templateId: number, yGap: number) =>
    autoLayoutWorkflowNodes(templateId, yGap)
  )
  // 某任务启动/关联的实例（对齐 instances_of_task，任务侧「工作流」卡片用）
  handle('db:workflowInstancesOfTask', (_e, taskId: number) =>
    listWorkflowInstancesByTask(taskId)
  )
  handle('db:updateWorkflowNodePos', (_e, id: number, x: number, y: number) =>
    updateWorkflowNodePos(id, x, y)
  )
  handle('db:setWorkflowBranch', (_e, id: number, branchId: number | null, slot?: string) =>
    // 三参调用是「满足 / 不满足」两条边；两参（旧脚本）按「满足」处理
    setWorkflowBranch(id, branchId, slot === 'false' ? 'false' : 'true')
  )
  handle(
    'db:instantiateWorkflow',
    (_e, templateId: number, title: string | null, originTaskId: number | null, policy?: string) =>
      instantiateWorkflow(templateId, title, originTaskId, policy)
  )
  handle('db:savedQueries', () => listSavedQueries())
  handle('db:saveSavedQuery', (_e, input: Parameters<typeof saveSavedQuery>[0]) => saveSavedQuery(input))
  handle('db:deleteSavedQuery', (_e, id: number) => deleteSavedQuery(id))
  handle('db:attachments', () => listAttachments())
  handle('db:attachmentStats', () => attachmentStats())
  handle('db:importAttachment', (_e, noteId: number, srcPath: string) =>
    importAttachment(noteId, srcPath)
  )
  handle('db:deleteAttachment', (_e, id: number) => deleteAttachment(id))
  handle('db:pruneAttachments', () => pruneAttachments())
  handle('db:workflowGroups', () => listWorkflowGroups())
  handle('db:workflowTemplateGroups', () => workflowTemplateGroups())
  handle('db:saveWorkflowGroup', (_e, input: Parameters<typeof saveWorkflowGroup>[0]) =>
    saveWorkflowGroup(input)
  )
  handle('db:deleteWorkflowGroup', (_e, id: number) => deleteWorkflowGroup(id))
  handle('db:moveWorkflowTemplate', (_e, id: number, groupId: number | null) =>
    moveWorkflowTemplate(id, groupId)
  )
  handle('db:renameWorkflowInstance', (_e, id: number, title: string) =>
    renameWorkflowInstance(id, title)
  )
  handle('db:workflowInstances', (_e, status?: string | null) =>
    listWorkflowInstances(status ?? null)
  )
  handle('db:workflowInstance', (_e, id: number) => getWorkflowInstance(id))
  handle('db:completeWorkflowStep', (_e, taskId: number) => completeWorkflowStep(taskId))
  // 自动步骤失败后原地重跑（失败时实例停在当前节点，没有这个入口就只能中止）
  handle('db:retryWorkflowStep', (_e, instanceId: number) => retryWorkflowStep(instanceId))
  handle('db:abortWorkflowInstance', (_e, id: number) => abortWorkflowInstance(id))
  // 删除实例记录（不动模板，也不删已派生的任务）
  handle('db:deleteWorkflowInstance', (_e, id: number) => deleteWorkflowInstance(id))
  // 重复运行：按同一模板再启动一个新实例，旧记录保留
  handle('db:rerunWorkflowInstance', (_e, id: number) => rerunWorkflowInstance(id))
  // G7：图谱构建参数（includeTasks / 文件夹 / 标签 / 邻域），默认纳入任务节点
  handle('db:graph', (_e, query?: GraphQuery) => buildGraphTracked({ includeTasks: true, ...(query ?? {}) }))
  // G8：笔记邻域子图（仅沿 note_link 做 1~2 度 BFS）
  handle('db:graphNeighborhood', (_e, noteId: number, degree?: number) =>
    graphNeighborhood(noteId, degree ?? 1)
  )
  // G9：选中节点预览文本（按类型输出摘要/状态/优先级/截止/父任务/关联笔记/来源）
  handle('db:graphPreview', (_e, node: GraphNodePayload) => graphPreview(node))
  // G5：图页开关增量推送（没人看图时不重算 diff）
  handle('db:graphWatch', (_e, active: boolean) => {
    setGraphWatch(active)
    return true
  })
  /**
   * G10：图页双击闪念/任务/文件夹的跨页跳转。
   * 复用主窗口既有的深链通道（app:deeplink → App 的 onDeepLink 分支），
   * 这样图谱不必为了跳页去持有 App 的页面路由状态。
   */
  handle('db:graphOpenNode', (e, kind: string, id: number) => {
    e.sender.send('app:deeplink', { kind, id, block: '' })
    return true
  })
  // N-§1.3#13：文件夹为空时补默认文件夹（对齐 note_page._reload_tree → ensure_default_folder）
  handle('db:ensureDefaultFolder', () => ensureDefaultFolder())
  handle('db:noteFolders', () => listNoteFolders())
  handle('db:note', (_e, id: number) => getNote(id))
  handle('db:resolveNoteTitle', (_e, title: string) => resolveNoteTitle(title))
  handle('db:outLinks', (_e, id: number) => listOutLinks(id))
  handle('db:backlinks', (_e, id: number) => listBacklinks(id))
  handle('db:saveNote', (_e, id: number, fields: Record<string, unknown>) =>
    saveNote(
      id,
      fields as {
        title?: string
        content_md?: string
        folder_id?: number | null
        pinned?: boolean
        // N3：saveNote 支持 format，UI 才有「改格式」入口
        format?: string
      }
    )
  )
  handle(
    'db:createNote',
    (_e, title: string, folderId: number | null, content?: string, format?: string) =>
      createNote(title, folderId, content ?? '', format ?? 'markdown')
  )
  handle('db:deleteNote', (_e, id: number) => deleteNote(id))
  handle('db:materializeDangling', (_e, srcId: number, title: string) =>
    materializeDangling(srcId, title)
  )
  handle('db:bindDanglingByTitle', (_e, title: string) => bindDanglingByTitle(title))
  handle('db:createNoteFolder', (_e, name: string, parentId: number | null) =>
    createNoteFolder(name, parentId)
  )
  handle('db:renameNoteFolder', (_e, id: number, name: string) => renameNoteFolder(id, name))
  handle('db:deleteNoteFolder', (_e, id: number) => deleteNoteFolder(id))
  handle('db:moveNoteFolder', (_e, id: number, parentId: number | null) =>
    moveNoteFolder(id, parentId)
  )
  handle('db:addReferenceLink', (_e, srcId: number, target: number | string) =>
    addReferenceLink(srcId, target)
  )
  handle('db:appendNote', (_e, id: number, text: string) => appendNote(id, text))
  handle('db:attachNoteBlock', (_e, taskId: number, noteId: number, blockKey: string, snippet: string) =>
    attachNoteBlockContext(taskId, noteId, blockKey, snippet)
  )
  handle('db:noteBlockContexts', (_e, noteId: number) => listNoteBlockContexts(noteId))
  handle('db:noteAttachedTasks', (_e, noteId: number) => noteAttachedTasks(noteId))
  handle('db:noteTaskCandidates', (_e, q: string, limit?: number) =>
    noteTaskCandidates(q ?? '', limit ?? 30)
  )

  // N1：关窗/刷新前最后一次落盘必须**同步**完成，否则渲染进程卸载后 invoke 永远不会回来。
  // 对齐 Python note_page 关窗前 commit 编辑器（阻塞式）的语义。
  ipcMain.on('db:flushNote', (event, id: number, fields: Record<string, unknown>) => {
    try {
      event.returnValue = !!saveNote(
        id,
        fields as { title?: string; content_md?: string }
      )
    } catch (err) {
      console.error('[db] 关窗前落盘失败', err)
      event.returnValue = false
    }
  })

  handle('db:toggleTask', (_e, id: number) => {
    const t = toggleTask(id)
    if (t?.status === 'done') void advanceWorkflowForTask(id)
    return t
  })
  handle('db:setPriority', (_e, id: number, priority: number) => setPriority(id, priority))
  handle('db:setTitle', (_e, id: number, title: string) => setTitle(id, title))
  handle('db:setStatus', (_e, id: number, status: TaskStatus) => {
    const t = setStatus(id, status)
    if (t?.status === 'done') void advanceWorkflowForTask(id)
    return t
  })
  handle('db:setDueDate', (_e, id: number, due: string | null) => setDueDate(id, due))
  handle('db:createTask', (_e, title: string, parentId: number | null, listId: number | null) =>
    createTask(title, parentId, listId)
  )
  // 把已完成的任务释放回待执行；连带恢复仍是终态的祖先，层级因此保留
  handle('db:getTask', (_e, id: number) => getTask(Number(id)))
  handle('db:restoreCompleted', (_e, id: number, listId?: number | null) =>
    restoreCompleted(Number(id), listId ?? null)
  )
  handle('db:updateTask', (_e, id: number, fields: Record<string, string | number | null>) => {
    const t = updateTask(id, fields)
    // 编辑面板把状态改成「已完成」同样要推进流程
    if (t?.status === 'done' && 'status' in fields) void advanceWorkflowForTask(id)
    return t
  })
  handle('db:deleteTask', (_e, id: number) => softDelete(id))
}
