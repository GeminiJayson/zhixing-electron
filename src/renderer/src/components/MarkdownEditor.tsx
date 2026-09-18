import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  placeholder as cmPlaceholder,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { autocompletion, closeBrackets, completionKeymap } from '@codemirror/autocomplete'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

interface Props {
  value: string
  onChange: (value: string) => void
  /** `[[` 补全的候选：全部笔记标题 */
  titles: string[]
  /** 实例就绪后交回 EditorView，供外部做查找定位 */
  onReady?: (view: EditorView) => void
  placeholder?: string
}

/** 语法高亮配色取自设计令牌，避免与主题脱节。 */
const mdHighlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--accent)', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--accent)' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', color: 'var(--accent-solid)' },
  { tag: tags.quote, color: 'var(--fg-secondary)', fontStyle: 'italic' },
  { tag: tags.list, color: 'var(--fg-primary)' },
])

const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent' },
  '.cm-scroller': {
    fontFamily: 'var(--font-ui)',
    lineHeight: '1.75',
    overflow: 'auto',
  },
  '.cm-content': { padding: 'var(--space-4)', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-soft)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-tooltip': {
    background: 'var(--bg-layer-solid)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius-md)',
    boxShadow: '0 12px 32px rgb(0 0 0 / 24%)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    background: 'var(--accent-soft)',
    color: 'var(--accent)',
  },
})

/**
 * CodeMirror 6 版 Markdown 编辑器（O9）：
 * 语法高亮 + `[[标题]]` 补全 + 撤销栈 + 括号配对。
 * 补全候选通过 ref 读取，标题变化时无需重建编辑器（避免丢焦点与光标）。
 */
export function MarkdownEditor({ value, onChange, titles, placeholder, onReady }: Props) {
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const titlesRef = useRef<string[]>(titles)
  const onChangeRef = useRef(onChange)
  titlesRef.current = titles
  onChangeRef.current = onChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    /** 输入 `[[` 后按前缀过滤笔记标题（对齐 Python 的链接补全语义）。 */
    const wikiCompletion = autocompletion({
      override: [
        (ctx) => {
          const before = ctx.matchBefore(/\[\[[^\]]*$/)
          if (!before) return null
          if (before.from === before.to && !ctx.explicit) return null
          const word = before.text.slice(2)
          const options = titlesRef.current
            .filter((t) => t.toLowerCase().includes(word.toLowerCase()))
            .slice(0, 20)
            .map((t) => ({ label: t, type: 'text' as const }))
          return { from: before.from + 2, options, validFor: /^[^\]]*$/ }
        },
      ],
      activateOnTyping: true,
    })

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          closeBrackets(),
          markdown(),
          syntaxHighlighting(mdHighlight),
          wikiCompletion,
          cmPlaceholder(placeholder ?? ''),
          editorTheme,
          EditorView.lineWrapping,
          keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString())
          }),
        ],
      }),
    })
    viewRef.current = view
    onReadyRef.current?.(view)
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 只在挂载时建实例；正文通过下面的 effect 同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 外部改正文（切笔记、回滚版本）时替换文档内容，且不触发 onChange 回环
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return <div className="md-editor" ref={hostRef} />
}
