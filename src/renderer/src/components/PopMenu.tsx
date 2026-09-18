import { useEffect, useRef } from 'react'

export interface PopMenuItem {
  key: string
  label: string
  danger?: boolean
  checked?: boolean
  onPick: () => void
}

interface Props {
  x: number
  y: number
  items: PopMenuItem[]
  onClose: () => void
}

/** 通用弹出菜单：优先级菜单、标签菜单、任务行右键菜单共用。 */
export function PopMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (el) {
      el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 200))}px`
      el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 48 - items.length * 30))}px`
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
  }, [x, y, items.length, onClose])

  return (
    <div className="popmenu" ref={ref} role="menu">
      {items.map((it) => (
        <button
          key={it.key}
          role="menuitem"
          className={`popmenu__item${it.danger ? ' popmenu__item--danger' : ''}`}
          onClick={() => {
            it.onPick()
            onClose()
          }}
        >
          <span className={`popmenu__tick${it.checked ? ' popmenu__tick--on' : ''}`} />
          {it.label}
        </button>
      ))}
    </div>
  )
}
