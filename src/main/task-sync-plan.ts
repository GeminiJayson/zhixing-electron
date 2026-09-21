/**
 * 外部任务同步的**决策**部分（纯函数，不碰数据库，便于单测）。
 *
 * 背景：按标题去重时会把**用户自己写的同名任务**「认领」过来，此时只写 external_source / external_id，
 * task-sync.ts 的注释也承诺「只建立映射、不改它的内容」。
 *
 * 但认领之后那条任务就带上了外部身份 —— 下一次同步会走「已存在」分支。若不区分
 * 「外部自建的」与「认领来的」，用户手写的内容就会被外部数据抹掉，**而注释还写着不会**。
 * 所以这里的关键输入是 linked：认领来的任务只**补空**，绝不覆盖用户已经写下的东西。
 */
export interface SyncExisting {
  title: string
  notes_md: string | null
  due_date: string | null
  priority: number | null
  status: string | null
  /** 这条任务是「认领」来的（外部 id 是后贴上去的），不是外部自建的 */
  linked: boolean
}

export interface SyncIncoming {
  title: string
  notes: string
  due: string | null
  priority: number
  /** 外部条目当前是已完成 */
  done: boolean
}

export interface SyncUpdatePlan {
  title?: string
  notes_md?: string
  due_date?: string | null
  priority?: number
  /** 需要把它标记为已完成 */
  markDone: boolean
}

/** 空值判断（认领来的任务只允许在空字段上落外部值）。 */
const isEmpty = (v: string | null | undefined): boolean => v == null || v === ''

export function planSyncUpdate(existing: SyncExisting, incoming: SyncIncoming): SyncUpdatePlan {
  const plan: SyncUpdatePlan = { markDone: incoming.done && existing.status !== 'done' }
  const fillOnly = existing.linked

  // 标题：认领来的任务一律不动 —— 它本来就是靠标题匹配上的，改了反而丢掉锚点
  if (!fillOnly && incoming.title !== existing.title) plan.title = incoming.title

  if (incoming.notes !== (existing.notes_md ?? '') && (!fillOnly || isEmpty(existing.notes_md))) {
    plan.notes_md = incoming.notes
  }
  if ((incoming.due ?? null) !== (existing.due_date ?? null) && (!fillOnly || isEmpty(existing.due_date))) {
    plan.due_date = incoming.due
  }
  if (incoming.priority !== (existing.priority ?? 0) && (!fillOnly || !existing.priority)) {
    plan.priority = incoming.priority
  }
  return plan
}
