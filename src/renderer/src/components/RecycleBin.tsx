import { useCallback, useEffect, useState } from 'react'
import { RotateCcw, Trash2 } from '@renderer/lib/icons'
import { parseSettings } from '@shared/settings'
import { useDialog } from './Dialogs'

interface Props {
  onNotice: (message: string) => void
  onChanged: () => Promise<void>
  onClose: () => void
}

type Kind = 'task' | 'note' | 'flash'

const TABS: { key: Kind; label: string }[] = [
  { key: 'task', label: '任务' },
  { key: 'note', label: '笔记' },
  { key: 'flash', label: '闪念' },
]

/** 回收站：三 Tab 展示软删除记录，可单条恢复/彻底删除，也可清空或按保留天数清理。 */
export function RecycleBin({ onNotice, onChanged, onClose }: Props) {
  const dialog = useDialog()
  const [tab, setTab] = useState<Kind>('task')
  const [items, setItems] = useState<{ id: number; label: string; deleted_at: string }[]>([])
  const [days, setDays] = useState(30)

  // 初始天数取设置里的 recycle_retention_days（此前硬编码 30，改设置也不生效）
  useEffect(() => {
    void window.zhixing.db
      .settings()
      .then((raw) => setDays(parseSettings(raw).recycle_retention_days))
      .catch(() => undefined)
  }, [])

  const load = useCallback(async () => {
    setItems(await window.zhixing.db.trashItems(tab))
  }, [tab])

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

  const afterChange = async (): Promise<void> => {
    await load()
    await onChanged()
  }

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="回收站" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <h2>回收站</h2>
        </header>
        <div className="modal__body">
          <div className="seg" role="tablist">
            {TABS.map((t) => (
              <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>

          {items.length === 0 ? (
            <p className="empty-hint">这个分类的回收站是空的。</p>
          ) : (
            <ul className="trash-list">
              {items.map((it) => (
                <li key={it.id} className="trash-row">
                  <span className="trash-row__label">{it.label || '（无标题）'}</span>
                  <span className="u-aux">{it.deleted_at.slice(0, 16)}</span>
                  <button
                    className="icon-btn"
                    title="恢复"
                    aria-label="恢复"
                    onClick={() =>
                      void (async () => {
                        await window.zhixing.db.restoreTrash(tab, it.id)
                        onNotice('已恢复')
                        await afterChange()
                      })()
                    }
                  >
                    <RotateCcw size={14} />
                  </button>
                  <button
                    className="icon-btn icon-btn--danger"
                    title="彻底删除"
                    aria-label="彻底删除"
                    onClick={() => {
                      void (async () => {
                        const confirmed = await dialog.confirm({
                          title: '彻底删除',
                          message: '彻底删除后无法恢复，确定？',
                          icon: <Trash2 size={15} />,
                          danger: true,
                          confirmText: '彻底删除',
                        })
                        if (!confirmed) return
                        await window.zhixing.db.purgeTrash(tab, it.id)
                        onNotice('已彻底删除')
                        await afterChange()
                      })()
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="trash-tools">
            <label className="form-row">
              <span>保留天数</span>
              <input
                type="number"
                className="field field--num"
                min={1}
                max={365}
                value={days}
                onChange={(e) => setDays(Number(e.target.value) || 30)}
              />
            </label>
            <button
              className="text-btn"
              onClick={() =>
                void (async () => {
                  const n = await window.zhixing.db.purgeTrashOlderThan(days)
                  onNotice(n ? `已清理 ${n} 项超过 ${days} 天的记录` : '没有超过保留期的记录')
                  await afterChange()
                })()
              }
            >
              清理超期记录
            </button>
            <span className="modal__spacer" />
            <button
              className="text-btn text-btn--danger"
              disabled={items.length === 0}
              onClick={() => {
                // 清空回收站：任务/笔记/闪念三类一起清（此前只清当前 Tab）
                void (async () => {
                  const confirmed = await dialog.confirm({
                    title: '清空回收站',
                    message: '清空全部三类（任务 / 笔记 / 闪念）？无法恢复。',
                    icon: <Trash2 size={15} />,
                    danger: true,
                    confirmText: '清空',
                  })
                  if (!confirmed) return
                  // 三类一个事务：分三次 IPC 的话，中途失败会留下「任务清了、笔记还在」，
                  // 而提示已经说了「已清空」
                  const n = await window.zhixing.db.emptyAllTrash()
                  onNotice(`已清空 ${n} 项`)
                  await afterChange()
                })()
              }}
            >
              清空此分类
            </button>
          </div>
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
