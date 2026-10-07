import { ipcRenderer } from 'electron'
import type { HabitView } from '../../shared/habit'
/**
 * habit 域的渲染进程 API（6 项）。
 *
 * 与 review 域分开：回顾页统计的是"已经发生的事"，习惯是"每天要做的事"，
 * 前者只读、后者天天要写，混在一起会让这个域同时长着两种节奏。
 */
export const habitApi = {
  /** 全部习惯 + 连续天数 / 近 7 天 / 完成率 */
  listHabits: (): Promise<HabitView[]> => ipcRenderer.invoke('db:listHabits'),
  /** 新建（无 id）或改名换图标（有 id），返回习惯 id（0 = 没保存成功） */
  saveHabit: (input: { id?: number; name: string; icon?: string; color?: string }): Promise<number> =>
    ipcRenderer.invoke('db:saveHabit', input),
  archiveHabit: (id: number, archived: boolean): Promise<boolean> =>
    ipcRenderer.invoke('db:archiveHabit', id, archived),
  deleteHabit: (id: number): Promise<boolean> => ipcRenderer.invoke('db:deleteHabit', id),
  /** 今天那颗按钮：切一下某天的打卡状态，返回切换后的状态 */
  toggleHabitDay: (id: number, day: string): Promise<boolean> =>
    ipcRenderer.invoke('db:toggleHabitDay', id, day),
  /** 明确设置某天打没打（周条上点某一天用这条） */
  setHabitDay: (id: number, day: string, done: boolean): Promise<boolean> =>
    ipcRenderer.invoke('db:setHabitDay', id, day, done),
}
