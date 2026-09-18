/** 截止日期的展示语义，今日页与任务页共用。 */

export interface DueLabel {
  text: string
  tone: 'overdue' | 'today' | 'soon' | 'none'
}

export function dueLabel(due: string | null): DueLabel {
  if (!due) return { text: '', tone: 'none' }
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const target = new Date(`${due}T00:00:00`)
  if (Number.isNaN(target.getTime())) return { text: due, tone: 'none' }
  const days = Math.round((target.getTime() - start.getTime()) / 86_400_000)
  // 数据里存在哨兵日期（如 1753-09-14），原版直接显示该日期；换算成天数会产生荒谬值
  if (Math.abs(days) > 3650) return { text: due, tone: 'soon' }
  if (days < 0) return { text: `逾期 ${-days} 天`, tone: 'overdue' }
  if (days === 0) return { text: '今天', tone: 'today' }
  if (days === 1) return { text: '明天', tone: 'soon' }
  return { text: `${target.getMonth() + 1} 月 ${target.getDate()} 日`, tone: 'soon' }
}

/** 「开始 ~ 截止」区间 chip 文案（对齐手册 §5.2 的时间范围 chip） */
export function rangeLabel(start: string | null, due: string | null): string {
  if (start && due) return start === due ? due : `${start} ~ ${due}`
  if (due) return due
  if (start) return `${start} 起`
  return ''
}
