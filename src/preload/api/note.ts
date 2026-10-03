import { ipcRenderer } from 'electron'
import type { Backlink, Flash, Note, NoteLink, NoteRevision, TaskNoteContext } from '../../shared/types'
/**
 * note 域的渲染进程 API（53 项）。
 *
 * 从 preload/index.ts 拆出来：db 一个对象原有 600 行 / 173 个方法，
 * 找一处调用要先在六百行里翻。index.ts 现在只负责拼装与暴露。
 */
export const noteApi = {
    recentNotes: (limit?: number): Promise<Note[]> => ipcRenderer.invoke('db:recentNotes', limit),
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
        /** 改笔记格式（markdown/richtext/word/excel/link） */
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
