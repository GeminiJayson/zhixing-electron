import { ipcRenderer } from 'electron'
import type { ScriptProblem, ScriptRunResult, UserScript } from '../../shared/user-scripts'
/**
 * system 域的渲染进程 API（27 项）。
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
    /** 选一个目录，返回绝对路径（取消返回空串）。目录变化触发与用户脚本目录都用它 */
    pickDirectory: (): Promise<string> => ipcRenderer.invoke('app:pickDirectory'),
    /** 这个路径存在吗（选完目录后给"目录不在"的即时提示，不必等触发布不上） */
    pathExists: (path: string): Promise<boolean> => ipcRenderer.invoke('app:pathExists', path),
    /** 用户脚本清单（`<数据目录>/scripts/` 下的 .ps1 / .cmd / .py / .js 等） */
    listUserScripts: (): Promise<UserScript[]> => ipcRenderer.invoke('app:listUserScripts'),
    /** 跑一个用户脚本（只收文件名；主进程会再校验一次真实路径落在脚本目录内） */
    runUserScript: (file: string): Promise<ScriptRunResult> =>
      ipcRenderer.invoke('app:runUserScript', file),
    scriptsDir: (): Promise<string> => ipcRenderer.invoke('app:scriptsDir'),
    /** 在资源管理器里打开脚本目录（顺带确保目录与说明文件已建好） */
    openScriptsDir: (): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('app:openScriptsDir'),
    // ---- 脚本编辑（知识库页的脚本站）----
    readUserScript: (file: string): Promise<{ ok: boolean; content: string; message: string }> =>
      ipcRenderer.invoke('app:readUserScript', file),
    writeUserScript: (file: string, content: string): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('app:writeUserScript', file, content),
    /** 新建脚本（名字 + 运行时 → 文件名，重名自动加序号） */
    createUserScript: (
      name: string,
      runtime: 'powershell' | 'cmd' | 'python' | 'node'
    ): Promise<{ ok: boolean; file: string; message: string }> =>
      ipcRenderer.invoke('app:createUserScript', name, runtime),
    renameUserScript: (file: string, newName: string): Promise<{ ok: boolean; file: string; message: string }> =>
      ipcRenderer.invoke('app:renameUserScript', file, newName),
    deleteUserScript: (file: string): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('app:deleteUserScript', file),
    /** 钉住 / 取消钉住（排在清单最前，与笔记的置顶同一个意思） */
    setScriptPinned: (file: string, pinned: boolean): Promise<boolean> =>
      ipcRenderer.invoke('app:setScriptPinned', file, pinned),
    /** 哪些工作流步骤引用了它（改名会让这些步骤失效，界面上要能提前看见） */
    scriptReferences: (file: string): Promise<{ template: string; node: string }[]> =>
      ipcRenderer.invoke('app:scriptReferences', file),
    /** 语法校验（磁盘脚本）：只解析不执行；content 省略时校验磁盘上的版本 */
    checkUserScript: (
      file: string,
      content?: string
    ): Promise<{ ok: boolean; problems: ScriptProblem[]; message: string }> =>
      ipcRenderer.invoke('app:checkUserScript', file, content),
    /** 语法校验（脚本笔记）：正文来自编辑区，运行时来自 note.script_runtime */
    checkNoteScript: (
      noteId: number,
      content: string
    ): Promise<{ ok: boolean; problems: ScriptProblem[]; message: string }> =>
      ipcRenderer.invoke('app:checkNoteScript', noteId, content),
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
    /**
     * 清空数据库：保留表结构与设置，删掉全部业务数据（主进程会先自动备份一份）。
     * 调用方必须自己做**强确认** —— 这是不可逆的。
     */
    wipeDatabase: (): Promise<{ tables: number; rows: number }> => ipcRenderer.invoke('db:wipeDatabase'),
    exportDocx: (
      srcPath: string,
      html: string,
      title: string
    ): Promise<{ ok: boolean; path?: string; message?: string }> =>
      ipcRenderer.invoke('word:exportDocx', srcPath, html, title),
    /** 取单个任务（含 parent_id / status），断言与调试都用得上 */
}
