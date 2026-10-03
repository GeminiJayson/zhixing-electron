import {
  CalendarCheck,
  CircleUser,
  ClipboardList,
  FileText,
  GitBranch,
  Inbox,
  Sparkles,
  Waypoints,
} from '@renderer/lib/icons'
import type { LucideIcon } from '@renderer/lib/icons'

export type PageKey =
  | 'today'
  | 'tasks'
  | 'inbox'
  | 'notes'
  | 'workflow'
  | 'graph'
  | 'review'
  | 'vault'
  | 'settings'

export interface NavItem {
  key: PageKey
  /** 导航文案（单语言，直接写中文） */
  label: string
  icon: LucideIcon
  /** top = 主导航区，bottom = 贴底 */
  zone: 'top' | 'bottom'
}

/** 导航结构（9 项）。 */
export const NAV_ITEMS: NavItem[] = [
  { key: 'today', label: '今日', icon: CalendarCheck, zone: 'top' },
  { key: 'tasks', label: '任务', icon: ClipboardList, zone: 'top' },
  { key: 'inbox', label: '收件箱', icon: Inbox, zone: 'top' },
  { key: 'notes', label: '知识库', icon: FileText, zone: 'top' },
  { key: 'workflow', label: '工作流', icon: GitBranch, zone: 'top' },
  { key: 'graph', label: '图谱', icon: Waypoints, zone: 'top' },
  { key: 'review', label: '回顾', icon: Sparkles, zone: 'top' },
  // 这里原本还有一项"保险箱"。它和知识库是同一个页面的两个视图，
  // 入口挪到了知识库页顶部筛选条的右侧 —— 导航里不该为"偶尔进去看一眼"
  // 的东西长期占一格（见 NotesPage 的 view 切换）。
  { key: 'settings', label: '设置', icon: CircleUser, zone: 'bottom' },
]
