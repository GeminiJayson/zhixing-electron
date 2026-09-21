import { useEffect, useState } from 'react'
import { Bell } from '@renderer/lib/icons'
import type { Task } from '@shared/types'

interface Props {
  onOpenTask: (id: number) => void
  onChanged: () => Promise<void>
}

/**
 * 到点提醒（主窗口兜底的卡片）。
 *
 * 提醒的主呈现是悬浮表情旁边的气泡（见 ReminderApp）；只有浮窗关掉 / 不可见时，
 * 主进程才会把列表推到这里（dispatchReminders 二选一）。
 *
 * 所以本组件**不再自己轮询数据库** —— reminder_at 的消费已收归主进程一处，
 * 渲染层自己查（旧的 db:dueReminders 是查与清合一）会和气泡窗口互相抢着清，
 * 用户反而少看到一条提醒。这里只显示与「用户处理了」。
 */
export function ReminderPopup({ onOpenTask, onChanged }: Props) {
  const [due, setDue] = useState<Task[]>([])

  useEffect(() => {
    // 挂载时先拉一次：推送可能早于本窗口挂载完成
    void window.zhixing.reminder.current().then(setDue)
    // 返回取消函数：这个 effect 在开发态 StrictMode 下会跑两次，不注销就会叠层
    return window.zhixing.reminder.onPush(setDue)
  }, [])

  const dismiss = async (id: number): Promise<void> => {
    setDue(await window.zhixing.reminder.dismiss(id))
    await onChanged()
  }

  const snooze = async (id: number, minutes: number): Promise<void> => {
    setDue(await window.zhixing.reminder.snooze(id, minutes))
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
            {task.reminder_at ? `提醒时刻 ${task.reminder_at.slice(11, 16)}` : '已到提醒时间'}
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
