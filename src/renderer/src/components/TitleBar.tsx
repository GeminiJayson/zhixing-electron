import type { MouseEvent } from 'react'
import { Morph, IconData, Square, X } from '@renderer/lib/icons'

interface Props {
  title: string
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  /** 标题栏签名 */
  signature?: string
}

const isMac = window.zhixing.platform === 'darwin'

/**
 * **双击标题栏 = 最大化 / 还原**（Windows 上的原生习惯）。
 *
 * 标题栏是 `-webkit-app-region: drag` 拖窗区，但 **Electron 不会**像系统标题栏那样
 * 自带双击最大化 —— 拖窗归拖窗，双击得自己接。
 *
 * 落在交互控件上的双击不处理（`.titlebar__actions` 里的按钮各有各的 onClick，
 * 双击关闭按钮不该把窗口最大化）。
 */
function onTitlebarDoubleClick(e: MouseEvent<HTMLElement>): void {
  if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return
  void window.zhixing.window.toggleMaximize()
}

export function TitleBar({ title, theme, onToggleTheme, signature }: Props) {
  return (
    <header className="titlebar drag-region" onDoubleClick={onTitlebarDoubleClick}>
      {/* macOS 红绿灯占位（titleBarStyle: hiddenInset） */}
      {isMac && <div className="titlebar__traffic" aria-hidden />}
      <div className="titlebar__title">{title}</div>
      {signature && <div className="titlebar__signature u-aux">{signature}</div>}
      <div className="titlebar__actions no-drag">
        <button
          className="icon-btn"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          title={theme === 'dark' ? '浅色主题' : '深色主题'}
        >
          <Morph icon={theme === 'dark' ? IconData.Sun : IconData.Moon} size={16} />
        </button>
        {!isMac && (
          <>
            <button
              className="icon-btn"
              onClick={() => void window.zhixing.window.minimize()}
              aria-label="最小化"
            >
              <span className="win-dot" />
            </button>
            <button
              className="icon-btn"
              onClick={() => void window.zhixing.window.toggleMaximize()}
              aria-label="最大化"
            >
              <Square size={13} />
            </button>
            <button
              className="icon-btn icon-btn--danger"
              onClick={() => void window.zhixing.window.close()}
              aria-label="关闭"
            >
              <X size={15} />
            </button>
          </>
        )}
      </div>
    </header>
  )
}
