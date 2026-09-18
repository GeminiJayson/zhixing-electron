import { useEffect, useMemo, useRef, useState } from 'react'
import { Hash, Inbox, NotebookPen, Plus, Search, SquareCheck } from 'lucide-react'
import { NAV_ITEMS, type PageKey } from '../nav'
import { t } from '../i18n'

interface Props {
  open: boolean
  onClose: () => void
  onNavigate: (page: PageKey) => void
  onOpenNote: (id: number) => void
  onQuickAdd: (text: string) => Promise<void>
}

interface Hit {
  kind: 'task' | 'note' | 'flash' | 'tag'
  id: number
  title: string
  subtitle: string
}
interface SearchResult {
  task: Hit[]
  note: Hit[]
  flash: Hit[]
  tag: Hit[]
}

interface Item {
  key: string
  label: string
  hint: string
  icon: 'page' | 'note' | 'action' | 'task' | 'flash' | 'tag'
  run: () => void | Promise<void>
}

const GROUP_ICON = {
  task: SquareCheck,
  note: NotebookPen,
  flash: Inbox,
  tag: Hash,
} as const

/**
 * 命令面板（Ctrl/Cmd+K）：页面跳转、命令、以及跨类型检索。
 * 检索走主进程的 global_search（FTS5 + 前缀/过滤语法），
 * 不再像以前那样只对已加载的笔记标题做子串匹配。
 */
export function CommandPalette({ open, onClose, onNavigate, onOpenNote, onQuickAdd }: Props) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchResult | null>(null)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQ('')
    setHits(null)
    setActive(0)
    window.setTimeout(() => inputRef.current?.focus(), 30)
  }, [open])

  // 输入后防抖查库（FTS 在主进程，跨类型一次返回）
  useEffect(() => {
    if (!open) return
    const query = q.trim()
    if (!query) {
      setHits(null)
      return
    }
    let alive = true
    const timer = window.setTimeout(() => {
      void window.zhixing.db.globalSearch(query).then((r) => {
        if (alive) setHits(r as SearchResult)
      })
    }, 120)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [q, open])

  const items = useMemo<Item[]>(() => {
    const query = q.trim().toLowerCase()
    const out: Item[] = []

    if (query) {
      out.push({
        key: 'quick-add',
        label: '新建任务「' + q.trim() + '」',
        hint: '命令 · 支持 !2 @列表 #标签 明天',
        icon: 'action',
        run: () => onQuickAdd(q.trim()),
      })
    }

    for (const n of NAV_ITEMS) {
      if (query && !t(n.labelKey).toLowerCase().includes(query)) continue
      out.push({
        key: 'page-' + n.key,
        label: '转到' + t(n.labelKey),
        hint: '命令 · 页面',
        icon: 'page',
        run: () => onNavigate(n.key),
      })
    }

    if (hits) {
      for (const h of hits.task) {
        out.push({
          key: 'task-' + h.id,
          label: h.title,
          hint: '任务 · ' + (h.subtitle || ''),
          icon: 'task',
          run: () => onNavigate('tasks'),
        })
      }
      for (const h of hits.note) {
        out.push({
          key: 'note-' + h.id,
          label: h.title,
          hint: '笔记 · ' + (h.subtitle || ''),
          icon: 'note',
          run: () => onOpenNote(h.id),
        })
      }
      for (const h of hits.flash) {
        out.push({
          key: 'flash-' + h.id,
          label: h.title,
          hint: '闪念 · ' + (h.subtitle || ''),
          icon: 'flash',
          run: () => onNavigate('inbox'),
        })
      }
      for (const h of hits.tag) {
        out.push({
          key: 'tag-' + h.id,
          label: h.title,
          hint: '标签',
          icon: 'tag',
          run: () => onNavigate('tasks'),
        })
      }
    }
    return out.slice(0, 30)
  }, [q, hits, onNavigate, onOpenNote, onQuickAdd])

  if (!open) return null

  const exec = async (item: Item | undefined): Promise<void> => {
    if (!item) return
    onClose()
    await item.run()
  }

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette__input">
          <Search size={15} aria-hidden />
          <input
            ref={inputRef}
            value={q}
            placeholder="搜索任务/笔记/闪念/标签，或直接建任务（支持 task: note: due: status: priority: folder:）"
            aria-label="命令面板输入"
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((i) => Math.min(i + 1, items.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                void exec(items[active])
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              }
            }}
          />
        </div>
        <ul className="palette__list" role="listbox">
          {items.map((it, i) => {
            const GroupIcon = it.icon === 'task' || it.icon === 'flash' || it.icon === 'tag' ? GROUP_ICON[it.icon] : null
            return (
              <li key={it.key}>
                <button
                  role="option"
                  aria-selected={i === active}
                  className={'palette__item' + (i === active ? ' palette__item--on' : '')}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => void exec(it)}
                >
                  {GroupIcon ? (
                    <GroupIcon size={14} aria-hidden />
                  ) : it.icon === 'note' ? (
                    <NotebookPen size={14} aria-hidden />
                  ) : it.icon === 'action' ? (
                    <Plus size={14} aria-hidden />
                  ) : (
                    <Search size={14} aria-hidden />
                  )}
                  <span className="palette__label">{it.label}</span>
                  <span className="u-aux">{it.hint}</span>
                </button>
              </li>
            )
          })}
          {items.length === 0 && <li className="u-aux palette__empty">没有匹配项</li>}
        </ul>
      </div>
    </div>
  )
}
