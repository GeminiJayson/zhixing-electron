import { useCallback, useEffect, useState } from 'react'
import { Check, Pencil, Plus, Trash2 } from '@renderer/lib/icons'
import { useDialog } from './Dialogs'
import { TAG_COLOR_PRESETS } from './TagMenu'

interface Props {
  onNotice: (message: string) => void
  onChanged: () => Promise<void>
  onClose: () => void
}

/** 标签管理：重命名、合并、删除；标签为任务与笔记共用一套。 */
export function TagManager({ onNotice, onChanged, onClose }: Props) {
  const dialog = useDialog()
  const [tags, setTags] = useState<{ id: number; name: string; color: string; count: number }[]>([])
  const [picked, setPicked] = useState<Set<number>>(new Set())
  /** 正在改色的标签 id；null = 没有展开调色板 */
  const [colorFor, setColorFor] = useState<number | null>(null)

  /**
   * 改颜色：先乐观更新这一行，再写库，最后 onChanged() 让任务页 / 笔记页重新取数。
   * 取色器拖动会连续触发 onChange，所以这里不做全量 load()（那会把列表刷得一闪一闪）。
   */
  const applyColor = async (id: number, color: string): Promise<void> => {
    setTags((prev) => prev.map((t) => (t.id === id ? { ...t, color } : t)))
    await window.zhixing.db.setTagColor(id, color)
    await onChanged()
  }

  const load = useCallback(async () => {
    setTags(await window.zhixing.db.tagsWithUsage())
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  const first = [...picked][0]

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="标签管理" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <h2>标签管理 · {tags.length} 个</h2>
        </header>
        <div className="modal__body">
          <div className="trash-tools">
            <button
              className="text-btn"
              onClick={() => {
                void (async () => {
                  const name = await dialog.prompt({ title: '新建标签', label: '标签名称' })
                  if (!name?.trim()) return
                  await window.zhixing.db.createTag(name)
                  await load()
                  onNotice('已新建标签')
                })()
              }}
            >
              <Plus size={13} /> 新建
            </button>
            <button
              className="text-btn"
              disabled={!first}
              onClick={() => {
                const tag = tags.find((t) => t.id === first)
                void (async () => {
                  const name = await dialog.prompt({ title: '重命名标签', label: '新名称', defaultValue: tag?.name ?? '' })
                  if (!name?.trim()) return
                  await window.zhixing.db.renameTag(first, name)
                  await load()
                  onNotice('已重命名')
                })()
              }}
            >
              <Pencil size={13} /> 重命名
            </button>
            <button
              className="text-btn"
              disabled={picked.size < 2}
              onClick={() =>
                void (async () => {
                  const ids = [...picked]
                  const target = ids[0]
                  const moved = await window.zhixing.db.mergeTags(target, ids.slice(1))
                  setPicked(new Set())
                  await load()
                  await onChanged()
                  onNotice(`已合并 ${ids.length} 个标签，迁移 ${moved} 处引用`)
                })()
              }
            >
              <Check size={13} /> 合并到第一个选中
            </button>
            <span className="modal__spacer" />
            <button
              className="text-btn text-btn--danger"
              disabled={picked.size === 0}
              onClick={() => {
                void (async () => {
                  const confirmed = await dialog.confirm({
                    title: '删除标签',
                    message: `删除选中的 ${picked.size} 个标签？关联会一并解除。`,
                    icon: <Trash2 size={15} />,
                    danger: true,
                    confirmText: '删除',
                  })
                  if (!confirmed) return
                  await window.zhixing.db.batchDeleteTags([...picked])
                  setPicked(new Set())
                  await load()
                  await onChanged()
                  onNotice('已删除标签')
                })()
              }}
            >
              <Trash2 size={13} /> 删除
            </button>
          </div>

          {tags.length === 0 ? (
            <p className="empty-hint">还没有标签。给任务或笔记加标签后会出现在这里。</p>
          ) : (
            <ul className="tag-list">
              {tags.map((t) => (
                <li key={t.id}>
                  <div className="tag-row">
                    <label className="tag-row__pick">
                      <input
                        type="checkbox"
                        checked={picked.has(t.id)}
                        onChange={(e) =>
                          setPicked((prev) => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(t.id)
                            else next.delete(t.id)
                            return next
                          })
                        }
                      />
                      <span className="tag-row__name">{t.name}</span>
                    </label>
                    {/* 色块即改色入口：点它是「给这个标签换色」，而不是再挑一次选中 */}
                    <button
                      type="button"
                      className={'tag-row__dot' + (colorFor === t.id ? ' tag-row__dot--on' : '')}
                      style={{ background: t.color }}
                      title={`改「${t.name}」的颜色`}
                      aria-label={`改「${t.name}」的颜色`}
                      aria-expanded={colorFor === t.id}
                      onClick={() => setColorFor((prev) => (prev === t.id ? null : t.id))}
                    />
                    <span className="u-aux">{t.count} 处引用</span>
                  </div>
                  {colorFor === t.id && (
                    <div className="tag-row__colors" role="group" aria-label={`${t.name} 的颜色`}>
                      {TAG_COLOR_PRESETS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={
                            'tagmenu__color' +
                            (c.toLowerCase() === t.color.toLowerCase() ? ' tagmenu__color--on' : '')
                          }
                          style={{ background: c }}
                          title={c}
                          aria-label={`${t.name} 用颜色 ${c}`}
                          onClick={() => void applyColor(t.id, c)}
                        />
                      ))}
                      <label className="tagmenu__custom" title="自定义颜色">
                        <input
                          type="color"
                          value={/^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#0D9488'}
                          aria-label={`${t.name} 的自定义颜色`}
                          onChange={(e) => void applyColor(t.id, e.target.value)}
                        />
                      </label>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="modal__foot">
          <span className="modal__spacer" />
          <button className="text-btn" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  )
}
