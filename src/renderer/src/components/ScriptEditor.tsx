import { useRef } from 'react'
import { CheckCircle2, CircleAlert } from '@renderer/lib/icons'
import type { ScriptProblem } from '@shared/user-scripts'

interface Props {
  /** 脚本笔记的 id */
  noteId: number
  value: string
  onChange: (v: string) => void
  /** 最近一次语法校验的结果（页面统一跑一次，标题栏的胶囊用的是同一份） */
  problems: ScriptProblem[]
  checking: boolean
}

/**
 * 脚本笔记的**正文编辑器**。
 *
 * 它只负责正文：标题栏、工具栏、底部信息区都由 NotesPage 提供 —— 与 markdown / 富文本 /
 * Word / Excel 那几种正文是同一个位置、同一套外壳。脚本不是"另一种页面"，是笔记的一种格式。
 *
 * 校验由页面统一发起（避免"编辑器跑一次、标题栏再跑一次"两条时间线），
 * 这里只负责把结果显示出来、并支持点一条跳到那一行。
 */
export function ScriptEditor({ noteId, value, onChange, problems, checking }: Props): React.JSX.Element {
  const gutterRef = useRef<HTMLDivElement>(null)
  const codeRef = useRef<HTMLTextAreaElement>(null)
  const failed = !checking && problems.length > 0

  /** 点问题：把光标放到那一行并选中它 */
  const gotoLine = (line: number): void => {
    const ta = codeRef.current
    if (!ta || line <= 0) return
    const lines = value.split('\n')
    let offset = 0
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) offset += lines[i].length + 1
    ta.focus()
    ta.setSelectionRange(offset, offset + (lines[line - 1]?.length ?? 0))
    const lineHeight = ta.scrollHeight / Math.max(1, lines.length)
    ta.scrollTop = Math.max(0, (line - 1) * lineHeight - ta.clientHeight / 3)
  }

  return (
    <div className="scripted" data-note={noteId}>
      <div className="scripted__edit">
        <div className="scripted__gutter" ref={gutterRef} aria-hidden>
          {Array.from({ length: value.split('\n').length }, (_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <textarea
          ref={codeRef}
          className="scripted__code"
          value={value}
          spellCheck={false}
          aria-label="脚本正文"
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => {
            if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop
          }}
        />
      </div>

      <div className={'scripted__status' + (failed ? ' is-bad' : !checking && !failed ? ' is-ok' : '')}>
        {checking ? (
          '正在检查语法…'
        ) : failed ? (
          <>
            <CircleAlert size={13} aria-hidden /> {problems.length} 处问题：
            {problems.slice(0, 4).map((p, i) => (
              <button
                key={i}
                className="scripted__problem"
                title={p.line > 0 ? '跳到第 ' + p.line + ' 行' : p.message}
                onClick={() => gotoLine(p.line)}
              >
                {p.line > 0 ? p.line + ': ' : ''}
                {p.message}
              </button>
            ))}
          </>
        ) : (
          <>
            <CheckCircle2 size={13} aria-hidden /> 语法检查通过（只解析，不执行）
          </>
        )}
      </div>
    </div>
  )
}
