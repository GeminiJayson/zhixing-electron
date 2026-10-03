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
import { closeBrackets, completionKeymap } from '@codemirror/autocomplete'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

/**
 * 交给宿主的编辑器句柄。
 *
 * 只暴露宿主真正要用的两个能力 —— 补全选中后需要「按坐标定位弹层」与
 * 「替换掉光标前那半截输入」。不要直接把整个 EditorView 交出去：
 * 那等于把整个 CodeMirror 的 API 面变成模块的公开契约。
 */
export interface MarkdownEditorHandle {
  coordsAtPos: (pos: number) => { left: number; top: number; bottom: number }
  replaceRange: (from: number, to: number, insert: string) => void
}

interface Props {
  value: string
  onChange: (value: string) => void
  /** 笔记标题（保留：别处仍在用） */
  titles: string[]
  /**
   * 输入双方括号时把「位置 + 已输入前缀」交给宿主，由宿主打开笔记选择器。
   *
   * 原先是 CodeMirror 自带的 autocompletion 下拉，只有纯标题、没有文件夹层级。
   * 现在改用与信息区正向引用同一个选择器（带层级、带类型图标、同一套摆放规则）。
   * 编辑器只负责「在哪一段上补」，选什么、怎么展示由宿主决定。
   */
  onLinkPick?: (info: { from: number; to: number; query: string }) => void
  /**
   * 补全需要的两个能力（定位弹层 / 替换那半截输入）。
   *
   * 单独一个回调而不是复用 onReady —— 后者交的是完整的 EditorView，
   * locateBlockInView 等地方要靠它；把公开契约放大到整个 CodeMirror API 面
   * 只为了两个方法，代价太大。
   */
  onHandle?: (h: MarkdownEditorHandle) => void
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

/**
 * 指纹实现已搬到 lib/block-fingerprint.ts —— 任务编辑器也要用它把段落列出来，
 * 两边必须逐字一致，否则"列表里算出来的键"和"这里扫描时算出来的键"对不上，
 * 表现就是"关联上了却跳不过去"。
 */
import { blockFingerprint, sha1Hex } from '@renderer/lib/block-fingerprint'
// 旧引用点（NotesPage 从本文件取 blockFingerprint）继续可用
export { blockFingerprint }

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
  onLinkPick,
  placeholder,
  onReady,
  onHandle,
  onAttachTask,
  highlight = '',
  onCreateTask,
}: Props) {
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const onHandleRef = useRef(onHandle)
  onHandleRef.current = onHandle
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const titlesRef = useRef<string[]>(titles)
  const onLinkPickRef = useRef(onLinkPick)
  onLinkPickRef.current = onLinkPick
  const onChangeRef = useRef(onChange)
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null)
  titlesRef.current = titles
  onChangeRef.current = onChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return


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
          cmPlaceholder(placeholder ?? ''),
          editorTheme,
          findField,
          EditorView.lineWrapping,
          keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString())
            /*
              输入双方括号后，把位置与已输入前缀交给宿主。
              只在文档变化时判定，且只在光标紧跟在一段未闭合的双方括号之后触发 ——
              否则光标移到别处也会反复弹选择器。
            */
            if (!u.docChanged) return
            const pick = onLinkPickRef.current
            if (!pick) return
            const sel = u.state.selection.main
            if (!sel.empty) return
            const before = u.state.sliceDoc(Math.max(0, sel.head - 200), sel.head)
            const m = /\[\[([^\]]*)$/.exec(before)
            if (!m) return
            pick({ from: sel.head - m[0].length, to: sel.head, query: m[1] })
          }),
        ],
      }),
    })
    viewRef.current = view
    const handle: MarkdownEditorHandle = {
      coordsAtPos: (pos: number) => {
        // coordsAtPos 在位置已滚出视口时会返回 null —— 退到编辑器顶端，
        // 让弹层至少贴着一个合理的位置，而不是抛错
        const c = view.coordsAtPos(pos)
        if (!c) {
          const box = view.dom.getBoundingClientRect()
          return { left: box.left, top: box.top, bottom: box.top + 20 }
        }
        return { left: c.left, top: c.top, bottom: c.bottom }
      },
      replaceRange: (from: number, to: number, insert: string) => {
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
        })
      },
    }
    onReadyRef.current?.(view)
    onHandleRef.current?.(handle)

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
