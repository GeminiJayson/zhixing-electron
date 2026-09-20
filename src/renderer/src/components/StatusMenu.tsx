import { useEffect, useRef } from 'react'
import { STATUS_CHOICES, STATUS_LABELS, STATUS_TONES } from '@shared/task'
import type { TaskStatus } from '@shared/types'

interface Props {
  anchor: HTMLElement
  current: TaskStatus
  onPick: (status: TaskStatus) => void
  onClose: () => void
}

/**
 * 点任务行状态胶囊弹出的状态菜单。
 *
 * 定位与关闭约定与 PriorityMenu 完全一致（贴着锚点下方、点外面或 Esc 关闭），
 * 这样两个胶囊的手感是一样的。
 */
export function StatusMenu({ anchor, current, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const rect = anchor.getBoundingClientRect()
    const el = ref.current
    if (el) {
      el.style.left = `${Math.round(rect.left)}px`
      el.style.top = `${Math.round(rect.bottom + 4)}px`
    }
    const onDocDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [anchor, onClose])

  return (
    <div className="popmenu" ref={ref} role="menu">
      {STATUS_CHOICES.map((c) => (
        <button
          key={c.value}
          role="menuitemradio"
          aria-checked={c.value === current}
          aria-label={STATUS_LABELS[c.value]}
          className={`popmenu__item${c.value === current ? ' popmenu__item--active' : ''}`}
          onClick={() => onPick(c.value)}
        >
          {/* 圆点跟着状态色走：.chip--status-* 只负责给 currentColor，这里拿它当底色 */}
          <span
            className={`popmenu__dot chip--status-${STATUS_TONES[c.value]}`}
            style={{ background: 'currentColor' }}
          />
          {STATUS_LABELS[c.value]}
        </button>
      ))}
    </div>
  )
}
