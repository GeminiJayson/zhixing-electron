import { useState } from 'react'
import { Bell } from '@renderer/lib/icons'
import { STATUS_CHOICES, STATUS_LABELS, STATUS_TONES } from '@shared/task'
import type { Task, TaskStatus } from '@shared/types'

interface Props {
  task: Task
  /**
   * 处理一步。主进程处理完会回传**最新列表**（dismiss / snooze / mute 都返回 Task[]），
   * 宿主拿到后照单更新即可。
   */
  onChange: (p: Promise<Task[]>) => void
}

/**
 * 到点提醒的一张卡。
 *
 * 提取成组件是因为它有两个宿主：悬浮球旁边的气泡（ReminderApp，主呈现）与主窗口兜底的
 * 卡片（ReminderPopup）。原先两处各写了一遍、按钮与文案还不完全一样 —— 要加「不再提醒」
 * 与状态设置时，这种重复立刻变成两倍成本。
 *
 * 交互上的一处取舍：**改状态即视为处理完了**。用户点「进行中」说明他已经在想这件事，
 * 再要求他额外点一次「知道了」是多余的动作，所以改状态成功后顺手把这条提醒消费掉。
 */
export function ReminderCard({ task, onChange }: Props) {
  /** 已点选、正在填原因的状态；null = 还没动状态 */
  const [pending, setPending] = useState<TaskStatus | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const applyStatus = async (): Promise<void> => {
    if (!pending || busy) return
    setBusy(true)
    try {
      await window.zhixing.db.updateTask(task.id, { status: pending })
      // 原因说明是可选的：空着就只记状态迁移，速览的时间轴照样读得懂
      await window.zhixing.db.pushTaskActivity(
        task.id,
        'status',
        STATUS_LABELS[task.status] + ' → ' + STATUS_LABELS[pending],
        reason.trim() || null
      )
      // 改完状态就把这条提醒消费掉（见组件注释里的取舍）
      onChange(window.zhixing.reminder.dismiss(task.id))
    } catch {
      setBusy(false)
    }
  }

  return (
    <div className="modal modal--reminder" role="alertdialog" aria-label="到点提醒">
      <header className="modal__head">
        <Bell size={15} aria-hidden />
        <h2>到点提醒</h2>
      </header>
      <div className="modal__body">
        <p className="reminder__title">{task.title}</p>
        <p className="u-aux">
          {task.reminder_at ? `提醒时刻 ${task.reminder_at.slice(11, 16)}` : '已到提醒时间'}
          {task.due_date ? ` · 截止 ${task.due_date}` : ''}
        </p>
        {/* 状态设置：点一下就地展开原因行，不另开弹窗（项目一贯不叠浮层） */}
        <div className="reminder__status" role="group" aria-label="设置任务状态">
          {STATUS_CHOICES.map((s) => (
            <button
              key={s.value}
              className={'chip chip--status-' + STATUS_TONES[s.value]}
              aria-pressed={pending === s.value}
              onClick={() => setPending(pending === s.value ? null : s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
        {pending && (
          <div className="reminder__reason">
            <input
              className="field field--compact"
              autoFocus
              value={reason}
              placeholder="说明为什么改成这个状态（可留空，回车提交）"
              aria-label="状态变更原因"
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void applyStatus()
                if (e.key === 'Escape') setPending(null)
              }}
            />
            <button className="text-btn text-btn--accent" disabled={busy} onClick={() => void applyStatus()}>
              记下
            </button>
          </div>
        )}
      </div>
      <div className="modal__foot reminder__actions">
        <button className="text-btn" onClick={() => onChange(window.zhixing.reminder.snooze(task.id, 5))}>
          稍后 5 分
        </button>
        <button className="text-btn" onClick={() => onChange(window.zhixing.reminder.snooze(task.id, 15))}>
          15 分
        </button>
        <button className="text-btn" onClick={() => onChange(window.zhixing.reminder.snooze(task.id, 30))}>
          30 分
        </button>
        <button
          className="text-btn"
          title="只关掉这一次；以后重新设了提醒照样会响"
          onClick={() => onChange(window.zhixing.reminder.mute(task.id, reason.trim() || null))}
        >
          不再提醒
        </button>
        <button
          className="text-btn"
          onClick={() => {
            void window.zhixing.reminder.openTask(task.id)
            onChange(window.zhixing.reminder.dismiss(task.id))
          }}
        >
          查看
        </button>
        <button
          className="text-btn text-btn--accent"
          onClick={() => onChange(window.zhixing.reminder.dismiss(task.id))}
        >
          知道了
        </button>
      </div>
    </div>
  )
}
