import { useEffect, useState } from 'react'
import { Undo2 } from '@renderer/lib/icons'
import type { NoteRevision } from '@shared/types'
import { useDialog } from './Dialogs'

interface Props {
  noteId: number
  onRestored: () => Promise<void>
  onClose: () => void
}

/** diff 的一行：kind 决定配色，text 是原始行文本。 */
interface DiffLine {
  kind: 'ctx' | 'add' | 'del' | 'hunk' | 'file'
  text: string
}

/**
 * 行级 unified diff（对齐 Python note_tools 的 difflib.unified_diff 口径）：
 * LCS 求增删、上下各 3 行上下文、`@@ -a,b +c,d @@` 段头，行前缀
 * ` ` / `+` / `-`，首两行 `--- 选中版本` / `+++ 当前内容`。
 */
export function unifiedDiff(oldText: string, newText: string, context = 3): DiffLine[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const n = a.length
  const m = b.length
  // LCS 长度表（笔记正文规模有限，O(n·m) 可接受）
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  // 逐行产出带 kind 的操作序列（等价 SequenceMatcher 的 opcodes 展开）
  type Op = { kind: 'eq' | 'del' | 'add'; text: string }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'eq', text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: 'del', text: a[i] })
      i++
    } else {
      ops.push({ kind: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) ops.push({ kind: 'del', text: a[i++] })
  while (j < m) ops.push({ kind: 'add', text: b[j++] })

  // 找出需要输出的变更段落（变更前后各留 context 行），合并相邻段落
  const keep = new Array<boolean>(ops.length).fill(false)
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].kind === 'eq') continue
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = true
  }
  const out: DiffLine[] = [
    { kind: 'file', text: '--- 选中版本' },
    { kind: 'file', text: '+++ 当前内容' },
  ]
  let k = 0
  // 行号计数器：unified diff 的段头是 1-based
  let oldNo = 0
  let newNo = 0
  while (k < ops.length) {
    // 跳过不需要输出的相等行，同时推进行号
    if (!keep[k]) {
      if (ops[k].kind === 'eq') {
        oldNo++
        newNo++
      } else if (ops[k].kind === 'del') oldNo++
      else newNo++
      k++
      continue
    }
    let oldStart = 0
    let newStart = 0
    const body: DiffLine[] = []
    let oldCount = 0
    let newCount = 0
    while (k < ops.length && keep[k]) {
      const op = ops[k]
      if (op.kind === 'eq') {
        if (oldStart === 0) {
          oldStart = oldNo + 1
          newStart = newNo + 1
        }
        body.push({ kind: 'ctx', text: op.text })
        oldNo++
        newNo++
        oldCount++
        newCount++
      } else if (op.kind === 'del') {
        if (oldStart === 0) {
          oldStart = oldNo + 1
          newStart = newNo + 1
        }
        body.push({ kind: 'del', text: op.text })
        oldNo++
        oldCount++
      } else {
        if (oldStart === 0) {
          oldStart = oldNo + 1
          newStart = newNo + 1
        }
        body.push({ kind: 'add', text: op.text })
        newNo++
        newCount++
      }
      k++
    }
    out.push({
      kind: 'hunk',
      text: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    })
    out.push(...body)
  }
  return out
}

/** 版本历史：列出最近 20 版快照，选中版本与当前内容做 unified diff，回滚二次确认。 */
export function NoteHistory({ noteId, onRestored, onClose }: Props) {
  const dialog = useDialog()
  const [revs, setRevs] = useState<NoteRevision[]>([])
  const [preview, setPreview] = useState<NoteRevision | null>(null)
  /** 当前笔记正文：diff 的「新」侧（对齐 Python _current_note_content） */
  const [currentContent, setCurrentContent] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      const [rows, note] = await Promise.all([
        window.zhixing.db.noteRevisions(noteId),
        window.zhixing.db.note(noteId),
      ])
      if (!alive) return
      setRevs(rows)
      setPreview(rows[0] ?? null)
      setCurrentContent(note?.content_md ?? '')
    })()
    return () => {
      alive = false
    }
  }, [noteId])

  useEffect(() => {
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  const diffLines =
    preview == null
      ? []
      : (preview.content_md ?? '') === currentContent
        ? []
        : unifiedDiff(preview.content_md ?? '', currentContent)

  const sameAsCurrent = preview != null && (preview.content_md ?? '') === currentContent

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
            {preview == null ? (
              <p className="u-aux">选择左侧版本查看 diff 预览。</p>
            ) : sameAsCurrent ? (
              <p className="u-aux">（该版本与当前内容一致）</p>
            ) : (
              <pre className="history__diff">
                {diffLines.map((l, i) => (
                  <div key={i} className={`history__diff-line history__diff-line--${l.kind}`}>
                    {l.kind === 'ctx'
                      ? ' ' + l.text
                      : l.kind === 'add'
                        ? '+' + l.text
                        : l.kind === 'del'
                          ? '-' + l.text
                          : l.text}
                  </div>
                ))}
              </pre>
            )}
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
            disabled={!preview || busy}
            onClick={async () => {
              if (!preview || busy) return
              // 回滚二次确认（W21）：误点即毁掉当前内容，必须先确认
              const confirmed = await dialog.confirm({
                title: '回滚到该版本',
                message: '当前内容会先另存一份快照，然后被这个历史版本覆盖。确定回滚？',
                icon: <Undo2 size={15} />,
                tone: 'warning',
                confirmText: '回滚',
              })
              if (!confirmed) return
              setBusy(true)
              void (async () => {
                try {
                  await window.zhixing.db.restoreNoteRevision(noteId, preview.id)
                  await onRestored()
                  onClose()
                } finally {
                  setBusy(false)
                }
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
