/**
 * 原型（可抛弃，不参与生产）：页面级工具栏的三种结构范式。
 *
 * 问题：8 个功能区里出现了 6 种工具区写法（tasks-toolbar 三种用法 / flash-toolbar /
 * ntree__tools / rt-editor__bar / quick-add / seg tab），搜索框、主操作、统计文本的位置
 * 每页都不一样，收件箱一页还有三条独立工具条。
 *
 * 计划：三条变体挂在**现有页面**上（真实数据、真实侧栏、真实密度），用 #ptoolbar=A|B|C
 * 切换，悬浮底栏左右箭头翻看，覆盖 今日 / 任务 / 收件箱 / 工作流 / 图谱 / 设置 / 回顾。
 *
 * 变体在**结构**上不同（不是换颜色）：
 *   A 单行三段：标题 + 导航 …… 搜索 / 筛选 / 次要(收进 ⋯) / 主操作 —— 一屏一行
 *   B 双层：主操作升到标题行；第二层放导航 / 搜索 / 筛选 / 次要（平铺）
 *   C 折叠命令式：常驻只有搜索 + 主操作，导航 / 筛选 / 次要全收进一个操作浮层
 *
 * 用法：npm run prototype:toolbars，然后 hash 加 #ptoolbar=A（或用底栏箭头 / ← → 键）。
 * 默认 off：不带 hash 时渲染各页**原有**工具栏，普通用户永远看不到原型。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal, SlidersHorizontal } from 'lucide-react'
import './toolbar-prototype.css'

export type ToolbarVariant = 'off' | 'A' | 'B' | 'C'

const ORDER: Exclude<ToolbarVariant, 'off'>[] = ['A', 'B', 'C']
const NAMES: Record<Exclude<ToolbarVariant, 'off'>, string> = {
  A: '单行三段',
  B: '双层：主操作上标题行',
  C: '折叠命令式',
}
const KEY = 'ptoolbar'

/** 变异开关只认 hash：#ptoolbar=A。不回写 localStorage —— 原型不该有任何持久化。 */
function readHash(): ToolbarVariant {
  const m = new RegExp('[#&]' + KEY + '=([ABC]|off)').exec(window.location.hash)
  const v = m?.[1]
  return v === 'A' || v === 'B' || v === 'C' || v === 'off' ? v : 'off'
}

export function useToolbarVariant(): ToolbarVariant {
  const [v, setV] = useState<ToolbarVariant>(readHash)
  useEffect(() => {
    const on = (): void => setV(readHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return v
}

export function setToolbarVariant(v: ToolbarVariant): void {
  const parts = window.location.hash
    .replace(/^#/, '')
    .split('&')
    .filter((p) => p && !p.startsWith(KEY + '='))
  if (v !== 'off') parts.push(KEY + '=' + v)
  const next = parts.length ? '#' + parts.join('&') : ''
  if (window.location.hash === next) window.dispatchEvent(new HashChangeEvent('hashchange'))
  else window.location.hash = next
}

/** 每个功能区把自己的操作按语义分类交出来，变体只决定**摆在哪**。 */
export type ToolbarSpec = {
  title: string
  subtitle?: string
  /** 视图 / 范围 / 模式切换（seg、tab 栏） */
  nav?: ReactNode
  /** 统计小字（共 N 项 / N 节点） */
  meta?: ReactNode
  /** 搜索或过滤输入 */
  search?: ReactNode
  /** 下拉筛选 */
  filters?: ReactNode[]
  /** 次要操作：可变、按需 |
   */
  secondary?: ReactNode[]
  /** 主操作：每页一个，位置固定 */
  primary?: ReactNode
}

export function PrototypeToolbar({
  spec,
  fallback,
}: {
  spec: ToolbarSpec
  fallback: ReactNode
}): JSX.Element {
  const variant = useToolbarVariant()
  if (variant === 'off') return <>{fallback}</>
  if (variant === 'A') return <VariantA spec={spec} />
  if (variant === 'B') return <VariantB spec={spec} />
  return <VariantC spec={spec} />
}

const isDev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true

/* ---------- A：单行三段 ---------- */
function VariantA({ spec }: { spec: ToolbarSpec }): JSX.Element {
  return (
    <div className="pto pto--a">
      <Lead spec={spec} />
      <div className="pto__nav">
        {spec.nav}
        {spec.meta ? <span className="pto__meta">{spec.meta}</span> : null}
      </div>
      <div className="pto__tail">
        {spec.search}
        {spec.filters?.map((f, i) => <span key={i}>{f}</span>)}
        {spec.secondary?.length ? <MoreMenu items={spec.secondary} /> : null}
        {spec.primary}
      </div>
    </div>
  )
}

/* ---------- B：双层，主操作上标题行 ---------- */
function VariantB({ spec }: { spec: ToolbarSpec }): JSX.Element {
  return (
    <div className="pto pto--b">
      <div className="pto__row">
        <Lead spec={spec} />
        <div className="pto__tail">{spec.primary}</div>
      </div>
      <div className="pto__row pto__row--sub">
        <div className="pto__nav">
          {spec.nav}
          {spec.meta ? <span className="pto__meta">{spec.meta}</span> : null}
        </div>
        <div className="pto__tail">
          {spec.search}
          {spec.filters?.map((f, i) => <span key={i}>{f}</span>)}
          {spec.secondary?.map((s, i) => <span key={i}>{s}</span>)}
        </div>
      </div>
    </div>
  )
}

/* ---------- C：折叠命令式 ---------- */
function VariantC({ spec }: { spec: ToolbarSpec }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
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
  const groups = [
    { k: '视图 / 范围', v: <>{spec.nav}{spec.meta ? <span className="pto__meta">{spec.meta}</span> : null}</> },
    ...(spec.filters?.length ? [{ k: '筛选', v: <>{spec.filters.map((f, i) => <span key={i}>{f}</span>)}</> }] : []),
    ...(spec.secondary?.length ? [{ k: '操作', v: <>{spec.secondary.map((s, i) => <span key={i}>{s}</span>)}</> }] : []),
  ]
  return (
    <div className="pto pto--c" ref={ref}>
      <Lead spec={spec} />
      <div className="pto__tail">
        {spec.search}
        <button className="pto-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <SlidersHorizontal size={14} /> 视图与筛选
        </button>
        {spec.primary}
      </div>
      {open ? (
        <div className="pto-sheet" role="dialog" aria-label="视图与筛选">
          {groups.map((g) => (
            <div className="pto-sheet__group" key={g.k}>
              <span className="pto-sheet__k">{g.k}</span>
              <div className="pto-sheet__v">{g.v}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Lead({ spec }: { spec: ToolbarSpec }): JSX.Element {
  return (
    <div className="pto__lead">
      <h1 className="page__title">{spec.title}</h1>
      {spec.subtitle ? <p className="page__subtitle">{spec.subtitle}</p> : null}
    </div>
  )
}

/** 单行变体里次要操作的落脚点：一个 ⋯ 菜单。 */
function MoreMenu({ items }: { items: ReactNode[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  return (
    <div className="pto-more" ref={ref}>
      <button className="pto-btn" aria-expanded={open} aria-label="更多操作" title="更多操作" onClick={() => setOpen((v) => !v)}>
        <MoreHorizontal size={15} />
      </button>
      {open ? (
        <div className="pto-menu" role="menu">
          {items.map((it, i) => (
            <div className="pto-menu__row" key={i} role="none">
              {it}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 悬浮底栏：← 标签 →，键盘 ← → 也能翻。只有开了 hash 或 dev 才出现。 */
export function PrototypeSwitcher(): JSX.Element | null {
  const variant = useToolbarVariant()
  const cycle = useCallback(
    (delta: number) => {
      const cur = variant === 'off' ? 0 : ORDER.indexOf(variant)
      setToolbarVariant(ORDER[(cur + delta + ORDER.length) % ORDER.length])
    },
    [variant]
  )
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        cycle(-1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        cycle(1)
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [cycle])
  if (!isDev && variant === 'off') return null
  const idx = variant === 'off' ? -1 : ORDER.indexOf(variant)
  return (
    <div className="pto-switch" role="group" aria-label="工具栏原型变体">
      <button onClick={() => cycle(-1)} aria-label="上一个变体">
        ←
      </button>
      <span className="pto-switch__k">{idx < 0 ? '工具栏原型：未启用' : ORDER[idx] + ' (' + NAMES[ORDER[idx]] + ')'}</span>
      <button onClick={() => cycle(1)} aria-label="下一个变体">
        →
      </button>
      {idx >= 0 ? (
        <button className="pto-switch__x" onClick={() => setToolbarVariant('off')} title="退出原型（回到现有工具栏）">
          ×
        </button>
      ) : null}
    </div>
  )
}
