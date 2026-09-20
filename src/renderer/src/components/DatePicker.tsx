import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarClock, ChevronDown, ChevronLeft, ChevronRight } from '@renderer/lib/icons'
import { monthGrid, pad2, todayStr } from '../lib/date'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)
/** 手动跳转用的年份范围：够宽，又是可滚动的普通列表 */
const YEARS = Array.from({ length: 151 }, (_, i) => 1950 + i)

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
 * 自绘的日期选择器。
 *
 * 为什么不用 <input type="date">：它点开的是 Chromium 的**原生日历面板** —— 不进页面的
 * 样式树，格子尺寸完全不受「控件高度」控制。这里每个日期格就是 --control-h 见方。
 *
 * 取值是**点即生效**：点某天 / 「今天」/ 「清除」都立刻写回并收起（日历上点一下就完成选择，
 * 再等失焦反而别扭）。点外面或 Esc 则只是收起，不改值。
 *
 * 点标题可以切到「年月跳转」两列：左边年份（可滚，1950–2100）、右边月份，
 * 选任一边立刻回到日历 —— 省得一年一年点箭头。
 */
export function DatePicker({ value, onChange, label }: Props) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'day' | 'ym'>('day')
  const [cursor, setCursor] = useState(() => cursorOf(value))
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const today = todayStr()

  const openMenu = (): void => {
    setCursor(cursorOf(value))
    setMode('day')
    setOpen(true)
  }

  /**
   * 刚关闭的时间戳。
   *
   * 点某一天时，那次点击的「第二次 click」会在几毫秒后落到下面露出来的日期框上，
   * 于是面板刚关就又被打开（用户报的「选择日期后反而重新唤起」）。埋点实测：
   * 关闭在 15772ms、重新打开在 15774ms。人不会在 250ms 内点两下，挡掉即可。
   */
  const closedAt = useRef(0)

  const close = (): void => {
    closedAt.current = performance.now()
    setOpen(false)
  }

  const done = (day: string): void => {
    // 先收起再回填：反过来的话，onChange 引起的父组件重渲会把这次关闭吞掉
    // （实测轨迹里面板从头到尾都是开的，而页面没有任何异常）
    close()
    onChange(day)
  }

  /**
   * 把年月**落到日期选择器上**：保留原来那一天，只换年和月。
   *
   * 这是用户报的那个「修改并未回填」—— 之前选年月只动了面板的游标，值没变，
   * 关掉再打开又回到老月份。
   *
   * 两个边界：还没选过日期时**不写值**（不能替用户决定是哪天，只挪日历）；
   * 目标月没有那一天时钳到月末（1 月 31 日 → 2 月 28/29 日）。
   */
  const applyYearMonth = (y: number, m0: number): void => {
    setCursor({ y, m0 })
    if (!value) return
    const last = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate()
    const day = Math.min(Number(value.slice(8, 10)), last)
    onChange(`${y}-${pad2(m0 + 1)}-${pad2(day)}`)
  }

  useEffect(() => {
    if (!open) return
    const rect = btnRef.current?.getBoundingClientRect()
    const el = menuRef.current
    if (el && rect) {
      el.style.left = `${Math.round(rect.left)}px`
      el.style.top = `${Math.round(rect.bottom + 4)}px`
    }
    // 年月跳转里把当前年月滚进视野，否则 1950 起的长列表要翻很久
    el?.querySelector('.dpick__ylist .popmenu__item--active, .dpick__mlist .popmenu__item--active')?.scrollIntoView({
      block: 'center',
    })

    // 捕获阶段：弹窗内层 .modal 上有 onMouseDown={stopPropagation}，冒泡阶段的点击
    // 到不了 document —— 那样在弹窗里点别处，面板不会关。
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
  }, [open, mode])

  const cells = useMemo(() => monthGrid(cursor.y, cursor.m0), [cursor])

  const shift = (delta: number): void => {
    setCursor((c) => {
      const d = new Date(Date.UTC(c.y, c.m0 + delta, 1))
      return { y: d.getUTCFullYear(), m0: d.getUTCMonth() }
    })
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="field datepick"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          // 挡掉紧随关闭而来的穿透点击，否则面板会立刻弹回来
          if (performance.now() - closedAt.current < 250) return
          if (open) close()
          else openMenu()
        }}
      >
        <span className={value ? undefined : 'datepick__empty'}>{value || '年 / 月 / 日'}</span>
        <CalendarClock size={14} />
      </button>

      {open && (
        <div className="popmenu popmenu--date" ref={menuRef} role="dialog" aria-label={label}>
          <div className="dpick__head">
            <button type="button" className="dpick__nav" aria-label="上个月" onClick={() => shift(-1)}>
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              className="dpick__title"
              aria-label="选择年份和月份"
              aria-expanded={mode === 'ym'}
              onClick={() => setMode(mode === 'day' ? 'ym' : 'day')}
            >
              {cursor.y} 年 {cursor.m0 + 1} 月
              <ChevronDown size={12} />
            </button>
            <button type="button" className="dpick__nav" aria-label="下个月" onClick={() => shift(1)}>
              <ChevronRight size={14} />
            </button>
          </div>

          {mode === 'day' ? (
            <>
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
                    c.day === value ? 'dpick__day--on' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')
                  return (
                    <button key={c.day} type="button" className={cls} onClick={() => done(c.day)}>
                      {Number(c.day.slice(-2))}
                    </button>
                  )
                })}
              </div>
              <div className="dpick__foot">
                <button type="button" onClick={() => done(today)}>
                  今天
                </button>
                <button type="button" onClick={() => done('')}>
                  清除
                </button>
              </div>
            </>
          ) : (
            /* 年月跳转：左年右月，各选各的，选完立刻回日历 */
            <div className="dpick__pick">
              <div className="popmenu__col dpick__ylist">
                {YEARS.map((y) => (
                  <button
                    key={y}
                    type="button"
                    className={`popmenu__item${y === cursor.y ? ' popmenu__item--active' : ''}`}
                    onClick={() => applyYearMonth(y, cursor.m0)}
                  >
                    {y} 年
                  </button>
                ))}
              </div>
              <div className="popmenu__col dpick__mlist">
                {MONTHS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`popmenu__item${m - 1 === cursor.m0 ? ' popmenu__item--active' : ''}`}
                    onClick={() => applyYearMonth(cursor.y, m - 1)}
                  >
                    {m} 月
                  </button>
                ))}
              </div>
              {/* 年月点选后不自动退回：先挑好年月，想选具体哪天时再走这里。
                  用 onMouseDown 而不是 onClick —— 实测真鼠标下 onClick 不触发
                  （程序化 click() 却有效，所以断言一度是绿的）。 */}
              <div className="dpick__foot">
                <button type="button" onMouseDown={() => setMode('day')}>
                  返回日历（选具体日期）
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  )
}
