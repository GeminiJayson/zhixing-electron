import { useEffect, useState } from 'react'
import type { NoteRevision } from '@shared/types'

interface Props {
  noteId: number
  onRestored: () => Promise<void>
  onClose: () => void
}

/** 版本历史（F2-9）：列出最近 20 版快照，可回滚（回滚前会自动给当前内容留快照）。 */
export function NoteHistory({ noteId, onRestored, onClose }: Props) {
  const [revs, setRevs] = useState<NoteRevision[]>([])
  const [preview, setPreview] = useState<NoteRevision | null>(null)

  useEffect(() => {
    void window.zhixing.db.noteRevisions(noteId).then((rows) => {
      setRevs(rows)
      setPreview(rows[0] ?? null)
    })
  }, [noteId])

  useEffect(() => {
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div
        className="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-label="版本历史"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal__head">
          <h2>版本历史 · {revs.length} 版</h2>
        </header>
        <div className="history">
          <ul className="history__list">
            {revs.map((r) => (
              <li key={r.id}>
                <button
                  className={`history__item${preview?.id === r.id ? ' history__item--on' : ''}`}
                  onClick={() => setPreview(r)}
                >
                  <strong>{r.title || '未命名'}</strong>
                  <span className="u-aux">{r.created_at.slice(0, 19)}</span>
                </button>
              </li>
            ))}
            {revs.length === 0 && <li className="u-aux">还没有历史版本（正文改动后才会产生快照）。</li>}
          </ul>
          <div className="history__preview">
            {preview ? <pre>{preview.content_md || '（空）'}</pre> : <p className="u-aux">选择左侧版本查看内容。</p>}
          </div>
        </div>
        <footer className="modal__foot">
          <span className="u-aux">回滚前会自动把当前内容存为一版</span>
          <span className="modal__spacer" />
          <button className="text-btn" onClick={onClose}>
            关闭
          </button>
          <button
            className="text-btn text-btn--accent"
            disabled={!preview}
            onClick={() => {
              if (!preview) return
              void (async () => {
                await window.zhixing.db.restoreNoteRevision(noteId, preview.id)
                await onRestored()
                onClose()
              })()
            }}
          >
            回滚到这一版
          </button>
        </footer>
      </div>
    </div>
  )
}
