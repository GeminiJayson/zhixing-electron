import { useEffect, useRef, useState } from 'react'
import { Check, Plus } from '@renderer/lib/icons'
import { TAG_COLOR_PRESETS } from '@shared/color'
import { placeAnchored } from '@renderer/lib/anchored-position'

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
 * 版式与「状态」弹层（StatusMenu）同构：容器 .popmenu、每行 .popmenu__item、
 * 左侧 8px 圆点 .popmenu__dot（颜色来自数据，走内联 style）、中间标签名纯文本、
 * 选中时右侧补一个 Check。原先把「色块 + 勾选位 + 彩色胶囊」三样东西塞在一行里，
 * 视觉上挤成一团；现在一行只表达一件事。
 *
 * 功能一件不少：点色点就地展开调色板、列表最后一行是「新建标签」。
 * tagmenu / tagmenu__swatch / tagmenu__name 这三个名字是 scripts/taglistcheck.mjs 用的选择器，
 * 外观一律来自 .popmenu / .popmenu__item，它们只当钩子。
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
      // 这里传的是**点击位置**而不是锚点矩形：标签弹层可以被右键菜单唤起，
      // 那时没有明确的"按钮"可贴，跟着指针走更自然。
      // 依赖里带 editing：展开 / 收起调色板会改变菜单尺寸，定位要跟着重算一次。
      placeAnchored(el, { left: x, top: y, bottom: y })
    }
    const onDocDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    // 捕获阶段：弹窗内部会 stopPropagation 掉冒泡事件，冒泡监听收不到（见 Select 里的说明）
    document.addEventListener('mousedown', onDocDown, true)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocDown, true)
      document.removeEventListener('keydown', onEsc)
    }
  }, [x, y, editing, onClose])

  return (
    <div className="popmenu tagmenu" ref={ref} role="dialog" aria-label={title}>
      {/* 说明行：借 .popmenu__item 的行节奏（同高、同内边距），但它是说明不是条目 ——
          hover 底色在 .tagmenu__head 里关掉，免得看起来能点。
          展开调色板时它换成「改颜色 · 名字」+「返回」，不再单起一个比行高一截的标题块。 */}
      <div className="popmenu__item tagmenu__head">
        <span className="tagmenu__head-text">
          {current ? `改颜色 · ${current.name}` : `${title} · ${tags.length}`}
        </span>
        {current && (
          <button type="button" className="text-btn tagmenu__back" onClick={() => setEditing(null)}>
            返回
          </button>
        )}
      </div>

      <ul className="tagmenu__list" role="menu">
        {tags.length === 0 && <li className="tagmenu__empty u-aux">还没有标签，点下面「新建标签」。</li>}
        {tags.map((t) => {
          const on = selected.has(t.id)
          const open = editing === t.id
          return (
            <li key={t.id} role="none">
              <div className={'popmenu__item' + (on ? ' popmenu__item--active' : '')}>
                {/* 色点即改色入口：色点本体仍是 .popmenu__dot（颜色走内联 style），
                    外面套一个按钮把它做成可点热区 */}
                <button
                  type="button"
                  className="tagmenu__swatch"
                  title={`改「${t.name}」的颜色`}
                  aria-label={`改「${t.name}」的颜色`}
                  aria-expanded={open}
                  onClick={() => setEditing((prev) => (prev === t.id ? null : t.id))}
                >
                  <span className="popmenu__dot" style={{ background: t.color }} />
                </button>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  className="tagmenu__name"
                  onClick={() => onToggle(t)}
                >
                  <span className="tagmenu__label">{t.name}</span>
                  {on && <Check size={14} className="tagmenu__tick" />}
                </button>
              </div>
              {/* 调色板：点色点后在这个标签行底下就地铺开 —— 一行普通色块，不是第二张卡片 */}
              {open && (
                <div className="tagmenu__colors" role="group" aria-label={`${t.name} 的颜色`}>
                  {TAG_COLOR_PRESETS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={
                        'tagmenu__color' + (c.toLowerCase() === t.color.toLowerCase() ? ' tagmenu__color--on' : '')
                      }
                      style={{ background: c }}
                      title={c}
                      aria-label={`${t.name} 用颜色 ${c}`}
                      onClick={() => onColor(t.id, c)}
                    />
                  ))}
                  {/* 取色器：预设之外的任意颜色。onChange 连续触发，写库很快，不额外节流 */}
                  <label className="tagmenu__custom" title="自定义颜色">
                    <input
                      type="color"
                      value={/^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#0D9488'}
                      aria-label={`${t.name} 的自定义颜色`}
                      onChange={(e) => onColor(t.id, e.target.value)}
                    />
                  </label>
                </div>
              )}
            </li>
          )
        })}
        {/* 新建标签是列表的最后一行（不再单起一个 footer 区块）：
            左侧 24px 槽位与上面的色点热区同宽，所以文字和标签名同列 */}
        <li role="none">
          <button type="button" role="menuitem" className="popmenu__item" onClick={onCreate}>
            <span className="tagmenu__lead">
              <Plus size={14} />
            </span>
            新建标签…
          </button>
        </li>
      </ul>
    </div>
  )
}
