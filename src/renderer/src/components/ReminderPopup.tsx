import { useEffect, useState } from 'react'
import { ReminderCard } from './ReminderCard'
import type { Task } from '@shared/types'

interface Props {
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
 *
 * 卡片本体与气泡共用 components/ReminderCard.tsx。
 */
export function ReminderPopup({ onChanged }: Props) {
  const [due, setDue] = useState<Task[]>([])

  useEffect(() => {
    // 挂载时先拉一次：推送可能早于本窗口挂载完成
    void window.zhixing.reminder.current().then(setDue)
    // 返回取消函数：这个 effect 在开发态 StrictMode 下会跑两次，不注销就会叠层
    return window.zhixing.reminder.onPush(setDue)
  }, [])

  /** 处理一步：主进程回传最新列表，同时把任务列表刷新一遍 */
  const act = (p: Promise<Task[]>): void => {
    void p.then((next) => {
      setDue(next)
      void onChanged()
    })
  }

  if (due.length === 0) return null

  return (
    // 一任务一卡；定位交给容器（.reminder-stack），卡片自身用应用弹框那套 .modal
    <div className="reminder-stack">
      {due.map((task) => (
        // 「查看」由卡片自己走 reminder.openTask → 主进程转发给主窗口，
        // 所以这里不需要再传一个 onOpenTask（那是另一条链路，见 App.tsx 的监听）
        <ReminderCard key={task.id} task={task} onChange={act} />
      ))}
    </div>
  )
}
