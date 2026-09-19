/**
 * 统一工具栏：B 骨架（两层）+ 空间不足时按 C 的方案逐级折叠。
 *
 * 结构（标题分区与工具栏分区**各自独立、明确分隔**）：
 *   标题分区  [标题 · 副标题]                        —— 只放页面身份，不放任何操作
 *   工具栏分区 [视图 / 范围 导航 · 统计] ……… [搜索 · 筛选 · 次要操作 · 主操作]
 *
 * 折叠：第二层最多平铺 collapseFrom 个「非搜索」控件（默认 3），超出的收进「更多」浮层；
 * 若这样仍溢出，再逐个收进来。判据是第二层右侧组**已渲染子项**的真实宽度和。
 * 收起**只升不降**，宽度变化时才重置 —— 按「有富余就降级」写会来回震荡并触发白屏。
 *
 * 两种形态：
 *   page   页面级：两层（第一层标题 + 主操作）
 *   panel  面板级：只有第二层 —— 侧栏、编辑器这类「没有页面标题的工具条」用
 *
 * 约定：样式里控件高度一律取 --control-h 家族（见 docs/03 §2.7、npm run check:ctlheight）。
 */
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal, SlidersHorizontal } from '@renderer/lib/icons'

export type ToolbarProps = {
  /** 页面标题（panel 形态不用）。标题本身要放可编辑输入框之类的节点时改用 titleNode */
  title?: string
  /** 自定义标题节点（优先于 title）：例如笔记编辑区那条可编辑的标题输入框 */
  titleNode?: ReactNode
  subtitle?: string
  /** 视图 / 范围 / 分区切换（seg、tab 栏） */
  nav?: ReactNode
  /** 统计小字：共 N 项 / N 节点 */
  meta?: ReactNode
  /** 搜索或过滤输入 */
  search?: ReactNode
  /** 下拉筛选 —— 空间不够时会被收进浮层的「筛选」组 */
  filters?: ReactNode[]
  /** 次要操作 —— 空间不够时收进浮层的「操作」组 */
  secondary?: ReactNode[]
  /** 主操作：每页一个，位置固定 */
  primary?: ReactNode
  variant?: 'page' | 'panel'
  /** 常驻（sticky）。默认 page 开、panel 关；嵌在卡片内部的编辑区工具栏可显式关掉 */
  sticky?: boolean
}

export function Toolbar({
  title,
  titleNode,
  subtitle,
  nav,
  meta,
  search,
  filters = [],
  secondary = [],
  primary,
  variant = 'page',
  sticky = variant === 'page',
}: ToolbarProps): JSX.Element {
  const rightRef = useRef<HTMLDivElement>(null)
  /** 隐藏的测量行：按最终顺序渲染一份完整内容，只为量出每项的自然宽度 */
  const measureRef = useRef<HTMLDivElement>(null)
  const flatTotal = filters.length + secondary.length
  /** 能平铺几个「非搜索」控件 —— 由可用宽度一次算准 */
  const [cap, setCap] = useState(flatTotal)

  /**
   * 一次算准能放几个：用隐藏测量行量出每个候选的真实宽度，按顺序累加到放不下为止。
   *
   * 为什么不做「逐个收 + 重渲染再检测」：那条路依赖逐帧收敛，实测在笔记编辑区会停在第 1 次
   * （子项宽和是容器的 6 倍、⋯ 却只显示 1），既慢又不可靠。一次量完直接得出数量。
   * 也不能用 scrollWidth —— 对 overflow:visible 的元素它等于 padding box 宽，量不出溢出。
   */
  const recompute = useCallback((): void => {
    const right = rightRef.current
    const box = measureRef.current
    if (!right || !box) return
    // 留 8px 余量：各项宽度是浮点，累加值与浏览器整数化后的实际布局会差几像素，
    // 不留余量时会出现「折叠数量已按计算收敛、最左侧控件仍压出 6px」这种边界溢出。
    const avail = Math.max(0, right.clientWidth - 8)
    const gap = parseFloat(getComputedStyle(box).columnGap || '0') || 0
    const kids = Array.from(box.children) as HTMLElement[]
    const head = search ? 1 : 0 // 搜索框固定留在最前
    const tail = 1 + (primary ? 1 : 0) // 「更多」与主操作固定留在最后
    const cand = kids.slice(head, kids.length - tail)
    const headW = kids.slice(0, head).reduce((n, k) => n + k.getBoundingClientRect().width, 0)
    const tailW = kids.slice(kids.length - tail).reduce((n, k) => n + k.getBoundingClientRect().width, 0)
    const candW = cand.map((c) => c.getBoundingClientRect().width)
    const gapOf = (n: number): number => gap * Math.max(0, n - 1)
    // 先看「一个都不收」能不能放下：能放下就不该为了让位给「更多」而白收一个。
    // 关键是这里要把「更多」的宽度**减掉** —— 全平铺时它不渲染，算进去会在边界上误判。
    const moreW = kids[kids.length - tail]?.getBoundingClientRect().width ?? 0
    const allW = headW + tailW - moreW + candW.reduce((n, w) => n + w, 0)
    const allN = head + tail - 1 + cand.length // 「更多」不计入
    if (allW + gapOf(allN) <= avail) {
      setCap(cand.length)
      return
    }
    // 放不下：这时才预留「更多」的位置，逐个累加
    let used = headW + tailW
    let shown = 0
    for (const w of candW) {
      if (used + w + gapOf(head + shown + tail) > avail) break
      used += w
      shown++
    }
    setCap(shown)
    // search / primary 在各页面都是固定的，故不列入依赖
  }, [flatTotal])

  // 渲染后与容器尺寸变化时都重算。recompute 是幂等的，同值时 setCap 会被 React bailout，
  // 所以不需要额外的「基准值」判断，也不会振荡。
  useLayoutEffect(() => {
    recompute()
  })

  useLayoutEffect(() => {
    const el = rightRef.current
    if (!el) return
    const ro = new ResizeObserver(() => recompute())
    ro.observe(el)
    return () => ro.disconnect()
  }, [recompute])
  const shownFilters = filters.slice(0, cap)
  const shownSecondary = secondary.slice(0, Math.max(0, cap - filters.length))
  const hiddenFilters = filters.slice(shownFilters.length)
  const hiddenSecondary = secondary.slice(shownSecondary.length)
  const overflowCount = hiddenFilters.length + hiddenSecondary.length

  return (
    <div className={'tb ' + (variant === 'page' ? 'tb--page' : 'tb--panel') + (sticky ? ' tb--sticky' : '')}>
      {variant === 'page' ? (
        // 标题分区：只放页面身份（标题 / 副标题），**不放任何操作**
        <div className="tb__head">
          <div className="tb__lead">
            {titleNode ?? <h1 className="page__title">{title}</h1>}
            {subtitle ? <p className="page__subtitle">{subtitle}</p> : null}
          </div>
        </div>
      ) : null}

      <div className="tb__sub">
        <div className="tb__subleft">
          {nav}
          {meta ? <span className="tb__meta">{meta}</span> : null}
        </div>
        <div className="tb__subright" ref={rightRef}>
          {search}
          {shownFilters.map((f, i) => <span key={i}>{f}</span>)}
          {shownSecondary.map((s, i) => <span key={i}>{s}</span>)}
          {overflowCount > 0 ? (
            <MoreMenu filters={hiddenFilters} secondary={hiddenSecondary} count={overflowCount} />
          ) : null}
          {/* 主操作永远在工具栏行最右端，两种形态一致 */}
          {primary}
        </div>
        {/* 隐藏测量行：脱离文档流、不可见、不接收事件，只为量宽度。
            顺序必须与实际渲染一致（搜索 → 筛选 → 次要操作 → 更多 → 主操作）。 */}
        <div className="tb__measure" ref={measureRef} aria-hidden>
          {search}
          {filters.map((f, i) => (
            <span key={'mf' + i}>{f}</span>
          ))}
          {secondary.map((s, i) => (
            <span key={'ms' + i}>{s}</span>
          ))}
          {/* 占位要与真按钮同款：图标给它 44px 的底宽，数字用两位数取上限 ——
              真实按钮的数字会随收起数量从 1 位涨到 2 位，漏算就会让折叠数量偏大，
              表现正是「折叠生效了、最左侧控件却仍超出」。宁可保守一点。 */}
          <span className="tb-btn">
            <MoreHorizontal size={15} />
            <span className="tb-btn__n">88</span>
          </span>
          {primary}
        </div>
      </div>
    </div>
  )
}

/** 折叠出来的「更多」：浮层里按 筛选 / 操作 分组，与 C 变体的分组一致。 */
function MoreMenu({
  filters,
  secondary,
  count,
}: {
  filters: ReactNode[]
  secondary: ReactNode[]
  count: number
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="tb__more" ref={ref}>
      <button
        className="tb-btn"
        aria-expanded={open}
        aria-label={'更多筛选与操作（' + count + '）'}
        title="更多筛选与操作"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={15} />
        <span className="tb-btn__n">{count}</span>
      </button>
      {open ? (
        <div className="tb-sheet" role="dialog" aria-label="更多筛选与操作">
          {filters.length > 0 ? (
            <div className="tb-sheet__group">
              <span className="tb-sheet__k">
                <SlidersHorizontal size={12} /> 筛选
              </span>
              <div className="tb-sheet__v">{filters.map((f, i) => <span key={i}>{f}</span>)}</div>
            </div>
          ) : null}
          {secondary.length > 0 ? (
            <div className="tb-sheet__group">
              <span className="tb-sheet__k">操作</span>
              <div className="tb-sheet__v">{secondary.map((s, i) => <span key={i}>{s}</span>)}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
