import { useEffect, useState } from 'react'
import { Bell } from 'lucide-react'
import type { Task } from '@shared/types'

interface Props {
  onOpenTask: (id: number) => void
  onChanged: () => Promise<void>
}

/**
 * 到点提醒：每 30 秒轮询一次到期提醒，弹卡片；
 * 「知道了」清空 reminder_at（一次性语义），或稍后 5/15/30 分。
 */
export function ReminderPopup({ onOpenTask, onChanged }: Props) {
  const [due, setDue] = useState<Task[]>([])

  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      const rows = await window.zhixing.db.dueReminders()
      if (alive) setDue(rows)
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 30_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  if (due.length === 0) return null
  const task = due[0]

  const dismiss = async (): Promise<void> => {
    await window.zhixing.db.dismissReminder(task.id)
    setDue((rows) => rows.filter((r) => r.id !== task.id))
    await onChanged()
  }

  const snooze = async (minutes: number): Promise<void> => {
    await window.zhixing.db.snoozeReminder(task.id, minutes)
    setDue((rows) => rows.filter((r) => r.id !== task.id))
    await onChanged()
  }

  return (
    <div className="reminder" role="alertdialog" aria-label="到点提醒">
      <header className="reminder__head">
        <Bell size={14} aria-hidden /> 到点提醒
        {due.length > 1 && <span className="u-aux">还有 {due.length - 1} 条</span>}
      </header>
      <p className="reminder__title">{task.title}</p>
      <p className="u-aux">
        {task.reminder_at ? `提醒时刻 ${task.reminder_at}` : '已到提醒时间'}
        {task.due_date ? ` · 截止 ${task.due_date}` : ''}
      </p>
      <div className="reminder__actions">
        <button className="text-btn" onClick={() => void snooze(5)}>
          稍后 5 分
        </button>
        <button className="text-btn" onClick={() => void snooze(15)}>
          15 分
        </button>
        <button className="text-btn" onClick={() => void snooze(30)}>
          30 分
        </button>
        <button
          className="text-btn"
          onClick={() => {
            onOpenTask(task.id)
            void dismiss()
          }}
        >
          查看
        </button>
        <button className="text-btn text-btn--accent" onClick={() => void dismiss()}>
          知道了
        </button>
      </div>
    </div>
  )
}
