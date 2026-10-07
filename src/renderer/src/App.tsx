import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { bindHostEvents, subscribeDomain } from '@shared/events'
import { parseSettings, type AppSettings } from '@shared/settings'
import { applyAppearance, applyMotion, resolveThemeMode } from './theme'
import { CommandPalette } from './components/CommandPalette'
import { DialogProvider } from './components/Dialogs'
// FloatingDock（右下角快捷新建浮条）已按用户要求下线，组件文件仍在 components/ 下未删
import { ReminderPopup } from './components/ReminderPopup'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { Toast } from './components/Toast'
import { NAV_ITEMS, type PageKey } from './nav'
import { usePresence } from './lib/presence'
import { GraphPage } from './pages/GraphPage'
import { InboxPage } from './pages/InboxPage'
import { NotesPage } from './pages/NotesPage'
import { ReviewPage } from './pages/ReviewPage'
import { VaultPage } from './pages/VaultPage'
import { SettingsPage } from './pages/SettingsPage'
import { WorkflowPage } from './pages/WorkflowPage'
import { TasksPage } from './pages/TasksPage'
import { TodayPage } from './pages/TodayPage'
import type { Overview, TaskStatus } from '@shared/types'
import './styles/app.css'
import './styles/toolbar.css'
import './styles/tasks.css'
import './styles/notes.css'
import './styles/graph.css'
import './styles/inbox.css'
import './styles/workflow.css'
import './styles/review.css'
import './styles/settings.css'
import './styles/vault.css'
import './styles/notes-filter.css'
import './styles/kbchip.css'
import './styles/habit.css'

const THEME_KEY = 'zhixing.theme'
/** 提示停留时长：Toast 的进度线与 App 的自动关闭定时器共用这一个数 */
const TOAST_STAY_MS = 2600
type Theme = 'light' | 'dark'

export default function App() {
  const [page, setPage] = useState<PageKey>('today')
  /** 页面切换方向：决定新页面从右侧（前进）还是左侧（返回）进场 */
  const [dir, setDir] = useState<'forward' | 'back'>('forward')
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
    /** 撤销「取消完成」时要回写的前一个状态；无此项则按完成/未完成反向切换 */
    prevStatus?: TaskStatus
  } | null>(null)
  /** 由今日页概览卡点击带过来的任务页聚焦过滤 */
  const [taskFocus, setTaskFocus] = useState<'today' | 'done' | 'overdue' | null>(null)
  /**
   * 全屏编辑：由笔记页发起的「只留正文」模式。
   * 状态放在 App 而不是笔记页 —— 左侧主导航也在 `.app__body` 里，
   * 只有提到这一层才能连导航一起让位；离开笔记页时由笔记页负责复位。
   */
  const [zen, setZen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_KEY)
    return saved === 'light' || saved === 'dark' ? saved : 'dark'
  })
  /** 最近一次读到的完整设置；null 表示还没从 settings 表读到，先别铺（免得用默认值闪一下） */
  const [appearance, setAppearance] = useState<AppSettings | null>(null)
  /** 数据库降级原因：迁移失败（只读）或完全打不开时非空，主区顶部据此弹危险横幅 */
  const [dbIssue, setDbIssue] = useState('')
  /** 上一个页面，供 Ctrl+Tab 往返 */
  const prevPage = useRef<PageKey | null>(null)
  const lastPage = useRef<PageKey>('today')
  /** 待派发的深链精确定位目标（等目标页渲染完成后再广播） */
  const pendingLink = useRef<{ kind: string; id: number; block: string } | null>(null)
  /** 深链计数器：目标页与当前页相同时 setPage 不会引发重渲染，靠它触发派发 effect */
  const [linkTick, setLinkTick] = useState(0)

  /** 以 settings 表为准重铺外观。 */
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
    // 主题包 + 强调色 + 字号/行高/动效一起铺开
    applyAppearance(s)
    return s
  }, [])

  useEffect(() => {
    void (async () => {
      await loadAppearance()
      // 读一次数据库状态。迁移失败（只读）或完全打不开时给主区顶部横幅取数；
      // 这里不能抛 —— 取不到信息也照样要放主窗出来，否则用户只会看到一个空白界面。
      try {
        const info = await window.zhixing.app.info()
        setDbIssue(info.dbReadonly || (info.dbReady ? '' : info.dbError) || '')
      } catch {
        // 主进程信息不可用时不显示横幅
      }
      // 首屏就绪 → 主进程关闭欢迎页并显示主窗：
      // 初始化全部完成后再显主窗，打开即可操作
      void window.zhixing.app.ready()
      // 主窗显示后再强制一次合成刷新：窗口刚显示时 Chromium 可能复用旧合成帧，
      // 表现就是「首次启动外观不对，手动切一下主题才消除」。
      window.setTimeout(() => {
        const el = document.documentElement
        el.style.transform = 'translateZ(0)'
        requestAnimationFrame(() => {
          el.style.transform = ''
        })
      }, 80)
    })()
  }, [loadAppearance])

  useEffect(() => {
    if (!appearance) return
    // 切明暗 / 换主题包都要整体重铺：只改 data-theme 不生效——applyTheme 已把包里的色内联到
    // :root，内联样式优先于 [data-theme] 规则。落库由切换动作负责，这里不写库，
    // 否则启动时 localStorage 的旧值会抢先把 settings 表改脏。
    applyAppearance({ ...appearance, theme_mode: theme })
  }, [theme, appearance])

  // 系统「减少动态效果」变化时重铺动效档位（applyMotion 会广播 zhixing:motion，
  // 画布类视图据此冻结物理动画）
  useEffect(() => {
    if (!appearance || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (): void => {
      applyMotion(appearance.motion_level)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [appearance])

  // theme_mode = system 时跟随系统明暗实时切换
  useEffect(() => {
    if (appearance?.theme_mode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setTheme(mq.matches ? 'dark' : 'light')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [appearance?.theme_mode])

  /** 一次性把明暗状态、本地缓存、主进程与 settings 表都推到位。 */
  const setThemeMode = useCallback((mode: Theme): void => {
    localStorage.setItem(THEME_KEY, mode)
    void window.zhixing.app.setTheme(mode)
    void window.zhixing.db.setSetting('theme_mode', mode)
    setTheme(mode)
  }, [])

  /** 标题栏的明暗切换。 */
  const toggleTheme = useCallback((): void => {
    setThemeMode(theme === 'dark' ? 'light' : 'dark')
  }, [theme, setThemeMode])

  // 记录页面切换历史（Ctrl+Tab 用）+ 判定切换方向（新页面从哪一侧进场）
  useEffect(() => {
    if (lastPage.current !== page) {
      const from = NAV_ITEMS.findIndex((i) => i.key === lastPage.current)
      const to = NAV_ITEMS.findIndex((i) => i.key === page)
      if (from >= 0 && to >= 0 && from !== to) setDir(to > from ? 'forward' : 'back')
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

  /**
   * 侧栏徽标（收件箱 / 今日 / 逾期）跟着数据走。
   *
   * 此前只在挂载时算一次：整理完收件箱、勾掉一个任务，数字都还停在旧值 ——
   * 用户看到的就是"收件箱里没东西了，徽标还挂着 18"。任务与闪念任何一个域有写入就重算。
   */
  useEffect(
    () => subscribeDomain(['task', 'flash'], () => void refreshOverview()),
    [refreshOverview]
  )

  // 把主进程的写入通知接进订阅表：只调一次
  useEffect(() => {
    bindHostEvents(window.zhixing.db)
    // 设置页换主题包/强调色/字号后，主窗口跟着重铺（浮窗各自订阅同一份广播）。
    // 番茄钟时长与「专注结束自动休息」不在这里跟 —— 那个小窗每次被打开都会重读设置
    // （见 PomodoroWindowApp 的挂载 effect），所以改完下一次发起就是新值。
    return subscribeDomain(['settings'], () => {
      void loadAppearance()
    })
  }, [loadAppearance])

  // 启动维护 + 跨天维护
  useEffect(() => {
    let day = new Date().toLocaleDateString('sv-SE')
    const maintain = async (announce: boolean): Promise<void> => {
      const rolled = await window.zhixing.db.rollRecurringToday()
      const resumed = await window.zhixing.db.resumeDueToday()
      // 回收站按保留期自动清理：
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
      // 跨天轮询间隔取 600000ms（10 分钟）：60s 太密，
      // 而跨天维护本身只关心「日期变了没有」，10 分钟内必然发生一次足够
    }, 600_000)
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
    // preload 的 on* 现在统一返回取消函数，这里必须接住 —— 否则每次 effect 重跑都叠一层监听
    const offDeepLink = window.zhixing.app.onDeepLink((link) => {
      // 先切页并记下待派发的「精确定位」目标；目标页可能在本次 setPage 后才挂载，
      // 立刻派发会丢事件，因此在下面的 effect 里等页面渲染后再发。
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
      pendingLink.current = link
      setLinkTick((n) => n + 1)
    })
    // 工作流节点动作「打开笔记」由页面派发事件，App 负责跨页跳转
    const onOpenNote = (e: Event): void => {
      const id = (e as CustomEvent<number>).detail
      if (Number.isFinite(id) && id > 0) openNote(id)
    }
    window.addEventListener('zhixing:open-note', onOpenNote)

    const offAction = window.zhixing.app.onAction((action, payload) => {
      // 「快速任务 / 划词捕获 / 读取选中并速记」现在开在**独立的捕获窗口**里，
      // 主窗口不再接管（按热键时用户正在别的应用里，不该把他拽回来）。
      if (action === 'notice') {
        // 捕获窗口完成后把回执转过来：只提示，不显示主窗口
        showToast(String(payload ?? ''))
      } else if (action === 'new-note') {
        // 托盘/浮窗「新建笔记」
        setPage('notes')
        window.dispatchEvent(new CustomEvent('zhixing:new-note'))
      } else if (action === 'flash-inbox') {
        // 托盘/浮窗「记闪念」：切到收件箱
        setPage('inbox')
      } else if (action === 'clipboard-notice') {
        showToast('已复制内容 — 可用快速捕获（Ctrl+N）记下来')
      }
    })

    return () => {
      offDeepLink()
      offAction()
      window.removeEventListener('zhixing:open-note', onOpenNote)
    }
  }, [openNote])

  /**
   * 深链的精确定位：按 kind 把 id / block 交给目标页。
   *
   * 页面状态（选中行、滚动位置、编辑器锚点）由各页自己持有，App 只负责在页面
   * 渲染完成后广播一次「打开这个对象」。对面订阅的事件名：
   *   task   → zhixing:open-task            detail { id }
   *   note   → zhixing:locate-note-block   detail { noteId, blockKey }
   *            （事件名沿用 NotesPage 已实现的段落锚定位契约）
   *   flash  → zhixing:open-flash           detail { id }
   *   folder → zhixing:open-note-folder     detail { id }
   */
  useEffect(() => {
    const link = pendingLink.current
    if (!link) return
    pendingLink.current = null
    // 等一帧：setPage 之后目标页才挂载，事件必须落在挂载完成之后
    const timer = window.setTimeout(() => {
      if (link.kind === 'task') {
        window.dispatchEvent(new CustomEvent('zhixing:open-task', { detail: { id: link.id } }))
      } else if (link.kind === 'flash') {
        window.dispatchEvent(new CustomEvent('zhixing:open-flash', { detail: { id: link.id } }))
      } else if (link.kind === 'folder') {
        window.dispatchEvent(
          new CustomEvent('zhixing:open-note-folder', { detail: { id: link.id } })
        )
      } else if (link.block) {
        // 事件名与 NotesPage 的段落锚定位契约一致（zhixing:locate-note-block）
        window.dispatchEvent(
          new CustomEvent('zhixing:locate-note-block', {
            detail: { noteId: link.id, blockKey: link.block },
          })
        )
      }
    }, 60)
    return () => window.clearTimeout(timer)
  }, [page, openNoteId, linkTick])

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
      const detail = (
        e as CustomEvent<{
          ids: number[]
          label: string
          action?: 'toggle' | 'restore'
          prevStatus?: TaskStatus
        }>
      ).detail
      if (!detail?.ids?.length) return
      setUndoBar(detail)
      window.setTimeout(() => setUndoBar((cur) => (cur === detail ? null : cur)), 6000)
    }
    window.addEventListener('zhixing:undoable', onUndoable)
    return () => window.removeEventListener('zhixing:undoable', onUndoable)
  }, [])

  /**
   * 打开主窗口并定位到某条任务。
   *
   * 抽成一个函数是因为这个参数**曾经在一条链路上被丢掉**：主窗口提醒卡片的 onOpenTask 当时是
   * \`setPage('tasks'); void id\` —— 于是卡片上的「查看」只切页、不定位，而气泡那条链路是好的。
   * 同一个语义两条实现，一条管用一条不管用。现在两条入口共用这一个。
   */
  const openTaskInList = useCallback((id: number): void => {
    setTaskFocus(null)
    setPage('tasks')
    // 等一帧：setPage 之后目标页才挂载，定位事件必须落在挂载完成之后（与深链同套路）
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('zhixing:open-task', { detail: { id } }))
    }, 60)
  }, [])

  // 提醒气泡里点「查看」：主进程已经把主窗口抬起来了，这里负责把那条任务送进列表并定位
  useEffect(() => window.zhixing.reminder.onOpenTask(openTaskInList), [openTaskInList])

  const undoLast = useCallback(async () => {
    if (!undoBar) return
    const { ids, action, prevStatus } = undoBar
    setUndoBar(null)
    // 撤销动作按来源区分：完成/取消完成 → 反向切换；删除 → 从回收站恢复
    //
    // 整批一次事务。原先是渲染层循环逐条 IPC：任一条失败即中断，而撤销条已经清掉了 ——
    // 用户既看不到错误，也没有重试入口（prevStatus 语义不变，仍由主进程分派）。
    await window.zhixing.db.batchUndoLast(ids, action ?? 'toggle', prevStatus ?? null)
    await refreshOverview()
    setToast(action === 'restore' ? `已恢复 ${ids.length} 项` : `已撤销 ${ids.length} 项完成`)
  }, [undoBar, refreshOverview])

  // Ctrl/Cmd+K 命令面板；Ctrl/Cmd+N 快速任务捕获（与手册一致）
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
        // 与应用内其它捕获入口一致：开独立窗口
        void window.zhixing.capture.open('quick')
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
      // Ctrl+Tab：在最近两个页面之间往返
      if (e.key === 'Tab') {
        e.preventDefault()
        if (prevPage.current) {
          const back = prevPage.current
          prevPage.current = page
          setPage(back)
        }
        return
      }
      // Ctrl+1..6：前六个导航页
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

  // Ctrl/Cmd+Z 撤销（与手册的「撤销最近一次完成/恢复」一致）
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
    window.setTimeout(() => setToast((t) => (t === message ? null : t)), TOAST_STAY_MS)
  }, [])

  // 底部撤销条：条件渲染 → 带退场的渲染。退场窗口里 undoBar 已经是 null，
  // 所以留一份最后的值，否则文字会先消失、再淡出。
  const { mounted: undoMounted, leaving: undoLeaving } = usePresence(undoBar !== null, 150)
  const lastUndoRef = useRef(undoBar)
  if (undoBar) lastUndoRef.current = undoBar
  const undoView = undoBar ?? lastUndoRef.current

  const current = useMemo(() => NAV_ITEMS.find((i) => i.key === page) ?? NAV_ITEMS[0], [page])

  return (
    <DialogProvider>
      <div className={'app' + (zen ? ' app--zen' : '')}>
        <TitleBar
        title={`知行 ZhiXing · ${current.label}`}
        theme={theme}
        onToggleTheme={toggleTheme}
        signature={appearance?.signature}
      />
      {/* 数据库只读 / 打不开时的危险横幅，铺在标题栏与主区之间（全宽），
          「恢复备份」跳设置页的数据页 —— 自动备份列表就在那里 */}
      {dbIssue && (
        <div className="dbwarn" role="alert">
          <span>数据库迁移失败，已进入只读模式：{dbIssue}</span>
          <button className="text-btn" onClick={() => setPage('settings')}>
            恢复备份
          </button>
        </div>
      )}
      <div className="app__body">
        <Sidebar
          page={page}
          collapsed={collapsed}
          inboxCount={overview?.inbox ?? 0}
          onSelect={setPage}
          onToggleCollapse={() => setCollapsed((c) => !c)}
        />
        <main className={`app__content app__content--${dir}`}>
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
            <NotesPage onNotice={showToast} initialNoteId={openNoteId} onZenChange={setZen} />
          ) : page === 'settings' ? (
            <SettingsPage onNotice={showToast} onChanged={refreshOverview} />
          ) : page === 'review' ? (
            <ReviewPage />
          ) : page === 'vault' ? (
            <VaultPage onNotice={showToast} />
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
          {/* 右下角快捷新建浮条已按用户要求取消（今日页 / 任务页都不再显示）：
              这两页各自已有明确的新建入口（今日页顶部输入框、任务页「＋ 新建任务」），
              浮条是第三个入口，反而是噪声。组件本身留在 components/FloatingDock.tsx 未删，
              要恢复只需把上面那段渲染放回来。 */}
        </main>
      </div>
      {/* 番茄钟从「右下角浮条」改成了独立小窗（2026-09-27）：
          它与主窗口的生命周期不同 —— 主窗口收进托盘/浮窗时专注还该继续。
          发起入口（任务行 / 命令面板 / 浮窗）统一走 window.zhixing.pomodoro.open()。 */}
      <ReminderPopup onChanged={refreshOverview} />

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
        onNotice={showToast}
      />

      {undoMounted && undoView && (
        <div className={'infobar' + (undoLeaving ? ' is-leaving' : '')} role="status">
          <span>{undoView.label}</span>
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
