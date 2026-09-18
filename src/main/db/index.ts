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
export * from './trash'
export * from './workflow'

// 显式导入供下方 IPC 注册使用（export * 不引入本地作用域）
import { APP_DIR_NAME, dataDir, dbPath, TASK_COLUMNS, open, conn, nowStamp, today, getTask, db, openedPath } from './connection'
import { EXPORT_TABLES, buildExportJson, buildTasksCsv, buildNotesExport, importFromJsonFile, importData, exportData, openNoteFile } from './export'
import { TASK_ID_OFFSET, FLASH_ID_OFFSET, FOLDER_ID_OFFSET, folderNodeId, classifyEdge, graphNodeId, buildGraph, connectionAllowed, resolveEdgeKind, wouldCreateCycle, linkNotes, linkTaskNoteRef, unlinkTaskNoteRef, unlinkNotes, connectGraphNodes, removeGraphEdge, rewireGraphEdge } from './graph'
import { FLASH_COLUMNS, listInboxTasks, getFlash, listFlashesByStatus, addFlash, setFlashStatus, deleteFlash, markFlashConverted, flashToTask, flashToNote, updateFlashRemark, tagFlash, mergeFlashes, flashToSubtask } from './inbox'
import { shiftDay, rollRecurringToday, resumeDueToday, recordPomodoro, pomodoroToday, dueReminders, dismissReminder, snoozeReminder, saveWidgetGeometry, currentSettings } from './maintenance'
import { NOTE_COLUMNS, listNoteFolders, getNote, resolveNoteTitle, syncNoteLinks, saveNote, createNote, deleteNote, listOutLinks, listBacklinks, materializeDangling, bindDanglingByTitle, createNoteFolder, renameNoteFolder, NOTE_REVISION_LIMIT, NOTE_TEMPLATES, snapshotNote, listNoteRevisions, restoreNoteRevision, orphanNotes, brokenLinks, createNoteFromTemplate } from './notes'
import { previewOfficeNote } from './preview'
import { dayOf, todayRoots, reviewStats } from './review'
import { listSettings, setSetting, setSettings, backupDatabase } from './settings'
import { autoBackup, listBackups, restoreBackup } from './backup'
import { globalSearch } from './search'
import { listFolders, listTasksByList, createListFolder, renameListFolder, deleteListFolder, moveTaskToList, defaultListId } from './lists'
import { siblingsOf, isDescendantOf, reorderTask, moveTaskRelative, reparentTask, batchComplete, batchMove, batchSetDue, listTags, setTaskTags, ensureListId, quickAdd } from './task-ops'
import { listTasks, listTodayTasks, recentNotes, noteCountMap, tagMap, listNotes, overview, toggleTask, cloneTaskTree, setPriority, setTitle, setStatus, setDueDate, nextSortKey, createTask, EDITABLE_FIELDS, updateTask, softDelete, syncTaskNoteLinks, attachTaskNote, detachTaskNote, listLinkedNotes } from './tasks'
import { trashItems, restoreTrash, purgeTrash, emptyTrash, purgeTrashOlderThan, tagsWithUsage, createTag, renameTag, deleteTag, mergeTags } from './trash'
import { NODE_COLUMNS, orderedNodes, nextWorkflowNode, validateWorkflowTemplate, listWorkflowTemplates, getWorkflowTemplate, saveWorkflowTemplate, deleteWorkflowTemplate, updateWorkflowNodePos, setWorkflowBranch, spawnStepTask, instantiateWorkflow, getWorkflowInstance, listWorkflowInstances, completeWorkflowStep, abortWorkflowInstance, splitCommand, describeWorkflowAction, runWorkflowAction } from './workflow'
import type { EditableField } from './tasks'
import type { TrashItem } from './trash'
import type { DataDomain } from '../../shared/events'
import type { TaskStatus } from '../../shared/types'

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
  'db:deleteTask': 'task',
  'db:reorderTask': 'task',
  'db:moveTaskRelative': 'task',
  'db:reparentTask': 'task',
  'db:batchComplete': 'task',
  'db:batchMove': 'task',
  'db:batchSetDue': 'task',
  'db:setTaskTags': 'task',
  'db:quickAdd': 'task',
  'db:saveNote': 'note',
  'db:createNote': 'note',
  'db:deleteNote': 'note',
  'db:restoreNoteRevision': 'note',
  'db:createNoteFromTemplate': 'note',
  'db:createNoteFolder': 'note',
  'db:renameNoteFolder': 'note',
  'db:bindDanglingByTitle': 'note',
  'db:materializeDangling': 'note',
  'db:addFlash': 'flash',
  'db:setFlashStatus': 'flash',
  'db:deleteFlash': 'flash',
  'db:flashToTask': 'flash',
  'db:flashToNote': 'flash',
  'db:updateFlashRemark': 'flash',
  'db:tagFlash': 'flash',
  'db:mergeFlashes': 'flash',
  'db:flashToSubtask': 'flash',
  'db:saveWorkflowTemplate': 'workflow',
  'db:deleteWorkflowTemplate': 'workflow',
  'db:updateWorkflowNodePos': 'workflow',
  'db:instantiateWorkflow': 'workflow',
  'db:completeWorkflowStep': 'workflow',
  'db:abortWorkflowInstance': 'workflow',
  'db:linkNotes': 'note',
  'db:linkTaskNoteRef': 'task',
  'db:unlinkTaskNoteRef': 'task',
  'db:unlinkNotes': 'note',
  // 图谱连线编辑动的是两端的真数据，笔记与任务两侧都要刷新
  'db:connectGraphNodes': ['note', 'task'],
  'db:removeGraphEdge': ['note', 'task'],
  'db:rewireGraphEdge': ['note', 'task'],
  'db:setWorkflowBranch': 'workflow',
  'db:createListFolder': 'task',
  'db:renameListFolder': 'task',
  'db:deleteListFolder': 'task',
  'db:moveTaskToList': 'task',
  'db:setSetting': 'settings',
  'db:setSettings': 'settings',
  'db:restoreTrash': 'task',
  'db:purgeTrash': 'task',
  'db:emptyTrash': 'task',
  'db:purgeTrashOlderThan': 'task',
  'db:createTag': 'task',
  'db:renameTag': 'task',
  'db:deleteTag': 'task',
  'db:mergeTags': 'task',
  'db:rollRecurringToday': 'task',
  'db:resumeDueToday': 'task',
  'db:recordPomodoro': 'task',
  'db:dismissReminder': 'task',
  'db:snoozeReminder': 'task',
  'db:importFromPath': 'task',
  'db:importData': 'task',
}

/** 数据变更后的额外通知（托盘标题等主进程侧 UI 用），由 main 注入，避免反向依赖。 */
let dataChangedHook: (() => void) | null = null
export function setDataChangedHook(fn: () => void): void {
  dataChangedHook = fn
}

/** 向所有窗口广播一次数据变更（浮窗等第二窗口也能同步）。 */
function broadcastDataChanged(domain: DataDomain): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('data:changed', domain)
  }
  try {
    dataChangedHook?.()
  } catch (err) {
    console.error('[db] 数据变更钩子失败', err)
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
function advanceWorkflowForTask(taskId: number): void {
  try {
    if (completeWorkflowStep(taskId)) broadcastDataChanged('workflow')
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
  handle('db:info', () => ({ path: openedPath || dbPath(), ready: open() !== null }))
  handle('db:overview', () => overview())
  handle('db:tasks', (_e, limit?: number) => listTasks(limit))
  handle('db:todayTasks', () => listTodayTasks())
  handle('db:quickAdd', (_e, text: string) => quickAdd(text))
  handle('db:reorderTask', (_e, id: number, anchorId: number, below?: boolean) =>
    reorderTask(id, anchorId, below ?? true)
  )
  handle('db:moveTaskRelative', (_e, id: number, delta: number) => moveTaskRelative(id, delta))
  handle('db:reparentTask', (_e, id: number, parentId: number | null) =>
    reparentTask(id, parentId)
  )
  handle('db:batchComplete', (_e, ids: number[]) => {
    const n = batchComplete(ids)
    for (const id of ids) advanceWorkflowForTask(id)
    return n
  })
  handle('db:batchMove', (_e, ids: number[], listId: number | null) => batchMove(ids, listId))
  handle('db:batchSetDue', (_e, ids: number[], due: string | null) => batchSetDue(ids, due))
  handle('db:tags', () => listTags())
  handle('db:setTaskTags', (_e, id: number, names: string[]) => setTaskTags(id, names))
  handle('db:recentNotes', (_e, limit?: number) => recentNotes(limit))
  handle('db:runWorkflowAction', (_e, kind: string, value: string) =>
    runWorkflowAction(kind, value)
  )
  handle('db:describeWorkflowAction', (_e, kind: string, value: string) =>
    describeWorkflowAction(kind, value)
  )
  handle(
    'db:recordPomodoro',
    (_e, taskId: number | null, minutes: number, completed: boolean, reason?: string) =>
      recordPomodoro(taskId, minutes, completed, reason ?? '')
  )
  handle('db:pomodoroToday', () => pomodoroToday())
  handle('db:dueReminders', () => {
    // 关掉「到点提醒」就不该再弹（对齐 app_controller：开关为 False 时直接 return）
    if (!currentSettings().reminder_enabled) return []
    const rows = dueReminders()
    // 弹出即视为已提醒：先清 reminder_at（对齐 app_controller 的弹窗前 dismiss），
    // 否则用户忽略弹窗后重启会被重复打扰。点「稍后」会写入新的 reminder_at。
    for (const t of rows) dismissReminder(t.id)
    return rows
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
  // 供自动化脚本直接按路径导入（等价于用户在对话框里选同一个文件）
  handle('db:importFromPath', (_e, path: string) => importFromJsonFile(path))
  handle('db:openNoteFile', (_e, id: number) => openNoteFile(id))
  handle('db:previewNote', (_e, id: number) => previewOfficeNote(id))
  handle('db:exportData', (e, kind: 'json' | 'csv' | 'markdown') =>
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
  handle('db:notes', (_e, limit?: number) => listNotes(limit))
  handle('db:flashes', (_e, status?: string | null) =>
    listFlashesByStatus(status === undefined ? 'inbox' : status)
  )
  handle('db:inboxTasks', () => listInboxTasks())
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
  handle('db:updateWorkflowNodePos', (_e, id: number, x: number, y: number) =>
    updateWorkflowNodePos(id, x, y)
  )
  handle('db:setWorkflowBranch', (_e, id: number, branchId: number | null) =>
    setWorkflowBranch(id, branchId)
  )
  handle(
    'db:instantiateWorkflow',
    (_e, templateId: number, title: string | null, originTaskId: number | null, policy?: string) =>
      instantiateWorkflow(templateId, title, originTaskId, policy)
  )
  handle('db:workflowInstances', (_e, status?: string | null) =>
    listWorkflowInstances(status ?? null)
  )
  handle('db:workflowInstance', (_e, id: number) => getWorkflowInstance(id))
  handle('db:completeWorkflowStep', (_e, taskId: number) => completeWorkflowStep(taskId))
  handle('db:abortWorkflowInstance', (_e, id: number) => abortWorkflowInstance(id))
  handle('db:graph', (_e, includeTasks?: boolean) => buildGraph(includeTasks ?? false))
  handle('db:noteFolders', () => listNoteFolders())
  handle('db:note', (_e, id: number) => getNote(id))
  handle('db:resolveNoteTitle', (_e, title: string) => resolveNoteTitle(title))
  handle('db:outLinks', (_e, id: number) => listOutLinks(id))
  handle('db:backlinks', (_e, id: number) => listBacklinks(id))
  handle('db:saveNote', (_e, id: number, fields: Record<string, unknown>) =>
    saveNote(id, fields as { title?: string; content_md?: string; folder_id?: number | null; pinned?: boolean })
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

  handle('db:toggleTask', (_e, id: number) => {
    const t = toggleTask(id)
    if (t?.status === 'done') advanceWorkflowForTask(id)
    return t
  })
  handle('db:setPriority', (_e, id: number, priority: number) => setPriority(id, priority))
  handle('db:setTitle', (_e, id: number, title: string) => setTitle(id, title))
  handle('db:setStatus', (_e, id: number, status: TaskStatus) => {
    const t = setStatus(id, status)
    if (t?.status === 'done') advanceWorkflowForTask(id)
    return t
  })
  handle('db:setDueDate', (_e, id: number, due: string | null) => setDueDate(id, due))
  handle('db:createTask', (_e, title: string, parentId: number | null, listId: number | null) =>
    createTask(title, parentId, listId)
  )
  handle('db:updateTask', (_e, id: number, fields: Record<string, string | number | null>) => {
    const t = updateTask(id, fields)
    // 编辑面板把状态改成「已完成」同样要推进流程
    if (t?.status === 'done' && 'status' in fields) advanceWorkflowForTask(id)
    return t
  })
  handle('db:deleteTask', (_e, id: number) => softDelete(id))
}
