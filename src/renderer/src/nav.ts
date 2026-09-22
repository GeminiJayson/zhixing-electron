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
  | 'settings'

export interface NavItem {
  key: PageKey
  /** 文案 key，实际文字由 i18n 的 t() 提供 */
  labelKey: MessageKey
  icon: LucideIcon
  /** top = 主导航区，bottom = 贴底 */
  zone: 'top' | 'bottom'
}

/** 导航结构（8 项）。 */
export const NAV_ITEMS: NavItem[] = [
  { key: 'today', labelKey: 'nav.today', icon: CalendarCheck, zone: 'top' },
  { key: 'tasks', labelKey: 'nav.tasks', icon: ClipboardList, zone: 'top' },
  { key: 'inbox', labelKey: 'nav.inbox', icon: Inbox, zone: 'top' },
  { key: 'notes', labelKey: 'nav.notes', icon: FileText, zone: 'top' },
  { key: 'workflow', labelKey: 'nav.workflow', icon: GitBranch, zone: 'top' },
  { key: 'graph', labelKey: 'nav.graph', icon: Waypoints, zone: 'top' },
  { key: 'review', labelKey: 'nav.review', icon: Sparkles, zone: 'top' },
  { key: 'settings', labelKey: 'nav.settings', icon: CircleUser, zone: 'bottom' },
]
