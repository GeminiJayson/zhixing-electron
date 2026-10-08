/** 主进程与渲染进程共享的类型定义。字段与现有 SQLite schema v18 对齐。 */

import type { TaskTimeSummary } from './task-time'

export type TaskStatus = 'todo' | 'doing' | 'waiting' | 'done' | 'abandoned'
export type RepeatPeriod = 'none' | 'daily' | 'weekly' | 'monthly' | 'custom'
export type NoteFormat = 'markdown' | 'richtext' | 'word' | 'excel' | 'link' | 'script' | 'mount'

/** 脚本笔记的运行环境（只有 format === 'script' 时有意义） */
/**
 * 番茄钟上报给浮窗的状态。
 *
 * 计时宿主是番茄钟小窗（见 PomodoroWindowApp）—— 浮窗只是**显示方**：
 * 小窗收起后用户看不到它，倒计时就落到悬浮表情（球）或浮窗标题行上。
 */
export interface PomodoroTick {
  phase: 'focus' | 'break'
  /** 这一段是长休息 */
  long?: boolean
  /** 剩余秒数 */
  remain: number
  running: boolean
  title: string
  /** 小窗是否收起：只有收起时浮窗才显示倒计时（展开后它自己就看得见，浮窗让位） */
  collapsed: boolean
}

export type ScriptNoteRuntime = 'powershell' | 'cmd' | 'python' | 'node'
export type FlashStatus = 'inbox' | 'archived' | 'converted'

export interface Task {
  id: number
  title: string
  notes_md: string
  status: TaskStatus
  priority: number
  due_date: string | null
  start_date: string | null
  /** 开始时刻 HH:MM（空 = 只精确到天）；与 start_date 合起来才是完整时刻 */
  start_time: string | null
  /** 截止时刻 HH:MM（空 = 当天结束前都算没到期） */
  due_time: string | null
  reminder_at: string | null
  /** 已提醒次数（提醒次数设置的记账） */
  reminder_fired: number | null
  /** 计数所依据的基准时刻；基准变了就重新计数 */
  reminder_base: string | null
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
  /** 脚本笔记的运行环境（其余格式为空）；见 ScriptNoteRuntime */
  script_runtime?: ScriptNoteRuntime | null
  /**
   * 挂载文件的引用行：'<挂载点 id>:<相对路径>'（format = 'mount'）。
   *
   * 只有被引用过的挂载文件才有行，**正文不入库**（打开时现读磁盘）。
   * 挂载点被卸载后这一行保留，界面按「来源已失效」显示（见挂载点的清理入口）。
   */
  mount_ref?: string | null
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
  /** 近 30 天按任务聚合的番茄用时（没挂任务的分钟单列出来） */
  taskTime: TaskTimeSummary
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
  /**
   * 日志规则（JSON 字符串，空 = 不看日志、只认退出码）：
   * 关键字匹配决定这一步的成败，命中「等待输入」类规则时还会把预设回答写进 stdin。
   * 结构见 shared/workflow-log-rules.ts。
   */
  log_rules: string
  /** 遗留字段：步骤自带的「进入条件」文本（编辑器已不再提供） */
  condition: string
  /** 条件成立（满足）时跳到的节点；空 = 按顺序走下一步 */
  branch_node_id: number | null
  /** 条件不成立（不满足）时跳到的节点；空 = 按顺序走下一步 */
  branch_false_node_id: number | null
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
  /** 定时计划（JSON 字符串，空 = 手动；见 shared/workflow-trigger.ts） */
  schedule: string
  /** 触发条件（JSON 字符串数组，空 = 无外部触发） */
  triggers: string
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
  /**
   * 这个实例是被什么拉起来的：manual / schedule / task_status / http / subflow。
   * 对用户是"这条是定时跑出来的"，对调度器是账本（"今天跑过没有"查最近一次 schedule 实例）。
   */
  trigger_kind: string
  /** 子流程时：父实例 id；普通实例为 null */
  parent_instance_id: number | null
  steps: WorkflowStepPayload[]
}

/** 任务活动流的分类：提醒 / 稍后 / 知道了 / 不再提醒 / 状态变更 */
export type TaskActivityKind = 'remind' | 'snooze' | 'dismiss' | 'mute' | 'status'

/**
 * 任务活动流的一条（task_activity）。
 *
 * 与 `task.reminder_at` / `reminder_fired` 的分工：那两列是**提醒调度**的状态
 * （下次什么时候响、这一轮第几次），这张表是**给人看的历史**（速览里的「活动记录」时间轴）。
 */
export interface TaskActivity {
  id: number
  task_id: number
  kind: TaskActivityKind
  /** 附加说明：稍后的分钟数、状态的 from→to、提醒的时刻… */
  detail: string | null
  /** 用户填写的原因说明（状态变更 / 不再提醒时可选） */
  reason: string | null
  created_at: string
}

/**
 * 工作流实例的执行日志一条（workflow_run_log）。
 *
 * 与 last_result 的分工：last_result 只存**最近一次**节点结果，是给下一个节点（条件判定）读的；
 * 这张表按时间追加，用来回答「这次运行每一步什么时候跑的、结果如何、现在卡在哪」。
 */
export interface WorkflowRunLogEntry {
  id: number
  instance_id: number
  node_id: number | null
  /**
   * start 开始 / enter 进入节点 / done 节点跑完 / finish 整个实例结束
   * / log 执行过程中的日志片段（节流写入，不是每个 chunk 一条）
   */
  kind: 'start' | 'enter' | 'done' | 'finish' | 'log'
  detail: string | null
  created_at: string
}

export interface WorkflowTemplateSummary {
  id: number
  name: string
  description: string
  start_policy: string
  /** 定时计划与触发条件（原样透出 JSON 字符串，由渲染层解析） */
  schedule: string
  triggers: string
  node_count: number
  updated_at: string
}

/** 图谱节点 kind（anchor = v0.15 段落锚） */
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
  /**
   * 笔记的知识类型（概念 / 摘要 / 方法论 / 踩坑 …）。
   *
   * 图谱上更该看出"这是概念还是踩坑"，而不是"它在哪个文件夹" ——
   * 所以在有 subKind 时优先按它上色，colorHint 退为兜底。
   */
  subKind?: string
  /** 待确认（未核对）的笔记，图谱上弱化显示 */
  unverified?: boolean
  /** anchor：引用该段落的任务 id */
  refTask?: number
  /** anchor：段落定位键 */
  blockKey?: string
  /** anchor：段落引文快照 */
  snippet?: string
}

export interface GraphPayload {
  nodes: GraphNodePayload[]
  edges: [number, number][]
  /** "src,dst" → 边类别；归属=实线，引用=虚线 */
  edgeKinds: Record<string, 'ownership' | 'reference'>
  /** 因环路被破环丢弃的归属层级边 */
  cycleEdges: [number, number][]
}

/** 图谱构建参数。 */
export interface GraphQuery {
  /** 是否纳入任务节点 */
  includeTasks?: boolean
  /** 仅看某笔记文件夹 */
  folderId?: number | null
  /** 仅看带某笔记标签的笔记 */
  tagId?: number | null
  /** 邻域子图：仅保留这些笔记主键 */
  onlyIds?: number[] | null
}

/**
 * 图谱增量：相对上一帧的最小变更集。
 * 消费端据此做定点增删、保留节点坐标与 pinned，避免整图重建。
 */
export interface GraphDelta {
  addedNodes: GraphNodePayload[]
  removedNodeIds: number[]
  updatedNodeIds: number[]
  /** 更新后的节点快照 */
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
  /**
   * 非空表示这是**挂载的本地文件夹**：指向本机目录，里面的文档不入库。
   *
   * 用 note_folder 而不是新开一张表，是因为挂载点本来就该是笔记树上的一个普通文件夹 ——
   * 能拖到任意文件夹下（parent_id 就是它的位置）、能改名、能排序；
   * 新表意味着树要同时读两套数据、右键菜单要写两份逻辑。
   */
  mount_path?: string | null
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
  /**
   * 'html' 表示 content 是网页剪藏来的 HTML。
   *
   * 渲染方**必须用沙箱 iframe**，不能直接插进 DOM —— 那段 HTML 来自不受信任的
   * 外部网页（见 InboxPage 里的渲染与 docs/specs/phase3-research.md §1.3）。
   */
  content_format?: string
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
  /** 收件箱待整理量：未归档闪念 + 收件箱里未完成的任务（含子任务），与收件箱页两个 tab 的数同口径 */
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
  /** 只读模式原因（库能打开但迁移失败）；空/缺省表示正常 */
  dbReadonly?: string
  /** 完全打不开时的中文原因；空/缺省表示正常 */
  dbError?: string
}
