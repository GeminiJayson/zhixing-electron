import { contextBridge, ipcRenderer } from 'electron'
import type { DeepLink } from '../shared/deep-link'
import type { AiLibraryOutcome, AiLibraryProgress, AiOrganizeOutcome } from '../shared/ai-note'
import type {
  AppInfo,
  Task,
} from '../shared/types'
import { noteApi } from './api/note'
import { taskApi } from './api/task'
import { graphApi } from './api/graph'
import { workflowApi } from './api/workflow'
import { reviewApi } from './api/review'
import { attachmentApi } from './api/attachment'
import { systemApi } from './api/system'

/** 渲染进程唯一的特权入口：只暴露显式列出的调用，不透传 ipcRenderer。 */
const api = {
  /** 渲染进程判断 macOS 红绿灯让位等平台差异用，避免靠 UA 嗅探。 */
  platform: process.platform as 'darwin' | 'win32' | 'linux',
  /*
    db 的实现按域拆在 api/ 下（173 个方法分了 7 个文件），这里只做拼装。
  */
  db: {
    ...noteApi,
    ...taskApi,
    ...graphApi,
    ...workflowApi,
    ...reviewApi,
    ...attachmentApi,
    ...systemApi,
  },
  /**
   * 全局热键唤出的捕获面板（独立小窗口）：主进程推 payload、渲染层回执。
   * 与条件确认窗同一套协议 —— 渲染层应用完主题发 ready，主进程才把窗口显示出来。
   */
  capture: {
    onOpen: (
      cb: (payload: { mode: 'quick' | 'capture'; seed: { text: string; html: string } }) => void
    ): (() => void) => {
      const handler = (
        _e: unknown,
        payload: { mode: 'quick' | 'capture'; seed: { text: string; html: string } }
      ): void => cb(payload)
      ipcRenderer.on('capture:open', handler)
      return () => ipcRenderer.removeListener('capture:open', handler)
    },
    /** 应用内入口（快捷键 / 浮条）主动开一个捕获窗口 */
    open: (mode: 'quick' | 'capture'): Promise<boolean> =>
      ipcRenderer.invoke('capture:open', mode),
    ready: (): void => ipcRenderer.send('capture:ready'),
    close: (): void => ipcRenderer.send('capture:close'),
    done: (message: string): void => ipcRenderer.send('capture:done', message),
  },
  /**
   * 快速笔记浮窗（独立小窗）。
   * 与 capture 同一套协议：ready 让主进程显示窗口（等主题应用完，避免先闪一下默认配色），
   * close 收窗，notice 把回执转给主窗口 —— 用户此刻在别的应用里，不该把主窗口拽出来。
   */
  quickNote: {
    /** 应用内入口（托盘 / 快捷键）主动开一个快速笔记窗 */
    open: (): Promise<boolean> => ipcRenderer.invoke('quicknote:open'),
    ready: (): void => ipcRenderer.send('quicknote:ready'),
    /** 直接设定内容尺寸（启动时恢复上次的尺寸用） */
    setSize: (width: number, height: number): Promise<boolean> =>
      ipcRenderer.invoke('quicknote:setSize', width, height),
    /** 拖窗口边缘/角落：开始 → 报位移 → 结束。方向是 n/s/e/w 的组合（如 ne） */
    resizeStart: (): Promise<boolean> => ipcRenderer.invoke('quicknote:resizeStart'),
    resize: (dir: string, dx: number, dy: number): Promise<boolean> =>
      ipcRenderer.invoke('quicknote:resize', dir, dx, dy),
    resizeEnd: (): Promise<string> => ipcRenderer.invoke('quicknote:resizeEnd'),
    close: (): void => ipcRenderer.send('quicknote:close'),
    notice: (message: string): void => ipcRenderer.send('quicknote:notice', message),
  },
  /**
   * 番茄钟（独立小窗，2026-09-27）：主窗口与浮窗都只是「发起方」，
   * 计时、暂停、中断与落库全部发生在那个窗口里 —— 主窗口关掉它也会继续跑。
   * 与捕获窗同一套协议：主进程推 payload、渲染层应用完主题发 ready 才显示。
   */
  pomodoro: {
    /** 发起一轮专注（taskId 为 null 表示不绑任务） */
    open: (payload: { taskId: number | null; title: string }): Promise<boolean> =>
      ipcRenderer.invoke('pomodoro:open', payload),
    onOpen: (cb: (payload: { taskId: number | null; title: string }) => void): (() => void) => {
      const handler = (_e: unknown, payload: { taskId: number | null; title: string }): void =>
        cb(payload)
      ipcRenderer.on('pomodoro:open', handler)
      return () => ipcRenderer.removeListener('pomodoro:open', handler)
    },
    ready: (): void => ipcRenderer.send('pomodoro:ready'),
    close: (): void => ipcRenderer.send('pomodoro:close'),
    /** 一轮结束/中断：把提示语与「数据变了」带给主窗口（它去刷新统计并弹提示） */
    done: (message: string): void => ipcRenderer.send('pomodoro:done', message),
    onDone: (cb: (message: string) => void): (() => void) => {
      const handler = (_e: unknown, message: string): void => cb(message)
      ipcRenderer.on('pomodoro:done', handler)
      return () => ipcRenderer.removeListener('pomodoro:done', handler)
    },
  },
  /**
   * 外部任务源：设置页手动同步 / 读状态 / 改完设置后重排定时器。
   * 类型与主进程 src/main/task-sync.ts 对齐（preload 不便 import 主进程代码）。
   */
  taskSync: {
    now: (): Promise<{ ok: boolean; message: string; total: number; created: number; updated: number; unchanged: number; skipped: number }> =>
      ipcRenderer.invoke('taskSync:now'),
    status: (): Promise<{ enabled: boolean; url: string; intervalMin: number; lastAt: string; lastResult: string }> =>
      ipcRenderer.invoke('taskSync:status'),
    reload: (): Promise<boolean> => ipcRenderer.invoke('taskSync:reload'),
  },
  /**
   * 工作流条件节点的人工确认（「提示确认」来源）：
   * 主进程发起询问 → 渲染层弹应用内对话框 → 回传成立 / 不成立。
   * 判定逻辑与原先一致，只是把原生模态换成了自绘弹框。
   */
  condition: {
    onAsk: (cb: (ask: { id: string; prompt: string }) => void): (() => void) => {
      const handler = (_e: unknown, ask: { id: string; prompt: string }): void => cb(ask)
      ipcRenderer.on('condition:confirm', handler)
      return () => ipcRenderer.removeListener('condition:confirm', handler)
    },
    answer: (id: string, ok: boolean): void => {
      ipcRenderer.send('condition:answer', id, ok)
    },
    /** 主题应用完毕：主进程收到后才把窗口显示出来，避免先闪一下默认配色 */
    ready: (): void => {
      ipcRenderer.send('condition:ready')
    },
  },
  /**
   * 笔记的「大模型解读整理归纳」。
   * 请求本身在主进程发出（渲染层不该拿到 API Key，也不该被 CORS 拦住）。
   */
  ai: {
    organizeNote: (noteId: number): Promise<AiOrganizeOutcome> =>
      ipcRenderer.invoke('ai:organizeNote', noteId),
    testConnection: (): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('ai:testConnection'),
    /** 逐篇整理整个笔记库（串行，可停止；只处理 Markdown / 富文本） */
    organizeLibrary: (): Promise<AiLibraryOutcome> => ipcRenderer.invoke('ai:organizeLibrary'),
    /** 停止整库整理；返回可读说明，便于区分「没任务在跑」与「已请求停止」 */
    cancelLibrary: (): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('ai:cancelLibrary'),
    /** 挂载时问一次当前进度（比如切页回来时任务还在跑） */
    libraryProgress: (): Promise<AiLibraryProgress | null> => ipcRenderer.invoke('ai:libraryProgress'),
    /** 整库整理的进度推送；返回值是取消订阅 */
    onLibraryProgress: (cb: (p: AiLibraryProgress) => void): (() => void) => {
      const handler = (_e: unknown, p: AiLibraryProgress): void => cb(p)
      ipcRenderer.on('ai:libraryProgress', handler)
      return () => ipcRenderer.removeListener('ai:libraryProgress', handler)
    },
  },
  /**
   * 知识库。
   *
   * 注意这里**没有"创建可用知识"的入口** —— create 一律产出待确认，
   * 想变可用只能走 verify，而它会对知识类条目检查来源（见方案 §4 / §8）。
   */
  knowledge: {
    kinds: (): Promise<{ key: string; label: string; needsSource: boolean }[]> =>
      Promise.resolve([
        { key: 'note', label: '笔记', needsSource: false },
        { key: 'project', label: '项目记录', needsSource: false },
        { key: 'concept', label: '概念', needsSource: true },
        { key: 'summary', label: '摘要', needsSource: true },
        { key: 'synthesis', label: '综合分析', needsSource: true },
        { key: 'method', label: '方法论', needsSource: true },
        { key: 'output', label: '输出', needsSource: true },
        { key: 'pitfall', label: '踩坑', needsSource: true },
      ]),
    list: (filter: {
      kind?: string
      status?: 'draft' | 'verified' | 'all'
      includeArchived?: boolean
      limit?: number
    }): Promise<
      {
        id: number
        title: string
        kind: string
        verified_at: string | null
        archived_at: string | null
        verify_note: string | null
        updated_at: string | null
        /** 是否有来源（derived_from 引用）—— 筛选条上「无来源」那一档用它 */
        has_source: number
        /** 有多少条知识引用了它 —— 0 就是「提炼了却没人用」 */
        ref_count: number
      }[]
    > => ipcRenderer.invoke('knowledge:list', filter),
    counts: (): Promise<Record<string, { verified: number; draft: number }>> =>
      ipcRenderer.invoke('knowledge:counts'),
    /** 三个"待办数字"：待确认 / 无来源 / 未被引用 */
    health: (): Promise<{ draft: number; noSource: number; unused: number }> =>
      ipcRenderer.invoke('knowledge:health'),
    meta: (id: number): Promise<unknown> => ipcRenderer.invoke('knowledge:meta', id),
    create: (input: {
      title: string
      content: string
      kind: string
      sourceNoteId?: number | null
    }): Promise<{ ok: boolean; id?: number; message?: string }> =>
      ipcRenderer.invoke('knowledge:create', input),
    /** 核对通过。evidence 为 'no' 时主进程会拒绝 —— 没有依据的结论不该进可用区 */
    verify: (
      id: number,
      check: {
        v: 1
        evidence: 'yes' | 'partial' | 'no'
        scope: string
        conflict: string
        freshness: string
        extra: string
      }
    ): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke('knowledge:verify', id, check),
    unverify: (id: number, reason: string): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke('knowledge:unverify', id, reason),
    /** 改类型。若改成"需要来源"的类型而它没有来源，会自动退回待确认（返回 demoted: true） */
    setKind: (id: number, kind: string): Promise<{ ok: boolean; demoted?: boolean }> =>
      ipcRenderer.invoke('knowledge:setKind', id, kind),
    archive: (id: number): Promise<boolean> => ipcRenderer.invoke('knowledge:archive', id),
    unarchive: (id: number): Promise<boolean> => ipcRenderer.invoke('knowledge:unarchive', id),
    sources: (id: number): Promise<{ title: string; kind: string; noteId: number | null }[]> =>
      ipcRenderer.invoke('knowledge:sources', id),
    /** 挂一条来源（kind 默认 derived_from） */
    link: (id: number, sourceId: number, kind?: string): Promise<boolean> =>
      ipcRenderer.invoke('knowledge:link', id, sourceId, kind ?? 'derived_from'),
    unlink: (id: number, title: string): Promise<boolean> => ipcRenderer.invoke('knowledge:unlink', id, title),
    /** 按标题搜可当来源的笔记 */
    searchSources: (query: string): Promise<{ id: number; title: string; kind: string }[]> =>
      ipcRenderer.invoke('knowledge:searchSources', query),
    derivedFrom: (sourceId: number): Promise<{ id: number; title: string }[]> =>
      ipcRenderer.invoke('knowledge:derivedFrom', sourceId),
    canDelete: (sourceId: number): Promise<{ ok: boolean; count: number; titles: string[] }> =>
      ipcRenderer.invoke('knowledge:canDelete', sourceId),
  },
  /**
   * 密码保险箱。
   *
   * 注意这里**没有任何"把主密钥交给渲染层"的通道** —— 密钥始终留在主进程的
   * vault/store 里，渲染层只能拿到"解密后的结果"。这是刻意的（见方案 §5.1）。
   */
  vault: {
    status: (): Promise<'uninitialized' | 'locked' | 'unlocked'> => ipcRenderer.invoke('vault:status'),
    setup: (password: string): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke('vault:setup', password),
    unlock: (password: string): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke('vault:unlock', password),
    lock: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('vault:lock'),
    list: (): Promise<{
      ok: boolean
      entries: {
        id: number
        title: string
        username: string
        password: string
        url: string
        notes: string
        tags: string[]
        created_at: string
        updated_at: string
      }[]
      message?: string
    }> => ipcRenderer.invoke('vault:list'),
    create: (input: {
      title: string
      username: string
      password: string
      url: string
      notes: string
      tags: string[]
    }): Promise<{ ok: boolean; entry?: unknown; message?: string }> =>
      ipcRenderer.invoke('vault:create', input),
    update: (
      id: number,
      input: { title: string; username: string; password: string; url: string; notes: string; tags: string[] }
    ): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke('vault:update', id, input),
    remove: (id: number): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke('vault:remove', id),
    destroy: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('vault:destroy'),
    touch: (): Promise<boolean> => ipcRenderer.invoke('vault:touch'),
    copy: (text: string): Promise<boolean> => ipcRenderer.invoke('vault:copy', text),
    generate: (opts?: {
      length?: number
      upper?: boolean
      lower?: boolean
      digits?: boolean
      symbols?: boolean
    }): Promise<string> => ipcRenderer.invoke('vault:generate', opts),
    strength: (password: string): Promise<{ score: number; label: string }> =>
      ipcRenderer.invoke('vault:strength', password),
    /** 订阅"被锁定"（手动 / 自动 / 主进程触发）。返回取消订阅函数。 */
    onLocked: (cb: () => void): (() => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('vault:locked', handler)
      return () => ipcRenderer.removeListener('vault:locked', handler)
    },

    // ------------------------------------------------------------ 浏览器导入
    /** 机器上装了哪些浏览器、各有多少 profile */
    browsers: (): Promise<{ key: 'chrome' | 'edge'; label: string; profiles: string[] }[]> =>
      ipcRenderer.invoke('vault:browsers'),
    /** 从浏览器导入已保存的密码（读的是用户自己的数据，不是键盘钩子） */
    importBrowser: (key: 'chrome' | 'edge'): Promise<{ ok: boolean; message?: string; imported: number }> =>
      ipcRenderer.invoke('vault:importBrowser', key),

    // ------------------------------------------------------------ 浏览器扩展
    /** 浏览器扩展要用的端口与令牌（令牌只用于写入，锁定状态下端点拒收） */
    httpInfo: (): Promise<{ port: number; token: string }> => ipcRenderer.invoke('vault:httpInfo'),
    /** 重新生成令牌；已配好的扩展需要重新粘一次 */
    rotateToken: (): Promise<{ token: string }> => ipcRenderer.invoke('vault:rotateToken'),

    // ------------------------------------------------------------ 剪贴板助手
    clipboardStart: (): Promise<boolean> => ipcRenderer.invoke('vault:clipboardStart'),
    clipboardStop: (): Promise<boolean> => ipcRenderer.invoke('vault:clipboardStop'),
    clipboardTake: (): Promise<string> => ipcRenderer.invoke('vault:clipboardTake'),
    /**
     * 订阅"剪贴板里出现了像密码的内容"。
     * 主进程只在保险箱解锁时监听，锁定时会自动停掉。
     */
    onClipboardCandidate: (cb: (text: string) => void): (() => void) => {
      const handler = (_e: unknown, text: string): void => cb(text)
      ipcRenderer.on('vault:clipboardCandidate', handler)
      return () => ipcRenderer.removeListener('vault:clipboardCandidate', handler)
    },
  },
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
    setTheme: (theme: 'light' | 'dark' | 'system'): Promise<void> =>
      ipcRenderer.invoke('theme:set', theme),
    /** 云母材质开关（仅 win32 生效，其他平台为空操作） */
    /** 首屏数据就绪：主进程据此关闭欢迎页并显示主窗（splash 流程） */
    ready: (): Promise<void> => ipcRenderer.invoke('app:ready'),
    /** 托盘图标按当前主题重建 */
    refreshTray: (): Promise<void> => ipcRenderer.invoke('app:refreshTray'),
    /** 热键注册状态（settings 键 → 中文状态串） */
    hotkeyStatus: (): Promise<Record<string, string>> => ipcRenderer.invoke('app:hotkeyStatus'),
    /** 应用内触发一次全局动作（与全局热键走同一条分发函数） */
    hotkeyAction: (action: string): Promise<void> =>
      ipcRenderer.invoke('app:hotkeyAction', action),
    /** 探测组合键当前能否注册（注册成功立刻注销）；改键浮层用它当场给结果 */
    probeHotkey: (combo: string): Promise<boolean> =>
      ipcRenderer.invoke('app:probeHotkey', combo),
    /** 进入改键捕获态：先注销全部热键，避免组合键被系统层拦截 */
    suspendHotkeys: (): Promise<void> => ipcRenderer.invoke('app:suspendHotkeys'),
    /** 改键完成/取消后重注册全部热键，返回最新状态 */
    rebindHotkeys: (): Promise<Record<string, string>> => ipcRenderer.invoke('app:rebindHotkeys'),
    /**
     * 深链跳转（zhixing:// …）。
     * 载荷形状用 shared/deep-link 的 DeepLink：图页双击跨页跳转也复用这条通道，
     * 因此 kind 只可能是 task / note / flash / folder。
     */
    onDeepLink: (cb: (link: DeepLink) => void): (() => void) => {
      const handler = (_e: unknown, link: DeepLink): void => cb(link)
      ipcRenderer.on('app:deeplink', handler)
      return () => ipcRenderer.removeListener('app:deeplink', handler)
    },
    /**
     * 托盘 / 全局热键触发的应用动作。
     * 「划词捕获 / 读取选中并速记 / 快速任务」这三个会带上主进程刚取到的**当前选中文字**
     * （文本 + HTML，HTML 用于解析来源 URL）。
     */
    onAction: (
      cb: (action: string, payload?: { text: string; html: string }) => void
    ): (() => void) => {
      const handler = (
        _e: unknown,
        action: string,
        payload?: { text: string; html: string }
      ): void => cb(action, payload || undefined)
      ipcRenderer.on('app:action', handler)
      return () => ipcRenderer.removeListener('app:action', handler)
    },
    /** 独立弹窗（无边框）把窗口高度贴合卡片内容 */
    fitHeight: (height: number): void => ipcRenderer.send('window:fitHeight', height),
    /**
     * 通知主进程重新确认窗口透明。
     * 主题切换会重建 Chromium 的合成器，Windows 上的透明窗口在那之后会丢逐像素透明 ——
     * 表现为页面里的玻璃层次整体失效。每次 applyAppearance 之后调一次。
     */
    reassertTransparency: (): Promise<boolean> => ipcRenderer.invoke('window:reassertTransparency'),
    /**
     * 快速笔记浮窗的"钉住"：钉住后窗口常驻、失焦不自动关闭。
     * 主进程记着这个标志，并据此决定 blur 时要不要收窗。
     */
    setQuickNotePinned: (pinned: boolean): Promise<boolean> =>
      ipcRenderer.invoke('quicknote:setPinned', pinned),
  },
  widget: {
    toggle: (): Promise<boolean> => ipcRenderer.invoke('widget:toggle'),
    close: (): Promise<void> => ipcRenderer.invoke('widget:close'),
    /**
     * 浮窗透明度（百分比）。值由主进程推给渲染层，真正画出来的是 CSS opacity ——
     * 窗口自己的 setOpacity 在 Windows 上会破坏透明窗口的逐像素透明（见 main/index.ts）。
     */
    setOpacity: (value: number): Promise<void> => ipcRenderer.invoke('widget:setOpacity', value),
    /** 当前透明度：挂载时问一次，之后靠 onOpacity 推送（推送可能早于渲染层挂载） */
    opacity: (): Promise<number> => ipcRenderer.invoke('widget:opacityGet'),
    onOpacity: (cb: (value: number) => void): (() => void) => {
      const handler = (_e: unknown, value: number): void => cb(value)
      ipcRenderer.on('widget:opacity', handler)
      return () => ipcRenderer.removeListener('widget:opacity', handler)
    },
    setClickThrough: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke('widget:setClickThrough', enabled),
    undock: (): Promise<void> => ipcRenderer.invoke('widget:undock'),
    /** 悬浮球拖动：只报告「正在拖」，位移由主进程按屏幕光标重算 */
    dragStart: (): Promise<void> => ipcRenderer.invoke('widget:dragStart'),
    dragTo: (): Promise<void> => ipcRenderer.invoke('widget:dragTo'),
    dragEnd: (moved: boolean): Promise<void> => ipcRenderer.invoke('widget:dragEnd', moved),
    /** 改悬浮球大小（球体边长，主进程钳在 88~160） */
    setBallSize: (size: number): Promise<void> => ipcRenderer.invoke('widget:setBallSize', size),
    /** 当前形态：'ball' 贴边收缩成悬浮球 / 'full' 完整卡片 */
    getMode: (): Promise<'full' | 'ball'> => ipcRenderer.invoke('widget:mode'),
    /** 悬浮球当前体型（bloub 的形状 id） */
    ballShape: (): Promise<string> => ipcRenderer.invoke('widget:ballShape'),
    /** 改悬浮球体型（bloub 的形状 id）；与右键菜单同一个入口 */
    setBallShape: (id: string): Promise<void> =>
      ipcRenderer.invoke('widget:setBallShape', id),
    /** 主进程改了体型后推一次（右键菜单选形状） */
    onBallShape: (cb: (shape: string) => void): (() => void) => {
      const handler = (_e: unknown, shape: string): void => cb(shape)
      ipcRenderer.on('widget:ballShape', handler)
      return () => ipcRenderer.removeListener('widget:ballShape', handler)
    },
    /** 主进程切换形态时推送（贴边收缩 / 展开 / 启动时恢复贴边态） */
    onMode: (cb: (mode: 'full' | 'ball') => void): (() => void) => {
      const handler = (_e: unknown, mode: 'full' | 'ball'): void => cb(mode)
      ipcRenderer.on('widget:mode', handler)
      return () => ipcRenderer.removeListener('widget:mode', handler)
    },
    /** 边缘缩放：渲染层判定命中的边后交给主进程按屏幕光标重算尺寸 */
    resizeStart: (edges: string): Promise<void> => ipcRenderer.invoke('widget:resizeStart', edges),
    resizeTo: (): Promise<void> => ipcRenderer.invoke('widget:resizeTo'),
    resizeEnd: (): Promise<void> => ipcRenderer.invoke('widget:resizeEnd'),
    contextMenu: (): Promise<void> => ipcRenderer.invoke('widget:contextMenu'),
    openMain: (): Promise<void> => ipcRenderer.invoke('widget:openMain'),
    /** 主进程告知「当前有 N 条提醒」，球据此切 notify 表情（0 = 回到常规节拍） */
    onNotice: (cb: (count: number) => void): (() => void) => {
      const handler = (_e: unknown, count: number): void => cb(count)
      ipcRenderer.on('widget:notice', handler)
      return () => ipcRenderer.removeListener('widget:notice', handler)
    },
  },
  /**
   * 到点提醒。消费（清 reminder_at）已收归主进程一处，这里只剩读与「用户处理了」——
   * 渲染层不再自己查库，否则气泡窗口与主窗口会互相抢着清，反而少看到一条。
   */
  reminder: {
    /** 当前待展示的提醒（含已消费、但用户还没处理的那一份） */
    current: (): Promise<Task[]> => ipcRenderer.invoke('reminder:current'),
    dismiss: (id: number): Promise<Task[]> => ipcRenderer.invoke('reminder:dismiss', id),
    snooze: (id: number, minutes: number): Promise<Task[]> =>
      ipcRenderer.invoke('reminder:snooze', id, minutes),
    /** 不再提醒这条（只对这一次生效；活动流里记 mute，与"知道了"区分开） */
    mute: (id: number, reason?: string | null): Promise<Task[]> =>
      ipcRenderer.invoke('reminder:mute', id, reason ?? null),
    /** 气泡量完内容高度上报，主进程据此贴边定位 */
    resize: (height: number): Promise<void> => ipcRenderer.invoke('reminder:resize', height),
    /** 打开主窗口并定位到该任务 */
    openTask: (id: number): Promise<void> => ipcRenderer.invoke('reminder:openTask', id),
    onPush: (cb: (rows: Task[]) => void): (() => void) => {
      const handler = (_e: unknown, rows: Task[]): void => cb(rows)
      ipcRenderer.on('reminder:push', handler)
      return () => ipcRenderer.removeListener('reminder:push', handler)
    },
    onOpenTask: (cb: (id: number) => void): (() => void) => {
      const handler = (_e: unknown, id: number): void => cb(id)
      ipcRenderer.on('reminder:openTask', handler)
      return () => ipcRenderer.removeListener('reminder:openTask', handler)
    },
  },
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggleMaximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
  },
}

export type ZhixingApi = typeof api

contextBridge.exposeInMainWorld('zhixing', api)
