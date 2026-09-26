import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { ChevronDown, X } from '../lib/icons'
import { noteIcon, type NoteFormat } from './NoteTree'
import { PopMenu } from './PopMenu'

/** 一个已打开的笔记。tab 条只吃这份数据，自己不碰数据库。 */
export interface NoteTab {
  id: number
  title: string
  format: NoteFormat
  /** 正文还没落盘。只有当前 tab 可能是 true —— 切换/关闭前都会 flush。 */
  unsaved: boolean
}

interface Props {
  tabs: NoteTab[]
  activeId: number | null
  onActivate: (id: number) => void
  onClose: (id: number) => void
}

/**
 * 笔记多标签页的条（受控、无数据访问）。
 *
 * 三条硬约定：
 *   1. **≤1 个 tab 时不渲染** —— 不给单篇笔记白占那 30px（产品决定，见
 *      docs/note-tabs-plan.md §10-B）。调用方也判断一次，这里再兜一层。
 *   2. 图标走 `noteIcon()`，与笔记树同一套映射 —— 同一篇笔记在树上与 tab 上
 *      长得一样，不会出现「树上说它是 Excel、tab 上说是 Word」。
 *   3. **装不下时给一个「选择」入口**：横向滚动是个不可见的手势，光靠它，
 *      被推到视口外的那几篇等于没有入口。溢出（内容宽 > 可视宽）才出现，
 *      点开列出全部已打开的笔记，当前那枚带勾。
 */
export function NoteTabs({ tabs, activeId, onActivate, onClose }: Props): ReactElement | null {
  const listRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  // 激活项必须可见：tab 多了会横向滚动，不能让当前那枚躲在视口外
  useEffect(() => {
    listRef.current?.querySelector('.note-tab--active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeId, tabs.length])

  /**
   * 是否装不下。容器尺寸变化（窗口缩放、笔记树收放）与 tab 集合变化都要重测 ——
   * ResizeObserver 只看得到前者，后者靠依赖项里的 tabs 重建一次。
   */
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const measure = (): void => setOverflow(el.scrollWidth > el.clientWidth + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [tabs])

  if (tabs.length <= 1) return null

  return (
    <div className="note-tabs">
      <div className="note-tabs__list" role="tablist" aria-label="已打开的笔记" ref={listRef}>
        {tabs.map((t) => {
          const { Comp, tone } = noteIcon(t.format)
          const active = t.id === activeId
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={'note-tab' + (active ? ' note-tab--active' : '')}
              title={t.title}
              onClick={() => onActivate(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onActivate(t.id)
                }
              }}
              onAuxClick={(e) => {
                // 中键关闭：与浏览器同一手势
                if (e.button === 1) {
                  e.preventDefault()
                  onClose(t.id)
                }
              }}
            >
              <Comp size={12} className={'note-tab__type note-tab__type--' + tone} aria-hidden />
              <span className="note-tab__title">{t.title}</span>
              {t.unsaved ? <span className="note-tab__dot" title="未保存" aria-label="未保存" /> : null}
              <button
                type="button"
                className="note-tab__close"
                aria-label={'关闭 ' + t.title}
                title="关闭（中键点击也可）"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(t.id)
                }}
              >
                <X size={11} />
              </button>
            </div>
          )
        })}
      </div>

      {overflow ? (
        <button
          type="button"
          className="note-tabs__pick"
          aria-label={'全部打开的笔记（' + tabs.length + ' 篇）'}
          title="装不下了：在这里选一篇"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            // 菜单向左展开，右边缘与按钮对齐；PopMenu 自己会做边界收敛
            setMenu({ x: r.right - 168, y: r.bottom + 4 })
          }}
        >
          <ChevronDown size={13} />
          <span>{tabs.length}</span>
        </button>
      ) : null}

      {menu ? (
        <PopMenu
          x={menu.x}
          y={menu.y}
          items={tabs.map((t) => ({
            key: String(t.id),
            label: t.unsaved ? t.title + '（未保存）' : t.title,
            checked: t.id === activeId,
            onPick: () => onActivate(t.id),
          }))}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  )
}
