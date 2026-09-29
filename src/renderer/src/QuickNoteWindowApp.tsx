import { useEffect } from 'react'
import { parseSettings } from '@shared/settings'
import { QuickNotePanel } from './components/QuickNotePanel'
import { applyAppearance } from './theme'

/**
 * 快速笔记浮窗 —— 跑在**自己的小窗口**里（`?quicknote=1`），不占主窗口。
 *
 * 与 CaptureWindowApp 同一套协议：
 *   · 先应用主题再 ready，避免窗口先闪一下默认配色；
 *   · 面板只管记与归档，回执经主进程转给主窗口（用的人多半在别的应用里）。
 */
export function QuickNoteWindowApp(): JSX.Element {
  useEffect(() => {
    void (async () => {
      try {
        applyAppearance(parseSettings(await window.zhixing.db.settings()))
      } catch {
        // 读不到设置就用默认，不能因此卡住窗口
      }
      window.zhixing.quickNote.ready()
    })()
  }, [])

  return (
    <QuickNotePanel
      onClose={() => window.zhixing.quickNote.close()}
      onNotice={(message) => window.zhixing.quickNote.notice(message)}
    />
  )
}
