import { useEffect, useRef, useState } from 'react'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import type { Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  placeholder as cmPlaceholder,
} from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
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
  /**
   * 选中一段文字后右键：「关联到任务」。
   * 只把「选中的文字 + 它的指纹 + 鼠标位置」交上去，具体关联关系由上层决定。
   */
  onAttachTask?: (info: { text: string; blockKey: string; x: number; y: number }) => void
  placeholder?: string
  /** 查找词：正文里全部命中高亮 */
  highlight?: string
  /** 右键「转为任务」/「转为任务并关联段落」 */
  onCreateTask?: (text: string, blockKey: string | null) => void
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
  // 横向内边距为 0：正文与标题、元信息行共处纸面的同一条左边缘
  // （这里再留 16px 就会让 Markdown 正文比标题右缩一格，与富文本 / 预览形态不一致）
  // 上内边距取 8px 与富文本对齐：工具栏下面那一截空当由 .sheet__body 的 4px + 这里 8px 组成，
  // 原来是 16px，正文首行离工具栏三十多像素。
  '.cm-content': { padding: 'var(--space-2) 0 var(--space-4)', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-soft)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  // 查找词的全部命中高亮
  '.cm-find-hit': { backgroundColor: 'var(--accent-soft)', borderBottom: '1px solid var(--accent)' },
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

// ---------------------------------------------------------------- 查找高亮

const setFindText = StateEffect.define<string>()

function buildFindDecorations(doc: string, needle: string): DecorationSet {
  if (!needle) return Decoration.none
  const ranges: Range<Decoration>[] = []
  let i = doc.indexOf(needle)
  while (i >= 0) {
    ranges.push(Decoration.mark({ class: 'cm-find-hit' }).range(i, i + needle.length))
    i = doc.indexOf(needle, i + needle.length)
  }
  return Decoration.set(ranges)
}

interface FindState {
  needle: string
  deco: DecorationSet
}

const findField = StateField.define<FindState>({
  create: () => ({ needle: '', deco: Decoration.none }),
  update(value, tr) {
    let needle = value.needle
    for (const e of tr.effects) if (e.is(setFindText)) needle = e.value
    if (!needle) return { needle, deco: Decoration.none }
    if (tr.docChanged || needle !== value.needle) {
      return { needle, deco: buildFindDecorations(tr.state.doc.toString(), needle) }
    }
    return { needle, deco: value.deco.map(tr.changes) }
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
})

// ---------------------------------------------------------------- 段落定位锚

/** 纯 JS SHA-1。 */
function sha1Hex(input: string): string {
  const utf8 = Array.from(new TextEncoder().encode(input))
  const ml = utf8.length
  const withOne = utf8.concat(0x80)
  while (withOne.length % 64 !== 56) withOne.push(0)
  const hi = Math.floor((ml * 8) / 0x100000000)
  const lo = (ml * 8) >>> 0
  withOne.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff)
  withOne.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff)
  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const rol = (n: number, s: number): number => ((n << s) | (n >>> (32 - s))) >>> 0
  for (let i = 0; i < withOne.length; i += 64) {
    const w = new Array<number>(80)
    for (let j = 0; j < 16; j++) {
      w[j] =
        (withOne[i + j * 4] << 24) |
        (withOne[i + j * 4 + 1] << 16) |
        (withOne[i + j * 4 + 2] << 8) |
        withOne[i + j * 4 + 3]
    }
    for (let j = 16; j < 80; j++) w[j] = rol(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1)
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4]
    for (let j = 0; j < 80; j++) {
      let f: number
      let k: number
      if (j < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (j < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (j < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const tmp = (rol(a, 5) + (f >>> 0) + e + k + (w[j] >>> 0)) >>> 0
      e = d
      d = c
      c = rol(b, 30)
      b = a
      a = tmp
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }
  return [h0, h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, '0')).join('')
}

/**
 * 段落定位键：
 * 空白折叠 + 去首尾 + 小写后取 sha1 前 12 位，前缀 `fp:`。
 * 用 task_note_context 表定位，键必须逐字一致才能互相定位。
 */
export function blockFingerprint(text: string, length = 12): string {
  const norm = text.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!norm) return ''
  return 'fp:' + sha1Hex(norm).slice(0, length)
}

/** 按 block_key 在编辑器里定位并滚动到该段。 */
export function locateBlockInView(view: EditorView, blockKey: string): boolean {
  if (!blockKey) return false
  const prefix = blockKey.replace(/^fp:/, '').toLowerCase()
  if (!prefix) return false
  const doc = view.state.doc.toString()
  let pos = 0
  for (const line of doc.split('\n')) {
    const norm = line.replace(/\s+/g, ' ').trim().toLowerCase()
    if (norm && sha1Hex(norm).startsWith(prefix)) {
      view.dispatch({ selection: { anchor: pos, head: pos + line.length }, scrollIntoView: true })
      view.dispatch({ effects: setFindText.of(line.trim().slice(0, 40)) })
      view.focus()
      window.setTimeout(() => view.dispatch({ effects: setFindText.of('') }), 1400)
      return true
    }
    pos += line.length + 1
  }
  return false
}

/**
 * CodeMirror 6 版 Markdown 编辑器：
 * 语法高亮 + `[[标题]]` 补全 + 撤销栈 + 括号配对 + 查找全命中高亮 + 右键转任务。
 * 补全候选通过 ref 读取，标题变化时无需重建编辑器（避免丢焦点与光标）。
 */
export function MarkdownEditor({
  value,
  onChange,
  titles,
  placeholder,
  onReady,
  onAttachTask,
  highlight = '',
  onCreateTask,
}: Props) {
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const titlesRef = useRef<string[]>(titles)
  const onChangeRef = useRef(onChange)
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null)
  titlesRef.current = titles
  onChangeRef.current = onChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    /** 输入 `[[` 后按前缀过滤笔记标题。 */
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
          findField,
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

    // 右键只由下面那一个 React onContextMenu 处理。
    // 这里原先另挂了一份原生 contextmenu 监听来做「关联任务」，同一次右键会**两个菜单同时弹**
    // （事件从 view.dom 冒泡到外层 div，两边各自 preventDefault + 各自开面板，位置完全重叠）。
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

  // 查找词变化时重算全部命中高亮
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setFindText.of(highlight) })
  }, [highlight])

  return (
    <div
      className="md-editor"
      ref={hostRef}
      onContextMenu={(e) => {
        const view = viewRef.current
        const sel = view ? view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) : ''
        // 唯一的右键入口：只要有一个回调可用就开菜单，两个回调都缺就交回原生菜单
        if (!sel.trim() || (!onCreateTask && !onAttachTask)) return
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY, text: sel })
      }}
    >
      {menu && (onCreateTask || onAttachTask) && (
        <div
          className="popmenu"
          style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 50 }}
          role="menu"
        >
          {onCreateTask && (
            <button
              className="popmenu__item"
              role="menuitem"
              onClick={() => {
                onCreateTask(menu.text, null)
                setMenu(null)
              }}
            >
              <span className="popmenu__tick" />
              转为任务
            </button>
          )}
          {onCreateTask && (
            <button
              className="popmenu__item"
              role="menuitem"
              onClick={() => {
                // 定位键取选中文本首行的指纹
                onCreateTask(menu.text, blockFingerprint(menu.text.split('\n')[0]))
                setMenu(null)
              }}
            >
              <span className="popmenu__tick" />
              转为任务并关联段落
            </button>
          )}
          {/* 「关联到已有任务」原先是另一份原生监听弹出的第二个菜单，现在并入这里 */}
          {onAttachTask && (
            <button
              className="popmenu__item"
              role="menuitem"
              onClick={() => {
                onAttachTask({
                  text: menu.text,
                  blockKey: blockFingerprint(menu.text),
                  x: menu.x,
                  y: menu.y,
                })
                setMenu(null)
              }}
            >
              <span className="popmenu__tick" />
              关联到已有任务…
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 富文本编辑器

export { RichTextEditor } from './RichTextEditor'
