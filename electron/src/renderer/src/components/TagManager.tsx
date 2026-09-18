import { useCallback, useEffect, useState } from 'react'
import { Check, Pencil, Plus, Trash2 } from 'lucide-react'
import { useDialog } from './Dialogs'

interface Props {
  onNotice: (message: string) => void
  onChanged: () => Promise<void>
  onClose: () => void
}

/** 标签管理（F1-6）：重命名、合并、删除；标签为任务与笔记共用一套。 */
export function TagManager({ onNotice, onChanged, onClose }: Props) {
  const dialog = useDialog()
  const [tags, setTags] = useState<{ id: number; name: string; color: string; count: number }[]>([])
  const [picked, setPicked] = useState<Set<number>>(new Set())

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
                if (!window.confirm(`删除选中的 ${picked.size} 个标签？关联会一并解除。`)) return
                void (async () => {
                  for (const id of picked) await window.zhixing.db.deleteTag(id)
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
                  <label className="tag-row">
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
                    <span className="tag-row__dot" style={{ background: t.color }} />
                    <span className="tag-row__name">{t.name}</span>
                    <span className="u-aux">{t.count} 处引用</span>
                  </label>
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
