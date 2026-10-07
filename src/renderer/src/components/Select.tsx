import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { isMotionFull, usePresence } from '../lib/presence'
import { placeAnchored } from '../lib/anchored-position'
import { ChevronDown } from '@renderer/lib/icons'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
  /** 选项级原生 tooltip —— 对应原 `<option title="…">` */
  title?: string
  /**
   * 层级缩进（0 = 顶层）。
   *
   * 与 `PopMenu` 的 `depth` 同义：清单、文件夹这类有父子关系的数据平铺成一列看不出归属 ——
   * 原生 `<select>` 用 `<optgroup>` 表达，这里用缩进（`<optgroup>` 只分一层，
   * 而目录树可以更深）。与菜单是同一套视觉，所以两处的层级读起来一致。
   */
  depth?: number
}

interface Props {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  /** 无障碍名。**必填** —— 原生 `<select>` 靠 `<label>` 或 aria-label，这个组件同理。 */
  ariaLabel: string
  /** 触发按钮的额外类名（沿用 `.field` / `.field--compact` 的尺寸口径） */
  className?: string
  disabled?: boolean
  /** 占位文案：`value` 为空且没有对应 option 时显示 */
  placeholder?: string
  /** 触发按钮的原生 tooltip —— 与原 `<select title="…">` 对齐 */
  title?: string
  /** 选项级 tooltip —— 与原 `<option title="…">` 对齐（长文本截断后靠它看全） */
  optionTitle?: string
}

/** 退场时长：与 `.popmenu--pop.is-leaving` 用的 `--dur-instant` 一致 */
const EXIT_MS = 100

/**
 * **统一的下拉选择器**（替换全仓的原生 `<select>`）。
 *
 * 为什么不用原生：它的**展开列表由浏览器/系统渲染**，CSS 完全够不着 ——
 * 浅色下是系统白底、深色下也不跟主题，与全应用的玻璃层、圆角、描边、阴影都对不上
 *（用户："下拉框的浮窗 UI 设置不统一，未匹配主题化"）。而是原生就**没法**匹配。
 *
 * 浮层复用弹出菜单那一套（`.popmenu` 的底 + 描边 + `--shadow-lg` + 圆角，
 * 以及 `placeAnchored` 的视口翻转、`usePresence` 的退场动画），
 * 所以下拉与右键菜单、优先级菜单是**同一种浮层**。
 *
 * **可访问性按 ARIA APG 的 combobox 模式实现**（"一次做到位"）：
 * · 触发器：`role="combobox"` + `aria-expanded` + `aria-controls` + `aria-haspopup="listbox"`；
 * · 列表：`role="listbox"` + `aria-activedescendant` 指向高亮项（**焦点始终留在触发器上**，
 *   这是 APG 推荐的做法 —— 焦点不跳走，屏幕阅读器与键盘行为都更稳）；
 * · 键盘：↑/↓ 移动、Home/End 到首尾、Enter/Space 选中、Esc 关闭并回到触发器、
 *   字母/数字键首字符匹配（连续输入则依次匹配同首字母的下一项）、Tab 关闭；
 * · 选中项带 `aria-selected`，禁用项带 `aria-disabled` 且不可达。
 */
export function Select({
  value,
  onChange,
  options,
  ariaLabel,
  className = 'field',
  disabled = false,
  placeholder,
  title,
  optionTitle,
}: Props) {
  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const typedRef = useRef({ buf: '', at: 0 })
  const baseId = useId()
  const listId = baseId + '-list'
  const exitMs = isMotionFull() ? EXIT_MS : 0
  const { mounted, leaving } = usePresence(open, exitMs)

  const current = options.findIndex((o) => o.value === value)
  const currentLabel = current >= 0 ? options[current].label : (placeholder ?? '')

  const requestClose = useCallback(
    (refocus = true) => {
      if (!openRef.current) return
      openRef.current = false
      setOpen(false)
      if (refocus) btnRef.current?.focus()
    },
    []
  )

  const openList = useCallback(
    (dir: 1 | -1 = 1) => {
      const first = options.findIndex((o) => !o.disabled)
      if (first < 0) return
      const start = current >= 0 ? current : dir > 0 ? first : options.length - 1
      // 落在禁用项上时向 dir 方向找第一个可选项
      let i = start
      for (let n = 0; n < options.length; n++) {
        const probe = (start + dir * n + options.length * 2) % options.length
        if (!options[probe].disabled) { i = probe; break }
      }
      setActive(i)
      const r = btnRef.current?.getBoundingClientRect()
      if (r) setPos({ x: r.left, y: r.bottom + 4 })
      openRef.current = true
      setOpen(true)
    },
    [current, options]
  )

  /**
   * 定位。**依赖里必须有 `mounted`**。
   *
   * `usePresence` 的 `mounted` 比 `open` 晚一帧（它有内部状态要过渡）：
   * `open` 变 true 时浮层还没挂到 DOM 上、`listRef.current` 是 null，这一次 effect 直接返回；
   * 等 `mounted` 变 true、元素真的在了，如果依赖没变就**不会重跑** —— 浮层于是停在
   * `position: fixed` 的默认位置（留在文档流里），看起来"吸附在左上角"而不是贴着触发器
   *（用户报的"设置页几个都吸附在左侧"就是这个）。
   */
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el || !open) return
    placeAnchored(el, { left: pos.x, top: pos.y, bottom: pos.y })
    el.style.transformOrigin = pos.x > window.innerWidth / 2 ? 'right top' : 'left top'
  }, [open, pos, options.length, mounted])

  // 打开时把高亮项滚进视野
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>('[data-idx="' + active + '"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  // 点外部关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (listRef.current?.contains(t) || btnRef.current?.contains(t)) return
      requestClose(false)
    }
    // **捕获阶段**：弹窗为了"点内部不关自己"会在冒泡路上 stopPropagation，
    // 挂在冒泡阶段就永远收不到 —— 表现为"弹窗里的下拉点别处不关"（用户反馈）。
    // DatePicker / NotePicker 一开始就用的捕获，这里补齐。
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open, requestClose])

  const step = (dir: 1 | -1): void => {
    const n = options.length
    if (!n) return
    let i = active
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n
      if (!options[i].disabled) { setActive(i); return }
    }
  }

  const commit = (i: number): void => {
    const o = options[i]
    if (!o || o.disabled) return
    onChange(o.value)
    requestClose()
  }

  /** 首字符匹配：1 秒内的连续输入拼成前缀，依次匹配（原生 select 的行为） */
  const typeAhead = (key: string): void => {
    const now = Date.now()
    const t = typedRef.current
    t.buf = now - t.at > 1000 ? key : t.buf + key
    t.at = now
    const needle = t.buf.toLowerCase()
    const n = options.length
    for (let k = 1; k <= n; k++) {
      const i = (active + k) % n
      const o = options[i]
      if (!o.disabled && o.label.toLowerCase().startsWith(needle)) { setActive(i); return }
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (disabled) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (!open) openList(1)
        else step(1)
        break
      case 'ArrowUp':
        e.preventDefault()
        if (!open) openList(-1)
        else step(-1)
        break
      case 'Home':
        if (open) { e.preventDefault(); setActive(0) }
        break
      case 'End':
        if (open) { e.preventDefault(); setActive(options.length - 1) }
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (!open) openList(1)
        else commit(active)
        break
      case 'Escape':
        if (open) { e.preventDefault(); e.stopPropagation(); requestClose() }
        break
      case 'Tab':
        if (open) requestClose(false)
        break
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          if (!open) openList(1)
          typeAhead(e.key)
        }
    }
  }

  const activeId = open && mounted ? listId + '-opt-' + active : undefined

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        aria-activedescendant={activeId}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        title={title}
        className={className + ' select__trigger' + (open ? ' is-open' : '')}
        onClick={() => (open ? requestClose() : openList(1))}
        onKeyDown={onKeyDown}
      >
        <span className="select__value">{currentLabel}</span>
        {/* 箭头用应用的图标（morphicons 的 ChevronDown）——与树、日期选择器同一套形状，
            颜色走 --fg-secondary 跟随主题；CSS 三角的粗细与角度都不如它稳。 */}
        <ChevronDown size={14} className="select__caret" aria-hidden />
      </button>
      {/*
        浮层**就地渲染**（不用 Portal）。
        试过挂到 body，结果是"点开一闪就没了"：选择器大量用在 `<label className="form-row">` 里，
        Portal 之后浮层在 body、脱离了那个 label —— 在浮层上按下鼠标会先被 label 的"点击即聚焦
        关联控件"接管，浮层当场被关掉。就地渲染没有这个问题，而定位的坐标系问题已经由
        `mounted` 依赖那处修复解决（见上面的 useLayoutEffect）。
      */}
      {mounted && (
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            className={'popmenu popmenu--pop select__list' + (leaving ? ' is-leaving' : '')}
          >
          {options.map((o, i) => (
            <div
              key={o.value}
              id={listId + '-opt-' + i}
              data-idx={i}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              title={o.title}
              className={
                'popmenu__item select__option' +
                (i === active ? ' is-active' : '') +
                (o.value === value ? ' is-selected' : '') +
                (o.disabled ? ' is-disabled' : '')
              }
              /* 层级缩进。内联样式而不是类名：深度是数据，档数不定（与 PopMenu 同一写法） */
              style={o.depth ? { paddingLeft: 'calc(var(--space-3) + ' + o.depth * 14 + 'px)' } : undefined}
              onMouseEnter={() => !o.disabled && setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              /**
               * **preventDefault + stopPropagation，两个都要。**
               *
               * 选择器大量用在 `<label className="form-row">` 里，而 label 的默认行为是
               * "点它就聚焦/激活它关联的控件"：选项的 click 之后，浏览器会**再合成一次
               * 针对触发器的 click** —— 浮层刚关就被它重新打开（用户看到"选完了浮层还在"）。
               *
               * · `preventDefault` 挡的是**默认行为**（那次合成的点击）—— 这才是关键；
               * · `stopPropagation` 挡的是冒泡（别让外层的点击处理也跟着跑）。
               *
               * 实测（事件探针）：只写 stopPropagation 时，选项上仍会出现
               * `click(option)` 之后紧跟 `click(trigger)` 两条记录。
               */
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                commit(i)
              }}
            >
              <span className={'popmenu__tick' + (o.value === value ? ' popmenu__tick--on' : '')} />
              {o.label}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
