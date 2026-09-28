/**
 * 工作流的定时调度：把「哪些模板到点了」这个判断做成纯函数，定时器只负责喂它数据。
 *
 * 分开的理由：判断本身（interval 够不够久、daily 是不是今天还没跑）是逻辑，
 * 而 setInterval / 数据库查询是环境 —— 混在一起就只能靠"等一分钟看看"来测。
 *
 * 记账不另存状态：`lastFiredAt` 由调用方从数据库里查最近一次
 * trigger_kind='schedule' 的实例得到。内存里的 Map 一重启就丢，
 * daily 计划会在同一天里补跑一次。
 */
import { dueByDaily, dueByInterval, parseSchedule } from '../../shared/workflow-trigger'

export interface ScheduleTarget {
  id: number
  name: string
  /** 模板上的 schedule（JSON 字符串，空 = 手动） */
  schedule: string
  /** 上一次**由计划触发**的实例是什么时候；从没跑过传 null */
  lastFiredAt: number | null
}

export interface DueHit {
  id: number
  name: string
  /** 给启动日志与界面看的一行说明，如「每 30 分钟」 */
  label: string
}

/** 该在 now 这一刻触发的模板。同一刻最多给每个模板一次机会，不会重复排队。 */
export function dueTargets(targets: ScheduleTarget[], now: Date): DueHit[] {
  const hits: DueHit[] = []
  for (const t of targets) {
    const s = parseSchedule(t.schedule)
    if (s.kind === 'manual') continue
    const due =
      s.kind === 'interval'
        ? dueByInterval(s, t.lastFiredAt, now.getTime())
        : dueByDaily(s, t.lastFiredAt, now)
    if (!due) continue
    hits.push({
      id: t.id,
      name: t.name,
      label: s.kind === 'interval' ? `每 ${s.everyMin} 分钟` : `每天 ${s.at}`,
    })
  }
  return hits
}
