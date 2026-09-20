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

interface Draft {
  h: string
  m: string
}

/**
 * 自绘的时刻选择器。
 *
 * 为什么不用 <input type="time">：它点开的是 Chromium 的**原生面板** —— 那个面板
 * 不进页面的样式树，项高完全不受「控件高度」控制（用户报过这个）。这里两列数字，
 * 每项借用 .popmenu__item 的 min-height: var(--control-h)，与其它控件严格等高。
 *
 * 取值分两步：面板里点选只改**草稿**（按钮上实时预览，他可能还要选另一列），
 * 等失焦 / 点外面 / Esc 才写回 —— 选过任一半就落库（缺的补 00），什么都没选则不动。
 */
export function TimePicker({ value, onChange, label }: Props) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>({ h: '', m: '' })
  // close() 是在 document 级监听里跑的，读 state 会拿到闭包里的旧值 —— 草稿额外存一份 ref
  const draftRef = useRef<Draft>({ h: '', m: '' })
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const put = (d: Draft): void => {
    draftRef.current = d
    setDraft(d)
  }

  const openMenu = (): void => {
    const [h, m] = value ? value.split(':') : ['', '']
    put({ h: h ?? '', m: m ?? '' })
    setOpen(true)
  }

  const close = (): void => {
    setOpen(false)
    const { h, m } = draftRef.current
    // 什么都没选就不动原值 —— 「也有可能没选」
    if (!h && !m) return
    onChange(`${h || '00'}:${m || '00'}`)
  }

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
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return
      close()
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    // 捕获阶段监听：弹窗内层的 .modal 上有 onMouseDown={stopPropagation}（防止点内部被
    // 当成点遮罩关闭），冒泡阶段的事件到不了 document —— 那样在弹窗里点别处面板不会关。
    // 捕获阶段先于 React 的处理器，能拿到；面板内部的点击由上面的 contains 判断放过。
    document.addEventListener('mousedown', onDocDown, true)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocDown, true)
      document.removeEventListener('keydown', onEsc)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 打开时显示草稿（实时预览），关闭后显示已落库的值
  const preview = draft.h || draft.m ? `${draft.h || '00'}:${draft.m || '00'}` : '--:--'
  const shown = open ? preview : value || '--:--'

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="field timepick"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : openMenu())}
      >
        <span className={shown === '--:--' ? 'timepick__empty' : undefined}>{shown}</span>
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
                aria-selected={h === draft.h}
                className={`popmenu__item${h === draft.h ? ' popmenu__item--active' : ''}`}
                onClick={() => put({ h, m: draftRef.current.m })}
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
                aria-selected={m === draft.m}
                className={`popmenu__item${m === draft.m ? ' popmenu__item--active' : ''}`}
                onClick={() => put({ h: draftRef.current.h, m })}
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
