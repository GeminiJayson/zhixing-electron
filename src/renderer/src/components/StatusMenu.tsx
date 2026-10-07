import { useEffect, useRef } from 'react'
import { STATUS_CHOICES, STATUS_LABELS, STATUS_TONES } from '@shared/task'
import type { TaskStatus } from '@shared/types'
import { placeAnchored } from '@renderer/lib/anchored-position'

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
    const el = ref.current
    // 贴锚点下方，并在下方放不下时翻到上方 —— 任务项在窗口底部时，
    // 旧写法会让菜单从下沿探出去，最后几项（已完成 / 已放弃）根本点不到
    if (el) placeAnchored(el, anchor.getBoundingClientRect())
    const onDocDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    // 捕获阶段：弹窗内部会 stopPropagation 掉冒泡事件，冒泡监听收不到（见 Select 里的说明）
    document.addEventListener('mousedown', onDocDown, true)
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
