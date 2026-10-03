import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isMotionFull, usePresence } from '../lib/presence'
import { placeAnchored } from '../lib/anchored-position'

export interface PopMenuItem {
  key: string
  label: string
  danger?: boolean
  checked?: boolean
  /**
   * 层级缩进（0 = 顶层）。
   *
   * 文件夹与任务分组是有父子关系的，平铺成一列看不出谁属于谁 ——
   * 用户报的"移动到文件夹/关联任务的弹窗没有层级"就是这个。
   * 只做缩进不做折叠：这两个弹窗的使用场景都是"快速找到某一项"，
   * 折叠起来反而要多点一次。
   */
  depth?: number
  onPick: () => void
}

interface Props {
  x: number
  y: number
  items: PopMenuItem[]
  onClose: () => void
}

/** 退场时长：必须与 global.css 里 `.popmenu--pop.is-leaving` 用的 --dur-instant 一致。 */
const EXIT_MS = 100

/** 通用弹出菜单：优先级菜单、标签菜单、任务行右键菜单共用。 */
export function PopMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // 「关闭意图」和「真正卸载」要分开：父组件是条件渲染，onClose 一被调用本组件立刻从树上消失，
  // 退场动画根本没有落点。所以先把自己置成退场态，等动画走完再通知父组件卸载。
  const [open, setOpen] = useState(true)
  const openRef = useRef(true)
  const closeTimer = useRef<number | null>(null)
  const exitMs = isMotionFull() ? EXIT_MS : 0
  const { mounted, leaving } = usePresence(open, exitMs)

  const requestClose = useCallback(() => {
    if (!openRef.current) return
    openRef.current = false
    setOpen(false)
    // 动效关闭时同步卸载，不让用户白等一个看不见的 100ms
    if (exitMs <= 0) onClose()
    else closeTimer.current = window.setTimeout(() => onClose(), exitMs)
  }, [exitMs, onClose])

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    },
    []
  )

  // 定位必须在提交前完成：useEffect 要等浏览器画完一帧，首帧会先落在默认位置再被挪走
  // ——看起来就是闪一下。顺带把 transform-origin 指向触发点，菜单从触发点那一侧长出来。
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // 原来是"按项数估算高度"（48 + n*30）再夹进视口 —— 菜单里有说明行、
    // 分组标题或长标签时估算必然偏小，下沿照样会探出去。改成实测 + 翻转。
    placeAnchored(el, { left: x, top: y, bottom: y })
    const originX = x > window.innerWidth / 2 ? 'right' : 'left'
    const originY = y > window.innerHeight / 2 ? 'bottom' : 'top'
    el.style.transformOrigin = `${originX} ${originY}`
  }, [x, y, items.length])

  useEffect(() => {
    const onDocDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) requestClose()
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') requestClose()
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [requestClose])

  if (!mounted) return null

  return (
    <div className={'popmenu popmenu--pop' + (leaving ? ' is-leaving' : '')} ref={ref} role="menu">
      {items.map((it) => (
        <button
          key={it.key}
          role="menuitem"
          className={`popmenu__item${it.danger ? ' popmenu__item--danger' : ''}`}
          /* 层级缩进。内联样式而不是类名：深度是数据，档数不定 */
          style={it.depth ? { paddingLeft: 'calc(var(--space-3) + ' + it.depth * 14 + 'px)' } : undefined}
          onClick={() => {
            it.onPick()
            requestClose()
          }}
        >
          <span className={`popmenu__tick${it.checked ? ' popmenu__tick--on' : ''}`} />
          {it.label}
        </button>
      ))}
    </div>
  )
}
