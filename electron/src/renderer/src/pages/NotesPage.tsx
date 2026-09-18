import type { EditorView } from '@codemirror/view'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Eye, Link2, Pencil, Plus } from 'lucide-react'
import { subscribeDomain } from '@shared/events'
import { useDialog } from '../components/Dialogs'
import type { Backlink, Note, NoteFolder, NoteLink } from '@shared/types'
import { t } from '../i18n'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { MarkdownView } from '../components/MarkdownView'
import { NoteHistory } from '../components/NoteHistory'
import { NoteTree } from '../components/NoteTree'
import { PopMenu } from '../components/PopMenu'

interface Props {
  onNotice: (message: string) => void
  /** 由其他页面（如图谱）跳转过来时要打开的笔记 */
  initialNoteId?: number | null
}

/** 自动保存防抖：与 markdown_editor 的自动保存节奏对齐，输入停顿后落库。 */
const AUTOSAVE_MS = 800

export function NotesPage({ onNotice, initialNoteId = null }: Props) {
  const dialog = useDialog()
  const [notes, setNotes] = useState<Note[]>([])
  const [folders, setFolders] = useState<NoteFolder[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [current, setCurrent] = useState<Note | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [preview, setPreview] = useState(false)
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const [outLinks, setOutLinks] = useState<NoteLink[]>([])
  const [linksOpen, setLinksOpen] = useState(true)
  const [dirty, setDirty] = useState(false)
  /** 新建笔记时使用的格式 */
  const [createFormat, setCreateFormat] = useState<string>('markdown')
  const [historyId, setHistoryId] = useState<number | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  const [templateMenu, setTemplateMenu] = useState<{ x: number; y: number } | null>(null)
  const [templates, setTemplates] = useState<string[]>([])
  const [panel, setPanel] = useState<{ kind: 'orphan' | 'broken'; x: number; y: number } | null>(null)
  /** 查找替换（Ctrl/Cmd+F 打开） */
  /** Office 笔记的内嵌预览（O11）：解析结果由主进程给出 */
  const [office, setOffice] = useState<{ kind: string; html: string; message: string } | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  /** CodeMirror 实例：查找定位要走它的 selection API */
  const viewRef = useRef<EditorView | null>(null)
  const [panelItems, setPanelItems] = useState<{ key: string; label: string; id: number }[]>([])
  const timer = useRef<number | null>(null)

  const load = useCallback(async () => {
    const [rows, fs] = await Promise.all([window.zhixing.db.notes(), window.zhixing.db.noteFolders()])
    setNotes(rows)
    setFolders(fs)
  }, [])

  useEffect(() => {
    void load()
    void window.zhixing.db.noteTemplates().then(setTemplates)
  }, [load])


  // 跨页跳转：带着笔记 id 进来时直接选中它
  useEffect(() => {
    if (initialNoteId != null) setSelectedId(initialNoteId)
  }, [initialNoteId])

  // 打开笔记：装载正文、出链与反链
  useEffect(() => {
    if (selectedId == null) {
      setCurrent(null)
      setTitle('')
      setContent('')
      setBacklinks([])
      setOutLinks([])
      setDirty(false)
      return
    }
    let alive = true
    void (async () => {
      const [note, back, out] = await Promise.all([
        window.zhixing.db.note(selectedId),
        window.zhixing.db.backlinks(selectedId),
        window.zhixing.db.outLinks(selectedId),
      ])
      if (!alive || !note) return
      setCurrent(note)
      setTitle(note.title)
      setContent(note.content_md ?? '')
      setBacklinks(back)
      setOutLinks(out)
      setDirty(false)
    })()
    return () => {
      alive = false
    }
  }, [selectedId])

  // Office 笔记：选中时按需解析一次（解析在主进程，只读内容，不写库）
  useEffect(() => {
    if (!current || (current.format !== 'word' && current.format !== 'excel')) {
      setOffice(null)
      return
    }
    let alive = true
    void window.zhixing.db.previewNote(current.id).then((res) => {
      if (alive) setOffice(res)
    })
    return () => {
      alive = false
    }
  }, [current])

  // 别的页面改了笔记（新建/删除/改标题）会影响反链；这里只更新反链列表，
  // 不重载正文 —— 当前笔记可能正在编辑，整篇重载会覆盖输入（O3）。
  useEffect(() => {
    if (selectedId == null) return
    return subscribeDomain(['note'], () => {
      void window.zhixing.db.backlinks(selectedId).then(setBacklinks)
    })
  }, [selectedId])

  /** 已解析标题表：驱动 [[标题]] 的链接化（未命中的即悬空）。 */
  const resolved = useMemo(() => new Map(notes.map((n) => [n.title, n.id])), [notes])

  const persist = useCallback(
    async (id: number, fields: { title?: string; content_md?: string }) => {
      const saved = await window.zhixing.db.saveNote(id, fields)
      if (!saved) return
      setCurrent(saved)
      setNotes((prev) => prev.map((n) => (n.id === saved.id ? saved : n)))
      setDirty(false)
    },
    []
  )

  /**
   * 切换笔记前，把还在防抖窗口里的编辑立刻落盘。
   *
   * 装载 effect 会把 dirty 重置为 false，自动保存 effect 随即清掉排队中的定时器
   * （NotesPage.tsx 自动保存 effect 的 cleanup），于是切换前 <800ms 的输入会被
   * 静默丢弃。Python 侧由 note_page._commit_current_editor 兜底，这里补齐。
   */
  const flushPending = useCallback(async (): Promise<void> => {
    if (!current || !dirty) return
    if (timer.current) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    await persist(current.id, { title, content_md: content })
  }, [current, dirty, persist, title, content])

  /** 所有「切换笔记」的入口都走这里：先落盘，再切换。 */
  const selectNote = useCallback(
    async (id: number | null): Promise<void> => {
      await flushPending()
      setSelectedId(id)
    },
    [flushPending]
  )

  // Ctrl/Cmd+S 立即保存（不必等自动保存的 800ms 防抖）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFindOpen(true)
        return
      }
      if (!mod || e.key.toLowerCase() !== 's') return
      e.preventDefault()
      if (!current) return
      void persist(current.id, { title, content_md: content }).then(async () => {
        setOutLinks(await window.zhixing.db.outLinks(current.id))
        onNotice('已保存')
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, title, content, persist, onNotice])
  // 自动保存
  useEffect(() => {
    if (!current || !dirty) return
    if (timer.current) window.clearTimeout(timer.current)
    const id = current.id
    timer.current = window.setTimeout(() => {
      void persist(id, { title, content_md: content }).then(async () => {
        setOutLinks(await window.zhixing.db.outLinks(id))
      })
    }, AUTOSAVE_MS)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [title, content, current, dirty, persist])

  /** 在正文里找下一个匹配并选中（textarea 用 selection 表达命中）。 */
  const findNext = useCallback((): void => {
    const view = viewRef.current
    const needle = findText
    if (!view || !needle) return
    const doc = view.state.doc.toString()
    const pos = view.state.selection.main.to
    let idx = doc.indexOf(needle, pos)
    if (idx < 0) idx = doc.indexOf(needle) // 到尾部后回到开头
    if (idx < 0) {
      onNotice('没有匹配项')
      return
    }
    view.dispatch({
      selection: { anchor: idx, head: idx + needle.length },
      scrollIntoView: true,
    })
    view.focus()
  }, [findText, onNotice])

  const replaceAll = useCallback((): void => {
    if (!findText) return
    const count = content.split(findText).length - 1
    if (count === 0) {
      onNotice('没有匹配项')
      return
    }
    setContent(content.split(findText).join(replaceText))
    setDirty(true)
    onNotice(`已替换 ${count} 处`)
  }, [content, findText, replaceText, onNotice])

  /** 新建笔记的格式（对齐 NOTE_FORMATS 的五种：Markdown / 富文本 / Word / Excel / 链接）。 */
  const handleCreateNote = useCallback(
    async (folderId: number | null): Promise<void> => {
      await flushPending()
      const n = await window.zhixing.db.createNote('未命名笔记', folderId, '', createFormat)
      if (!n) return
      await load()
      setSelectedId(n.id)
    },
    [flushPending, createFormat, load]
  )

  // 应用内快捷键由 App 统一监听，页面只负责自己的动作（对齐 note_page 的 toggle_preview / 查找）
  useEffect(() => {
    const onNew = (): void => void handleCreateNote(null)
    const onPreview = (): void => setPreview((p) => !p)
    const onFind = (): void => setFindOpen(true)
    window.addEventListener('zhixing:new-note', onNew)
    window.addEventListener('zhixing:toggle-preview', onPreview)
    window.addEventListener('zhixing:find', onFind)
    return () => {
      window.removeEventListener('zhixing:new-note', onNew)
      window.removeEventListener('zhixing:toggle-preview', onPreview)
      window.removeEventListener('zhixing:find', onFind)
    }
  }, [handleCreateNote])

  /** 点击悬空 [[标题]]：按标题新建并绑定该引用（对齐 materialize_dangling）。 */
  const handleCreateFromLink = async (linkTitle: string): Promise<void> => {
    if (selectedId == null) return
    const dst = await window.zhixing.db.materializeDangling(selectedId, linkTitle)
    if (dst == null) return
    onNotice(`已创建并绑定「${linkTitle}」`)
    await load()
    setOutLinks(await window.zhixing.db.outLinks(selectedId))
    await selectNote(dst)
  }

  const handleCreateFolder = async (): Promise<void> => {
    const name = await dialog.prompt({ title: '新建文件夹', label: '文件夹名称' })
    if (!name?.trim()) return
    await window.zhixing.db.createNoteFolder(name, null)
    await load()
  }

  const handleTogglePin = async (id: number, pinned: boolean): Promise<void> => {
    await window.zhixing.db.saveNote(id, { pinned })
    await load()
  }

  const handleDelete = async (id: number): Promise<void> => {
    const note = notes.find((n) => n.id === id)
    if (!note) return
    if (!window.confirm(`删除笔记「${note.title}」？\n（软删除，可在回收站恢复）`)) return
    await window.zhixing.db.deleteNote(id)
    if (selectedId === id) setSelectedId(null)
    await load()
    onNotice('已删除（可在回收站恢复）')
  }

  const dangling = outLinks.filter((l) => l.dst_note_id == null)

  return (
    <div className="page page--notes">
      <div className="page__head">
        <h1 className="page__title">{t('page.notes')}</h1>
        <p className="page__subtitle">{t('page.notes.sub')}</p>
      </div>
      <div className="page__body">
      <div className="notes-wrap">
        <NoteTree
          notes={notes}
          folders={folders}
          selectedId={selectedId}
          onSelect={(id) => void selectNote(id)}
          onCreateNote={handleCreateNote}
          createFormat={createFormat}
          onCreateFormatChange={setCreateFormat}
          onCreateFolder={handleCreateFolder}
          onTogglePin={(id, pinned) => void handleTogglePin(id, pinned)}
          onDeleteNote={(id) => void handleDelete(id)}
          onContextMenuNote={(id, x, y) => setCtxMenu({ id, x, y })}
        />

        {/* 编辑区与链接面板纵向排列：链接面板从右侧栏挪到了编辑区下方 */}
        <div className="notes-main">
        <div className="editor">
          {current ? (
            <>
              <div className="editor__bar">
                <input
                  className="editor__title"
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value)
                    setDirty(true)
                  }}
                  aria-label="笔记标题"
                />
                <span className="u-aux">{dirty ? '未保存…' : '已保存'}</span>
                <button
                  className="text-btn"
                  aria-pressed={preview}
                  onClick={() => setPreview((v) => !v)}
                >
                  {preview ? <Pencil size={13} /> : <Eye size={13} />}
                  {preview ? '编辑' : '预览'}
                </button>
                <button
                  className="text-btn"
                  aria-pressed={linksOpen}
                  onClick={() => setLinksOpen((v) => !v)}
                >
                  <Link2 size={13} /> 链接
                </button>
                <button
                  className="text-btn"
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setTemplateMenu({ x: r.left, y: r.bottom + 4 })
                  }}
                >
                  <Plus size={13} /> 模板
                </button>
                <button
                  className="text-btn"
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    void (async () => {
                      const rows = await window.zhixing.db.orphanNotes()
                      setPanelItems(rows.map((n) => ({ key: `o-${n.id}`, label: n.title, id: n.id })))
                      setPanel({ kind: 'orphan', x: r.left, y: r.bottom + 4 })
                    })()
                  }}
                >
                  孤儿 {''}
                </button>
                <button
                  className="text-btn"
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    void (async () => {
                      const rows = await window.zhixing.db.brokenLinks()
                      setPanelItems(
                        rows.map((b, i) => ({
                          key: `b-${i}`,
                          label: `${b.src_title} → [[${b.dst_title}]]`,
                          id: b.src_note_id,
                        }))
                      )
                      setPanel({ kind: 'broken', x: r.left, y: r.bottom + 4 })
                    })()
                  }}
                >
                  失效链接
                </button>
              </div>

              {current.format === 'link' ? (
                // 链接笔记：content_md 存 URL，或存 Python 版写的 [{title,target}] JSON 数组。
                // 此前它落进 Office 预览分支，于是把 URL 当成文件路径去解析并报「关联文件已不存在」。
                <div className="editor__link">
                  <p className="u-aux">链接笔记</p>
                  {(() => {
                    let items: { title: string; target: string }[] = []
                    try {
                      const parsed = JSON.parse(content)
                      if (Array.isArray(parsed)) items = parsed
                    } catch {
                      // 不是 JSON：按单个 URL / 路径处理
                    }
                    if (!items.length) {
                      items = [{ title: content.slice(0, 60) || '未命名链接', target: content }]
                    }
                    return items.map((it, i) => (
                      <p key={i} className="editor__link-row">
                        <a href={it.target} target="_blank" rel="noreferrer">
                          {it.title || it.target}
                        </a>
                        <button
                          className="text-btn"
                          onClick={() =>
                            void window.zhixing.db
                              .openNoteFile(current.id)
                              .then((r) => onNotice(r.message))
                          }
                        >
                          用系统应用打开
                        </button>
                      </p>
                    ))
                  })()}
                </div>
              ) : current.format !== 'markdown' && current.format !== 'richtext' ? (
                office?.html ? (
                  <div className="editor__office">
                    <div className="editor__office-head">
                      <span className="u-aux">
                        {current.format === 'word' ? 'Word 只读预览' : 'Excel 只读预览'}
                        {office.message ? ` · ${office.message}` : ''}
                      </span>
                      <button
                        className="text-btn"
                        onClick={() =>
                          void window.zhixing.db.openNoteFile(current.id).then((r) => onNotice(r.message))
                        }
                      >
                        用系统应用打开
                      </button>
                    </div>
                    <div
                      className="editor__office-body"
                      // 内容由 mammoth/xlsx 解析后经主进程白名单清洗
                      dangerouslySetInnerHTML={{ __html: office.html }}
                    />
                  </div>
                ) : (
                  <div className="editor__external">
                    <p>
                      这篇笔记是
                      <strong>
                        {current.format === 'word' ? ' Word ' : current.format === 'excel' ? ' Excel ' : ' 链接 '}
                      </strong>
                      格式，内容是外部文件或链接的引用。
                    </p>
                    <code className="editor__path">{current.content_md || '（未填写引用路径）'}</code>
                    {office?.message && <p className="u-aux">{office.message}</p>}
                    <div className="editor__external-actions">
                      <button
                        className="text-btn text-btn--accent"
                        disabled={!current.content_md}
                        onClick={() =>
                          void window.zhixing.db.openNoteFile(current.id).then((r) => onNotice(r.message))
                        }
                      >
                        用系统默认应用打开
                      </button>
                    </div>
                  </div>
                )
              ) : preview ? (
                <div className="editor__preview">
                  <MarkdownView
                    md={content}
                    resolved={resolved}
                    onOpenNote={(id) => void selectNote(id)}
                    onCreateNote={(t) => void handleCreateFromLink(t)}
                  />
                </div>
              ) : (
                <MarkdownEditor
                  value={content}
                  onChange={(v) => {
                    setContent(v)
                    setDirty(true)
                  }}
                  titles={notes.map((n) => n.title)}
                  placeholder="用 Markdown 写作；输入 [[ 可链接到其他笔记"
                  onReady={(v) => {
                    viewRef.current = v
                  }}
                />
              )}
              </>
            ) : (
              <p className="empty-hint">从左侧选择一篇笔记，或点右上角新建。</p>
            )}

            {findOpen && current && (
              <div className="find-bar" role="search">
                <input
                  className="field field--compact"
                  value={findText}
                  placeholder="查找…"
                  aria-label="查找内容"
                  onChange={(e) => setFindText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') findNext()
                    if (e.key === 'Escape') setFindOpen(false)
                  }}
                />
                <input
                  className="field field--compact"
                  value={replaceText}
                  placeholder="替换为…"
                  aria-label="替换内容"
                  onChange={(e) => setReplaceText(e.target.value)}
                />
                <button className="text-btn" onClick={findNext}>
                  下一个
                </button>
                <button className="text-btn" onClick={replaceAll}>
                  全部替换
                </button>
                <button className="text-btn" onClick={() => setFindOpen(false)}>
                  关闭
                </button>
              </div>
            )}
        </div>

        {linksOpen && current && (
          <aside className="links" aria-label="链接面板">
            <section className="links__card">
              <header className="links__head">反向链接 · {backlinks.length}</header>
              {backlinks.length === 0 ? (
                <p className="u-aux">还没有其他笔记引用它。</p>
              ) : (
                backlinks.map((b) => (
                  <button key={b.src_note_id} className="links__item" onClick={() => void selectNote(b.src_note_id)}>
                    <strong>{b.src_title}</strong>
                    <span className="u-aux">{b.snippet}</span>
                  </button>
                ))
              )}
            </section>
            <section className="links__card">
              <header className="links__head">引用（正向）· {outLinks.length}</header>
              {outLinks.length === 0 ? (
                <p className="u-aux">正文里还没有 [[链接]]。</p>
              ) : (
                outLinks.map((l) =>
                  l.dst_note_id != null ? (
                    <button key={l.id} className="links__item" onClick={() => void selectNote(l.dst_note_id!)}>
                      <strong>{l.dst_title}</strong>
                    </button>
                  ) : (
                    <button
                      key={l.id}
                      className="links__item links__item--dangling"
                      onClick={() => void handleCreateFromLink(l.dst_title)}
                      title="目标笔记还不存在，点击创建并绑定"
                    >
                      <span className="dangling">[[{l.dst_title}]]</span>
                      <span className="u-aux"><Plus size={11} /> 创建</span>
                    </button>
                  )
                )
              )}
            </section>
            {dangling.length > 0 && (
              <p className="u-aux">有 {dangling.length} 条待建链接，点击即可创建目标笔记。</p>
            )}
          </aside>
        )}
        </div>
      </div>
      </div>

      {ctxMenu && (
        <PopMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              key: 'pin',
              label: notes.find((n) => n.id === ctxMenu.id)?.pinned ? '取消置顶' : '置顶',
              onPick: () =>
                void handleTogglePin(ctxMenu.id, !notes.find((n) => n.id === ctxMenu.id)?.pinned),
            },
            {
              key: 'rename',
              label: '重命名…',
              onPick: () => {
                const note = notes.find((n) => n.id === ctxMenu.id)
                void (async () => {
                  const next = await dialog.prompt({
                    title: '重命名笔记',
                    label: '新标题',
                    defaultValue: note?.title ?? '',
                  })
                  if (next?.trim()) await window.zhixing.db.saveNote(ctxMenu.id, { title: next }).then(load)
                })()
              },
            },
            {
              key: 'history',
              label: '版本历史…',
              onPick: () => setHistoryId(ctxMenu.id),
            },
            {
              key: 'delete',
              label: '删除',
              danger: true,
              onPick: () => void handleDelete(ctxMenu.id),
            },
          ]}
        />
      )}

      {templateMenu && (
        <PopMenu
          x={templateMenu.x}
          y={templateMenu.y}
          onClose={() => setTemplateMenu(null)}
          items={templates.map((name) => ({
            key: name,
            label: name,
            onPick: () => {
              void (async () => {
                const created = await window.zhixing.db.createNoteFromTemplate(name, null)
                if (!created) return
                await load()
                await selectNote(created.id)
                onNotice(`已按「${name}」新建笔记`)
              })()
            },
          }))}
        />
      )}

      {panel && (
        <PopMenu
          x={panel.x}
          y={panel.y}
          onClose={() => setPanel(null)}
          items={
            panelItems.length
              ? panelItems.map((it) => ({
                  key: it.key,
                  label: it.label,
                  onPick: () => void selectNote(it.id),
                }))
              : [{ key: 'none', label: '没有符合条件的笔记', onPick: () => undefined }]
          }
        />
      )}

      {historyId != null && (
        <NoteHistory
          noteId={historyId}
          onRestored={async () => {
            await load()
            const note = await window.zhixing.db.note(historyId)
            if (note) {
              setCurrent(note)
              setTitle(note.title)
              setContent(note.content_md ?? '')
            }
            onNotice('已回滚到所选版本')
          }}
          onClose={() => setHistoryId(null)}
        />
      )}
    </div>
  )
}
