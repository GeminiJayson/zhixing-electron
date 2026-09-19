import { useEffect, useState } from 'react'
import { parseSettings } from '@shared/settings'
import { CapturePanel } from './components/CapturePanel'
import { applyAppearance } from './theme'

/**
 * 全局热键唤出的捕获面板 —— 跑在**自己的小窗口**里（`?capture=1`），不占主窗口。
 *
 * 卡片与工作流条件确认窗共用同一套骨架（.modal + .dialog__icon + .modal__foot），
 * 所以外观、主题、字体都一致；这里只负责接 payload、把结果回执给主进程。
 */
export function CaptureWindowApp(): JSX.Element | null {
  const [payload, setPayload] = useState<{
    mode: 'quick' | 'capture'
    seed: { text: string; html: string }
  } | null>(null)

  useEffect(() => window.zhixing.capture.onOpen(setPayload), [])

  // 应用与主窗口一致的主题，完成后再让主进程显示窗口（避免先闪一下默认配色）
  useEffect(() => {
    void (async () => {
      try {
        applyAppearance(parseSettings(await window.zhixing.db.settings()))
      } catch {
        // 读不到设置就用默认
      }
      window.zhixing.capture.ready()
    })()
  }, [])

  // 无边框窗口要贴合卡片：payload 到了、卡片渲染出来之后再量，之后跟着内容变化重算
  useEffect(() => {
    if (!payload) return
    const el = document.querySelector('.modal')
    if (!el) return
    const report = (): void => window.zhixing.app.fitHeight(Math.ceil(el.getBoundingClientRect().height))
    const timer = window.setTimeout(report, 60)
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => {
      window.clearTimeout(timer)
      ro.disconnect()
    }
  }, [payload])

  if (!payload) return null
  return (
    <CapturePanel
      open
      embedded
      mode={payload.mode}
      seed={payload.seed}
      onClose={() => window.zhixing.capture.close()}
      // 完成即回执：主进程会关掉本窗口，并把提示转给主窗口（不显示主窗口）
      onNotice={(message) => window.zhixing.capture.done(message)}
      onChanged={async () => undefined}
    />
  )
}
