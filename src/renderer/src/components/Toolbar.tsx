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
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal, SlidersHorizontal } from 'lucide-react'

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
  /** 在阈值之外**额外**收起的控件数：只在溢出时递增 */
  const [extra, setExtra] = useState(0)
  const flatTotal = filters.length + secondary.length

  // 控件数量变了（收件箱切 tab、条件项出现/消失）就重新评估收起数量。
  // 只靠宽度变化重置是不够的：容器宽度没变但内容变了时，会沿用上一次的收起数，
  // 该收的没收（溢出）或不该收的收了（白收）。
  useEffect(() => {
    setExtra(0)
  }, [flatTotal])

  /**
   * 检测一次：当前渲染出的子项放不下就多收一个。
   * 不用 scrollWidth —— 对 overflow:visible 的元素它等于 padding box 宽，量不出溢出；
   * 直接求子项布局宽度和（子项都是 flex: 0 0 auto，宽度即真实需求）。
   */
  const detect = useCallback((): void => {
    const el = rightRef.current
    if (!el) return
    const style = getComputedStyle(el)
    const gap = parseFloat(style.columnGap || style.gap || '0') || 0
    const kids = Array.from(el.children) as HTMLElement[]
    const need =
      kids.reduce((n, k) => n + k.getBoundingClientRect().width, 0) + gap * Math.max(0, kids.length - 1)
    if (need > el.clientWidth + 1) setExtra((e) => (e < flatTotal ? e + 1 : e))
  }, [flatTotal])

  // 渲染后检测一次：每收一个就重渲染，再检测，直到放得下（收敛在这里）
  useLayoutEffect(() => {
    detect()
  })

  // 容器尺寸变化：重置收起数量，并**立刻再检测一次**。
  // 只重置是不够的 —— extra 本来就是 0 时 setExtra(0) 是个 no-op，React 不会重渲染，
  // 上面那条检测 effect 就永远不跑，窗口缩放后折叠会彻底失效（笔记编辑区正是如此）。
  useLayoutEffect(() => {
    const el = rightRef.current
    if (!el) return
    // 首次回调只记录宽度：effect 运行时布局未必稳定，拿未稳定的值当基准会误判
    let last = -1
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      if (last < 0) {
        last = w
        detect()
        return
      }
      if (w === last) return
      last = w
      setExtra(0)
      detect()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [detect])

  // 平铺几个**完全由可用宽度决定**：默认全部平铺，放不下才逐个收（extra 由溢出递增）。
  // 之前那个固定阈值是错的 —— 它会把「明明放得下」的控件也收进浮层。
  const cap = Math.max(0, flatTotal - extra)
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
