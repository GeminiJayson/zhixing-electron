import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from '@renderer/lib/icons'
import { priorityColor, priorityLabel } from '@shared/priority'
import { addDays, type WeekStart } from '@shared/calendar'
import {
  GANTT_SCALES,
  ganttAlign,
  ganttBar,
  ganttPanAnchor,
  ganttPct,
  ganttTone,
  ganttWindow,
  type GanttScale,
  type GanttWindow,
} from '@shared/gantt'
import { rangeLabel, todayStr } from '../lib/date'

/**
 * 甘特图侧栏的一行。
 *
 * 由任务页的**展平结果**映射而来（与列表逐行对应：同一批可见行、同一份折叠状态、
 * 同一个缩进深度、同一份「有效完成」判定），所以两个视图不存在"谁多一行"的问题。
 */
export interface GanttRow {
  id: number
  title: string
  depth: number
  start_date: string | null
  due_date: string | null
  priority: number
  /** 有效完成（父任务后代全完成即算完成，见 shared/task 的 effectiveDoneMap） */
  done: boolean
}

interface Props {
  rows: GanttRow[]
  onOpen: (id: number) => void
  onClose: () => void
  /** 周起始：与日历同一份设置，周档的列边界跟着它走 */
  weekStart: WeekStart
}

/**
 * 侧栏宽度的默认 / 上下界 / 键盘步长。
 *
 * 拖拽与键盘手感与另两处侧栏**取同一套**（12px 命中区、← → 各 16px、Home 复位 ——
 * 见 NoteTree.tsx 的 TREE_* 与 WorkflowPage.tsx 的 SIDE_*），只有尺寸上下界按内容另定：
 * 时间轴要放下 12~14 列刻度，窄于 240px 连"今天在哪儿"都读不出来。
 */
const WIDTH_DEFAULT = 360
const WIDTH_MIN = 240
/**
 * 宽度上限 = **任务面板宽度的 85%**（用户要求：最大可以占面板的 85%）。
 *
 * 上限是相对值：定死一个像素数在大屏上太保守，在窄窗口里又早就越过面板了。
 * 真正的上限由父容器实测宽度算出（见下面的 `panelW`），这里只是首帧的兜底。
 */
const WIDTH_MAX_RATIO = 0.85
const WIDTH_MAX_FALLBACK = 720
const KEY_STEP = 16
/** 名称列（左侧标题栏）宽度：与面板边缘那根分隔条同一套手感，独立可拖 */
const LABEL_DEFAULT = 132
const LABEL_MIN = 72
/** 名称列最多占侧栏的这个比例 —— 再宽时间轴就读不出刻度了 */
const LABEL_MAX_RATIO = 0.6
/** 纯界面偏好（与 zhixing.tree.* / notes.treeWidth 同一个理由：不该跟着数据被导出） */
const WIDTH_KEY = 'tasks.ganttWidth'
const LABEL_KEY = 'tasks.ganttLabel'
const SCALE_KEY = 'tasks.ganttScale'

/**
 * 表头刻度标签的最小间距：小于它就隔列显示。
 *
 * 列宽是拿容器实测算出来的（时间轴自适应侧栏宽度），所以标签密度不能写死 ——
 * 定死"每列都显示"在窄栏下会糊成一团，定死"隔列显示"在 620px 宽栏下又空得离谱。
 */
const MIN_LABEL_PX: Record<GanttScale, number> = { day: 30, week: 46, month: 42 }

/** 两根分隔条共用的夹取：上界由调用方算（面板 85% / 侧栏 60%） */
const clampW = (w: number, min: number, max: number): number => Math.min(max, Math.max(min, w))

/** 读一个存过的像素宽度：读不到或小于下限就回默认（越界由 clampW 兜，不写坏值） */
const readStored = (key: string, min: number, fallback: number): number => {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v >= min ? v : fallback
  } catch {
    return fallback
  }
}

const readScale = (): GanttScale => {
  try {
    const v = localStorage.getItem(SCALE_KEY)
    return v === 'day' || v === 'week' || v === 'month' ? v : 'week'
  } catch {
    return 'week'
  }
}

/**
 * 列表视图右侧的甘特图侧栏：把当前列表逐行的「开始 ~ 截止」画到一条时间轴上。
 *
 * 只读视图（点行/点条打开任务编辑器），不在这里改期 —— 拖条改期与列表的"拖拽排序 /
 * 改挂父子"是两套手势，挤在同一条侧栏里会互相抢起手。
 */
export function GanttSidebar({ rows, onOpen, onClose, weekStart }: Props) {
  /** 视窗锚点：翻页改它，粒度切换保留它（切档时仍看着同一段时间） */
  const [anchor, setAnchor] = useState(() => todayStr())
  const [scale, setScale] = useState<GanttScale>(readScale)
  const [width, setWidth] = useState<number>(() => readStored(WIDTH_KEY, WIDTH_MIN, WIDTH_DEFAULT))
  /** 左侧名称列宽度（用户可拖；默认 132px ≈ 面板 360px 时的 38%） */
  const [labelW, setLabelW] = useState<number>(() => readStored(LABEL_KEY, LABEL_MIN, LABEL_DEFAULT))
  /** 拖拽中：根元素挂 is-resizing，整块禁止选中文本（与笔记树同一件事） */
  const [resizing, setResizing] = useState(false)
  /** 正在拖哪一根：面板左边缘（改侧栏宽）还是名称列右边界（改标题列宽） */
  const resizeRef = useRef<{ kind: 'panel' | 'label'; x: number; w: number } | null>(null)
  const rootRef = useRef<HTMLElement>(null)
  /** 键盘与落盘读它：闭包里的 width 可能是旧值 */
  const widthRef = useRef(width)
  widthRef.current = width
  const labelRef = useRef(labelW)
  labelRef.current = labelW
  /** 表头刻度区的实测宽度 → 标签密度 */
  const [axisW, setAxisW] = useState(0)
  const axisRef = useRef<HTMLSpanElement>(null)
  /**
   * 拖动平移时间窗口：按住内容区左右拖，视窗跟着走，松手对齐到粒度边界。
   *
   * 起点存的是**那一帧的整窗**（win 本身），不是天数 —— 拖动过程中 anchor 一直在变，
   * 若拿最新的 win 去算位移，每帧都会在上一次的结果上再叠一次，越拖越快（实测过这种漂移）。
   */
  const [panning, setPanning] = useState(false)
  const panRef = useRef<{ x: number; win: GanttWindow } | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const persist = (key: string, w: number): void => {
    try {
      localStorage.setItem(key, String(Math.round(w)))
    } catch {
      // 存不下就只在本次会话里生效
    }
  }

  /**
   * 任务面板（父元素 = 任务页工作区）宽度实测 → 侧栏宽度上限。
   *
   * 观察父元素而不是自己：自己变宽时父元素不变，只有窗口缩放、收起清单树 / 速览栏
   * 才需要重算上限。
   */
  const [panelW, setPanelW] = useState(0)
  const [slackW, setSlackW] = useState(WIDTH_MAX_FALLBACK)
  useEffect(() => {
    const el = rootRef.current?.parentElement
    if (!el) return
    const measure = (): void => {
      const box = el.getBoundingClientRect()
      const self = rootRef.current
      const kids = [...el.children].filter((k) => k !== self)
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0
      // 只有**不可收缩**的兄弟才是硬占用（清单栏 shrink 不是 0，可以被让到很窄）
      const fixed = kids.reduce(
        (sum, k) => sum + (getComputedStyle(k).flexShrink === '0' ? k.getBoundingClientRect().width : 0),
        0
      )
      setPanelW(box.width)
      setSlackW(Math.round(box.width - fixed - gap * kids.length))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  /**
   * 侧栏宽度上限 = `min(面板的 85%, 面板 - 不可收缩的兄弟 - 间隙)`。
   *
   * 两个都要夹：85% 是用户要的上限；后一项是**不许把工作区撑出横向滚动条** ——
   * 实测 1011px 的面板扣掉 208px 清单栏与两段 14px 间隙，留给甘特图的只有 775px，
   * 顶到 859px 就溢出 84px。面板极窄时两者都会小于最小可用宽度，所以下限仍是 WIDTH_MIN。
   */
  const maxW =
    panelW > 0
      ? Math.max(WIDTH_MIN, Math.min(Math.round(panelW * WIDTH_MAX_RATIO), slackW))
      : WIDTH_MAX_FALLBACK
  /** 名称列上限跟着侧栏走：侧栏拖宽了，标题列才可以更宽 */
  const maxLabelW = Math.max(LABEL_MIN, Math.round(width * LABEL_MAX_RATIO))

  // 窗口缩小 / 面板变窄之后，存过的宽度要跟着收回来，否则侧栏会顶破上限
  useEffect(() => {
    setWidth((w) => (w > maxW ? maxW : w))
  }, [maxW])
  useEffect(() => {
    setLabelW((w) => (w > maxLabelW ? maxLabelW : w))
  }, [maxLabelW])

  /**
   * 拖动两根分隔条中的一根。
   *
   * 方向语义按分隔条所在的边定：面板那根在侧栏**左边缘**，指针往左 → 侧栏变宽；
   * 名称列那根在名称列的**右边界**，指针往右 → 名称列变宽。
   */
  const moveDrag = (e: React.PointerEvent<HTMLDivElement>, kind: 'panel' | 'label'): void => {
    const start = resizeRef.current
    if (!start || start.kind !== kind) return
    const dx = e.clientX - start.x
    if (kind === 'panel') {
      // 先写 ref 再 setState：move 与 up 可能落在同一批里（快速拖放时 React 还没重渲染），
      // 松手时落盘读的是 ref —— 不先写就会把拖动**前**的宽度存回去（实测过：拖到 485 存了 425）
      const next = clampW(start.w - dx, WIDTH_MIN, maxW)
      widthRef.current = next
      setWidth(next)
    } else {
      const next = clampW(start.w + dx, LABEL_MIN, maxLabelW)
      labelRef.current = next
      setLabelW(next)
    }
  }
  const startDrag = (e: React.PointerEvent<HTMLDivElement>, kind: 'panel' | 'label'): void => {
    // 不 preventDefault：分隔条要能被点中聚焦（聚焦后 ← → 可微调）
    resizeRef.current = { kind, x: e.clientX, w: kind === 'panel' ? widthRef.current : labelRef.current }
    setResizing(true)
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId)
    } catch {
      // 指针已失效就忽略：捕获失败不影响拖动本身
    }
  }
  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    const start = resizeRef.current
    if (!start) return
    resizeRef.current = null
    setResizing(false)
    persist(
      start.kind === 'panel' ? WIDTH_KEY : LABEL_KEY,
      start.kind === 'panel' ? widthRef.current : labelRef.current
    )
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    } catch {
      // 指针已经松开就无所谓
    }
  }
  /** 两根分隔条共用的键盘：← → 各 16px、Home 复位（与笔记树 / 工作流同一套） */
  const keyStep = (e: React.KeyboardEvent<HTMLDivElement>, kind: 'panel' | 'label'): void => {
    const isPanel = kind === 'panel'
    const cur = isPanel ? widthRef.current : labelRef.current
    const min = isPanel ? WIDTH_MIN : LABEL_MIN
    const max = isPanel ? maxW : maxLabelW
    const commit = (w: number): void => {
      if (isPanel) {
        widthRef.current = w
        setWidth(w)
      } else {
        labelRef.current = w
        setLabelW(w)
      }
      persist(isPanel ? WIDTH_KEY : LABEL_KEY, w)
    }
    if (e.key === 'Home') {
      e.preventDefault()
      e.stopPropagation()
      commit(clampW(isPanel ? WIDTH_DEFAULT : LABEL_DEFAULT, min, max))
      return
    }
    const delta = e.key === 'ArrowRight' ? KEY_STEP : e.key === 'ArrowLeft' ? -KEY_STEP : 0
    if (!delta) return
    // 任务页在 window 上监听 ← →（折叠 / 展开子任务），不拦住的话调宽会顺手改折叠状态
    e.preventDefault()
    e.stopPropagation()
    commit(clampW(cur + (isPanel ? -delta : delta), min, max))
  }

  const pickScale = (next: GanttScale): void => {
    setScale(next)
    try {
      localStorage.setItem(SCALE_KEY, next)
    } catch {
      // 同上
    }
  }

  const today = todayStr()
  const win = useMemo(
    () => ganttWindow(scale, anchor, today, weekStart),
    [scale, anchor, today, weekStart]
  )

  /**
   * 时间轴宽度实测。
   *
   * 与 Toolbar / VirtualList 同一个做法：ResizeObserver 盯住容器本身 ——
   * 侧栏被拖宽时窗口尺寸事件不会触发，只有观察这个元素才拿得到新宽度。
   */
  useEffect(() => {
    const el = axisRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setAxisW(el.getBoundingClientRect().width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * 换粒度 / 改宽度时再各测一次。
   *
   * ResizeObserver 只在**元素尺寸变化**时回调，而切档时 `.gantt__ticks` 自身尺寸没变
   * （两种粒度下它都是 `flex: 1` 撑满同一段）—— 只靠 RO 的话，一旦首帧没测到宽度，
   * 标签密度会一直停在"一列都不标"（实测：月档 12 列只剩 1 个标签，labelStep 退回 99）。
   */
  useEffect(() => {
    const el = axisRef.current
    if (el) setAxisW(el.getBoundingClientRect().width)
  }, [scale, width])

  const perCell = axisW > 0 ? axisW / win.cells.length : 0
  // 还没测到宽度时先不画标签（99 = 一列都不显示），免得首帧糊一层再收
  const labelStep = perCell > 0 ? Math.max(1, Math.ceil(MIN_LABEL_PX[scale] / perCell)) : 99

  /**
   * 列分隔线：把每列的起点叠成一层 background-image（12 条上下，成本可以忽略）。
   * 用背景而不是每列一个元素 —— 网格要跨**所有行**，铺成元素的话是"行数 × 列数"个节点。
   */
  const gridImage = useMemo(
    () =>
      win.cells
        .slice(1)
        .map((c) => {
          const p = ((ganttPct(win, c.start) ?? 0) * 100).toFixed(4)
          return (
            'linear-gradient(to right, transparent calc(' + p + '% - 0.5px),' +
            ' var(--border) calc(' + p + '% - 0.5px),' +
            ' var(--border) calc(' + p + '% + 0.5px),' +
            ' transparent calc(' + p + '% + 0.5px))'
          )
        })
        .join(', '),
    [win]
  )

  const todayPct = ganttPct(win, today)
  const todayInWindow = todayPct !== null && todayPct >= 0 && todayPct < 1
  const rangeText = win.start.slice(5) + ' ~ ' + win.end.slice(5)

  const shift = (delta: number): void => {
    // 翻页 = 整窗前后移动：下一页从窗口结束后一天起算，所以连着翻也不会漂
    setAnchor(delta > 0 ? addDays(win.end, 1) : addDays(win.start, -win.days))
  }

  /** 时间轴的实测宽度：拖动位移换算成天数要用它，三档共用 */
  const laneWidth = (): number => {
    const lane = contentRef.current?.querySelector('.gantt__lane')
    return lane ? lane.getBoundingClientRect().width : 0
  }
  const startPan = (e: React.PointerEvent<HTMLDivElement>): void => {
    // 条与标题各自有"打开任务"的点击，从它们起手时不拖视窗（否则一点一拖就打开了两篇）
    if ((e.target as HTMLElement).closest('.gantt__bar, .gantt__title')) return
    panRef.current = { x: e.clientX, win }
    setPanning(true)
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId)
    } catch {
      // 指针已失效就忽略：捕获失败不影响拖动本身
    }
  }
  const movePan = (e: React.PointerEvent<HTMLDivElement>): void => {
    const start = panRef.current
    if (!start) return
    setAnchor(ganttPanAnchor(start.win, e.clientX - start.x, laneWidth()))
  }
  const endPan = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!panRef.current) return
    panRef.current = null
    setPanning(false)
    // 松手才对齐（对齐到周一 / 月初）：拖动过程中对齐会一跳一跳
    setAnchor((a) => ganttAlign(scale, a, weekStart))
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    } catch {
      // 指针已经松开就无所谓
    }
  }

  /** 档位的人话：颜色之外再给一句说明 —— 悬浮提示里读得出来，不靠辨色 */
  const TONE_LABEL: Record<string, string> = {
    overdue: '已逾期',
    today: '今天到期',
    soon: '三天内到期',
    done: '已完成',
    none: '',
  }

  const bar = (r: GanttRow): React.ReactNode => {
    const geo = ganttBar(r, win)
    if (!geo) return null
    const tone = ganttTone(r.due_date, today, r.done)
    const cls =
      'gantt__bar gantt__bar--' + geo.kind + ' gantt__bar--' + tone +
      (geo.clipStart ? ' gantt__bar--clip-start' : '') +
      (geo.clipEnd ? ' gantt__bar--clip-end' : '')
    return (
      <button
        type="button"
        className={cls}
        style={{ left: geo.left + '%', width: geo.width + '%' }}
        onClick={() => onOpen(r.id)}
        title={
          r.title + ' · ' + (rangeLabel(r.start_date, r.due_date) || '未排期') +
          ' · ' + priorityLabel(r.priority) +
          (TONE_LABEL[tone] ? ' · ' + TONE_LABEL[tone] : '') +
          (geo.kind === 'due' ? '（只有截止日）' : geo.kind === 'start' ? '（只有开始日）' : '') +
          (geo.clipStart || geo.clipEnd ? ' · 区间超出视窗' : '')
        }
        aria-label={'打开任务：' + r.title}
      />
    )
  }

  return (
    <aside
      ref={rootRef}
      className={'gantt' + (resizing ? ' is-resizing' : '')}
      aria-label="甘特图"
      style={{ width, flexBasis: width, '--gantt-label': labelW + 'px' } as React.CSSProperties}
    >
      <header className="gantt__head">
        <div className="gantt__tools">
          <span className="gantt__cap">甘特图</span>
          <span className="seg seg--tight" role="group" aria-label="甘特图时间粒度">
            {GANTT_SCALES.map((s) => (
              <button
                key={s.value}
                type="button"
                aria-pressed={scale === s.value}
                title={s.hint}
                onClick={() => pickScale(s.value)}
              >
                {s.label}
              </button>
            ))}
          </span>
          <span className="gantt__spacer" />
          <button className="icon-btn" onClick={() => shift(-1)} aria-label="上一段" title="上一段">
            <ChevronLeft size={14} />
          </button>
          <button className="text-btn" onClick={() => setAnchor(today)} title="回到今天所在的一段">
            今天
          </button>
          <button className="icon-btn" onClick={() => shift(1)} aria-label="下一段" title="下一段">
            <ChevronRight size={14} />
          </button>
          <button className="icon-btn" onClick={onClose} aria-label="关闭甘特图" title="关闭甘特图">
            <X size={14} />
          </button>
        </div>

        {/* 刻度行：左侧是视窗范围，右侧是各列标签（宽度按"这列有几天"分配，月档才不会被拉平） */}
        <div className="gantt__axis">
          <span className="gantt__range" title={'视窗 ' + win.start + ' ~ ' + win.end}>
            {rangeText}
          </span>
          {/* 名称列右边界上的分隔条。只占表头这一行的高度（Excel 的列宽拖动也在表头），
              而且**绝对定位**、不参与布局 —— 表头刻度必须与行内轨道同起点，占 1px 都会错位。 */}
          <div
            className="gantt__labelbar"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整任务名称列宽度"
            aria-valuenow={Math.round(labelW)}
            aria-valuemin={LABEL_MIN}
            aria-valuemax={maxLabelW}
            tabIndex={0}
            title="拖动调整名称列宽度（← → 微调，Home 复位）"
            onPointerDown={(e) => startDrag(e, 'label')}
            onPointerMove={(e) => moveDrag(e, 'label')}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={(e) => keyStep(e, 'label')}
          />
          <span className="gantt__ticks" ref={axisRef}>
            {win.cells.map((c, i) => (
              <span
                key={c.start}
                className={'gantt__tick' + (c.today ? ' gantt__tick--today' : '')}
                style={{ flexBasis: (c.days / win.days) * 100 + '%' }}
                title={c.start === c.end ? c.start : c.start + ' ~ ' + c.end}
              >
                {i % labelStep === 0 ? (
                  <>
                    <b>{c.label}</b>
                    {c.sub ? <i>{c.sub}</i> : null}
                  </>
                ) : null}
              </span>
            ))}
          </span>
        </div>
      </header>

      <div className="gantt__body">
        {rows.length === 0 ? (
          <p className="u-aux gantt__empty">当前视图没有可排期的任务。</p>
        ) : (
          <div
            ref={contentRef}
            className={'gantt__content' + (panning ? ' is-panning' : '')}
            onPointerDown={startPan}
            onPointerMove={movePan}
            onPointerUp={endPan}
            onPointerCancel={endPan}
            onDoubleClick={(e) => {
              // 双击条 / 标题是"打开任务"，不该顺手把视窗也拉回今天
              if (!(e.target as HTMLElement).closest('.gantt__bar, .gantt__title')) setAnchor(today)
            }}
            title="按住拖动调整时间窗口（日 / 周 / 月都生效），双击回到今天"
          >
            {rows.map((r) => (
              <div key={r.id} className={'gantt__row' + (r.done ? ' gantt__row--done' : '')}>
                <span className="gantt__label" style={{ paddingLeft: 8 + r.depth * 12 }}>
                  <i className="gantt__dot" style={{ background: priorityColor(r.priority) }} aria-hidden />
                  <button
                    type="button"
                    className="gantt__title"
                    onClick={() => onOpen(r.id)}
                    title={r.title + ' · ' + (rangeLabel(r.start_date, r.due_date) || '未排期')}
                  >
                    {r.title}
                  </button>
                </span>
                <span className="gantt__lane">{bar(r)}</span>
              </div>
            ))}
            {/* 网格与"今天"线画在所有行之上：绝对定位的一层，不吃指针事件 */}
            <div className="gantt__overlay" aria-hidden>
              <div className="gantt__grid" style={{ backgroundImage: gridImage }} />
              {todayInWindow ? (
                <i className="gantt__now" style={{ left: (todayPct ?? 0) * 100 + '%' }} />
              ) : null}
            </div>
          </div>
        )}
      </div>

      {/* 左边缘分隔条：拖动改侧栏宽度（上限 = 面板的 85%）。
          与笔记树 / 工作流的分隔条同一套规格（命中区铺满面板间隙 + 不画线 + 可聚焦 + ← → 微调），
          差别只在贴哪一边 —— 甘特图右边是速览栏与窗口边缘，能拖的边界在它左边。 */}
      <div
        className="gantt__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整甘特图宽度"
        aria-valuenow={Math.round(width)}
        aria-valuemin={WIDTH_MIN}
        aria-valuemax={maxW}
        tabIndex={0}
        title="拖动调整甘特图宽度（← → 微调，Home 复位）"
        onPointerDown={(e) => startDrag(e, 'panel')}
        onPointerMove={(e) => moveDrag(e, 'panel')}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(e) => keyStep(e, 'panel')}
      />
    </aside>
  )
}
