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
 * 约定：样式里控件高度一律取 --control-h 家族（见 docs/03、npm run check:ctlheight）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal, SlidersHorizontal } from '@renderer/lib/icons'

/** 抬升阈值：正文滚过这个距离就认为「已经开始滚」（工具栏加投影、标题区收紧）。 */
const LIFT_ON_PX = 24
/**
 * 落下阈值必须**明显低于**抬升阈值（迟滞）。
 *
 * 抬升态会让标题区的下内边距从 4px 变成 0，也就是内容整体上移 4px ——
 * 若两个方向共用一个阈值，滚动位置停在它附近时就会来回跨越：抬升 → 高度变 → scrollTop 变 →
 * 判定落下 → 高度变回来 → 又抬升…… 这是自激循环，表现为滚动到某处后页面持续抖动、
 * 严重时把渲染主线程按住（layoutcheck 正是在滚动结构那一段把它踩出来的）。
 */
const LIFT_OFF_PX = 8

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
  const hostRef = useRef<HTMLDivElement>(null)
  /** 页面正文已经滚动：工具栏该「抬起来」（加投影、标题区收紧） */
  const [lifted, setLifted] = useState(false)
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
    const moreW = kids[kids.length - tail]?.getBoundingClientRect().width ?? 0
    const cand = kids.slice(head, kids.length - tail)
    const headW = kids.slice(0, head).reduce((n, k) => n + k.getBoundingClientRect().width, 0)
    const tailW = kids.slice(kids.length - tail).reduce((n, k) => n + k.getBoundingClientRect().width, 0)
    const candW = cand.map((c) => c.getBoundingClientRect().width)
    const gapOf = (n: number): number => gap * Math.max(0, n - 1)
    // 先看「一个都不收」能不能放下：能放下就不该为了让位给「更多」而白收一个。
    // 全平铺时「更多」不渲染，所以它的宽度不能算进去 —— 算进去会在边界上误判。
    const allW = headW + tailW - moreW + candW.reduce((n, w) => n + w, 0)
    const allN = head + tail - 1 + cand.length // 「更多」不计入
    if (allW + gapOf(allN) <= avail) {
      setCap(cand.length)
      return
    }
    // 放不下才预留「更多」的位置，**从左往右**累加：折叠从右边开始收，
    // 从左往右能放几个就留几个，「⋯」紧跟在它们后面。
    let used = headW + tailW + moreW
    let shown = 0
    for (const w of candW) {
      if (used + w + gapOf(head + 1 + shown + tail) > avail) break
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

  /**
   * 窗口尺寸**停稳之后**，把这一行剩下的宽度交给第一个控件（下拉 / 输入框）。
   *
   * 为什么等停稳：折叠数量是按自然宽度算出来的，而拉伸会改变控件宽度 ——
   * 拖动窗口时如果立刻拉伸，「拉伸 → 测量基准变 → 折叠数量抖 → 空间又变」会互相追。
   * 拖动期间保持自然宽度，松手（尺寸 250ms 不变）后再补上这个类。
   */
  const [fillFirst, setFillFirst] = useState(false)
  useEffect(() => {
    let timer: number | undefined
    const onResize = (): void => {
      setFillFirst(false)
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => setFillFirst(true), 250)
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => {
      if (timer) window.clearTimeout(timer)
      window.removeEventListener('resize', onResize)
    }
  }, [])
  // cap = 保留的**头部**个数（折叠从右边开始收，「⋯」紧跟其后）。
  // 筛选排在次要操作前面，所以被收起的总是「尾部若干项」，左侧那组原地不动。
  const shownFilters = filters.slice(0, cap)
  const shownSecondary = secondary.slice(0, Math.max(0, cap - filters.length))
  const hiddenFilters = filters.slice(shownFilters.length)
  const hiddenSecondary = secondary.slice(shownSecondary.length)
  const overflowCount = hiddenFilters.length + hiddenSecondary.length

  // 第二层整层为空时（例如笔记编辑区把操作挂到了富文本格式条上）不渲染这一行，
  // 否则会留下一条只有内边距的空行。
  const hasSubRow = Boolean(nav || meta || search || filters.length > 0 || secondary.length > 0 || primary)

  /**
   * 滚动驱动：正文滚过阈值后，吸顶工具栏加投影、标题区收紧。
   *
   * 滚动容器不是 window —— 每个页面的 .page__body 才是（docs/03 §3：标题固定，正文自己滚），
   * 所以这里往上找最近的可滚动祖先，而不是监听 window。
   */
  useEffect(() => {
    if (!sticky) {
      setLifted(false)
      return
    }
    const host = hostRef.current
    if (!host) return
    let scroller: HTMLElement | null = host.parentElement
    while (scroller) {
      if (/(auto|scroll)/.test(window.getComputedStyle(scroller).overflowY)) break
      scroller = scroller.parentElement
    }
    if (!scroller) {
      // 有些页面把「标题行固定」做成了「正文自己滚」：滚动容器是工具栏的**兄弟**而不是祖先
      // （设置页就是这样）。这类页面在正文容器上标 data-scroll="1" 告诉我们去找谁。
      scroller = host.closest('.page')?.querySelector<HTMLElement>('[data-scroll="1"]') ?? null
    }
    if (!scroller) return
    const target = scroller
    /** 只在跨过阈值时 setState：滚动事件每秒几十次，每次调用 setState（哪怕值没变）
        都会走一遍 React 的调度；记一个 ref 就把它降成「只在真正抬升/落下时各一次」。 */
    let liftedNow = false
    const onScroll = (): void => {
      const top = target.scrollTop
      // 迟滞：抬升要滚过 LIFT_ON_PX，落下要退回 LIFT_OFF_PX 以内（见常量的注释）
      const next = liftedNow ? top > LIFT_OFF_PX : top > LIFT_ON_PX
      if (next === liftedNow) return
      liftedNow = next
      setLifted(next)
    }
    onScroll()
    target.addEventListener('scroll', onScroll, { passive: true })
    return () => target.removeEventListener('scroll', onScroll)
  }, [sticky])

  return (
    <div
      ref={hostRef}
      className={
        'tb ' +
        (variant === 'page' ? 'tb--page' : 'tb--panel') +
        (sticky ? ' tb--sticky' : '') +
        (lifted ? ' tb--lifted' : '')
      }
    >
      {variant === 'page' ? (
        // 标题分区：只放页面身份（标题 / 副标题），**不放任何操作**
        <div className="tb__head">
          <div className="tb__lead">
            {titleNode ?? <h1 className="page__title">{title}</h1>}
            {subtitle ? <p className="page__subtitle">{subtitle}</p> : null}
          </div>
        </div>
      ) : null}

      {hasSubRow ? (
      <div className="tb__sub">
        {/* 左侧只有真的有东西（导航 / 统计）时才与右侧工具区拉开 50px；
            左侧空着时不留这段空白，免得工具行整体看起来往右缩了一截。 */}
        <div className={'tb__subleft' + (nav || meta ? ' tb__subleft--gap' : '')}>
          {nav}
          {meta ? <span className="tb__meta">{meta}</span> : null}
        </div>
        <div className={'tb__subright' + (fillFirst ? ' tb__subright--fill' : '')} ref={rightRef}>
          {search}
          {shownFilters.map((f, i) => <span key={i}>{f}</span>)}
          {shownSecondary.map((s, i) => <span key={i}>{s}</span>)}
          {/* 「更多」排在已显示项之后：收起的是右边那些，省略号就落在它们的原位 */}
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
      ) : null}
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
