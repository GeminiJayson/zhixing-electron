import { useEffect, useRef } from 'react'
import { PRIORITY_CHOICES, priorityColor } from '@shared/priority'

interface Props {
  anchor: HTMLElement
  current: number
  onPick: (priority: number) => void
  onClose: () => void
}

/** 点任务行旗子弹出的优先级菜单：无 / P1–P8（与手册 §5.3 一致）。 */
export function PriorityMenu({ anchor, current, onPick, onClose }: Props) {
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
      {PRIORITY_CHOICES.map((c) => (
        <button
          key={c.value}
          role="menuitemradio"
          aria-checked={c.value === current}
          className={`popmenu__item${c.value === current ? ' popmenu__item--active' : ''}`}
          onClick={() => onPick(c.value)}
        >
          <span className="popmenu__dot" style={{ background: priorityColor(c.value) }} />
          {c.label}
        </button>
      ))}
    </div>
  )
}
