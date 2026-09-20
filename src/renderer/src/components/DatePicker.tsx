import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarClock, ChevronLeft, ChevronRight } from '@renderer/lib/icons'
import { monthGrid, todayStr } from '../lib/date'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

interface Props {
  /** 'YYYY-MM-DD'；空串表示不指定 */
  value: string
  onChange: (value: string) => void
  /** 无障碍标签，例如「开始日期」 */
  label: string
}

/** 'YYYY-MM-DD' → 面板要看的年月（0 基月）；空值或坏值回落到今天。 */
function cursorOf(value: string): { y: number; m0: number } {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + 'T00:00:00') : new Date()
  return { y: base.getFullYear(), m0: base.getMonth() }
}

/**
 * 自绘的日期选择器，与 TimePicker 同一套路。
 *
 * 为什么不用 <input type="date">：它点开的是 Chromium 的**原生日历面板** —— 不进页面的
 * 样式树，格子高度完全不受「控件高度」控制（时间那边报过同样的问题）。这里每个日期格
 * 就是 --control-h 见方，整块面板的尺度都跟着这个设置走。
 *
 * 取值同样是两步：点格子只改草稿（按钮上实时预览），失焦 / 点外面 / Esc 才写回。
 * 月历本身用 lib/date.ts 的 monthGrid —— 与任务页的日历视图共用一套算法。
 */
export function DatePicker({ value, onChange, label }: Props) {
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(() => cursorOf(value))
  const [draft, setDraft] = useState(value)
  // close() 在 document 级监听里跑，读 state 会拿到闭包里的旧值 —— 草稿另存一份 ref
  const draftRef = useRef(value)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const today = todayStr()

  const put = (d: string): void => {
    draftRef.current = d
    setDraft(d)
  }

  const openMenu = (): void => {
    put(value)
    setCursor(cursorOf(value))
    setOpen(true)
  }

  const close = (): void => {
    setOpen(false)
    // 没动过就不回调，免得白白触发一次「已修改」
    if (draftRef.current === value) return
    onChange(draftRef.current)
  }

  useEffect(() => {
    if (!open) return
    const rect = btnRef.current?.getBoundingClientRect()
    const el = menuRef.current
    if (el && rect) {
      el.style.left = `${Math.round(rect.left)}px`
      el.style.top = `${Math.round(rect.bottom + 4)}px`
    }
    // 捕获阶段：弹窗内层 .modal 上有 onMouseDown={stopPropagation}，冒泡阶段的点击
    // 到不了 document —— 那样在弹窗里点别处，面板不会关（TimePicker 里踩过）
    const onDocDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return
      close()
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDocDown, true)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocDown, true)
      document.removeEventListener('keydown', onEsc)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const cells = useMemo(() => monthGrid(cursor.y, cursor.m0), [cursor])

  const shift = (delta: number): void => {
    setCursor((c) => {
      const d = new Date(Date.UTC(c.y, c.m0 + delta, 1))
      return { y: d.getUTCFullYear(), m0: d.getUTCMonth() }
    })
  }

  const shown = open ? draft : value

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="field datepick"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : openMenu())}
      >
        <span className={shown ? undefined : 'datepick__empty'}>{shown || '年 / 月 / 日'}</span>
        <CalendarClock size={14} />
      </button>

      {open && (
        <div className="popmenu popmenu--date" ref={menuRef} role="dialog" aria-label={label}>
          <div className="dpick__head">
            <button type="button" className="dpick__nav" aria-label="上个月" onClick={() => shift(-1)}>
              <ChevronLeft size={14} />
            </button>
            <span className="dpick__title">
              {cursor.y} 年 {cursor.m0 + 1} 月
            </span>
            <button type="button" className="dpick__nav" aria-label="下个月" onClick={() => shift(1)}>
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="dpick__week">
            {WEEKDAYS.map((w) => (
              <span key={w} className="dpick__wk">
                {w}
              </span>
            ))}
          </div>
          <div className="dpick__grid">
            {cells.map((c) => {
              const cls = [
                'dpick__day',
                c.inMonth ? '' : 'dpick__day--out',
                c.day === today ? 'dpick__day--today' : '',
                c.day === draft ? 'dpick__day--on' : '',
              ]
                .filter(Boolean)
                .join(' ')
              return (
                <button key={c.day} type="button" className={cls} onClick={() => put(c.day)}>
                  {Number(c.day.slice(-2))}
                </button>
              )
            })}
          </div>
          <div className="dpick__foot">
            <button type="button" onClick={() => put(today)}>
              今天
            </button>
            <button
              type="button"
              onClick={() => {
                put('')
                onChange('')
                setOpen(false)
              }}
            >
              清除
            </button>
          </div>
        </div>
      )}
    </>
  )
}
