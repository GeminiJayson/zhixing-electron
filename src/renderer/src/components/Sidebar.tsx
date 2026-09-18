import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { NAV_ITEMS, type PageKey } from '../nav'
import { t } from '../i18n'

interface Props {
  page: PageKey
  collapsed: boolean
  inboxCount: number
  onSelect: (key: PageKey) => void
  onToggleCollapse: () => void
}

export function Sidebar({ page, collapsed, inboxCount, onSelect, onToggleCollapse }: Props) {
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
            <span className="nav-item__badge">{inboxCount}</span>
          )}
        </button>
      )
    })

  return (
    <nav className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`} aria-label="主导航">
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
            {collapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
          </span>
          {!collapsed && <span className="nav-item__label">折叠</span>}
        </button>
      </div>
    </nav>
  )
}
