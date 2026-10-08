import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Note, NoteFolder } from '@shared/types'
import { NOTE_FORMATS, noteIcon } from './NoteTree'
import { Search } from '@renderer/lib/icons'
import { placeAnchored } from '@renderer/lib/anchored-position'

interface Props {
  notes: Note[]
  folders: NoteFolder[]
  /** 当前选中的笔记 id（字符串，与调用方的 pickNote 一致） */
  value: string
  /** 触发按钮的位置：弹层贴在它下面 */
  anchor: DOMRect | null
  onPick: (noteId: string) => void
  onClose: () => void
}

/** 文件夹名查表用（含"未分类"） */
const ROOT_LABEL = '未分类'

/**
 * 笔记选择器：带**类型图标**与**文件夹层级**的弹层。
 *
 * 为什么不用原生 <select>：<option> 里放不下图标，也做不出缩进 ——
 * 而用户反馈的正是"不知道选的是哪个类型"，平铺一列标题解决不了这个。
 *
 * 层级按**文件夹分组**展示（不是可折叠树）：这里的使用场景是"快速找到某一篇"，
 * 折叠起来反而要多点一次；每个文件夹一行小标题 + 它下面的笔记缩进一格，
 * 扫一眼就知道某篇在哪儿。顶部给一个过滤框，笔记多的时候直接搜标题。
 */
export function NotePicker({ notes, folders, value, anchor, onPick, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  /**
   * 挂载点下的文件也出现在这里（虚拟负数 id）。
   *
   * 它们是**外部文件**、内容不入库，但用户要的就是「和选普通笔记一样选它」——
   * 所以这里把它们伪装成 Note 参与同一套分组/图标/搜索，选中时再懒建成真实引用行
   *（见 handlePick）：调用方因此完全不用知道虚拟节点的存在。
   */
  const [mountFiles, setMountFiles] = useState<
    { nodeId: number; folderId: number; relPath: string; name: string; isDir: boolean }[]
  >([])
  useEffect(() => {
    void window.zhixing.db.mountPickerItems().then(setMountFiles)
  }, [])
  /** 真笔记 + 挂载文件（后者 folder_id 指向挂载点，于是分组到那个文件夹下） */
  const allNotes = useMemo(() => {
    const fake = mountFiles
      .filter((m) => !m.isDir)
      .map(
        (m) =>
          ({
            id: m.nodeId,
            folder_id: m.folderId,
            title: m.relPath,
            format: 'mount',
            content_md: '',
            pinned: 0,
            word_count: 0,
            created_at: '',
            updated_at: '',
          }) as unknown as Note
      )
    return fake.length ? [...notes, ...fake] : notes
  }, [notes, mountFiles])
  /** 选中：负数 id 是挂载文件 → 先懒建引用行再交真 id；否则原样 */
  const handlePick = async (idStr: string): Promise<void> => {
    const n = Number(idStr)
    if (n < 0) {
      const real = await window.zhixing.db.ensureMountNoteByNode(n)
      if (real) onPick(String(real))
      return
    }
    onPick(idStr)
  }

  /** 分组：先"未分类"，再每个文件夹（按名字），空文件夹不显示 */
  const groups = useMemo(() => {
    const kw = q.trim().toLowerCase()
    const match = (n: Note): boolean => !kw || n.title.toLowerCase().includes(kw)
    const byFolder = new Map<number | null, Note[]>()
    for (const n of allNotes) {
      if (!match(n)) continue
      const key = n.folder_id ?? null
      const list = byFolder.get(key)
      if (list) list.push(n)
      else byFolder.set(key, [n])
    }
    const out: { id: number | null; label: string; notes: Note[] }[] = []
    const root = byFolder.get(null)
    // 搜索时"未分类"这个空标题没有意义，只显示有内容的组
    if (root?.length) out.push({ id: null, label: ROOT_LABEL, notes: root })
    for (const f of folders) {
      const list = byFolder.get(f.id)
      if (list?.length) out.push({ id: f.id, label: f.name, notes: list })
    }
    // 文件夹里的笔记按标题排，便于扫
    for (const g of out) g.notes.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
    return out
  }, [allNotes, folders, q])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // 与其它锚定弹层同一套摆放规则（下方放不下翻到上方、右侧放不下往左收）
    if (anchor) placeAnchored(el, anchor)
    el.querySelector('input')?.focus()
  }, [anchor])

  useEffect(() => {
    const onDocDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    /**
     * **必须在捕获阶段监听。**
     *
     * 这个选择器被用在任务编辑弹窗里，而那个弹窗的遮罩上有
     * onMouseDown={e => e.stopPropagation()}（Dialogs.tsx）—— 冒泡被掐断，
     * 挂在 document 上的普通监听永远收不到点击，于是弹层点外面也不消失。
     * 捕获阶段先于冒泡，不受它影响。
     */
    document.addEventListener('mousedown', onDocDown, true)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocDown, true)
      document.removeEventListener('keydown', onEsc)
    }
  }, [onClose])

  const total = groups.reduce((n, g) => n + g.notes.length, 0)

  /**
   * **必须用 Portal 挂到 body。**
   *
   * 这个弹层是 position: fixed，但它会被用在任务编辑弹窗里 —— 而那个弹窗有
   * `backdrop-filter`。backdrop-filter 与 transform 一样会创建 containing block，
   * 于是 fixed 不再相对视口，而是相对弹窗定位：既被弹窗边界裁掉（显示不全），
   * 又因为参与了弹窗的布局把它撑大。
   *
   * 挂到 body 之后就脱离了那个 containing block，placeAnchored 的视口坐标
   * 也才重新成立。
   */
  return createPortal(
    <div className="popmenu note-picker" ref={ref} role="listbox" aria-label="选择笔记">
      <div className="note-picker__search">
        <Search size={13} aria-hidden />
        <input
          className="note-picker__input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索标题…"
          aria-label="搜索笔记标题"
        />
      </div>
      <div className="note-picker__list">
        {total === 0 ? (
          <p className="u-aux note-picker__empty">{notes.length === 0 ? '还没有笔记。' : '没有匹配的标题。'}</p>
        ) : (
          groups.map((g) => (
            <div key={g.id ?? 'root'} className="note-picker__group">
              <div className="note-picker__group-head">
                {g.label}
                <span className="note-picker__count">{g.notes.length}</span>
              </div>
              {g.notes.map((n) => {
                const { Comp, tone } = noteIcon(n.format)
                return (
                  <button
                    key={n.id}
                    type="button"
                    role="option"
                    aria-selected={String(n.id) === value}
                    className={'note-picker__item' + (String(n.id) === value ? ' note-picker__item--on' : '')}
                    title={`${n.title}（${NOTE_FORMATS.find((f) => f.key === n.format)?.label ?? n.format}）`}
                    onClick={() => void handlePick(String(n.id))}
                  >
                    {/* 图标按格式着色：与笔记树、编辑区标题行的那套映射是同一份 */}
                    <Comp size={13} className={'ntree__type--' + tone} aria-hidden />
                    <span className="note-picker__title">{n.title}</span>
                  </button>
                )
              })}
            </div>
          ))
        )}
      </div>
    </div>,
    document.body
  )
}
