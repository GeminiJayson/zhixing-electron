import { useCallback, useEffect, useState } from 'react'
import { RotateCcw, Trash2 } from '@renderer/lib/icons'
import { parseSettings } from '@shared/settings'
import { isMotionFull } from '../lib/presence'
import { useDialog } from './Dialogs'
import { readTokenMs } from '@renderer/lib/motion-tokens'

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
  /** 正在退场的行：挂 .is-leaving 播一段 --dur-fast 的退出动画 */
  const [leaving, setLeaving] = useState<Set<number>>(new Set())

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

  /**
   * 先退场、再落库。
   *
   * 行从列表里消失是 load() 造成的（items 一变，React 立刻把元素摘出 DOM），
   * CSS 的退出动画于是永远没有落点 —— 所以先挂 .is-leaving 把 --dur-fast 这段时间让出来。
   * 动效非 full 档、或时长读成 0 时同步执行，一秒都不多等（isMotionFull() 读的是 dataset.motion）。
   */
  const withExit = async (id: number, run: () => Promise<void>): Promise<void> => {
    const ms = readTokenMs('--dur-fast')
    if (ms <= 0 || !isMotionFull()) {
      await run()
      return
    }
    setLeaving((prev) => new Set(prev).add(id))
    try {
      await new Promise((resolve) => window.setTimeout(resolve, ms))
      await run()
    } finally {
      setLeaving((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
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
                <li
                  key={it.id}
                  className={'trash-row' + (leaving.has(it.id) ? ' is-leaving' : '')}
                >
                  <span className="trash-row__label">{it.label || '（无标题）'}</span>
                  <span className="u-aux">{it.deleted_at.slice(0, 16)}</span>
                  <button
                    className="icon-btn"
                    title="恢复"
                    aria-label="恢复"
                    onClick={() =>
                      void withExit(it.id, async () => {
                        await window.zhixing.db.restoreTrash(tab, it.id)
                        onNotice('已恢复')
                        await afterChange()
                      })
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
                        await withExit(it.id, async () => {
                          await window.zhixing.db.purgeTrash(tab, it.id)
                          onNotice('已彻底删除')
                          await afterChange()
                        })
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
                /*
                  按钮写的是「清空此分类」，那就**只清当前 Tab**。

                  此前它调的是 emptyAllTrash() —— 文案说「此分类」、实际三类一起清，
                  而按钮的 disabled 又只按当前分类有没有条目来判：用户在「笔记」分类下看到按钮可用，
                  点下去连任务和闪念一起没了（用户反馈）。
                */
                void (async () => {
                  const label = TABS.find((t) => t.key === tab)?.label ?? '本分类'
                  const confirmed = await dialog.confirm({
                    title: `清空「${label}」`,
                    message: `清空「${label}」分类的 ${items.length} 条记录？无法恢复。`,
                    icon: <Trash2 size={15} />,
                    danger: true,
                    confirmText: '清空',
                  })
                  if (!confirmed) return
                  // 三类一个事务：分三次 IPC 的话，中途失败会留下「任务清了、笔记还在」，
                  // 而提示已经说了「已清空」
                  const n = await window.zhixing.db.emptyTrash(tab)
                  onNotice(n ? `已清空「${label}」的 ${n} 项` : '这个分类本来就是空的')
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
