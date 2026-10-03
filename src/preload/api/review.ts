import { ipcRenderer } from 'electron'
import type { Overview, ReviewStats, TodayTasks } from '../../shared/types'
/**
 * review 域的渲染进程 API（8 项）。
 *
 * 从 preload/index.ts 拆出来：db 一个对象原有 600 行 / 173 个方法，
 * 找一处调用要先在六百行里翻。index.ts 现在只负责拼装与暴露。
 */
export const reviewApi = {
    overview: (): Promise<Overview> => ipcRenderer.invoke('db:overview'),
    todayTasks: (): Promise<TodayTasks> => ipcRenderer.invoke('db:todayTasks'),
    reviewStats: (): Promise<ReviewStats> => ipcRenderer.invoke('db:reviewStats'),
    /** 图谱构建：includeTasks / 文件夹 / 标签（默认纳入任务节点） */
    recordPomodoro: (
      taskId: number | null,
      minutes: number,
      completed: boolean,
      reason?: string
    ): Promise<number> =>
      ipcRenderer.invoke('db:recordPomodoro', taskId, minutes, completed, reason ?? null),
    pomodoroToday: (): Promise<{ minutes: number; sessions: number }> =>
      ipcRenderer.invoke('db:pomodoroToday'),
    exportPreview: (kind: 'json' | 'csv' | 'markdown'): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke('db:exportPreview', kind),
    previewNote: (id: number): Promise<{ kind: string; html: string; message: string }> =>
      ipcRenderer.invoke('db:previewNote', id),
    /** Word/Excel 可编辑内容（Word→HTML，Excel→单元格网格） */
    rollRecurringToday: (): Promise<number> => ipcRenderer.invoke('db:rollRecurringToday'),
}
