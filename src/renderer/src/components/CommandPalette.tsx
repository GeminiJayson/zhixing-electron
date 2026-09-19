import { useEffect, useMemo, useRef, useState } from 'react'
import { Hash, Inbox, NotebookPen, Plus, Search, SquareCheck, TerminalSquare } from '@renderer/lib/icons'
import { NAV_ITEMS, type PageKey } from '../nav'
import { t } from '../i18n'

interface Props {
  open: boolean
  onClose: () => void
  onNavigate: (page: PageKey) => void
  onOpenNote: (id: number) => void
  onQuickAdd: (text: string) => Promise<void>
  /** 可选：命令执行结果提示；App 未注入时命令仍会执行，只是不弹提示 */
  onNotice?: (message: string) => void
}

interface Hit {
  kind: 'task' | 'note' | 'flash' | 'tag'
  id: number
  title: string
  subtitle: string
}
interface CommandHit {
  id: string
  title: string
  subtitle: string
}
interface SearchResult {
  command: CommandHit[]
  task: Hit[]
  note: Hit[]
  flash: Hit[]
  tag: Hit[]
}

interface Item {
  key: string
  label: string
  hint: string
  icon: 'page' | 'note' | 'action' | 'task' | 'flash' | 'tag' | 'command'
  run: () => void | Promise<void>
  /** 命中记录（MRU）：非命令的数据条目才有 */
  mru?: { kind: string; id: number }
}

const GROUP_ICON = {
  task: SquareCheck,
  note: NotebookPen,
  flash: Inbox,
  tag: Hash,
} as const

/** 备份目录：dbPath 所在目录下的 backups/（与主进程 backupDir() 同口径）。 */
function backupsDirOf(dbPath: string): string {
  const cut = Math.max(dbPath.lastIndexOf('\\'), dbPath.lastIndexOf('/'))
  const sep = dbPath.includes('\\') ? '\\' : '/'
  return cut > 0 ? dbPath.slice(0, cut) + sep + 'backups' : 'backups'
}

/**
 * 命令面板（Ctrl/Cmd+K）：命令、页面跳转、以及跨类型检索。
 *
 * 检索走主进程的 global_search（FTS5 + 前缀/过滤语法 + 命令注入 + MRU），
 * 不再像以前那样只对已加载的笔记标题做子串匹配。
 * 命令组来自主进程注入的命令注册表（对齐 Python 的 search_service.commands），
 * 渲染层只负责把稳定命令 id 映射到具体动作。
 */
export function CommandPalette({ open, onClose, onNavigate, onOpenNote, onQuickAdd, onNotice }: Props) {
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

  // 输入后防抖查库；**空查询也要查一次**——命令注册表就是这么注入的
  // （对齐 global_search 对空查询返回命令组的行为）。
  useEffect(() => {
    if (!open) return
    const query = q.trim()
    let alive = true
    const timer = window.setTimeout(
      () => {
        void window.zhixing.db.globalSearch(query).then((r) => {
          if (alive) setHits(r as SearchResult)
        })
      },
      query ? 120 : 0
    )
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [q, open])

  /** 命令 id → 渲染层动作（对齐 app_controller 的 7 条注册命令）。 */
  const runCommand = async (id: string): Promise<void> => {
    try {
      if (id === 'theme-dark' || id === 'theme-light') {
        // 走 settings 域写入：App 订阅 settings 域后会重铺外观
        await window.zhixing.db.setSetting('theme_mode', id === 'theme-dark' ? 'dark' : 'light')
      } else if (id === 'toggle-widget') {
        await window.zhixing.widget.toggle()
      } else if (id === 'new-note') {
        onNavigate('notes')
        // 页面切换是异步渲染的，等一帧再派发「新建笔记」
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('zhixing:new-note')), 60)
      } else if (id === 'open-graph') {
        onNavigate('graph')
      } else if (id === 'backup-now') {
        const info = await window.zhixing.db.info()
        const res = await window.zhixing.db.backupDatabase(backupsDirOf(info.path))
        onNotice?.(res ? '已备份到 ' + res.path : '备份失败')
      } else if (id === 'start-pomodoro') {
        // 无任务启动专注（对齐 _start_pomodoro(None)）
        window.dispatchEvent(new CustomEvent('zhixing:pomodoro', { detail: { taskId: null, title: '' } }))
      }
    } catch (err) {
      onNotice?.('命令执行失败：' + (err as Error).message)
    }
  }

  const items = useMemo<Item[]>(() => {
    const query = q.trim().toLowerCase()
    const out: Item[] = []

    // 1) 命令组（主进程注入，空查询即全部；对齐 SearchResult.groups 的「命令」在首位）
    for (const c of hits?.command ?? []) {
      out.push({
        key: 'cmd-' + c.id,
        label: c.title,
        hint: c.subtitle || '命令',
        icon: 'command',
        run: () => runCommand(c.id),
      })
    }

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
          mru: { kind: 'task', id: h.id },
          run: () => onNavigate('tasks'),
        })
      }
      for (const h of hits.note) {
        out.push({
          key: 'note-' + h.id,
          label: h.title,
          hint: '笔记 · ' + (h.subtitle || ''),
          icon: 'note',
          mru: { kind: 'note', id: h.id },
          run: () => onOpenNote(h.id),
        })
      }
      for (const h of hits.flash) {
        out.push({
          key: 'flash-' + h.id,
          label: h.title,
          hint: '闪念 · ' + (h.subtitle || ''),
          icon: 'flash',
          mru: { kind: 'flash', id: h.id },
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, hits, onNavigate, onOpenNote, onQuickAdd, onNotice])

  if (!open) return null

  const exec = async (item: Item | undefined): Promise<void> => {
    if (!item) return
    // MRU：选中即记一次（对齐 app_controller._open_hit 的 search_service.touch）
    if (item.mru) {
      try {
        await window.zhixing.db.searchTouch(item.mru.kind, item.mru.id)
      } catch {
        // 记一次失败不影响导航
      }
    }
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
            placeholder="搜索任务/笔记/闪念/标签或命令（支持 task: note: due: status: priority: folder:）"
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
                  ) : it.icon === 'command' ? (
                    <TerminalSquare size={14} aria-hidden />
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
