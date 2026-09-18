import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { bindHostEvents, subscribeDomain } from '@shared/events'
import { t } from './i18n'
import { parseSettings, type AppSettings } from '@shared/settings'
import { applyAppearance, resolveThemeMode } from './theme'
import { CapturePanel } from './components/CapturePanel'
import { CommandPalette } from './components/CommandPalette'
import { DialogProvider } from './components/Dialogs'
import { PomodoroBar } from './components/PomodoroBar'
import { ReminderPopup } from './components/ReminderPopup'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { Toast } from './components/Toast'
import { NAV_ITEMS, type PageKey } from './nav'
import { GraphPage } from './pages/GraphPage'
import { InboxPage } from './pages/InboxPage'
import { NotesPage } from './pages/NotesPage'
import { ReviewPage } from './pages/ReviewPage'
import { SettingsPage } from './pages/SettingsPage'
import { WorkflowPage } from './pages/WorkflowPage'
import { TasksPage } from './pages/TasksPage'
import { TodayPage } from './pages/TodayPage'
import type { Overview } from '@shared/types'
import './styles/app.css'
import './styles/tasks.css'
import './styles/notes.css'
import './styles/graph.css'
import './styles/inbox.css'
import './styles/workflow.css'
import './styles/review.css'
import './styles/settings.css'

const THEME_KEY = 'zhixing.theme'
type Theme = 'light' | 'dark'

export default function App() {
  const [page, setPage] = useState<PageKey>('today')
  const [collapsed, setCollapsed] = useState(false)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  /** 跨页跳转：图谱双击笔记 → 切到笔记页并选中该篇 */
  const [openNoteId, setOpenNoteId] = useState<number | null>(null)
  /** 最近一次可撤销的完成动作（底部 InfoBar + Ctrl+Z） */
  const [undoBar, setUndoBar] = useState<{
    ids: number[]
    label: string
    action?: 'toggle' | 'restore'
  } | null>(null)
  /** 由今日页概览卡点击带过来的任务页聚焦过滤 */
  const [taskFocus, setTaskFocus] = useState<'today' | 'done' | 'overdue' | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [pomo, setPomo] = useState({ focus: 25, break: 5, autoBreak: true })
  const [captureOpen, setCaptureOpen] = useState(false)
  const [captureMode, setCaptureMode] = useState<'quick' | 'capture'>('quick')
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_KEY)
    return saved === 'light' || saved === 'dark' ? saved : 'dark'
  })
  /** 最近一次读到的完整设置；null 表示还没从 settings 表读到，先别铺（免得用默认值闪一下） */
  const [appearance, setAppearance] = useState<AppSettings | null>(null)
  /** 上一个页面，供 Ctrl+Tab 往返（对齐 switch_recent） */
  const prevPage = useRef<PageKey | null>(null)
  const lastPage = useRef<PageKey>('today')

  /** 以 settings 表为准重铺外观：Python 版与 Electron 版共用同一份偏好。 */
  const loadAppearance = useCallback(async (): Promise<AppSettings> => {
    let s: AppSettings
    try {
      s = parseSettings(await window.zhixing.db.settings())
    } catch {
      // 读不到设置（库不可用 / 被别的进程占用）也不能让外观永久失效：
      // appearance 一旦恒为 null，标题栏切明暗就会完全没反应。
      s = parseSettings()
    }
    setAppearance(s)
    setTheme(resolveThemeMode(s.theme_mode))
    // 主题包 + 强调色 + 字号/行高/动效一起铺开（O8）
    applyAppearance(s)
    return s
  }, [])

  useEffect(() => {
    void (async () => {
      const s = await loadAppearance()
      setPomo({
        focus: s.pomodoro_focus_min,
        break: s.pomodoro_break_min,
        autoBreak: s.pomodoro_auto_break,
      })
    })()
  }, [loadAppearance])

  useEffect(() => {
    if (!appearance) return
    // 切明暗 / 换主题包都要整体重铺：只改 data-theme 不生效——applyTheme 已把包里的色内联到
    // :root，内联样式优先于 [data-theme] 规则。落库由切换动作负责，这里不写库，
    // 否则启动时 localStorage 的旧值会抢先把 settings 表改脏。
    applyAppearance({ ...appearance, theme_mode: theme })
  }, [theme, appearance])

  // theme_mode = system 时跟随系统明暗实时切换（对齐 Python 的 styleHints 信号）
  useEffect(() => {
    if (appearance?.theme_mode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setTheme(mq.matches ? 'dark' : 'light')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [appearance?.theme_mode])

  /** 标题栏的明暗切换：一次把状态、本地缓存、主进程与 settings 表都推到位。 */
  const toggleTheme = useCallback((): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    localStorage.setItem(THEME_KEY, next)
    void window.zhixing.app.setTheme(next)
    void window.zhixing.db.setSetting('theme_mode', next)
    setTheme(next)
  }, [theme])

  // 记录页面切换历史（Ctrl+Tab 用）
  useEffect(() => {
    if (lastPage.current !== page) {
      prevPage.current = lastPage.current
      lastPage.current = page
    }
  }, [page])

  const refreshOverview = useCallback(async () => {
    setOverview(await window.zhixing.db.overview())
  }, [])

  useEffect(() => {
    void refreshOverview()
  }, [refreshOverview])

  // 把主进程的写入通知接进订阅表（O3）：只调一次
  useEffect(() => {
    bindHostEvents(window.zhixing.db)
    // 设置页换主题包/强调色/字号后，主窗口跟着重铺（浮窗各自订阅同一份广播）
    return subscribeDomain(['settings'], () => void loadAppearance())
  }, [loadAppearance])

  // 启动维护 + 跨天维护（对齐 AppController：打卡重置、等待中到期恢复）
  useEffect(() => {
    let day = new Date().toLocaleDateString('sv-SE')
    const maintain = async (announce: boolean): Promise<void> => {
      const rolled = await window.zhixing.db.rollRecurringToday()
      const resumed = await window.zhixing.db.resumeDueToday()
      // 回收站按保留期自动清理（对齐 app_controller 跨天流程末尾的 _purge_recycle）：
      // 此前只有手动按钮，设置里的 recycle_retention_days 形同虚设，回收站会无限增长。
      try {
        const s = parseSettings(await window.zhixing.db.settings())
        await window.zhixing.db.purgeTrashOlderThan(s.recycle_retention_days)
      } catch (err) {
        console.error('[maintain] 回收站清理失败', err)
      }
      if (announce) {
        if (rolled) showToast(`新的一天：${rolled} 个打卡子任务已重置`)
        else if (resumed) showToast(`有 ${resumed} 个等待中的任务已到期恢复`)
      } else {
        if (rolled) showToast(`新的一天：${rolled} 个打卡子任务已重置`)
        if (resumed) showToast(`有 ${resumed} 个等待中的任务已到期恢复`)
      }
      if (rolled || resumed) await refreshOverview()
    }
    void maintain(true)

    const timer = window.setInterval(() => {
      const now = new Date().toLocaleDateString('sv-SE')
      if (now === day) return
      day = now
      void maintain(false)
    }, 60_000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const focusTasks = useCallback((kind: 'today' | 'done' | 'overdue') => {
    setTaskFocus(kind)
    setPage('tasks')
  }, [])

  const openNote = useCallback((id: number) => {
    setOpenNoteId(id)
    setPage('notes')
  }, [])

  // 深链与全局动作（托盘 / 全局热键）统一在这里落地
  useEffect(() => {
    window.zhixing.app.onDeepLink((link) => {
      if (link.kind === 'task') {
        setTaskFocus(null)
        setPage('tasks')
      } else if (link.kind === 'note') {
        openNote(link.id)
      } else if (link.kind === 'flash') {
        setPage('inbox')
      } else if (link.kind === 'folder') {
        setPage('notes')
      }
    })
    // 工作流节点动作「打开笔记」由页面派发事件，App 负责跨页跳转
    const onOpenNote = (e: Event): void => {
      const id = (e as CustomEvent<number>).detail
      if (Number.isFinite(id) && id > 0) openNote(id)
    }
    window.addEventListener('zhixing:open-note', onOpenNote)

    window.zhixing.app.onAction((action) => {
      if (action === 'quick-capture') {
        setCaptureMode('quick')
        setCaptureOpen(true)
      } else if (action === 'capture') {
        setCaptureMode('capture')
        setCaptureOpen(true)
      } else if (action === 'clipboard-notice') {
        showToast('已复制内容 — 可用快速捕获（Ctrl+N）记下来')
      } else if (action === 'select-quick') {
        // 划词速记：Electron 侧读系统剪贴板预填（无跨应用模拟复制能力，属降级实现）
        setCaptureMode('capture')
        setCaptureOpen(true)
      }
    })

    return () => window.removeEventListener('zhixing:open-note', onOpenNote)
  }, [openNote])

  /** 图谱里创建「待建」笔记：新建后按标题把悬空引用一次绑定过去。 */
  const createNoteFromDangling = useCallback(async (linkTitle: string) => {
    const created = await window.zhixing.db.createNote(linkTitle, null)
    if (!created) return
    const bound = await window.zhixing.db.bindDanglingByTitle(linkTitle)
    showToast(`已创建「${linkTitle}」并绑定 ${bound} 条引用`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 页面完成任务后派发这个事件，由 App 统一承载「可撤销」提示
  useEffect(() => {
    const onUndoable = (e: Event): void => {
      const detail = (e as CustomEvent<{ ids: number[]; label: string; action?: 'toggle' | 'restore' }>)
        .detail
      if (!detail?.ids?.length) return
      setUndoBar(detail)
      window.setTimeout(() => setUndoBar((cur) => (cur === detail ? null : cur)), 6000)
    }
    window.addEventListener('zhixing:undoable', onUndoable)
    return () => window.removeEventListener('zhixing:undoable', onUndoable)
  }, [])

  const undoLast = useCallback(async () => {
    if (!undoBar) return
    const { ids, action } = undoBar
    setUndoBar(null)
    // 撤销动作按来源区分：完成/取消完成 → 反向切换；删除 → 从回收站恢复
    // （对齐 app_controller._undo_last 支持撤销删除整棵子树）
    for (const id of ids) {
      if (action === 'restore') await window.zhixing.db.restoreTrash('task', id)
      else await window.zhixing.db.toggleTask(id)
    }
    await refreshOverview()
    setToast(action === 'restore' ? `已恢复 ${ids.length} 项` : `已撤销 ${ids.length} 项完成`)
  }, [undoBar, refreshOverview])

  // Ctrl/Cmd+K 命令面板；Ctrl/Cmd+N 快速任务捕获（与手册 §5.3 / §5.4 一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const key = e.key.toLowerCase()
      if (key === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      if (e.shiftKey && key === 'n') {
        e.preventDefault()
        setPage('notes')
        window.dispatchEvent(new CustomEvent('zhixing:new-note'))
        return
      }
      if (key === 'n') {
        e.preventDefault()
        setCaptureMode('quick')
        setCaptureOpen(true)
        return
      }
      if (key === 'b') {
        e.preventDefault()
        setCollapsed((c) => !c)
        return
      }
      if (key === 'e') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('zhixing:toggle-preview'))
        return
      }
      if (key === 'f') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('zhixing:find'))
        return
      }
      if (key === ',') {
        e.preventDefault()
        setPage('settings')
        return
      }
      // Ctrl+Tab：在最近两个页面之间往返（对齐 switch_recent）
      if (e.key === 'Tab') {
        e.preventDefault()
        if (prevPage.current) {
          const back = prevPage.current
          prevPage.current = page
          setPage(back)
        }
        return
      }
      // Ctrl+1..6：前六个导航页（对齐 main_window._install_shortcuts）
      if (/^[1-6]$/.test(e.key)) {
        const item = NAV_ITEMS[Number(e.key) - 1]
        if (item) {
          e.preventDefault()
          setPage(item.key)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [page])

  // Ctrl/Cmd+Z 撤销（与 docs 手册 §4.3 的「撤销最近一次完成/恢复」一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || !undoBar) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      e.preventDefault()
      void undoLast()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoBar, undoLast])

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast((t) => (t === message ? null : t)), 2600)
  }, [])

  const current = useMemo(() => NAV_ITEMS.find((i) => i.key === page) ?? NAV_ITEMS[0], [page])

  return (
    <DialogProvider>
      <div className="app">
        <TitleBar
        title={`知行 ZhiXing · ${t(current.labelKey)}`}
        theme={theme}
        onToggleTheme={toggleTheme}
        signature={appearance?.signature}
      />
      <div className="app__body">
        <Sidebar
          page={page}
          collapsed={collapsed}
          inboxCount={overview?.inbox ?? 0}
          onSelect={setPage}
          onToggleCollapse={() => setCollapsed((c) => !c)}
        />
        <main className="app__content">
          {page === 'today' ? (
            <TodayPage
              overview={overview}
              onChanged={refreshOverview}
              onNotice={showToast}
              onOpenNote={openNote}
              onFocusTasks={focusTasks}
            />
          ) : page === 'tasks' ? (
            <TasksPage
              onChanged={refreshOverview}
              onNotice={showToast}
              focus={taskFocus}
              onClearFocus={() => setTaskFocus(null)}
            />
          ) : page === 'notes' ? (
            <NotesPage onNotice={showToast} initialNoteId={openNoteId} />
          ) : page === 'settings' ? (
            <SettingsPage onNotice={showToast} onChanged={refreshOverview} />
          ) : page === 'review' ? (
            <ReviewPage />
          ) : page === 'workflow' ? (
            <WorkflowPage onNotice={showToast} onChanged={refreshOverview} />
          ) : page === 'inbox' ? (
            <InboxPage onNotice={showToast} onChanged={refreshOverview} />
          ) : page === 'graph' ? (
            <GraphPage
              onOpenNote={openNote}
              onCreateNoteFromDangling={createNoteFromDangling}
              onNotice={showToast}
            />
          ) : null}
        </main>
      </div>
      <CapturePanel
        open={captureOpen}
        mode={captureMode}
        onClose={() => setCaptureOpen(false)}
        onNotice={showToast}
        onChanged={refreshOverview}
      />

      <PomodoroBar
        focusMinutes={pomo.focus}
        breakMinutes={pomo.break}
        autoBreak={pomo.autoBreak}
        onNotice={showToast}
      />
      <ReminderPopup
        onOpenTask={(id) => {
          setTaskFocus(null)
          setPage('tasks')
          void id
        }}
        onChanged={refreshOverview}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={setPage}
        onOpenNote={openNote}
        onQuickAdd={async (text) => {
          await window.zhixing.db.quickAdd(text)
          await refreshOverview()
          showToast(`已添加「${text}」`)
        }}
      />

      {undoBar && (
        <div className="infobar" role="status">
          <span>{undoBar.label}</span>
          <button className="text-btn" onClick={() => void undoLast()}>
            撤销
          </button>
          <button className="infobar__close" aria-label="关闭提示" onClick={() => setUndoBar(null)}>
            ×
          </button>
        </div>
      )}
      <Toast message={toast} />
      </div>
    </DialogProvider>
  )
}
