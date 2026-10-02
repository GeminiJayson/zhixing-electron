import {
  CalendarCheck,
  CircleUser,
  ClipboardList,
  FileText,
  GitBranch,
  Inbox,
  Database,
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
  // 保险箱是"工具"而不是"日常"，放在回顾之后、设置之前。
  // 知识库**不在这里** —— 它不是独立页面，类型与可信状态是笔记自己的属性，
  // 以筛选的形式长在笔记页上（见 notes-filter.css 与 KnowledgeChip.tsx）。
  { key: 'vault', labelKey: 'nav.vault', icon: Database, zone: 'top' },
  { key: 'settings', labelKey: 'nav.settings', icon: CircleUser, zone: 'bottom' },
]
