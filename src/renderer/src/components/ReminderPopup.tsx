import { useCallback, useEffect, useState } from 'react'
import { Bell } from 'lucide-react'
import type { Task } from '@shared/types'

interface Props {
  onOpenTask: (id: number) => void
  onChanged: () => Promise<void>
}

/**
 * 到点提醒：每 30 秒轮询一次到期提醒。
 *
 * Python 侧对**每条**到期任务各弹一窗（app_controller._check_reminders，D17），
 * 这里同样逐条渲染卡片，而不是只显示 due[0] 再把它余下的降级成一个计数。
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

  const drop = useCallback((id: number): void => {
    setDue((rows) => rows.filter((r) => r.id !== id))
  }, [])

  const dismiss = async (id: number): Promise<void> => {
    await window.zhixing.db.dismissReminder(id)
    drop(id)
    await onChanged()
  }

  const snooze = async (id: number, minutes: number): Promise<void> => {
    await window.zhixing.db.snoozeReminder(id, minutes)
    drop(id)
    await onChanged()
  }

  if (due.length === 0) return null

  return (
    // 一任务一卡；定位交给容器，卡片自身取消 fixed 以便纵向堆叠
    <div
      style={{
        position: 'fixed',
        right: 'var(--space-5)',
        top: 'calc(var(--titlebar-h) + var(--space-3))',
        width: 300,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
        zIndex: 'var(--z-reminder)',
      }}
    >
      {due.map((task) => (
        <div
          key={task.id}
          className="reminder"
          role="alertdialog"
          aria-label="到点提醒"
          style={{ position: 'static', width: '100%' }}
        >
          <header className="reminder__head">
            <Bell size={14} aria-hidden /> 到点提醒
          </header>
          <p className="reminder__title">{task.title}</p>
          <p className="u-aux">
            {task.reminder_at ? `提醒时刻 ${task.reminder_at}` : '已到提醒时间'}
            {task.due_date ? ` · 截止 ${task.due_date}` : ''}
          </p>
          <div className="reminder__actions">
            <button className="text-btn" onClick={() => void snooze(task.id, 5)}>
              稍后 5 分
            </button>
            <button className="text-btn" onClick={() => void snooze(task.id, 15)}>
              15 分
            </button>
            <button className="text-btn" onClick={() => void snooze(task.id, 30)}>
              30 分
            </button>
            <button
              className="text-btn"
              onClick={() => {
                onOpenTask(task.id)
                void dismiss(task.id)
              }}
            >
              查看
            </button>
            <button className="text-btn text-btn--accent" onClick={() => void dismiss(task.id)}>
              知道了
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
