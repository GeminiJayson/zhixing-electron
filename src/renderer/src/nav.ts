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
import type { MessageKey } from './i18n'

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
  /** 文案 key，实际文字由 i18n 的 t() 提供 */
  labelKey: MessageKey
  icon: LucideIcon
  /** top = 主导航区，bottom = 贴底 */
  zone: 'top' | 'bottom'
}

/** 导航结构（9 项）。 */
export const NAV_ITEMS: NavItem[] = [
  { key: 'today', labelKey: 'nav.today', icon: CalendarCheck, zone: 'top' },
  { key: 'tasks', labelKey: 'nav.tasks', icon: ClipboardList, zone: 'top' },
  { key: 'inbox', labelKey: 'nav.inbox', icon: Inbox, zone: 'top' },
  { key: 'notes', labelKey: 'nav.notes', icon: FileText, zone: 'top' },
  { key: 'workflow', labelKey: 'nav.workflow', icon: GitBranch, zone: 'top' },
  { key: 'graph', labelKey: 'nav.graph', icon: Waypoints, zone: 'top' },
  { key: 'review', labelKey: 'nav.review', icon: Sparkles, zone: 'top' },
  // 这里原本还有一项"保险箱"。它和知识库是同一个页面的两个视图，
  // 入口挪到了知识库页顶部筛选条的右侧 —— 导航里不该为"偶尔进去看一眼"
  // 的东西长期占一格（见 NotesPage 的 view 切换）。
  { key: 'settings', labelKey: 'nav.settings', icon: CircleUser, zone: 'bottom' },
]
