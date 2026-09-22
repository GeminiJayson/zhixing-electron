import { useEffect, useRef, useState } from 'react'
import { NotebookPen, Plus, Sparkles, SquareCheck } from '@renderer/lib/icons'
import type { PageKey } from '../nav'

interface Props {
  /** 当前页：只在今日/任务页显示 */
  page: PageKey
  /** 快速添加任务 */
  onTask: () => void
  /** 新建笔记 */
  onNote: () => void
  /** 记闪念 */
  onFlash: () => void
}

/** 主「+」按钮边长：圆角恒取半高，尺寸是「正圆」的唯一来源。 */
/** 浮动主操作（FAB）的边长。**独立于「控件高度」尺度**：它是页面级主操作，
 *  比表单控件大一档，不随设置页的控件高度缩放；
 *  展开出来的三个动作是 .text-btn，那个才跟控件高度。 */
const MAIN_BTN = 38

/** 展开项：新建任务 / 新建笔记 / 记闪念。 */
const ITEMS = [
  { key: 'task', label: '新建任务', Icon: SquareCheck },
  { key: 'note', label: '新建笔记', Icon: NotebookPen },
  { key: 'flash', label: '记闪念', Icon: Sparkles },
] as const

/** 只在高频新建页出现——其余页已有各自的新建入口，避免重复入口。 */
const VISIBLE_PAGES: readonly PageKey[] = ['today', 'tasks']

/**
 * 右下角快捷新建浮条。
 *
 * 收起态是一个正圆「+」；点开向上展开三枚胶囊。切页离开今日/任务页立即收起，
 * 点击外部或按 Esc 也收起。
 * 样式用行内值 + 设计令牌，不新增样式文件（样式文件不在本域所有权内）。
 */
export function FloatingDock({ page, onTask, onNote, onFlash }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const visible = VISIBLE_PAGES.includes(page)

  // 切到别的页立即收起
  useEffect(() => {
    if (!visible) setOpen(false)
  }, [visible])

  // 点击 dock 之外的任何区域 / 按 Esc 收起展开项
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!visible) return null

  const fire = (fn: () => void): void => {
    setOpen(false)
    fn()
  }

  return (
    <div
      ref={rootRef}
      style={{
        position: 'fixed',
        // 番茄钟浮条常驻右下（24px），这里抬高一层避免叠在一起
        right: 'var(--space-5)',
        bottom: 'calc(var(--space-5) + 52px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        zIndex: 'var(--z-float)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
          opacity: open ? 1 : 0,
          transform: open ? 'none' : 'translateY(6px)',
          transition: 'opacity var(--dur-fast) var(--ease-enter), transform var(--dur-fast) var(--ease-enter)',
          pointerEvents: open ? 'auto' : 'none',
        }}
        aria-hidden={!open}
      >
        {ITEMS.map(({ key, label, Icon }) => (
          <button
            key={key}
            className="text-btn"
            tabIndex={open ? 0 : -1}
            onClick={() => fire(key === 'task' ? onTask : key === 'note' ? onNote : onFlash)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minHeight: 'var(--control-h)',
              padding: '3px 10px',
              borderRadius: 'var(--radius-ctl)',
              background: 'var(--bg-layer-solid)',
              border: 'var(--border-w) solid var(--border)',
              boxShadow: 'var(--shadow-sm)',
              fontSize: 'var(--text-aux)',
              color: 'var(--fg-primary)',
              whiteSpace: 'nowrap',
            }}
          >
            <Icon size={14} aria-hidden /> {label}
          </button>
        ))}
      </div>
      <button
        className="icon-btn"
        aria-label="快捷新建"
        title="快捷新建"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          width: MAIN_BTN,
          height: MAIN_BTN,
          minWidth: MAIN_BTN,
          minHeight: MAIN_BTN,
          padding: 0,
          borderRadius: MAIN_BTN / 2,
          background: 'var(--accent)',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        <Plus
          size={18}
          aria-hidden
          style={{
            transform: open ? 'rotate(45deg)' : 'none',
            transition: 'transform var(--dur-fast) var(--ease-enter)',
          }}
        />
      </button>
    </div>
  )
}
