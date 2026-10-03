import { ipcRenderer } from 'electron'
/**
 * system 域的渲染进程 API（22 项）。
 *
 * 从 preload/index.ts 拆出来：db 一个对象原有 600 行 / 173 个方法，
 * 找一处调用要先在六百行里翻。index.ts 现在只负责拼装与暴露。
 */
export const systemApi = {
    info: (): Promise<{ path: string; ready: boolean; readonly: string; error: string }> =>
      ipcRenderer.invoke('db:info'),
    settings: (): Promise<Record<string, string>> => ipcRenderer.invoke('db:settings'),
    setSetting: (key: string, value: string): Promise<number> =>
      ipcRenderer.invoke('db:setSetting', key, value),
    setSettings: (entries: Record<string, string>): Promise<number> =>
      ipcRenderer.invoke('db:setSettings', entries),
    backupDatabase: (dir: string): Promise<{ path: string; bytes: number } | null> =>
      ipcRenderer.invoke('db:backupDatabase', dir),
    globalSearch: (q: string): Promise<unknown> => ipcRenderer.invoke('db:globalSearch', q),
    /** 记一次命中（MRU）：命令面板选中 task/note/flash 条目时调用 */
    searchTouch: (kind: string, id: number): Promise<boolean> =>
      ipcRenderer.invoke('db:searchTouch', kind, id),
    /** 拖拽连线是否允许（返回 'ownership' | 'reference' | 'either' | null） */
    listBackups: (): Promise<{ name: string; path: string; bytes: number; mtime: number }[]> =>
      ipcRenderer.invoke('db:listBackups'),
    /** 用某个备份覆盖当前库（会先自动备份当前库） */
    restoreBackup: (file: string): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('db:restoreBackup', file),
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
    /** 导入 Markdown 文件夹：选目录，递归 *.md 建笔记 */
    importMarkdownFolder: (): Promise<{ ok: boolean; count: number; message: string }> =>
      ipcRenderer.invoke('db:importMarkdownFolder'),
    /** 按路径导入 Markdown 文件夹（自动化脚本用，等价于在对话框里选同一目录） */
    importMarkdownFromPath: (path: string): Promise<{ ok: boolean; count: number; message: string }> =>
      ipcRenderer.invoke('db:importMarkdownFromPath', path),
    exportData: (
      kind: 'json' | 'csv' | 'markdown' | 'markdown-zip'
    ): Promise<{ path: string; count: number } | null> => ipcRenderer.invoke('db:exportData', kind),
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
    onDataChanged: (cb: (domain: string) => void): (() => void) => {
      const handler = (_e: unknown, domain: string): void => cb(domain)
      ipcRenderer.on('data:changed', handler)
      return () => ipcRenderer.removeListener('data:changed', handler)
    },

    emptyAllTrash: (): Promise<number> => ipcRenderer.invoke('db:emptyAllTrash'),
    exportDocx: (
      srcPath: string,
      html: string,
      title: string
    ): Promise<{ ok: boolean; path?: string; message?: string }> =>
      ipcRenderer.invoke('word:exportDocx', srcPath, html, title),
    /** 取单个任务（含 parent_id / status），断言与调试都用得上 */
}
