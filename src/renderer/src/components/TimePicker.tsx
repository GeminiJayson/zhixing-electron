import { useEffect, useRef, useState } from 'react'
import { Timer } from '@renderer/lib/icons'

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'))

interface Props {
  /** 'HH:MM'；空串表示只精确到天 */
  value: string
  onChange: (value: string) => void
  /** 无障碍标签，例如「开始时间」 */
  label: string
}

/**
 * 自绘的时刻选择器。
 *
 * 为什么不用 <input type="time">：它点开的是 Chromium 的**原生面板** —— 那个面板
 * 不进页面的样式树，项高完全不受「控件高度」控制（用户报过这个）。
 * 这里两列数字，每项都借用 .popmenu__item 的 min-height: var(--control-h)，
 * 于是它和输入框、下拉、按钮严格等高，且不受浏览器版本影响。
 *
 * 定位与关闭沿用 PriorityMenu / StatusMenu 那一套（贴锚点下方，点外面或 Esc 关闭）。
 */
export function TimePicker({ value, onChange, label }: Props) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [hour, minute] = value ? value.split(':') : ['', '']

  useEffect(() => {
    if (!open) return
    const rect = btnRef.current?.getBoundingClientRect()
    const el = menuRef.current
    if (el && rect) {
      el.style.left = `${Math.round(rect.left)}px`
      el.style.top = `${Math.round(rect.bottom + 4)}px`
    }
    // 打开时把选中那一格滚进视野：60 个分钟项里，31 分不滚就落在列表外
    el?.querySelector('.popmenu__item--active')?.scrollIntoView({ block: 'center' })

    const onDocDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  const pick = (h: string, m: string): void => {
    onChange(`${h}:${m}`)
    setOpen(false)
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="field timepick"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={value ? undefined : 'timepick__empty'}>{value || '--:--'}</span>
        <Timer size={14} />
      </button>

      {open && (
        <div className="popmenu popmenu--time" ref={menuRef} role="listbox" aria-label={label}>
          <div className="popmenu__col">
            {HOURS.map((h) => (
              <button
                key={h}
                type="button"
                role="option"
                aria-selected={h === hour}
                className={`popmenu__item${h === hour ? ' popmenu__item--active' : ''}`}
                onClick={() => pick(h, minute || '00')}
              >
                {h}
              </button>
            ))}
          </div>
          <div className="popmenu__col">
            {MINUTES.map((m) => (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={m === minute}
                className={`popmenu__item${m === minute ? ' popmenu__item--active' : ''}`}
                onClick={() => pick(hour || '00', m)}
              >
                {m}
              </button>
            ))}
          </div>
          {/* 只精确到天也是一种合法取值，所以清空必须有入口 */}
          <button
            type="button"
            className="popmenu__item popmenu__clear"
            onClick={() => {
              onChange('')
              setOpen(false)
            }}
          >
            清除（只精确到天）
          </button>
        </div>
      )}
    </>
  )
}
