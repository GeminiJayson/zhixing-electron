import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Morph, IconData } from '@renderer/lib/icons'
import { NAV_ITEMS, type PageKey } from '../nav'
import { isMotionFull } from '../lib/presence'
import { t } from '../i18n'

interface Props {
  page: PageKey
  collapsed: boolean
  inboxCount: number
  onSelect: (key: PageKey) => void
  onToggleCollapse: () => void
}

/** 指示条的高度上限：行高被用户调到 72px 时，指示条不该跟着变成一根长条。 */
const INDICATOR_MAX_H = 18
const INDICATOR_MIN_H = 12

export function Sidebar({ page, collapsed, inboxCount, onSelect, onToggleCollapse }: Props) {
  const navRef = useRef<HTMLElement>(null)
  const [marker, setMarker] = useState({ y: 0, h: INDICATOR_MAX_H, on: false })
  const [animated, setAnimated] = useState(false)

  /**
   * 实测活动项的位置：行高来自 --row-h（用户可调），写死高度或步长都会错位。
   * 两个分组（上/下）共用同一个指示条，所以坐标取的是相对 nav 的绝对值。
   */
  const measure = useCallback((): void => {
    const host = navRef.current
    if (!host) return
    const active = host.querySelector<HTMLElement>('.nav-item--active')
    if (!active) {
      setMarker((m) => (m.on ? { ...m, on: false } : m))
      return
    }
    const hostBox = host.getBoundingClientRect()
    const box = active.getBoundingClientRect()
    const h = Math.min(INDICATOR_MAX_H, Math.max(INDICATOR_MIN_H, box.height * 0.45))
    setMarker({ y: box.top - hostBox.top + (box.height - h) / 2, h, on: true })
  }, [])

  useLayoutEffect(() => {
    measure()
  }, [measure, page, collapsed, inboxCount])

  // 首帧量完再开过渡，避免挂载时从 0 滑到当前位置
  useLayoutEffect(() => {
    const timer = window.setTimeout(() => setAnimated(isMotionFull()), 0)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    const host = navRef.current
    if (!host) return
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  const render = (zone: 'top' | 'bottom') =>
    NAV_ITEMS.filter((i) => i.zone === zone).map((item) => {
      const Icon = item.icon
      const active = item.key === page
      return (
        <button
          key={item.key}
          data-nav-item={item.key}
          className={`nav-item${active ? ' nav-item--active' : ''}`}
          onClick={() => onSelect(item.key)}
          aria-current={active ? 'page' : undefined}
          title={collapsed ? t(item.labelKey) : undefined}
        >
          <span className="nav-item__icon">
            <Icon size={20} strokeWidth={2} />
          </span>
          {!collapsed && <span className="nav-item__label">{t(item.labelKey)}</span>}
          {!collapsed && item.key === 'inbox' && inboxCount > 0 && (
            /* key 用数量：数字一变就重建节点，于是 badge-pop 动画重播一次 */
            <span key={inboxCount} className="nav-item__badge">
              {inboxCount}
            </span>
          )}
        </button>
      )
    })

  return (
    <nav
      ref={navRef}
      className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`}
      aria-label="主导航"
    >
      <span
        className={`nav-indicator${marker.on ? ' nav-indicator--on' : ''}${animated ? ' nav-indicator--anim' : ''}`}
        style={{ transform: `translateY(${marker.y}px)`, height: marker.h }}
        aria-hidden="true"
      />
      <div className="sidebar__group">{render('top')}</div>
      <div className="sidebar__group sidebar__group--bottom">
        {render('bottom')}
        <button
          className="nav-item nav-item--ghost"
          onClick={onToggleCollapse}
          aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
          title={collapsed ? '展开侧栏' : '折叠侧栏'}
        >
          <span className="nav-item__icon">
            {/* 同一位置换图标 → morphicons 带弹簧形变 */}
            <Morph icon={collapsed ? IconData.PanelLeftOpen : IconData.PanelLeftClose} size={20} />
          </span>
          {!collapsed && <span className="nav-item__label">折叠</span>}
        </button>
      </div>
    </nav>
  )
}
