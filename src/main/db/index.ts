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
export * from './task-activity'
export * from './notes'
export * from './preview'
export * from './review'
export * from './habit'
export * from './note-table'
export * from './settings'
export * from './task-ops'
export * from './tasks'
// export * 只导出名字，不把它引进本文件作用域 —— 这里要直接调用它
import { restoreCompleted } from './tasks'
export * from './trash'
export * from './workflow'
// re-export 不会带进本地绑定，这里要显式 import 才能在 handler 里直接用
import { findTaskStatusTriggers } from './workflow'

// 显式导入供下方 IPC 注册使用（export * 不引入本地作用域）
import { APP_DIR_NAME, dataDir, dbPath, TASK_COLUMNS, open, conn, nowStamp, today, getTask, db, openedPath, dbReadonlyReason, dbOpenError } from './connection'
import { EXPORT_TABLES, buildExportJson, buildTasksCsv, buildNotesExport, importFromJsonFile, importData, importMarkdownFolder, importMarkdownFolderDialog, exportData, openNoteFile } from './export'
import { TASK_ID_OFFSET, FLASH_ID_OFFSET, FOLDER_ID_OFFSET, ANCHOR_ID_OFFSET, folderNodeId, anchorNodeId, classifyEdge, graphNodeId, buildGraphTracked, acyclicOwnershipEdges, diffGraph, graphDelta, graphNeighborhood, graphPreview, isGraphWatching, setGraphWatch, connectionAllowed, resolveEdgeKind, wouldCreateCycle, linkNotes, linkTaskNoteRef, unlinkTaskNoteRef, unlinkNotes, connectGraphNodes, removeGraphEdge, rewireGraphEdge } from './graph'
import { FLASH_COLUMNS, getFlash, listFlashesByStatus, addFlash, setFlashStatus, deleteFlash, markFlashConverted, flashToTask, flashToNote, updateFlashRemark, tagFlash, mergeFlashes, flashToSubtask } from './inbox'
import { shiftDay, rollRecurringToday, resumeDueToday, recordPomodoro, pomodoroToday, dueReminders, dismissReminder, snoozeReminder, saveWidgetGeometry, currentSettings, seedIfEmpty } from './maintenance'
import { NOTE_COLUMNS, listNoteFolders, getNote, resolveNoteTitle, syncNoteLinks, saveNote, createNote, deleteNote, listOutLinks, listBacklinks, materializeDangling, bindDanglingByTitle, createNoteFolder, renameNoteFolder, ensureDefaultFolder, moveNoteFolder, deleteNoteFolder, addReferenceLink, appendNote, listNoteBlockContexts, noteLinkedTasks, noteTaskCandidates, NOTE_REVISION_LIMIT, NOTE_TEMPLATES, snapshotNote, listNoteRevisions, restoreNoteRevision, orphanNotes, brokenLinks, createNoteFromTemplate, noteTagMap, setNoteTags, relinkAllNotes } from './notes'
import {
  previewOfficeNote,
  officeDocNote,
  saveWordNote,
  saveExcelNote,
  createBlankOfficeFile,
} from './preview'
import { dayOf, todayRoots, reviewStats } from './review'
import { ensureScriptsFolder } from './notes'
import { archiveHabit, deleteHabit, listHabits, saveHabit, setHabitDay, toggleHabitDay } from './habit'
import { noteTableRows } from './note-table'
import { listSettings, setSetting, setSettings, backupDatabase } from './settings'
import { autoBackup, listBackups, restoreBackup } from './backup'
import { globalSearch, searchTouch } from './search'
import { listFolders, listTasksByList, createListFolder, renameListFolder, deleteListFolder, moveListFolder, reorderListFolder, isListDescendantOf, moveTaskToList, defaultListId } from './lists'
import { linkTaskWikiNotes } from './task-note-links'
import { listTaskActivity, logTaskActivity } from './task-activity'
import { siblingsOf, isDescendantOf, reorderTask, moveTaskRelative, reparentTask, batchComplete, batchMove, batchSetDue, listTags, setTaskTags, ensureListId, quickAdd } from './task-ops'
import { listTasks, listTodayTasks, recentNotes, noteCountMap, tagMap, listNotes, overview, toggleTask, cloneTaskTree, setPriority, setTitle, setStatus, setDueDate, nextSortKey, createTask, EDITABLE_FIELDS, updateTask, softDelete, batchDeleteTasks, batchUndoLast, linkTaskNote, unlinkTaskNote, listLinkedNotes, pauseTask, resumeTask, linkTaskNoteBlock, unlinkTaskNoteBlock, listLinkedContexts, contextsForNote, noteContextMap, writeNoteAfterDone, taskCandidates } from './tasks'
import { trashItems, restoreTrash, purgeTrash, emptyTrash, emptyAllTrash, purgeTrashOlderThan, tagsWithUsage, createTag, renameTag, deleteTag, setTagColor, batchDeleteTags, mergeTags } from './trash'
import { attachmentStats, cleanOrphanFiles, deleteAttachment, importAttachment, listAttachments, listOrphanFiles, pruneAttachments } from './attachments'
import { deleteSavedQuery, listSavedQueries, saveSavedQuery } from './queries'
import { NODE_COLUMNS, orderedNodes, nextWorkflowNode, validateWorkflowTemplate, listWorkflowTemplates, getWorkflowTemplate, saveWorkflowTemplate, deleteWorkflowTemplate, duplicateWorkflowTemplate, autoLayoutWorkflowNodes, updateWorkflowNodePos, batchUpdateNodePos, setWorkflowBranch, spawnStepTask, instantiateWorkflow, getWorkflowInstance, listWorkflowInstances, listWorkflowInstancesByTask, completeWorkflowStep, abortWorkflowInstance, retryWorkflowStep, deleteWorkflowInstance, rerunWorkflowInstance, setWorkflowNotifier, splitCommand, describeWorkflowAction, runWorkflowAction, listWorkflowGroups, workflowTemplateGroups, saveWorkflowGroup, deleteWorkflowGroup, moveWorkflowTemplate, renameWorkflowInstance, listWorkflowRunLog } from './workflow'
import type { EditableField } from './tasks'
import type { TrashItem } from './trash'
import type { DataDomain } from '../../shared/events'
import type { GraphNodePayload, GraphQuery, TaskActivityKind, TaskStatus } from '../../shared/types'

// ---------------------------------------------------------------- 数据变更广播

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
  'db:linkTaskNoteBlock': ['note', 'task'],
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
  'db:moveListFolder': 'task',
  'db:reorderListFolder': 'task',
  'db:pauseTask': 'task',
  'db:resumeTask': 'task',
  // 段落级上下文：任务侧「关联段落」与笔记侧反链/图谱两侧都要刷新
  // （db:linkTaskNoteBlock 已在上面登记过，这里不重复 —— 它原先是两个 IPC 通道
  //   attachBlock / attachNoteBlock，合并成一个名字后在两张表里会撞车）
  'db:unlinkTaskNoteBlock': ['task', 'note'],
  // 任务↔笔记的归属关联（写 task_note_link）此前漏登记：行内 ⇄N 计数与图谱边不会跟着刷新
  'db:linkTaskNote': 'task',
  // 显式重解析任务正文的 [[链接]]：
  // 新建/改名已会自动回绑，这个入口是给「修复上线前就写坏的历史数据」用的
  'db:linkTaskWikiNotes': 'task',
  'db:unlinkTaskNote': 'task',
  // 建默认笔记文件夹会写 note_folder
  'db:ensureDefaultFolder': 'note',
  'db:writeNoteAfterDone': ['task', 'note'],
  'db:setSetting': 'settings',
  'db:setSettings': 'settings',
  // 回收站操作按 kind 动的是三类记录之一（任务清理还会级联 workflow_step_task），
  // 逐个 kind 判断做不到就整组广播：多刷一次无害，漏刷才会让页面显示陈数据
  'db:restoreTrash': ['task', 'note', 'flash', 'workflow'],
  'db:purgeTrash': ['task', 'note', 'flash', 'workflow'],
  'db:emptyTrash': ['task', 'note', 'flash', 'workflow'],
  'db:purgeTrashOlderThan': ['task', 'note', 'flash', 'workflow'],
  'db:createTag': 'task',
  'db:renameTag': 'task',
  'db:deleteTag': 'task',
  'db:mergeTags': 'task',
  // 标签颜色是任务与笔记共用的同一行数据，两边的胶囊都要跟着换色
  'db:setTagColor': ['task', 'note'],
  // 给笔记打标签写的是 note_tag；标签本身共用，但受影响的是笔记视图
  'db:setNoteTags': 'note',
  'db:rollRecurringToday': 'task',
  'db:resumeDueToday': 'task',
  'db:recordPomodoro': 'task',
  // 习惯打卡挂在 task 域：今日页本来就订阅 task，多开一个域只会多一条没有独立订阅者的
  // 广播通道（DataDomain 是联合类型，加一个值要动 shared/events 与所有 switch）
  'db:saveHabit': 'task',
  'db:archiveHabit': 'task',
  'db:deleteHabit': 'task',
  'db:toggleHabitDay': 'task',
  'db:setHabitDay': 'task',
  'db:dismissReminder': 'task',
  'db:snoozeReminder': 'task',
  // 导入是整库替换：只广播 task 会留下
  // 过期的笔记/闪念/工作流/设置视图
  'db:importFromPath': ['task', 'note', 'flash', 'workflow', 'settings'],
  'db:importData': ['task', 'note', 'flash', 'workflow', 'settings'],
  'db:importMarkdownFolder': 'note',
  'db:importMarkdownFromPath': 'note',
}

/**
 * 数据变更后的额外通知（托盘标题、目录监视等主进程侧反应），由 main 注入，避免反向依赖。
 *
 * 带上 domain：调用方常只关心某一域（例如只有工作流模板变了才需要重建目录监视），
 * 没有它就只能"每次变更都重算一遍"。
 */
let dataChangedHook: ((domain: DataDomain) => void) | null = null
export function setDataChangedHook(fn: (domain: DataDomain) => void): void {
  dataChangedHook = fn
}

/** 向所有窗口广播一次数据变更（浮窗等第二窗口也能同步）。 */
export function broadcastDataChanged(domain: DataDomain): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('data:changed', domain)
  }
  // 笔记/任务/闪念写入后，图谱相关的域顺带推一帧增量（diff 在数据层算），
  // 图页据此定点增删并保留坐标；没有图页在看时不白算。
  if ((domain === 'note' || domain === 'task' || domain === 'flash') && isGraphWatching()) {
    try {
      broadcastGraphDelta()
    } catch (err) {
      console.error('[graph] 增量推送失败', err)
    }
  }
  try {
    dataChangedHook?.(domain)
  } catch (err) {
    console.error('[db] 数据变更钩子失败', err)
  }
}

/** 把当前图谱增量推给所有窗口。 */
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
 * 任务完成时推进它所属的工作流实例。
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
  // 首次启动写入欢迎内容：只在空库时写，
  // 放在注册 IPC 之前，保证窗口首次取数时种子数据已就位。
  try {
    seedIfEmpty()
  } catch (err) {
    console.error('[db] 写入欢迎内容失败', err)
  }
  // 只读分支：ready=库是否打开；readonly=能打开但迁移失败（显示只读横幅+恢复备份入口）；
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
  handle('db:noteTags', () => noteTagMap())
  handle('db:setNoteTags', (_e, id: number, names: string[]) => setNoteTags(id, names))
  handle('db:setTagColor', (_e, id: number, color: string) => setTagColor(id, color))
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
  // 习惯打卡：读一次给整个视图（连续天数与完成率由 shared/habit.ts 推导）
  handle('db:listHabits', () => listHabits())
  // 笔记数据库视图：表格要的列一次取齐（属性 / 知识类型 / 标签 / 文件夹）
  handle('db:noteTableRows', () => noteTableRows())
  // 新建脚本笔记时给它一个默认落点（幂等：已有同名顶层文件夹就复用）
  handle('db:ensureScriptsFolder', () => ensureScriptsFolder())
  handle('db:saveHabit', (_e, input: { id?: number; name: string; icon?: string; color?: string }) =>
    saveHabit(input ?? { name: '' })
  )
  handle('db:archiveHabit', (_e, id: number, archived: boolean) => archiveHabit(id, archived))
  handle('db:deleteHabit', (_e, id: number) => deleteHabit(id))
  handle('db:toggleHabitDay', (_e, id: number, day: string) => toggleHabitDay(id, day))
  handle('db:setHabitDay', (_e, id: number, day: string, done: boolean) => setHabitDay(id, day, done))
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
  handle('db:moveListFolder', (_e, id: number, parentId: number | null) =>
    moveListFolder(id, parentId)
  )
  handle('db:reorderListFolder', (_e, id: number, anchorId: number, below?: boolean) =>
    reorderListFolder(id, anchorId, below ?? true)
  )
  handle('db:isListDescendantOf', (_e, ancestorId: number, nodeId: number) =>
    isListDescendantOf(ancestorId, nodeId)
  )
  handle('db:moveTaskToList', (_e, taskId: number, listId: number | null) =>
    moveTaskToList(taskId, listId)
  )
  handle('db:pauseTask', (_e, id: number, resumeAt?: string | null) => pauseTask(id, resumeAt ?? null))
  handle('db:resumeTask', (_e, id: number, status?: TaskStatus) => resumeTask(id, status ?? 'todo'))
  handle(
    'db:linkTaskNoteBlock',
    (_e, taskId: number, noteId: number, blockKey: string, snippet?: string) =>
      linkTaskNoteBlock(taskId, noteId, blockKey, snippet ?? '')
  )
  handle('db:unlinkTaskNoteBlock', (_e, taskId: number, noteId: number, blockKey?: string) =>
    unlinkTaskNoteBlock(taskId, noteId, blockKey ?? '')
  )
  handle('db:linkedContexts', (_e, taskId: number) => listLinkedContexts(taskId))
  handle('db:contextsForNote', (_e, noteId: number) => contextsForNote(noteId))
  handle('db:noteContextMap', (_e, taskIds: number[]) => noteContextMap(taskIds))
  handle('db:writeNoteAfterDone', (_e, taskId: number, title: string) =>
    writeNoteAfterDone(taskId, title)
  )
  handle('db:taskCandidates', (_e, q?: string, limit?: number) => taskCandidates(q ?? '', limit ?? 20))
  handle('db:linkTaskWikiNotes', (_e, taskId: number) => linkTaskWikiNotes(taskId))

  handle('db:linkTaskNote', (_e, taskId: number, noteId: number) =>
    linkTaskNote(taskId, noteId)
  )
  handle('db:unlinkTaskNote', (_e, taskId: number, noteId: number) =>
    unlinkTaskNote(taskId, noteId)
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
  // MRU —— 命令面板选中某条命中时记一次，后续搜索按最近访问优先
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
  // Markdown 文件夹导入：一个走系统对话框，一个供脚本按路径直接导入
  handle('db:importMarkdownFolder', (e) => importMarkdownFolderDialog(e.sender))
  handle('db:importMarkdownFromPath', (_e, path: string) => importMarkdownFolder(path))
  // 供自动化脚本直接按路径导入（等价于用户在对话框里选同一个文件）
  handle('db:importFromPath', (_e, path: string) => importFromJsonFile(path))
  handle('db:openNoteFile', (_e, id: number) => openNoteFile(id))
  handle('db:previewNote', (_e, id: number) => previewOfficeNote(id))
  // Word/Excel 可编辑写回
  handle('db:officeDoc', (_e, id: number) => officeDocNote(id))
  handle('db:saveWordNote', (_e, id: number, html: string) => saveWordNote(id, html))
  handle('db:saveExcelNote', (_e, id: number, rows: string[][]) => saveExcelNote(id, rows))
  // Word/Excel 未指定文件时自动新建空白文件
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
  // 无 LIMIT：listNotes 自身默认 300，
  // 这里在没有显式 limit 时传 -1（SQLite 的「不限量」），笔记页不再被截断。
  handle('db:notes', (_e, limit?: number) => listNotes(limit ?? -1))
  handle('db:flashes', (_e, status?: string | null) =>
    listFlashesByStatus(status === undefined ? 'inbox' : status)
  )
  // 收件箱：只以「顶层且 list_id 为空」的任务为根 + 完整子树闭包，
  // 不能按 list_id IS NULL 平铺（否则子任务会同时出现在收件箱）。
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
  handle(
    'db:addFlash',
    (
      _e,
      content: string,
      remark?: string,
      sourceApp?: string,
      sourceUrl?: string,
      contentFormat?: 'text' | 'html'
    ) => addFlash(content, remark ?? '', sourceApp ?? '', sourceUrl ?? '', contentFormat ?? 'text')
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
  // 复制模板：名称加「 副本」，节点整体复制
  handle('db:duplicateWorkflowTemplate', (_e, id: number) => duplicateWorkflowTemplate(id))
  // 一键对齐：pos_x=0、pos_y=i*yGap
  handle('db:autoLayoutWorkflow', (_e, templateId: number, yGap: number) =>
    autoLayoutWorkflowNodes(templateId, yGap)
  )
  // 某任务启动/关联的实例
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
  handle('db:orphanFiles', () => listOrphanFiles())
  handle('db:relinkAllNotes', () => relinkAllNotes())
  handle('db:cleanOrphanFiles', () => cleanOrphanFiles())
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
  // 实例的执行日志（时间轴）：点开实例详情时拉一次
  handle('db:workflowRunLog', (_e, instanceId: number) => listWorkflowRunLog(instanceId))
  // 任务活动流：速览的时间轴读它；渲染层改状态后也往这里补一条（带原因说明）
  handle('db:taskActivity', (_e, taskId: number, limit?: number | null) =>
    listTaskActivity(taskId, limit ?? 50)
  )
  handle(
    'db:pushTaskActivity',
    (_e, taskId: number, kind: TaskActivityKind, detail?: string | null, reason?: string | null) => {
      logTaskActivity(taskId, kind, detail ?? null, reason ?? null)
      return true
    }
  )
  handle('db:completeWorkflowStep', (_e, taskId: number) => completeWorkflowStep(taskId))
  // 自动步骤失败后原地重跑（失败时实例停在当前节点，没有这个入口就只能中止）
  handle('db:retryWorkflowStep', (_e, instanceId: number) => retryWorkflowStep(instanceId))
  handle('db:abortWorkflowInstance', (_e, id: number) => abortWorkflowInstance(id))
  // 删除实例记录（不动模板，也不删已派生的任务）
  handle('db:deleteWorkflowInstance', (_e, id: number) => deleteWorkflowInstance(id))
  // 重复运行：按同一模板再启动一个新实例，旧记录保留
  handle('db:rerunWorkflowInstance', (_e, id: number) => rerunWorkflowInstance(id))
  // 图谱构建参数（includeTasks / 文件夹 / 标签 / 邻域），默认纳入任务节点
  handle('db:graph', (_e, query?: GraphQuery) => buildGraphTracked({ includeTasks: true, ...(query ?? {}) }))
  // 笔记邻域子图（仅沿 note_link 做 1~2 度 BFS）
  handle('db:graphNeighborhood', (_e, noteId: number, degree?: number) =>
    graphNeighborhood(noteId, degree ?? 1)
  )
  // 选中节点预览文本（按类型输出摘要/状态/优先级/截止/父任务/关联笔记/来源）
  handle('db:graphPreview', (_e, node: GraphNodePayload) => graphPreview(node))
  // 图页开关增量推送（没人看图时不重算 diff）
  handle('db:graphWatch', (_e, active: boolean) => {
    setGraphWatch(active)
    return true
  })
  /**
   * 图页双击闪念/任务/文件夹的跨页跳转。
   * 复用主窗口既有的深链通道（app:deeplink → App 的 onDeepLink 分支），
   * 这样图谱不必为了跳页去持有 App 的页面路由状态。
   */
  handle('db:graphOpenNode', (e, kind: string, id: number) => {
    e.sender.send('app:deeplink', { kind, id, block: '' })
    return true
  })
  // 文件夹为空时补默认文件夹
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
        // saveNote 支持 format，UI 才有「改格式」入口
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
  /*
    段落级关联的 IPC 通道只有一个 —— 它原先是两个（attachBlock / attachNoteBlock），
    合并成同一个名字后两处 handler 并存，主进程会以
    "Attempted to register a second handler for 'db:linkTaskNoteBlock'" 直接崩。
    这类重复 tsc 查不出来（handle 的签名不冲突），只有真的启动才暴露。
  */
  handle('db:noteBlockContexts', (_e, noteId: number) => listNoteBlockContexts(noteId))
  handle('db:noteLinkedTasks', (_e, noteId: number) => noteLinkedTasks(noteId))
  handle('db:noteTaskCandidates', (_e, q: string, limit?: number) =>
    noteTaskCandidates(q ?? '', limit ?? 30)
  )

  // 关窗/刷新前最后一次落盘必须**同步**完成，否则渲染进程卸载后 invoke 永远不会回来。
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
    // 任务状态触发：有模板盯着"这个任务变成这个状态"就把它拉起来
    if ('status' in fields && t?.status) {
      for (const hit of findTaskStatusTriggers(id, t.status)) {
        void instantiateWorkflow(hit.id, null, null, undefined, 'task_status').then((inst) => {
          if (inst) console.log(`[wf] 任务 #${id} 变成「${t.status}」→ 启动「${hit.name}」实例 #${inst.id}`)
        })
      }
    }
    return t
  })
  handle('db:deleteTask', (_e, id: number) => softDelete(id))
}
