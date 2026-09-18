/** 主进程与渲染进程共享的类型定义。字段与现有 SQLite schema v12 对齐。 */

export type TaskStatus = 'todo' | 'doing' | 'waiting' | 'done' | 'abandoned'
export type RepeatPeriod = 'none' | 'daily' | 'weekly' | 'monthly' | 'custom'
export type NoteFormat = 'markdown' | 'richtext' | 'word' | 'excel' | 'link'
export type FlashStatus = 'inbox' | 'archived' | 'converted'

export interface Task {
  id: number
  title: string
  notes_md: string
  status: TaskStatus
  priority: number
  due_date: string | null
  start_date: string | null
  reminder_at: string | null
  list_id: number | null
  parent_id: number | null
  repeat_period: RepeatPeriod
  repeat_rule: string | null
  streak: number
  /** 同级排序键（拖拽/上下移动用中间值算法） */
  sort_key: number
  /** 等待中的自动恢复日期 */
  resume_at: string | null
  /** 循环子任务上次打卡重置日（跨天重置用） */
  last_reset_date: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export interface Note {
  id: number
  folder_id: number | null
  title: string
  content_md: string
  format: NoteFormat
  pinned: boolean
  word_count: number
  created_at: string
  updated_at: string
}

/** 今日待办：根任务 id 列表 + 这些根及其完整子树的扁平集合 */
export interface TodayTasks {
  roots: number[]
  subtree: Task[]
}

export interface ReviewStats {
  todayCounts: {
    todayDue: number
    doneToday: number
    overdue: number
    inbox: number
    flash: number
  }
  week: { completed: number[]; pomodoro: number[]; notes: number[]; labels: string[] }
  /** 近 N 周每日完成任务数，[weeks][7]；未来日期为 -1 */
  heatmap: number[][]
  streak: number
  achievements: { name: string; desc: string; unlocked: boolean }[]
  tagDistribution: { name: string; color: string; count: number }[]
}

export interface WorkflowNodePayload {
  id: number
  template_id: number
  title: string
  detail: string
  order_index: number
  note_id: number | null
  action_kind: string
  action_value: string
  condition: string
  branch_node_id: number | null
  pos_x: number | null
  pos_y: number | null
}

export interface WorkflowTemplatePayload {
  id: number
  name: string
  description: string
  start_policy: string
  nodes: WorkflowNodePayload[]
}

export interface WorkflowStepPayload {
  node_id: number
  title: string
  task_id: number | null
  done: boolean
}

export interface WorkflowInstancePayload {
  id: number
  template_id: number
  title: string
  status: string
  current_node_id: number | null
  origin_task_id: number | null
  created_at: string
  finished_at: string | null
  steps: WorkflowStepPayload[]
}

export interface WorkflowTemplateSummary {
  id: number
  name: string
  description: string
  start_policy: string
  node_count: number
  updated_at: string
}

/** 图谱节点 kind，与 graph_service.GraphNode.kind 同名 */
export type GraphKind = 'note' | 'folder' | 'dangling' | 'task' | 'flash'

export interface GraphNodePayload {
  id: number
  label: string
  kind: GraphKind
  size: number
  degree: number
  colorHint: string
  refId: number
  format: string
}

export interface GraphPayload {
  nodes: GraphNodePayload[]
  edges: [number, number][]
  /** "src,dst" → 边类别；归属=实线，引用=虚线 */
  edgeKinds: Record<string, 'ownership' | 'reference'>
}

/** 任务清单 / 分组（list_folder 表）。kind='group' 可收纳 kind='list'。 */
export interface ListFolder {
  id: number
  parent_id: number | null
  kind: 'group' | 'list'
  name: string
  icon: string | null
  collapsed: number
  sort: number | null
}

export interface NoteFolder {
  id: number
  parent_id: number | null
  name: string
  sort: number
}

export interface NoteLink {
  id: number
  src_note_id: number
  dst_note_id: number | null
  dst_title: string
}

export interface NoteRevision {
  id: number
  note_id: number
  title: string
  content_md: string
  format: string
  created_at: string
}

export interface Backlink {
  src_note_id: number
  src_title: string
  snippet: string
}

export interface Flash {
  id: number
  content: string
  remark: string
  source_app: string
  source_url: string
  status: FlashStatus
  /** 转换去向：'task' | 'note' | '' */
  converted_type: string
  converted_id: number
  created_at: string
}

export interface Overview {
  today: number
  overdue: number
  doneToday: number
  notes: number
  inbox: number
}

/** 应用信息（关于页与诊断用） */
export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  dbPath: string
  dbReady: boolean
}
