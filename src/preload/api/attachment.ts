import { ipcRenderer } from 'electron'
/**
 * attachment 域的渲染进程 API（2 项）。
 *
 * 从 preload/index.ts 拆出来：db 一个对象原有 600 行 / 173 个方法，
 * 找一处调用要先在六百行里翻。index.ts 现在只负责拼装与暴露。
 */
export const attachmentApi = {
    saveAttachmentData: (
      noteId: number,
      fileName: string,
      base64: string
    ): Promise<{ ok: boolean; path?: string; message: string }> =>
      ipcRenderer.invoke('attachment:saveData', noteId, fileName, base64),
    /** 多图上传：一次 IPC 存一批，逐张回结果（替代渲染层的 for + saveAttachmentData） */
    /**
     * 批量落盘附件。
     * noteId 为 null 表示「还没有归属」—— 快速笔记粘贴的图片那时连 flash 都还没存下。
     * 文件会暂存在 attachments/pending/ 下，等转成笔记时再迁移归属。
     */
    saveAttachmentsBatch: (
      noteId: number | null,
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
  /** 暂存区里没人引用的附件：搬移逻辑修好之前积下的，或闪念被删后留下的 */
  orphanFiles: (): Promise<{ name: string; path: string; bytes: number }[]> =>
    ipcRenderer.invoke('db:orphanFiles'),
  cleanOrphanFiles: (): Promise<number> => ipcRenderer.invoke('db:cleanOrphanFiles'),
  /** 弹系统文件选择框并归档到指定笔记，返回归档后的路径 */
  pickAttachment: (noteId: number): Promise<{ ok: boolean; message: string; paths: string[] }> =>
    ipcRenderer.invoke('attachment:pick', noteId),
}
