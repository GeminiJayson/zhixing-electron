import { useEffect, useRef, useState } from 'react'
import { Check, Plus } from '@renderer/lib/icons'
import { TAG_COLOR_PRESETS, inkOn } from '@shared/color'

// 色板的定义在 shared/color.ts：那里有单测守着「每个预设色配它的文字色都够读」
export { TAG_COLOR_PRESETS }

export interface TagItem {
  id: number
  name: string
  color: string
}

interface Props {
  x: number
  y: number
  /** 面板标题，如「任务标签」/「笔记标签」 */
  title?: string
  /** 全部标签（任务与笔记共用一套） */
  tags: TagItem[]
  /** 当前实体已挂的标签 id */
  selectedIds: number[]
  /** 勾选 / 取消勾选：父层按标签名整体覆盖写回 */
  onToggle: (tag: TagItem) => void
  /** 新建标签…（父层弹输入框） */
  onCreate: () => void
  /** 改颜色（#RRGGBB） */
  onColor: (id: number, color: string) => void
  onClose: () => void
}

/**
 * 标签弹层：勾选已有标签 + 就地改颜色 + 新建。
 *
 * 任务行与笔记页共用同一个组件 —— 此前任务侧只有一个「复选框式」的 PopMenu，
 * 颜色只能靠 createTag 的默认值，用户没有改色的入口（需求：胶囊颜色可自定义）。
 * 把调色板挂在每一行左侧的色块上，而不是另开一个「标签管理」窗口才能改色。
 */
export function TagMenu({ x, y, title = '标签', tags, selectedIds, onToggle, onCreate, onColor, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  /** 正在改色的标签 id；null = 没展开调色板 */
  const [editing, setEditing] = useState<number | null>(null)
  const selected = new Set(selectedIds)
  const current = editing == null ? null : tags.find((t) => t.id === editing) ?? null

  useEffect(() => {
    const el = ref.current
    if (el) {
      el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 248))}px`
      el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 60))}px`
    }
    const onDocDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [x, y, onClose])

  return (
    <div className="tagmenu" ref={ref} role="dialog" aria-label={title}>
      <header className="tagmenu__head">
        <span>{current ? `改颜色 · ${current.name}` : `${title} · ${tags.length}`}</span>
        {current && (
          <button className="text-btn tagmenu__back" onClick={() => setEditing(null)}>
            返回
          </button>
        )}
      </header>

      <ul className="tagmenu__list" role="menu">
        {tags.length === 0 && <li className="tagmenu__empty u-aux">还没有标签，点下面「新建标签」。</li>}
        {tags.map((t) => {
          const on = selected.has(t.id)
          return (
            <li key={t.id} className="tagmenu__row">
              <button
                type="button"
                className="tagmenu__swatch"
                style={{ background: t.color }}
                title={`改「${t.name}」的颜色`}
                aria-label={`改「${t.name}」的颜色`}
                onClick={() => setEditing((prev) => (prev === t.id ? null : t.id))}
              />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                className={'tagmenu__name' + (on ? ' tagmenu__name--on' : '')}
                onClick={() => onToggle(t)}
              >
                <span className={'tagmenu__tick' + (on ? ' tagmenu__tick--on' : '')}>
                  {on ? <Check size={12} /> : null}
                </span>
                <span className={'tagmenu__chip'} style={{ background: t.color, color: inkOn(t.color) }}>
                  {t.name}
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      {current && (
        <div className="tagmenu__colors" role="group" aria-label={`${current.name} 的颜色`}>
          {TAG_COLOR_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              className={'tagmenu__color' + (c.toLowerCase() === current.color.toLowerCase() ? ' tagmenu__color--on' : '')}
              style={{ background: c }}
              title={c}
              aria-label={`${current.name} 用颜色 ${c}`}
              onClick={() => onColor(current.id, c)}
            />
          ))}
          {/* 取色器：预设之外的任意颜色。onChange 连续触发，写库很快，不额外节流 */}
          <label className="tagmenu__custom" title="自定义颜色">
            <input
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(current.color) ? current.color : '#0D9488'}
              aria-label={`${current.name} 的自定义颜色`}
              onChange={(e) => onColor(current.id, e.target.value)}
            />
          </label>
        </div>
      )}

      <footer className="tagmenu__foot">
        <button className="text-btn" onClick={onCreate}>
          <Plus size={13} /> 新建标签…
        </button>
      </footer>
    </div>
  )
}
