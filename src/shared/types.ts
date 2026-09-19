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
  /** 结构化属性（JSON 对象字符串）：{ "来源": "书籍", "评分": "5" } */
  props?: string | null
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
  /** 旧库的单条 SOP 绑定（新写入时同步为 note_ids 的第一条） */
  note_id: number | null
  /** SOP 文档可以绑多条；读取时若为空则回退成 [note_id] */
  note_ids: number[]
  action_kind: string
  action_value: string
  /** 命令 / 脚本的期望退出码（文本，空 = 0） */
  action_expect: string
  /** 脚本步骤的运行环境：powershell / cmd / python / node（空 = powershell） */
  action_runtime: string
  /** 遗留字段：步骤自带的「进入条件」文本（编辑器已不再提供） */
  condition: string
  branch_node_id: number | null
  pos_x: number | null
  pos_y: number | null
}

/** 一次节点执行的运行态 —— 自动节点（命令 / 脚本）跑的进度与结果。 */
export interface NodeRunResult {
  nodeId: number
  /** task / command / script / condition */
  kind: string
  /** running：正在跑；ok：返回值正确；failed：退出码不符；timeout：超时被掐断 */
  state: 'running' | 'ok' | 'failed' | 'timeout'
  code: number | null
  /** 进程输出（截断后的尾部），供人工排查 */
  output: string
  message: string
  at: string
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
  /** 最近一次节点执行的结果：条件节点「上一步结果」的来源，也是失败后的可见凭据 */
  last_result: NodeRunResult | null
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

/** 图谱节点 kind，与 graph_service.GraphNode.kind 同名（anchor = v0.15 段落锚） */
export type GraphKind = 'note' | 'folder' | 'dangling' | 'task' | 'flash' | 'anchor'

export interface GraphNodePayload {
  id: number
  label: string
  kind: GraphKind
  size: number
  degree: number
  colorHint: string
  refId: number
  format: string
  /** anchor：引用该段落的任务 id（对齐 GraphNode.ref_task） */
  refTask?: number
  /** anchor：段落定位键（对齐 GraphNode.block_key） */
  blockKey?: string
  /** anchor：段落引文快照（对齐 GraphNode.snippet） */
  snippet?: string
}

export interface GraphPayload {
  nodes: GraphNodePayload[]
  edges: [number, number][]
  /** "src,dst" → 边类别；归属=实线，引用=虚线 */
  edgeKinds: Record<string, 'ownership' | 'reference'>
  /** 因环路被破环丢弃的归属层级边（对齐 GraphData.cycle_edges，供图页提示） */
  cycleEdges: [number, number][]
}

/** 图谱构建参数（对齐 GraphService.build 的 folder_id / tag_id / include_tasks）。 */
export interface GraphQuery {
  /** 是否纳入任务节点（Python 图页默认 True） */
  includeTasks?: boolean
  /** 仅看某笔记文件夹 */
  folderId?: number | null
  /** 仅看带某笔记标签的笔记 */
  tagId?: number | null
  /** 邻域子图：仅保留这些笔记主键（对齐 neighborhood 的 only_ids） */
  onlyIds?: number[] | null
}

/**
 * 图谱增量（对齐 GraphDelta）：相对上一帧的最小变更集。
 * 消费端据此做定点增删、保留节点坐标与 pinned，避免整图重建。
 */
export interface GraphDelta {
  addedNodes: GraphNodePayload[]
  removedNodeIds: number[]
  updatedNodeIds: number[]
  /** 更新后的节点快照（渲染层拿不到主进程缓存，Python 侧由消费端读 cache.by_id） */
  updatedNodes?: GraphNodePayload[]
  addedEdges: [number, number][]
  removedEdges: [number, number][]
  /** 新增边的类别 */
  edgeKinds: Record<string, 'ownership' | 'reference'>
  /** True=结构剧变（无上一帧），建议整体重建但保留坐标 */
  full: boolean
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

/** 任务↔笔记「段落级」上下文（task_note_context 表，schema v12）。 */
export interface TaskNoteContext {
  id: number
  task_id: number
  note_id: number
  /** 段落块键（回跳定位用） */
  block_key: string
  /** 引文快照（定位兜底 + 预览） */
  snippet: string
  created_at: string | null
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
  /** 只读模式原因（库能打开但迁移失败）；空/缺省表示正常（D2） */
  dbReadonly?: string
  /** 完全打不开时的中文原因；空/缺省表示正常（D2） */
  dbError?: string
}
