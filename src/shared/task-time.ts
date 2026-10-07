/**
 * 按任务聚合番茄钟用时 —— 纯函数，SQL 只负责把行捞出来。
 *
 * 为什么单独一个模块：SQL 里的 GROUP BY 写错了 tsc 看不见（列名是字符串），
 * 而"哪个任务最费时间、合计多少、没挂任务的算多少"这类判断是业务口径，
 * 值得有单测盯着。聚合逻辑放这里，db 层就只剩一条 SELECT。
 */

/** pomodoro_session 里捞出来的一行（LEFT JOIN task 拿标题，任务删了就只剩 null） */
export interface PomodoroRow {
  task_id: number | null
  title: string | null
  minutes: number | null
  started_at: string | null
}

export interface TaskTimeStat {
  /** null = 没挂到具体任务上（「随手一个番茄」，或任务已删） */
  taskId: number | null
  title: string
  minutes: number
  sessions: number
  /** 最近一次的时间串，用于排序展示 */
  lastAt: string | null
}

export interface TaskTimeSummary {
  /** 区间内所有番茄的总分钟 */
  total: number
  /** 其中没挂到任务上的分钟 —— 这部分"去哪了"用户看不出来，值得单列 */
  unassigned: number
  items: TaskTimeStat[]
}

/** 把分钟说成人话：90 → 「1 小时 30 分」 */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(Number(minutes) || 0))
  if (m < 60) return `${m} 分`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`
}

/**
 * 聚合：按 task_id 合并分钟与次数，按用时降序。
 *
 * 只计 completed 的会话 —— 中途放弃的番茄不该算进"这个任务花了多久"，
 * 那会把「打开又关掉」也算成投入（调用方已经在 SQL 里过滤，这里再兜一次坏数据）。
 */
export function summarizeTaskTime(rows: PomodoroRow[], limit = 8): TaskTimeSummary {
  const byTask = new Map<number | null, TaskTimeStat>()
  let total = 0
  let unassigned = 0
  for (const r of rows) {
    const minutes = Math.max(0, Math.round(Number(r.minutes) || 0))
    if (!minutes) continue
    total += minutes
    const key = r.task_id === null || r.task_id === undefined ? null : Number(r.task_id)
    if (key === null) unassigned += minutes
    const prev = byTask.get(key)
    if (prev) {
      prev.minutes += minutes
      prev.sessions += 1
      if (r.started_at && (!prev.lastAt || r.started_at > prev.lastAt)) prev.lastAt = r.started_at
    } else {
      byTask.set(key, {
        taskId: key,
        title: key === null ? '（未挂任务）' : (r.title ?? `已删除的任务 #${key}`),
        minutes,
        sessions: 1,
        lastAt: r.started_at ?? null,
      })
    }
  }
  const items = [...byTask.values()]
    // 用时相同的按最近一次排前：同样是 25 分钟，刚做的那个更值得看
    .sort((a, b) => b.minutes - a.minutes || (b.lastAt ?? '').localeCompare(a.lastAt ?? ''))
    .slice(0, Math.max(0, limit))
  return { total, unassigned, items }
}
