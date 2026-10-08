import { ipcRenderer } from 'electron'
import type { Backlink, Flash, Note, NoteFolder, NoteLink, NoteRevision, TaskNoteContext } from '../../shared/types'
import type { NoteRow as NoteTableRow } from '../../shared/note-view'
/**
 * note 域的渲染进程 API（54 项）。
 *
 * 从 preload/index.ts 拆出来：db 一个对象原有 600 行 / 173 个方法，
 * 找一处调用要先在六百行里翻。index.ts 现在只负责拼装与暴露。
 */
export const noteApi = {
    recentNotes: (limit?: number): Promise<Note[]> => ipcRenderer.invoke('db:recentNotes', limit),
    /** 数据库视图的一整张表：标题 / 文件夹 / 知识类型 / 标签 / 属性 / 字数 / 更新时间 */
    noteTableRows: (): Promise<NoteTableRow[]> => ipcRenderer.invoke('db:noteTableRows'),
    /** 「用户脚本」顶层文件夹（没有就建一个）—— 新建脚本笔记时的默认落点 */
    ensureScriptsFolder: (): Promise<NoteFolder | null> => ipcRenderer.invoke('db:ensureScriptsFolder'),
    notes: (limit?: number): Promise<Note[]> => ipcRenderer.invoke('db:notes', limit),
    flashes: (status: string | null = 'inbox'): Promise<Flash[]> =>
      ipcRenderer.invoke('db:flashes', status),
    addFlash: (
      content: string,
      remark?: string,
      sourceApp?: string,
      sourceUrl?: string,
      contentFormat?: 'text' | 'html'
    ): Promise<Flash | null> =>
      ipcRenderer.invoke(
        'db:addFlash',
        content,
        remark ?? '',
        sourceApp ?? '',
        sourceUrl ?? '',
        contentFormat ?? 'text'
      ),
    updateFlashRemark: (id: number, remark: string): Promise<Flash | null> =>
      ipcRenderer.invoke('db:updateFlashRemark', id, remark),
    tagFlash: (id: number, tags: string[]): Promise<number> =>
      ipcRenderer.invoke('db:tagFlash', id, tags),
    mergeFlashes: (ids: number[]): Promise<number | null> =>
      ipcRenderer.invoke('db:mergeFlashes', ids),
    archiveFlash: (id: number): Promise<Flash | null> => ipcRenderer.invoke('db:archiveFlash', id),
    unarchiveFlash: (id: number): Promise<Flash | null> => ipcRenderer.invoke('db:unarchiveFlash', id),
    deleteFlash: (id: number): Promise<number> => ipcRenderer.invoke('db:deleteFlash', id),
    flashToNote: (id: number, folderId?: number | null): Promise<number | null> =>
      ipcRenderer.invoke('db:flashToNote', id, folderId ?? null),
    noteCounts: (): Promise<{ task_id: number; c: number }[]> => ipcRenderer.invoke('db:noteCounts'),
    linkedNotes: (taskId: number): Promise<Note[]> => ipcRenderer.invoke('db:linkedNotes', taskId),
      /** 显式重解析任务正文里的 [[链接]] */
      linkTaskWikiNotes: (taskId: number): Promise<number[]> =>
        ipcRenderer.invoke('db:linkTaskWikiNotes', taskId),
    /** 命令面板统一搜索 */
    linkNotes: (srcId: number, dstId: number): Promise<boolean> =>
      ipcRenderer.invoke('db:linkNotes', srcId, dstId),
    unlinkNotes: (srcId: number, dstId: number): Promise<boolean> =>
      ipcRenderer.invoke('db:unlinkNotes', srcId, dstId),
    /** 按端点类型 + 边类建立连接（图谱连线逻辑下沉到主进程） */
    note: (id: number): Promise<Note | null> => ipcRenderer.invoke('db:note', id),
    resolveNoteTitle: (title: string): Promise<number | null> =>
      ipcRenderer.invoke('db:resolveNoteTitle', title),
    outLinks: (id: number): Promise<NoteLink[]> => ipcRenderer.invoke('db:outLinks', id),
    /** 全库重跑双链解析：回填「标题能解析到、dst_note_id 却没绑」的链接。返回回填条数 */
    relinkAllNotes: (): Promise<number> => ipcRenderer.invoke('db:relinkAllNotes'),
    backlinks: (id: number): Promise<Backlink[]> => ipcRenderer.invoke('db:backlinks', id),
    saveNote: (
      id: number,
      fields: {
        title?: string
        content_md?: string
        folder_id?: number | null
        pinned?: boolean
        /** 改笔记格式（markdown/richtext/word/excel/link/script） */
        format?: string
        /** 脚本笔记（format='script'）的运行环境：powershell / cmd / python / node */
        script_runtime?: string | null
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
     * 关窗/刷新前的同步落盘：beforeunload 里没有 await 的机会，
     * 只有 sendSync 能保证写入真正发生。
     */
    flushNoteSync: (
      id: number,
      fields: { title?: string; content_md?: string }
    ): boolean => ipcRenderer.sendSync('db:flushNote', id, fields),
    materializeDangling: (srcId: number, title: string): Promise<number | null> =>
      ipcRenderer.invoke('db:materializeDangling', srcId, title),
    /** 手动试跑一个步骤（命令 / 脚本会等待退出并核对退出码） */
    openNoteFile: (id: number): Promise<{ ok: boolean; message: string; path: string }> =>
      ipcRenderer.invoke('db:openNoteFile', id),
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
    /** Word/Excel 未指定文件时自动新建空白文件 */
    createBlankOffice: (
      format: string,
      title: string
    ): Promise<{ ok: boolean; path: string; message: string }> =>
      ipcRenderer.invoke('db:createBlankOffice', format, title),
    tagsWithUsage: (): Promise<{ id: number; name: string; color: string; count: number }[]> =>
      ipcRenderer.invoke('db:tagsWithUsage'),
    createTag: (name: string, color?: string): Promise<number | null> =>
      ipcRenderer.invoke('db:createTag', name, color),
    renameTag: (id: number, name: string): Promise<void> => ipcRenderer.invoke('db:renameTag', id, name),
    /** 改标签颜色（#RRGGBB）：任务与笔记的胶囊共用同一个色值 */
    setTagColor: (id: number, color: string): Promise<number> =>
      ipcRenderer.invoke('db:setTagColor', id, color),
    deleteTag: (id: number): Promise<number> => ipcRenderer.invoke('db:deleteTag', id),
    mergeTags: (target: number, sources: number[]): Promise<number> =>
      ipcRenderer.invoke('db:mergeTags', target, sources),
    /** 主进程写入后广播的数据变更：domain 取值见 shared/events.ts */
    noteRevisions: (id: number): Promise<NoteRevision[]> =>
      ipcRenderer.invoke('db:noteRevisions', id),
    restoreNoteRevision: (noteId: number, revId: number): Promise<Note | null> =>
      ipcRenderer.invoke('db:restoreNoteRevision', noteId, revId),
    orphanNotes: (): Promise<Note[]> => ipcRenderer.invoke('db:orphanNotes'),
    brokenLinks: (): Promise<{ src_note_id: number; src_title: string; dst_title: string }[]> =>
      ipcRenderer.invoke('db:brokenLinks'),
    noteTemplates: (): Promise<string[]> => ipcRenderer.invoke('db:noteTemplates'),
  // ---- 挂载本地文件夹（文档不入库，只存顶层引用路径）----
  mounts: (): Promise<{ id: number; name: string; path: string }[]> => ipcRenderer.invoke('db:mounts'),
  mountFolder: (path: string, parentId: number | null): Promise<number | null> =>
    ipcRenderer.invoke('db:mountFolder', path, parentId),
  unmountFolder: (id: number): Promise<boolean> => ipcRenderer.invoke('db:unmountFolder', id),
  /** 选择器用：挂载点下的文件（虚拟负数 id），一次给全 */
  mountPickerItems: (): Promise<{ nodeId: number; folderId: number; relPath: string; name: string; isDir: boolean }[]> =>
    ipcRenderer.invoke('db:mountPickerItems'),
  /** 虚拟节点 id → 真实 note id（懒建），选中挂载文件时用 */
  ensureMountNoteByNode: (nodeId: number): Promise<number | null> =>
    ipcRenderer.invoke('db:ensureMountNoteByNode', nodeId),
  /** 来源已失效的挂载引用行 */
  staleMountNotes: (): Promise<{ id: number; title: string; mount_ref: string }[]> =>
    ipcRenderer.invoke('db:staleMountNotes'),
  /** 清理失效引用行（设置页入口） */
  deleteStaleMountNotes: (): Promise<number> => ipcRenderer.invoke('db:deleteStaleMountNotes'),
  /** 所有挂载点的条目一次拿全（渲染层不许在循环里逐条 IPC） */
  /** 挂载文件的引用行（懒建，幂等）：选择器/图谱在引用前拿一个真实 note id */
  ensureMountNote: (folderId: number, relPath: string): Promise<unknown> =>
    ipcRenderer.invoke('db:ensureMountNote', folderId, relPath),
  allMountEntries: (): Promise<Record<number, { relPath: string; name: string; isDir: boolean; size: number; mtime: number }[]>> =>
    ipcRenderer.invoke('db:allMountEntries'),
  mountEntries: (id: number): Promise<{ relPath: string; name: string; isDir: boolean; size: number; mtime: number }[]> =>
    ipcRenderer.invoke('db:mountEntries', id),
  readMountFile: (
    id: number,
    relPath: string,
  ): Promise<{ kind: 'text' | 'image' | 'none'; name: string; size: number; text?: string; dataUrl?: string; tooLarge?: boolean } | null> =>
    ipcRenderer.invoke('db:readMountFile', id, relPath),
  /** 某个模板的标题与正文（编辑器用它把结构插进当前笔记，而不是新建一篇） */
  noteTemplateText: (kind: string): Promise<{ title: string; content: string } | null> =>
    ipcRenderer.invoke('db:noteTemplateText', kind),
    createNoteFromTemplate: (kind: string, folderId: number | null): Promise<Note | null> =>
      ipcRenderer.invoke('db:createNoteFromTemplate', kind, folderId),
    bindDanglingByTitle: (title: string): Promise<number> =>
      ipcRenderer.invoke('db:bindDanglingByTitle', title),
    addReferenceLink: (srcId: number, target: number | string): Promise<string> =>
      ipcRenderer.invoke('db:addReferenceLink', srcId, target),
    /** 追加正文 */
    appendNote: (id: number, text: string): Promise<Note | null> =>
      ipcRenderer.invoke('db:appendNote', id, text),
    /** 选文转任务时落「段落定位锚」 */
    noteBlockContexts: (noteId: number): Promise<unknown[]> =>
      ipcRenderer.invoke('db:noteBlockContexts', noteId),
    /** 本笔记归属的任务（笔记页「归属」分组） */
    linkedContexts: (taskId: number): Promise<TaskNoteContext[]> =>
      ipcRenderer.invoke('db:linkedContexts', taskId),
    contextsForNote: (noteId: number): Promise<TaskNoteContext[]> =>
      ipcRenderer.invoke('db:contextsForNote', noteId),
    noteContextMap: (taskIds: number[]): Promise<Record<number, TaskNoteContext[]>> =>
      ipcRenderer.invoke('db:noteContextMap', taskIds),
    /** 完成任务写复盘/结论回写 */
    writeNoteAfterDone: (
      taskId: number,
      title: string
    ): Promise<{ noteId: number; blockKey: string } | null> =>
      ipcRenderer.invoke('db:writeNoteAfterDone', taskId, title),
    /** 捕获目标选择器候选 */
    tags: (): Promise<{ id: number; name: string; color: string }[]> => ipcRenderer.invoke('db:tags'),
    noteTags: (): Promise<{ note_id: number; id: number; name: string; color: string }[]> =>
      ipcRenderer.invoke('db:noteTags'),
    setNoteTags: (id: number, names: string[]): Promise<void> =>
      ipcRenderer.invoke('db:setNoteTags', id, names),
}
