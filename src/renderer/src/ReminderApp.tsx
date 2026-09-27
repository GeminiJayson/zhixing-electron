import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ReminderCard } from '@renderer/components/ReminderCard'
import { bindHostEvents, subscribeDomain } from '@shared/events'
import { parseSettings } from '@shared/settings'
import type { Task } from '@shared/types'
import { applyAppearance } from './theme'

/**
 * 提醒气泡（?reminder=1）—— 挂在悬浮表情旁边的透明小窗。
 *
 * 数据全部来自主进程推送：reminder_at 的消费已经收归主进程一处（见 main/index.ts 的
 * startReminderDispatch），这里只负责显示与「用户处理了」。挂载时先拉一次 current ——
 * 推送可能早于本窗口加载完成，而窗口又是启动时就常驻创建的。
 *
 * 卡片本体在 components/ReminderCard.tsx：它与主窗口兜底的 ReminderPopup 共用同一份，
 * 免得「不再提醒」「改状态」这类改动要在两个宿主里各写一遍。
 */
export function ReminderApp() {
  const [rows, setRows] = useState<Task[]>([])
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.zhixing.reminder.current().then(setRows)
    return window.zhixing.reminder.onPush(setRows)
  }, [])

  /**
   * 外观：气泡同样是**独立渲染进程**，主窗口那套主题不在这个进程里 ——
   * 不自己应用一次的话，卡片用的是 tokens.css 的兜底色，跟应用里的主题对不上
   * （实测：主窗口浅色、气泡深色）。与浮窗同一套路，靠 'settings' 域广播重铺。
   */
  useEffect(() => {
    bindHostEvents(window.zhixing.db)
    const syncAppearance = async (): Promise<void> => {
      try {
        applyAppearance(parseSettings(await window.zhixing.db.settings()))
      } catch {
        // 读不到设置就用默认主题，不能因为外观把提醒卡住
      }
    }
    void syncAppearance()
    return subscribeDomain(['settings'], () => void syncAppearance())
  }, [])

  /**
   * 内容一变就把高度报给主进程 —— 窗口的尺寸与落点都归它管（气泡得贴着球）。
   * 用 layoutEffect 而不是 effect：上报要赶在浏览器绘制之前，否则会先闪一帧被裁掉的卡片。
   */
  useLayoutEffect(() => {
    const h = hostRef.current?.scrollHeight
    if (h && h > 0) void window.zhixing.reminder.resize(h)
  }, [rows])

  /** 处理一步（知道了 / 稍后 / 不再提醒 / 改状态）后主进程会回传最新列表，直接照单更新 */
  const act = (p: Promise<Task[]>): void => {
    void p.then(setRows)
  }

  if (rows.length === 0) return <div ref={hostRef} className="rbug" />

  return (
    <div ref={hostRef} className="rbug">
      {rows.map((t) => (
        <ReminderCard key={t.id} task={t} onChange={act} />
      ))}
    </div>
  )
}
