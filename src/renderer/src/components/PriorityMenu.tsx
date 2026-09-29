import { useEffect, useRef } from 'react'
import { PRIORITY_CHOICES, priorityColor } from '@shared/priority'
import { placeAnchored } from '@renderer/lib/anchored-position'

interface Props {
  anchor: HTMLElement
  current: number
  onPick: (priority: number) => void
  onClose: () => void
}

/** 点任务行旗子弹出的优先级菜单：无 / P1–P8（与手册一致）。 */
export function PriorityMenu({ anchor, current, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    // 同 StatusMenu：下方放不下时翻到上方，任务项在窗口底部也点得到
    if (el) placeAnchored(el, anchor.getBoundingClientRect())
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
