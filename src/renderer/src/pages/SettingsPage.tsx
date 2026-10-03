import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert, Database, Download, FileText, Info, Link2, Palette, RefreshCw, SlidersHorizontal, Sparkles, Tag, Timer, Trash2 } from '@renderer/lib/icons'
import { parseSettings, type AppSettings } from '@shared/settings'
import {
  AI_PROTOCOLS,
  DEFAULT_AI_LIBRARY_PROMPT,
  DEFAULT_AI_PROMPT,
  normalizeAiProtocol,
} from '@shared/ai-note'
import {
  CUSTOM_THEME_TOKENS,
  PACK_ACCENT,
  THEME_PACK_NAMES,
  accentForPack,
  effectiveThemeColors,
  parseThemeOverrides,
  type ThemeColors,
} from '@shared/theme-packs'
import { Toolbar } from '../components/Toolbar'
import { applyAppearance, prefersReducedMotion, resolveThemeMode } from '../theme'
import { useDialog } from '../components/Dialogs'
import type { AppInfo } from '@shared/types'
import { RecycleBin } from '../components/RecycleBin'
import { TagManager } from '../components/TagManager'
import { quietFailure } from '@shared/quiet-failure'

interface Props {
  onNotice: (message: string) => void
  onChanged: () => Promise<void>
}

type Tab = 'general' | 'hotkeys' | 'tasks' | 'integrations' | 'data' | 'ai' | 'about'

/**
 * 强调色是否还"在联动体系内"（没有被人为改过）。
 *
 * 两个来源都要认：界面上的预设色板，以及各主题包带出来的推荐色 ——
 * 换包时强调色会被自动设成后者，如果只认前者，那么"换一次包"就会被误判成
 * "用户自定义过"，从此不再联动。
 */
const isPresetAccent = (c: string): boolean =>
  ACCENTS.includes(c) || Object.values(PACK_ACCENT).includes(c)

const ACCENTS = ['#0D9488', '#2563EB', '#7C3AED', '#DB2777', '#EA580C', '#16A34A', '#D97706', '#0891B2']

/** 外部任务同步的字段映射项：留空 = 按候选字段名自动识别 */
const API_MAP_FIELDS: { key: string; label: string; placeholder: string }[] = [
  { key: 'id', label: 'ID', placeholder: '如 data.id（必填）' },
  { key: 'title', label: '标题', placeholder: '如 attributes.name（必填）' },
  { key: 'notes', label: '备注', placeholder: '如 description' },
  { key: 'due', label: '截止', placeholder: '如 due_date' },
  { key: 'priority', label: '优先级', placeholder: '如 priority' },
  { key: 'done', label: '是否完成', placeholder: '如 completed' },
]

/** 附件占用大小的可读格式 */
function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

/** 解析字段映射的设置值；坏 JSON 当没配 */
function parseMapDraft(raw: string): Record<string, string> {
  try {
    const v = JSON.parse(raw || '{}') as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 可改键的四项全局热键。
 * hint 是改键失败时的降级说明 —— 注册不上的热键一律回到托盘菜单。
 */
const HOTKEY_ROWS: { key: keyof AppSettings; label: string; hint: string }[] = [
  { key: 'capture_hotkey', label: '划词捕获', hint: '捕获当前选中内容' },
  {
    key: 'select_quick_hotkey',
    label: '读取选中并速记',
    hint: '读取选中文字预填快速捕获',
  },
  {
    key: 'flash_quick_hotkey',
    label: '选中入闪念',
    hint: '读选中文字直接存进闪念，不弹窗',
  },
  { key: 'quick_capture_hotkey', label: '快速任务', hint: '弹出快速捕获窗口' },
  { key: 'widget_hotkey', label: '浮窗显隐', hint: '显示 / 隐藏桌面浮窗' },
  {
    key: 'quick_note_hotkey',
    label: '快速笔记',
    hint: '唤出快速笔记浮窗（默认未设置，录一个组合键即可）',
  },
]

/**
 * 分区顺序按「从常用到少用」：日常会调的（通用、快捷键、任务）在前，
 * 一次配好就不动的（集成、数据、AI、关于）在后。
 */
const TABS: { key: Tab; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'hotkeys', label: '快捷键' },
  { key: 'tasks', label: '任务与提醒' },
  { key: 'integrations', label: '集成' },
  { key: 'data', label: '数据与安全' },
  { key: 'ai', label: 'AI 整理' },
  { key: 'about', label: '关于' },
]

export function SettingsPage({ onNotice, onChanged }: Props) {
  const dialog = useDialog()
  const [tab, setTab] = useState<Tab>('general')
  /**
   * 浏览器扩展的端口与令牌。
   * **与保险箱状态无关** —— 它服务于"扩展连本机端点"，随时都该看得到。
   */
  const [httpInfo, setHttpInfo] = useState<{ port: number; token: string } | null>(null)
  /** 令牌默认不显示：它会出现在屏幕上，而屏幕可能正被别人看着 */
  const [showToken, setShowToken] = useState(false)

  useEffect(() => {
    void window.zhixing?.vault?.httpInfo?.().then(setHttpInfo)
  }, [])
  const [settings, setSettings] = useState<AppSettings>(() => parseSettings())
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [recycleOpen, setRecycleOpen] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  /** settings 表的原始 KV 快照：写库前用它算出「乐观设置」，好让界面先动起来 */
  const rawRef = useRef<Record<string, string>>({})
  /** 自动备份列表（进入「数据」页时刷新） */
  const [backups, setBackups] = useState<{ name: string; path: string; bytes: number }[]>([])
  /** 系统级「减少动态效果」探测结果 */
  const [osReducedMotion, setOsReducedMotion] = useState(() => prefersReducedMotion())
  /** 热键注册状态：settings 键 → 中文状态串 */
  const [hotkeys, setHotkeys] = useState<Record<string, string>>({})
  /** 正在改键的 settings 键；null = 未在改键 */
  const [rebinding, setRebinding] = useState<keyof AppSettings | null>(null)
  /** 捕获到的组合键（显示用；真正取值走 ref，避免键盘监听闭包读到旧值） */
  const [captured, setCaptured] = useState('')
  /** 当场预检这个组合能不能注册；busy = 被别的程序占用 */
  const [probe, setProbe] = useState<'idle' | 'checking' | 'ok' | 'busy'>('idle')
  const capturedRef = useRef('')
  /** 密度滑块是否正在拖动：拖动中一律不给过渡（每帧重启过渡会发黏），松手后才允许收尾 */
  const [sliding, setSliding] = useState(false)

  useEffect(() => {
    if (tab !== 'data') return
    void window.zhixing.db.listBackups().then(setBackups)
  }, [tab])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (): void => setOsReducedMotion(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // 密度滑块：松手（或指针被取消）就退出拖动态。监听挂在 window 上 ——
  // 拖动时指针常常会移到卡片外面才抬起。
  useEffect(() => {
    if (!sliding) return
    const end = (): void => setSliding(false)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [sliding])

  // 读一次热键注册状态
  useEffect(() => {
    void window.zhixing.app
      .hotkeyStatus()
      .then(setHotkeys)
      .catch(() => undefined)
  }, [])

  /** 结束改键：save=true 时先落库，然后无论成败都重注册并刷新状态标签。 */
  const finishRebind = useCallback(
    async (save: boolean): Promise<void> => {
      // 幂等：遮罩点击与键盘事件可能同时触发
      if (!rebinding) return
      const key = rebinding
      const combo = capturedRef.current
      setRebinding(null)
      setCaptured('')
      capturedRef.current = ''
      // 保存这一步是否真的成功。失败时不能继续往下报「已改好」——
      // onNotice 只有一条，后一句会把前面那句失败提示直接盖掉，
      // 用户于是看到「改键成功」却发现设置页里还是旧值（报过这个现象）
      let saved = false
      if (save && key && combo) {
        try {
          await window.zhixing.db.setSetting(key, combo)
          rawRef.current = await window.zhixing.db.settings()
          setSettings(parseSettings(rawRef.current))
          saved = true
        } catch (err) {
          onNotice(`热键未能保存：${(err as Error).message}`)
        }
      }
      // 取消也要重注册：进入捕获态时已把全部热键注销了
      let next: Record<string, string> = {}
      try {
        next = await window.zhixing.app.rebindHotkeys()
        setHotkeys(next)
      } catch (err) {
        // 重注册整体失败：这次连状态都是旧的，别让界面显示成「已改好」
        onNotice(`热键重注册失败：${(err as Error).message}`)
        return
      }
      if (!save || !key || !combo) {
        // 按出了组合又放弃（Esc / 点浮层外面）：浮层里已经把新组合显示出来了，
        // 不给一句话很容易被当成「已经改好了」
        if (!save && key && combo) onNotice('已取消，热键没有改动')
        return
      }
      if (!saved) return
      // 注册不上时**绝不能**报「已改好」：用户会以为生效了、按下去却没反应 ——
      // 这正是「设置页改键不生效」最常见的原因（组合被别的程序占用）
      if ((next[key] ?? '').includes('已注册')) onNotice(`热键已改为 ${combo}`)
      else onNotice(`「${combo}」没能注册：这个组合已被别的程序占用，换一个再试`)
    },
    [rebinding, onNotice]
  )

  /** 改键捕获：必须有修饰键；Enter 确认、Esc 取消。 */
  useEffect(() => {
    if (!rebinding) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        void finishRebind(false)
        return
      }
      if (e.key === 'Enter') {
        if (capturedRef.current) void finishRebind(true)
        return
      }
      const parts: string[] = []
      if (e.ctrlKey) parts.push('ctrl')
      if (e.altKey) parts.push('alt')
      if (e.shiftKey) parts.push('shift')
      if (e.metaKey) parts.push('cmd')
      const k = e.key.toLowerCase()
      if (['control', 'alt', 'shift', 'meta'].includes(k)) return
      // 至少一个修饰键，否则会抢占普通按键输入（与 toAccelerator 的校验一致）
      if (!parts.length) return
      parts.push(k === ' ' ? 'space' : k)
      const combo = parts.join('+')
      capturedRef.current = combo
      setCaptured(combo)
      // 当场预检：进捕获态时旧热键已全部注销，此刻注册一次最干净 ——
      // 让用户在**按下组合的那一刻**就知道它能不能用，而不是保存后才发现注册失败
      setProbe('checking')
      void window.zhixing.app
        .probeHotkey(combo)
        .then((ok) => setProbe(ok ? 'ok' : 'busy'))
        .catch(() => setProbe('idle'))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [rebinding, finishRebind])

  useEffect(() => {
    void (async () => {
      try {
        rawRef.current = await window.zhixing.db.settings()
      } catch {
        // 读不到就用默认值：设置页仍可操作，不能整页失效
      }
      setSettings(parseSettings(rawRef.current))
      setInfo(await window.zhixing.app.info())
    })()
  }, [])

  /** AI 整理：连接测试的进行态，以及提示词的本地草稿（大段文本不适合每敲一个字就写库）。 */
  const [aiTesting, setAiTesting] = useState(false)
  const [promptDraft, setPromptDraft] = useState('')
  /** 整库整理提示词草稿（留空表示「与单篇那份相同」） */
  const [libPromptDraft, setLibPromptDraft] = useState('')

  // 提示词：库里有就用库里的，没有则铺上默认提示词（用户可在此基础上改）
  useEffect(() => {
    setPromptDraft(settings.ai_prompt || DEFAULT_AI_PROMPT)
  }, [settings.ai_prompt])
  useEffect(() => {
    // 没自定义过就铺上「整库专用」的默认提示词（比单篇更克制），而不是留空
    setLibPromptDraft(settings.ai_library_prompt || DEFAULT_AI_LIBRARY_PROMPT)
  }, [settings.ai_library_prompt])

  /** 外部任务同步：状态 + 手动触发。改完地址/开关/间隔后让主进程重排定时器。 */
  const [syncStatus, setSyncStatus] = useState<{ lastAt: string; lastResult: string } | null>(null)
  const [syncing, setSyncing] = useState(false)
  /**
   * 暂存区里没人引用的附件。
   *
   * 与上面的「清理失效与孤儿文件」不是一回事：那个走 attachment 表，
   * 清的是"记录还在、文件没了"与"目录里有文件、记录没了"；
   * 这里清的是 attachments/pending/ 下**没有任何闪念或笔记引用**的文件 ——
   * 搬移逻辑修好之前积下的，或者闪念被删之后留下来的。
   */
  const [orphans, setOrphans] = useState<{ name: string; bytes: number }[]>([])
  /** 附件统计（数量 / 占用 / 失效） */
  const [attStats, setAttStats] = useState<{ count: number; bytes: number; missing: number; dir: string } | null>(
    null
  )

  const refreshAttachments = useCallback(async (): Promise<void> => {
    try {
      setAttStats(await window.zhixing.db.attachmentStats())
      setOrphans(await window.zhixing.db.orphanFiles())
    } catch (e) {
      // 附件统计整块消失，用户以为没有附件
      quietFailure('读取附件统计', e)
      setAttStats(null)
    }
  }, [])

  /** 清掉暂存区里没人引用的附件，并刷新计数 */
  const handleCleanOrphans = async (): Promise<void> => {
    const n = await window.zhixing.db.cleanOrphanFiles()
    setOrphans(await window.zhixing.db.orphanFiles())
    onNotice(n > 0 ? '已清理 ' + n + ' 个未引用的暂存附件' : '没有可清理的暂存附件')
  }

  const handlePruneAttachments = async (): Promise<void> => {
    const res = await window.zhixing.db.pruneAttachments()
    await refreshAttachments()
    onNotice(
      res.removedRows || res.removedFiles
        ? `已清理 ${res.removedRows} 条失效记录、${res.removedFiles} 个孤儿文件`
        : '没有需要清理的附件'
    )
  }

  useEffect(() => {
    void refreshAttachments()
  }, [refreshAttachments])

  /** 清单（list 类型的文件夹）—— 外部同步的落点候选 */
  const [lists, setLists] = useState<{ id: number; name: string }[]>([])

  useEffect(() => {
    void window.zhixing.db
      .listFolders()
      .then((rows) =>
        setLists(
          (rows as { id: number; name: string; kind?: string }[]).filter((f) => f.kind === 'list')
        )
      )
      .catch(() => setLists([]))
  }, [])
  /** 字段映射草稿：改哪个就即时落库（空值会被剔除，全空则存空串 = 自动识别） */
  const [mapDraft, setMapDraft] = useState<Record<string, string>>({})

  useEffect(() => {
    setMapDraft(parseMapDraft(settings.task_api_map))
  }, [settings.task_api_map])

  const updateMapField = (key: string, value: string): void => {
    const next = { ...mapDraft, [key]: value }
    setMapDraft(next)
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(next)) if (v.trim()) clean[k] = v.trim()
    void update('task_api_map', Object.keys(clean).length ? JSON.stringify(clean) : '')
  }

  useEffect(() => {
    void window.zhixing.taskSync.status().then(setSyncStatus).catch(() => setSyncStatus(null))
  }, [])

  const updateApi = async (key: keyof AppSettings, value: string): Promise<void> => {
    await update(key, value)
    await window.zhixing.taskSync.reload()
  }

  const handleSyncNow = async (): Promise<void> => {
    setSyncing(true)
    try {
      const res = await window.zhixing.taskSync.now()
      onNotice(res.message)
      setSyncStatus(await window.zhixing.taskSync.status())
    } finally {
      setSyncing(false)
    }
  }

  const handleTestAi = async (): Promise<void> => {
    setAiTesting(true)
    try {
      const res = await window.zhixing.ai.testConnection()
      onNotice(res.message)
    } finally {
      setAiTesting(false)
    }
  }

  const update = useCallback(
    async (key: keyof AppSettings, value: string): Promise<void> => {
      // 外观是纯 UI：先用「原始表 + 本次改动」把界面立即铺开。
      // 写库失败不该让整次切换看起来毫无反应——
      // 旧顺序把 applyAppearance 排在 await setSetting 之后，一失败就只剩窗口底色在变。
      const optimistic = parseSettings({ ...rawRef.current, [key]: value })
      setSettings(optimistic)
      applyAppearance(optimistic)
      if (key === 'widget_opacity') await window.zhixing.widget.setOpacity(optimistic.widget_opacity)
      if (key === 'widget_click_through') {
        await window.zhixing.widget.setClickThrough(optimistic.widget_click_through)
      }
      try {
        await window.zhixing.db.setSetting(key, value)
        // 写完回读并重新解析：state 始终是类型化值，不再散落字符串
        rawRef.current = await window.zhixing.db.settings()
        const next = parseSettings(rawRef.current)
        setSettings(next)
        applyAppearance(next)
      } catch (err) {
        onNotice(`设置未能保存：${(err as Error).message}`)
      }
    },
    [onNotice]
  )

  // ---- 主题自定义：强调色任意取色 + 主题包 token 覆盖（按当前模式分别存） ----
  /** 实际生效的明暗模式（theme_mode=system 时按系统解析） */
  const themeMode = resolveThemeMode(settings.theme_mode)
  /** 自定义覆盖存在哪个键：浅色与深色各一套，互不影响 */
  const themeCustomKey: keyof AppSettings = themeMode === 'dark' ? 'theme_custom_dark' : 'theme_custom_light'
  const themeOverrides = parseThemeOverrides(settings[themeCustomKey])
  /** 当前实际生效的配色（主题包 + 用户覆盖），设置页用它显示色块的当前值 */
  const themeColors = effectiveThemeColors(settings.theme_pack, themeMode, themeOverrides)

  const setCustomToken = (token: keyof ThemeColors, color: string): void => {
    void update(themeCustomKey, JSON.stringify({ ...themeOverrides, [token]: color }))
  }

  /** 清空当前模式的自定义配色，回到主题包原样 */
  const resetCustomTheme = (): void => {
    void update(themeCustomKey, '')
  }

  const toggleThemeMode = (mode: 'light' | 'dark' | 'system'): void => {
    // 主题由 App 的主题状态驱动（会同步写回 settings），这里只派发一次切换请求
    document.documentElement.dataset.theme = mode
    void window.zhixing.app.setTheme(mode)
    void update('theme_mode', mode)
  }

  /** 从自动备份恢复：主进程会先给当前库留一份 pre-restore 备份。 */
  const handleRestore = async (file: string): Promise<void> => {
    const confirmed = await dialog.confirm({
      title: '从备份恢复',
      message: '将用该备份覆盖当前数据库（会先自动备份当前库）。\n恢复后需要重启应用。',
      icon: <CircleAlert size={15} />,
      tone: 'warning',
      confirmText: '恢复',
    })
    if (!confirmed) return
    const res = await window.zhixing.db.restoreBackup(file)
    onNotice(res.message)
  }

  const handleBackup = async (): Promise<void> => {
    const dir = await dialog.prompt({
      title: '备份目录',
      label: '绝对路径',
      defaultValue: info?.dbPath.replace(/\/[^/]+$/, '/backups/electron') ?? '',
    })
    if (!dir) return
    const res = await window.zhixing.db.backupDatabase(dir)
    if (res) onNotice(`已备份到 ${res.path}（${(res.bytes / 1024).toFixed(0)} KB）`)
    else onNotice('备份失败')
  }


  return (
    <div className="page page--settings">
      <div className="page__body">
      <Toolbar
        title={'设置'}
        subtitle={'外观、行为与数据'}
        /* 不吸顶：这一页的标题行与分区 tab 本来就固定不动（滚动收在下面的 .set-body 里），
           再加吸顶那一套（滚动后铺底色 + 投影 + 收副标题）只会在 tab 下方多出一条色带。 */
        sticky={false}
        nav={(
          <div className="seg" role="tablist" aria-label="设置分区">
            {TABS.map((tabItem) => (
              <button
                key={tabItem.key}
                role="tab"
                aria-selected={tab === tabItem.key}
                onClick={() => setTab(tabItem.key)}
              >
                {tabItem.label}
              </button>
            ))}
          </div>
        )}
      />

      <div className="set-body">
        {tab === 'general' && (
          <>
            <section className="set-card set-card--ambient">
              <header className="set-card__head"><Palette size={15} /> 主题</header>
              <label className="set-row">
                <span>外观模式</span>
                <div className="seg">
                  <button aria-pressed={settings.theme_mode === 'light'} onClick={() => toggleThemeMode('light')}>浅色</button>
                  <button aria-pressed={settings.theme_mode === 'dark'} onClick={() => toggleThemeMode('dark')}>深色</button>
                  <button aria-pressed={settings.theme_mode === 'system'} onClick={() => toggleThemeMode('system')}>跟随系统</button>
                </div>
              </label>
              <label className="set-row">
                <span>主题包</span>
                <select
                  className="field"
                  value={settings.theme_pack}
                  onChange={(e) => {
                    const picked = e.target.value
                    void (async () => {
                      // update() 内部已经 applyAppearance，换主题包立即预览，不必重启
                      await update('theme_pack', picked)
                      // 联动：强调色还停在体系内（没被手动改过）时，跟着新包的推荐色走，
                      // 这样"选樱花粉"出来的就是配套的粉，而不是上一套皮肤留下的绿。
                      // 用户一旦自己挑过色，就不再覆盖他的选择。
                      if (isPresetAccent(settings.accent_color)) {
                        await update('accent_color', accentForPack(picked))
                      }
                    })()
                  }}
                >
                  {THEME_PACK_NAMES.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="set-row">
                <span>强调色</span>
                <div className="swatches">
                  {ACCENTS.map((c) => (
                    <button
                      key={c}
                      className={'swatch' + (settings.accent_color === c ? ' swatch--on' : '')}
                      style={{ background: c }}
                      aria-label={`强调色 ${c}`}
                      onClick={() => void update('accent_color', c)}
                    />
                  ))}
                  {/* 预设之外任选：色块本身就是取色器，改完立即预览 */}
                  <label
                    className={
                      'swatch swatch--custom' +
                      (isPresetAccent(settings.accent_color) ? '' : ' swatch--on')
                    }
                    title={`自定义强调色（当前 ${settings.accent_color}）`}
                    style={{ background: settings.accent_color }}
                  >
                    <input
                      type="color"
                      value={
                        /^#[0-9a-f]{6}$/i.test(settings.accent_color) ? settings.accent_color : '#0D9488'
                      }
                      aria-label="自定义强调色"
                      onChange={(e) => void update('accent_color', e.target.value)}
                    />
                  </label>
                </div>
              </div>
              <div className="set-row set-row--stack">
                <span>主题包配色</span>
                <div className="theme-tokens">
                  {CUSTOM_THEME_TOKENS.map(({ key, label }) => {
                    const value = themeColors[key]
                    const custom = typeof themeOverrides[key] === 'string'
                    return (
                      <label
                        key={key}
                        className={'theme-token' + (custom ? ' theme-token--custom' : '')}
                        title={custom ? `${label}：已自定义` : `${label}：跟随主题包`}
                      >
                        <input
                          type="color"
                          value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
                          aria-label={`${label}颜色`}
                          onChange={(e) => setCustomToken(key, e.target.value)}
                        />
                        <span className="theme-token__label">{label}</span>
                        <code className="theme-token__value">{value}</code>
                      </label>
                    )
                  })}
                  <button
                    className="text-btn"
                    disabled={Object.keys(themeOverrides).length === 0}
                    onClick={resetCustomTheme}
                  >
                    恢复主题包默认
                  </button>
                </div>
              </div>
              <label className="set-row">
                <span>动效</span>
                <select
                  className="field"
                  value={settings.motion_level}
                  onChange={(e) => void update('motion_level', e.target.value)}
                >
                  <option value="full">完整</option>
                  <option value="essential">仅必要</option>
                  <option value="none">关闭</option>
                </select>
                <span className="u-aux">
                  {osReducedMotion
                    ? '系统已开启「减少动态效果」，实际按「仅必要」降级'
                    : '完整 / 仅必要 / 关闭'}
                </span>
              </label>
              <label className="set-row">
                <span>树形路径跟踪</span>
                <input
                  type="checkbox"
                  checked={settings.tree_guide}
                  onChange={(e) => void update('tree_guide', e.target.checked ? '1' : '0')}
                />
                <span className="u-aux">
                  清单 / 笔记 / 工作流模板树里按层级画虚线，一眼看出当前行挂在哪一支下
                </span>
              </label>
              <label className="set-row">
                <span>玻璃拟态</span>
                <input
                  type="checkbox"
                  checked={settings.glass_enabled}
                  onChange={(e) => void update('glass_enabled', e.target.checked ? '1' : '0')}
                />
                <span className="u-aux">
                  标题栏 / 面板 / 卡片 / 控件都用半透明底，层与层之间能透出层次；
                  「不透明度」同时决定窗口透出桌面的程度，模糊与饱和度作用于浮层。
                  关闭后全部退回不透明实色，窗口也不再透出桌面。
                </span>
              </label>
              {/*
                三个参数只在总开关打开时可调 —— 关掉时 --glass-filter 直接变 none，
                这些滑块拖了也没有任何效果，留着会让人以为坏了。
              */}
              {/*
                **预览块**：玻璃的三个参数在真实界面上很难看出差别 ——
                这个应用的主界面是浅灰白、几乎没纹理，而"模糊"要背后有内容才看得见、
                "饱和度"要背景有色才起作用，白叠白连不透明度都分不出来。
                所以这里自己造一块有花纹的底，三个参数拖一下就能看见。
              */}
              {settings.glass_enabled && (
                <div className="glass-preview" aria-label="玻璃效果预览">
                  <div className="glass-preview__bg" aria-hidden />
                  <div className="glass-preview__pane">预览</div>
                </div>
              )}
              {settings.glass_enabled && (
                <>
                  <label className="set-row set-row--slider">
                    <span>模糊半径</span>
                    <input
                      type="range"
                      min={0}
                      max={40}
                      value={settings.glass_blur}
                      aria-label="玻璃模糊半径"
                      onChange={(e) => void update('glass_blur', e.target.value)}
                    />
                    <span className="u-aux set-row__val">{settings.glass_blur}px</span>
                  </label>
                  <label className="set-row set-row--slider">
                    <span>不透明度</span>
                    <input
                      type="range"
                      min={30}
                      max={100}
                      value={settings.glass_alpha}
                      aria-label="玻璃不透明度"
                      onChange={(e) => void update('glass_alpha', e.target.value)}
                    />
                    <span className="u-aux set-row__val">{settings.glass_alpha}%</span>
                  </label>
                  <label className="set-row set-row--slider">
                    <span>饱和度</span>
                    <input
                      type="range"
                      min={100}
                      max={250}
                      value={settings.glass_saturate}
                      aria-label="玻璃饱和度"
                      onChange={(e) => void update('glass_saturate', e.target.value)}
                    />
                    <span className="u-aux set-row__val">{settings.glass_saturate}%</span>
                  </label>
                  {/*
                    这条说明是必要的：模糊与饱和度只作用于**浮层**（上面那个预览块 /
                    弹窗 / 菜单），它们背后有页面内容可采。主界面的标题栏与面板背后是
                    纯色画布 —— 糊一个纯色和没糊完全一样，所以那两层只用不透明度控制。
                    不写清楚的话，用户拖这两个滑块看着主界面毫无变化，会以为坏了。
                  */}
                  <p className="u-aux set-row__note">
                    模糊与饱和度作用于**浮层**（预览块、弹窗、菜单、吸顶工具栏）—— 它们背后有内容可采。
                    主界面的标题栏与面板背后是纯色画布，糊了看不出差别，那两层由上面那个「不透明度」控制。
                  </p>
                </>
              )}
              {/*
                窗口阴影**不受玻璃开关影响**，所以放在那个条件之外 ——
                它是窗口的轮廓，关了玻璃同样需要。
                这个值是"内阴影"的强度：外投影在透明窗口上放不了（要么被窗口边界裁成直边，
                要么留出透明区露出方角），所以轮廓只能往内画。
              */}
              <label className="set-row set-row--slider">
                <span>窗口阴影</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={settings.window_shadow}
                  aria-label="窗口阴影强度"
                  onChange={(e) => void update('window_shadow', e.target.value)}
                />
                <span className="u-aux set-row__val">{settings.window_shadow}</span>
              </label>
              <p className="u-aux set-row__note">
                窗口四周**向内**的阴影强度，0 为完全不要轮廓。向外画不了 ——
                透明窗口的可见形状就是窗口矩形，外投影要么被边界裁成直边，要么留出透明区露出方角。
              </p>
            </section>

            {/*
              浏览器扩展**归设置页，不归保险箱**。
              它服务于"扩展连本机端点"，而那个端点同时服务密码与剪藏两件事 ——
              把入口藏在保险箱里，会让从没用过保险箱的人永远拿不到令牌，
              剪藏对他来说就是坏的。（原先确实放在保险箱页，是个设计错误。）
              现在插件的职责已经不只密码，这里才是它该在的地方。
            */}
          </>
        )}

        {/* 浏览器扩展归「集成」：与「外部任务同步」同属"和外部系统对接" */}
        {tab === 'integrations' && (
          <>
            <section className="set-card set-card--ambient">
              <header className="set-card__head"><Link2 size={15} /> 浏览器扩展</header>
              {httpInfo ? (
                <>
                  <div className="set-row">
                    <span>访问令牌</span>
                    {showToken ? (
                      <input
                        className="vault-input"
                        readOnly
                        value={httpInfo.token}
                        aria-label="浏览器扩展令牌"
                        onFocus={(e) => e.currentTarget.select()}
                      />
                    ) : (
                      <span className="u-aux">已生成，点右侧显示</span>
                    )}
                    {/* 令牌默认不显示 —— 它会出现在屏幕上，而屏幕可能正被别人看着。
                        这一点从保险箱页搬过来时保留：那里原本也是要点开才看的。 */}
                    <button className="btn btn--ghost" onClick={() => setShowToken((v) => !v)}>
                      {showToken ? '隐藏' : '显示'}
                    </button>
                  </div>
                  {showToken && (
                    <div className="set-row">
                      <span />
                      <button
                        className="btn btn--ghost"
                        onClick={() => {
                          void navigator.clipboard.writeText(httpInfo.token)
                          onNotice('令牌已复制')
                        }}
                      >
                        复制
                      </button>
                      <button
                        className="btn btn--ghost"
                        title="重新生成（已配好的扩展需要重新粘贴）"
                        onClick={async () => {
                          const ok = await dialog.confirm({
                            title: '重新生成令牌',
                            message: '已经连上的浏览器扩展会立刻失效，需要在扩展设置里重新粘贴新令牌。',
                            confirmText: '重新生成',
                          })
                          if (!ok) return
                          const r = await window.zhixing?.vault?.rotateToken?.()
                          // rotateToken 只回 token，端口是设置页自己那份
                          if (r) setHttpInfo({ ...httpInfo, token: r.token })
                          onNotice('令牌已重新生成')
                        }}
                      >
                        重新生成
                      </button>
                    </div>
                  )}
                  <p className="u-aux set-row__note">
                    一个令牌同时服务两件事：**保存登录凭据**与**剪藏网页正文**。
                    在扩展的「设置」里粘贴它，扩展只会把内容发到
                    <code>127.0.0.1:{httpInfo.port}</code>，不联网。
                    令牌不是主密码 —— 拿到它只能往收件箱和保险箱里<b>写</b>，
                    且保险箱锁定时一律拒收。
                  </p>
                </>
              ) : (
                <p className="u-aux set-row__note">正在读取…</p>
              )}
            </section>
          </>
        )}

        {tab === 'general' && (
          <>
            <section className="set-card set-card--ambient">
              <header className="set-card__head"><SlidersHorizontal size={15} /> 桌面浮窗</header>
              <label className="set-row">
                <span>启用桌面浮窗</span>
                <input
                  type="checkbox"
                  checked={settings.widget_enabled}
                  onChange={(e) => void update('widget_enabled', e.target.checked ? '1' : '0')}
                />
                <span className="u-aux">
                  启动只显示主窗口；主窗隐藏或最小化时才浮出待办
                </span>
              </label>
              <label className="set-row">
                <span>不透明度</span>
                <input
                  type="range"
                  min={30}
                  max={100}
                  value={settings.widget_opacity}
                  onChange={(e) => {
                    void update('widget_opacity', e.target.value)
                    void window.zhixing.widget.setOpacity(Number(e.target.value))
                  }}
                />
                <span className="u-aux">{settings.widget_opacity}%</span>
              </label>
              <label className="set-row">
                <span>鼠标穿透</span>
                <input
                  type="checkbox"
                  checked={settings.widget_click_through}
                  onChange={(e) => {
                    void update('widget_click_through', e.target.checked ? '1' : '0')
                    void window.zhixing.widget.setClickThrough(e.target.checked)
                  }}
                />
              </label>
              <div className="set-row">
                <span>操作</span>
                <button className="text-btn" onClick={() => void window.zhixing.widget.toggle()}>
                  显示 / 隐藏浮窗
                </button>
              </div>
            </section>

            <section className={'set-card set-card--ambient' + (sliding ? ' set-card--sliding' : '')}>
              <header className="set-card__head"><SlidersHorizontal size={15} /> 密度</header>
              {/* 滑杆区间与 parseSettings 的钳位区间同源（字号 9–20、
                  控件高度 24–48、行高 24–72），不再自定一套偏移区间 */}
              <label className="set-row">
                <span>字号</span>
                <input
                  type="range"
                  min={9}
                  max={20}
                  value={settings.font_size}
                  onPointerDown={() => setSliding(true)}
                  onChange={(e) => void update('font_size', e.target.value)}
                />
                <span className="u-aux">{settings.font_size}px</span>
              </label>
              <label className="set-row">
                <span>控件高度</span>
                <input
                  type="range"
                  min={24}
                  max={48}
                  value={settings.control_height}
                  onPointerDown={() => setSliding(true)}
                  onChange={(e) => void update('control_height', e.target.value)}
                />
                <span className="u-aux">{settings.control_height}px</span>
              </label>
              <label className="set-row">
                <span>任务行高</span>
                <input
                  type="range"
                  min={24}
                  max={72}
                  value={settings.task_row_height}
                  onPointerDown={() => setSliding(true)}
                  onChange={(e) => void update('task_row_height', e.target.value)}
                />
                <span className="u-aux">{settings.task_row_height}px</span>
              </label>
              <label className="set-row">
                <span>子任务缩进</span>
                <input
                  type="range"
                  min={8}
                  max={48}
                  value={settings.task_indent}
                  onChange={(e) => void update('task_indent', e.target.value)}
                />
                <span className="u-aux">{settings.task_indent}px</span>
              </label>
            </section>
          </>
        )}

        {/* 外部任务同步归「集成」：与「浏览器扩展」同属"和外部系统对接"，
            此前一个在外观、一个在任务与提醒，分居两处。 */}
        {tab === 'integrations' && (
          <section className="set-card">
            <header className="set-card__head"><RefreshCw size={15} /> 外部任务同步</header>
            <p className="u-aux">
              填一个返回 JSON 的 <b>GET</b> 接口，把外部任务拉成本地任务。按 id 认领所以重复同步
              只会更新、不会重复创建；外部标完成会同步到本地，反向不会（避免外部系统抖动把你
              已经做完的任务翻回去）。
            </p>
            <label className="set-row">
              <span>自动同步</span>
              <input
                type="checkbox"
                checked={settings.task_api_enabled}
                onChange={(e) => void updateApi('task_api_enabled', e.target.checked ? '1' : '0')}
              />
              <span className="u-aux">按下面间隔自动跑；关掉只留「立即同步」</span>
            </label>
            <label className="set-row">
              <span>接口地址</span>
              <input
                className="field field--grow"
                value={settings.task_api_url}
                placeholder="例如 https://example.com/api/tasks"
                onChange={(e) => void update('task_api_url', e.target.value)}
                onBlur={() => void updateApi('task_api_url', settings.task_api_url)}
              />
            </label>
            <label className="set-row">
              <span>API Key</span>
              <input
                className="field field--grow"
                type="password"
                value={settings.task_api_key}
                placeholder="可留空；填了会以 Bearer 发送"
                onChange={(e) => void update('task_api_key', e.target.value)}
              />
            </label>
            <label className="set-row">
              <span>同步间隔</span>
              <input
                type="number"
                className="field field--num"
                min={5}
                max={1440}
                value={settings.task_api_interval_min}
                onChange={(e) => void updateApi('task_api_interval_min', e.target.value)}
              />
              <span className="u-aux">分钟（应用启动 30 秒后先跑一次）</span>
            </label>
            <label className="set-row">
              <span>落到清单</span>
              <select
                className="field field--compact"
                value={settings.task_api_list_id ?? ''}
                onChange={(e) => void updateApi('task_api_list_id', e.target.value)}
              >
                <option value="">收件箱（默认）</option>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <span className="u-aux">外部拉回来的任务进哪个清单</span>
            </label>
            <div className="set-row set-row--end">
              <span />
              <span className="u-aux">
                {syncStatus?.lastAt
                  ? `上次：${syncStatus.lastAt.slice(5, 16)} · ${syncStatus.lastResult}`
                  : '还没同步过'}
              </span>
              <button className="text-btn" onClick={() => void handleSyncNow()} disabled={syncing}>
                {syncing ? '同步中…' : '立即同步'}
              </button>
            </div>
            <label className="set-row">
              <span>按标题去重</span>
              <input
                type="checkbox"
                checked={settings.task_api_dedupe}
                onChange={(e) => void updateApi('task_api_dedupe', e.target.checked ? '1' : '0')}
              />
              <span className="u-aux">
                本地已有同名任务时「认领」它（只建立映射、不改它的内容），不再新建一条
              </span>
            </label>

            <p className="u-aux">
              <b>字段映射</b>：接口的字段藏在包装里时，用 JSON 路径告诉同步器去哪儿取
              （支持 <code>data.rows[0].attributes.name</code> 这种点号 + 下标写法）。
              <b>留空 = 按候选字段名自动识别</b>（id / title / description / due_date / priority / done
              及其常见别名）。
            </p>
            <label className="set-row">
              <span>列表路径</span>
              <input
                className="field field--grow"
                value={settings.task_api_rows_path}
                placeholder="留空 = 自动（顶层数组，或 items / data / tasks）"
                onChange={(e) => void update('task_api_rows_path', e.target.value)}
                onBlur={() => void updateApi('task_api_rows_path', settings.task_api_rows_path)}
              />
            </label>
            {/* 原来是 .set-grid-2（auto-fit minmax(220px,1fr)）—— 与 .u-grid 的默认档完全一致 */}
            <div className="u-grid">
              {API_MAP_FIELDS.map((f) => (
                <label className="form-row" key={f.key}>
                  <span>
                    {f.label}
                    <span className="u-aux">（{f.key}）</span>
                  </span>
                  <input
                    className="field"
                    value={mapDraft[f.key] ?? ''}
                    placeholder={f.placeholder}
                    aria-label={'字段映射 ' + f.key}
                    onChange={(e) => updateMapField(f.key, e.target.value)}
                  />
                </label>
              ))}
            </div>
          </section>
        )}

        {tab === 'tasks' && (
          <section className="set-card">
            <header className="set-card__head"><Timer size={15} /> 任务与提醒</header>
            <label className="set-row">
              <span>到点发系统通知</span>
              <input
                type="checkbox"
                checked={settings.reminder_notify}
                onChange={(e) => void update('reminder_notify', e.target.checked ? '1' : '0')}
              />
              <span className="u-aux">
                主窗口收进托盘时也能提醒（走 Windows 通知中心；关掉只剩窗口内的提醒卡片）
              </span>
            </label>
            <label className="set-row">
              <span>番茄钟专注</span>
              <input
                type="number"
                className="field field--num"
                min={5}
                max={90}
                value={settings.pomodoro_focus_min}
                onChange={(e) => void update('pomodoro_focus_min', e.target.value)}
              />
              <span className="u-aux">分钟</span>
            </label>
            <label className="set-row">
              <span>番茄钟休息</span>
              <input
                type="number"
                className="field field--num"
                min={1}
                max={30}
                value={settings.pomodoro_break_min}
                onChange={(e) => void update('pomodoro_break_min', e.target.value)}
              />
              <span className="u-aux">分钟</span>
            </label>
            <label className="set-row">
              <span>专注结束自动休息</span>
              <input
                type="checkbox"
                checked={settings.pomodoro_auto_break}
                onChange={(e) => void update('pomodoro_auto_break', e.target.checked ? '1' : '0')}
              />
              <span className="u-aux">专注结束后自动开始休息计时</span>
            </label>
            <label className="set-row">
              <span>到点提醒</span>
              <input
                type="checkbox"
                checked={settings.reminder_enabled}
                onChange={(e) => void update('reminder_enabled', e.target.checked ? '1' : '0')}
              />
            </label>
            {settings.reminder_enabled && (
              <div className="set-sub">
                <p className="u-aux">
                  下面三项决定「哪些任务会自动提醒」。手动在任务里设过提醒时刻的，一律以手动为准。
                </p>
                <label className="set-row">
                  <span>提前提醒</span>
                  <input
                    type="number"
                    className="field field--num"
                    min={0}
                    max={1440}
                    step={5}
                    value={settings.reminder_lead_minutes}
                    onChange={(e) => void update('reminder_lead_minutes', e.target.value)}
                  />
                  <span className="u-aux">分钟（0 = 到点才提醒）</span>
                </label>
                <label className="set-row">
                  <span>有截止时刻的任务自动提醒</span>
                  <input
                    type="checkbox"
                    checked={settings.reminder_rule_due_time}
                    onChange={(e) => void update('reminder_rule_due_time', e.target.checked ? '1' : '0')}
                  />
                </label>
                <label className="set-row">
                  <span>只有截止日期的任务当天提醒</span>
                  <input
                    type="checkbox"
                    checked={settings.reminder_rule_due_date}
                    onChange={(e) => void update('reminder_rule_due_date', e.target.checked ? '1' : '0')}
                  />
                  <input
                    type="time"
                    className="field"
                    value={settings.reminder_day_clock}
                    onChange={(e) => void update('reminder_day_clock', e.target.value)}
                  />
                </label>
                <label className="set-row">
                  <span>只自动提醒优先级 ≥</span>
                  <input
                    type="number"
                    className="field field--num"
                    min={0}
                    max={8}
                    value={settings.reminder_rule_priority_min}
                    onChange={(e) => void update('reminder_rule_priority_min', e.target.value)}
                  />
                  <span className="u-aux">0 = 不限</span>
                </label>
                <label className="set-row">
                  <span>每条最多提醒</span>
                  <input
                    type="number"
                    className="field field--num"
                    min={1}
                    max={20}
                    value={settings.reminder_repeat_count}
                    onChange={(e) => void update('reminder_repeat_count', e.target.value)}
                  />
                  <span className="u-aux">次</span>
                </label>
                <label className="set-row">
                  <span>重复间隔</span>
                  <input
                    type="number"
                    className="field field--num"
                    min={1}
                    max={240}
                    value={settings.reminder_repeat_interval_minutes}
                    onChange={(e) => void update('reminder_repeat_interval_minutes', e.target.value)}
                  />
                  <span className="u-aux">分钟</span>
                </label>
              </div>
            )}
            <label className="set-row">
              <span>剪贴板监听</span>
              <input
                type="checkbox"
                checked={settings.clipboard_monitor}
                onChange={(e) => void update('clipboard_monitor', e.target.checked ? '1' : '0')}
              />
              <span className="u-aux">复制后提示可用快速捕获</span>
            </label>
            <label className="set-row">
              <span>开机自启</span>
              <input
                type="checkbox"
                checked={settings.autostart_enabled}
                onChange={(e) => void update('autostart_enabled', e.target.checked ? '1' : '0')}
              />
            </label>
            <label className="set-row">
              <span>标题栏签名</span>
              <input
                className="field field--compact"
                value={settings.signature}
                onChange={(e) => void update('signature', e.target.value)}
              />
            </label>
            <label className="set-row">
              <span>日历显示已完成任务</span>
              <input
                type="checkbox"
                checked={settings.calendar_show_done}
                onChange={(e) => void update('calendar_show_done', e.target.checked ? '1' : '0')}
              />
            </label>
            <div className="set-row">
              <span>标签管理</span>
              <button className="text-btn" onClick={() => setTagsOpen(true)}>
                <Tag size={13} /> 打开标签管理…
              </button>
            </div>
          </section>
        )}

        {tab === 'hotkeys' && (
          <section className="set-card">
            <header className="set-card__head"><SlidersHorizontal size={15} /> 全局热键</header>
            {HOTKEY_ROWS.map((row) => (
              <div className="set-row" key={row.key}>
                <span>{row.label}</span>
                <input
                  className="field field--compact"
                  value={String(settings[row.key] ?? '')}
                  readOnly
                  aria-label={`${row.label}热键`}
                />
                <button className="text-btn" onClick={() => {
                  setCaptured('')
                  capturedRef.current = ''
                  setProbe('idle')
                  setRebinding(row.key)
                  // 捕获期间先注销全部全局热键，否则组合键被系统层吞掉
                  void window.zhixing.app.suspendHotkeys()
                }}>
                  改键
                </button>
                <span className="u-aux">{hotkeys[row.key] ?? row.hint}</span>
              </div>
            ))}
            <p className="u-aux">
              改键后立即生效。组合被系统或其他程序占用时会注册失败（行尾标出），
              此时只有托盘菜单里对应那一项可用 —— 换一个组合再试即可。
              「读取选中并速记」在 Electron 侧无跨应用模拟复制能力，降级为读取系统剪贴板。
            </p>
          </section>
        )}

        {/* 密码保险箱归「数据与安全」：它管的是本地条目的加密与自动锁定，
            与「数据」那张卡（附件 / 备份 / 回收站）是同一类关注点。 */}
        {tab === 'data' && (
          <section className="set-card set-card--ambient">
            <header className="set-card__head"><Database size={15} /> 密码保险箱</header>
            <label className="set-row">
              <span>自动锁定</span>
              <select
                className="vault-select"
                value={settings.vault_auto_lock_min}
                aria-label="保险箱自动锁定"
                onChange={(e) => void update('vault_auto_lock_min', e.target.value)}
              >
                <option value={1}>1 分钟无操作</option>
                <option value={5}>5 分钟无操作</option>
                <option value={15}>15 分钟无操作</option>
                <option value={30}>30 分钟无操作</option>
                <option value={0}>从不自动锁定</option>
              </select>
            </label>
            <p className="u-aux set-row__note">
              保险箱的主密码**无法找回** —— 它不以任何形式保存，只在你输入时用于派生密钥。
              忘记之后唯一的出路是在保险箱页面里清空重建，届时里面的条目会一并删除。
            </p>
          </section>
        )}

        {tab === 'data' && (
          <section className="set-card">
            <header className="set-card__head"><Database size={15} /> 数据</header>
            <div className="set-row set-row--end">
              <span>附件</span>
              <span className="u-aux">
                {attStats
                  ? `${attStats.count} 个 · ${formatBytes(attStats.bytes)}${attStats.missing ? ` · ${attStats.missing} 个文件已丢失` : ''}`
                  : '统计中…'}
              </span>
              <button className="text-btn" onClick={() => void refreshAttachments()}>
                刷新
              </button>
              <button
                className="text-btn"
                onClick={() => {
                  if (attStats?.dir) void window.zhixing.db.openPath(attStats.dir)
                }}
              >
                打开目录
              </button>
              <button className="text-btn text-btn--danger" onClick={() => void handlePruneAttachments()}>
                清理失效与孤儿文件
              </button>
            </div>
            {orphans.length > 0 && (
              <div className="set-row set-row--end">
                <span>未引用的暂存附件</span>
                <span className="u-aux">
                  {orphans.length} 个 · {formatBytes(orphans.reduce((n, o) => n + o.bytes, 0))}{' '}
                  （没有闪念或笔记引用它们）
                </span>
                <button className="text-btn text-btn--danger" onClick={() => void handleCleanOrphans()}>
                  清理
                </button>
              </div>
            )}
            <label className="set-row">
              <span>回收站保留</span>
              <input
                type="number"
                className="field field--num"
                min={1}
                max={365}
                value={settings.recycle_retention_days}
                onChange={(e) => void update('recycle_retention_days', e.target.value)}
              />
              <span className="u-aux">天</span>
            </label>
            <div className="set-row">
              <span>数据库</span>
              <code className="u-aux">{info?.dbPath ?? '—'}</code>
            </div>
            <div className="set-row">
              <span>回收站</span>
              <button className="text-btn" onClick={() => setRecycleOpen(true)}>
                <Trash2 size={13} /> 打开回收站…
              </button>
            </div>
            <div className="set-row">
              <span>导出</span>
              <div className="set-actions">
                <button
                  className="text-btn"
                  onClick={() =>
                    void window.zhixing.db.exportData('json').then((r) => {
                      if (r) onNotice(`已导出 JSON（${r.count} 条记录）到 ${r.path}`)
                    })
                  }
                >
                  全部数据 JSON
                </button>
                <button
                  className="text-btn"
                  onClick={() =>
                    void window.zhixing.db.exportData('csv').then((r) => {
                      if (r) onNotice(`已导出 ${r.count} 个任务到 ${r.path}`)
                    })
                  }
                >
                  任务 CSV
                </button>
                <button
                  className="text-btn"
                  onClick={() =>
                    void window.zhixing.db.exportData('markdown').then((r) => {
                      if (r) onNotice(`已导出 ${r.count} 篇笔记到 ${r.path}`)
                    })
                  }
                >
                  笔记 Markdown
                </button>
                {/* 整包 Markdown（ZIP） */}
                <button
                  className="text-btn"
                  onClick={() =>
                    void window.zhixing.db.exportData('markdown-zip').then((r) => {
                      if (r) onNotice(`已导出 ${r.count} 篇笔记（ZIP）到 ${r.path}`)
                    })
                  }
                >
                  笔记 Markdown（ZIP）
                </button>
              </div>
            </div>
            <div className="set-row">
              <span>自动备份</span>
              <span className="u-aux">
                {backups.length === 0
                  ? '暂无自动备份（每次启动会自动备份，保留最近 10 份）'
                  : `共 ${backups.length} 份，点选可恢复：`}
                {backups.slice(0, 3).map((b) => (
                  <button key={b.path} className="text-btn" onClick={() => void handleRestore(b.path)}>
                    {b.name.replace(/\.db$/, '')}（{(b.bytes / 1024).toFixed(0)}KB）
                  </button>
                ))}
              </span>
            </div>
            <div className="set-row">
              <span>导入</span>
              <div className="set-actions">
                <button
                  className="text-btn"
                  onClick={async () => {
                    const confirmed = await dialog.confirm({
                      title: '导入数据',
                      message:
                        '导入会用文件内容覆盖当前全部数据（任务 / 笔记 / 闪念 / 标签 / 设置）。\n' +
                        '导入前会自动把当前数据库备份到 backups/（保留最近 10 份）。',
                      icon: <CircleAlert size={15} />,
                      tone: 'warning',
                      confirmText: '导入',
                    })
                    if (!confirmed) return
                    void window.zhixing.db.importData().then((r) => {
                      onNotice(r.backup ? `${r.message}；备份：${r.backup}` : r.message)
                    })
                  }}
                >
                  从 JSON 恢复…
                </button>
                {/* Markdown 文件夹导入（preload 已暴露，走系统目录选择框） */}
                <button
                  className="text-btn"
                  onClick={() =>
                    void window.zhixing.db.importMarkdownFolder().then((r) => onNotice(r.message))
                  }
                >
                  Markdown 文件夹…
                </button>
              </div>
            </div>
            <div className="set-row">
              <span>备份</span>
              <button className="text-btn" onClick={() => void handleBackup()}>
                <Download size={13} /> 备份到指定目录
              </button>
            </div>
          </section>
        )}

        {tab === 'ai' && (
          <>
            <section className="set-card">
              <header className="set-card__head"><Sparkles size={15} /> 笔记 AI 整理（大模型）</header>
              <label className="set-row">
                <span>协议</span>
                <select
                  className="field field--compact"
                  value={settings.ai_protocol}
                  onChange={(e) => void update('ai_protocol', normalizeAiProtocol(e.target.value))}
                >
                  {AI_PROTOCOLS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </label>
              <p className="u-aux">
                {AI_PROTOCOLS.find((p) => p.value === settings.ai_protocol)?.hint}
              </p>
              <label className="set-row">
                <span>请求地址</span>
                <input
                  className="field field--grow"
                  value={settings.ai_base_url}
                  placeholder={AI_PROTOCOLS.find((p) => p.value === settings.ai_protocol)?.baseUrlHint}
                  onChange={(e) => void update('ai_base_url', e.target.value)}
                />
              </label>
              <label className="set-row">
                <span>API Key</span>
                <input
                  className="field field--grow"
                  type="password"
                  value={settings.ai_api_key}
                  placeholder="本地模型（Ollama 等）可留空"
                  onChange={(e) => void update('ai_api_key', e.target.value)}
                />
              </label>
              <label className="set-row">
                <span>模型</span>
                <input
                  className="field field--grow"
                  value={settings.ai_model}
                  placeholder={AI_PROTOCOLS.find((p) => p.value === settings.ai_protocol)?.defaultModel}
                  onChange={(e) => void update('ai_model', e.target.value)}
                />
                <span className="u-aux">留空则无法整理</span>
              </label>
              <label className="set-row">
                <span>超时</span>
                <input
                  type="number"
                  className="field field--num"
                  min={10}
                  max={600}
                  value={settings.ai_timeout_sec}
                  onChange={(e) => void update('ai_timeout_sec', e.target.value)}
                />
                <span className="u-aux">秒（长笔记可能要等上一两分钟）</span>
              </label>
              <div className="set-row">
                <span />
                <button className="text-btn" onClick={() => void handleTestAi()} disabled={aiTesting}>
                  {aiTesting ? '测试中…' : '测试连接'}
                </button>
                <span className="u-aux">
                  Key 只保存在本机数据库；请求由主进程发出，渲染层与网页端都拿不到它。
                </span>
              </div>
            </section>

            <section className="set-card">
              <header className="set-card__head"><FileText size={15} /> 整理提示词</header>
              <p className="u-aux">
                用下面这几个变量把数据带进提示词：{'{{FOLDERS}}'} 现有文件夹、{'{{NOTES}}'} 现有笔记标题、
                {'{{TITLE}}'} 标题、{'{{FORMAT}}'} 格式、{'{{KIND}}'} 类型说明（Markdown / Word / 链接笔记…）、
                {'{{ATTACHMENTS}}'} 图片/文件占位符清单、{'{{CONTENT}}'} 正文。
                其中 <b>{'{{CONTENT}}'}</b> 必须保留，否则模型拿不到正文，整理会被直接拒绝。
                正文里的图片与附件不会上传，只以 {'@@IMG1@@'}、{'@@FILE1@@'} 这类标记占位，返回后自动填回。
              </p>
              <p className="u-aux">
                一份提示词要照顾三类笔记：<b>Markdown / 富文本</b>重排正文；
                <b>Word / Excel</b> 库里只有标题，只做归类；
                <b>链接笔记</b>的内容是一组「标题 + 链接」，要判断每条链接归到哪篇笔记（没有就新建）。
              </p>
              <textarea
                className="field field--area field--code"
                rows={18}
                value={promptDraft}
                onChange={(e) => setPromptDraft(e.target.value)}
                aria-label="整理提示词"
              />
              <div className="set-row set-row--end">
                <span />
                <button className="text-btn" onClick={() => setPromptDraft(DEFAULT_AI_PROMPT)}>
                  恢复默认提示词
                </button>
                <button
                  className="text-btn text-btn--accent"
                  onClick={() => void update('ai_prompt', promptDraft).then(() => onNotice('提示词已保存'))}
                >
                  保存提示词
                </button>
                {promptDraft !== (settings.ai_prompt || DEFAULT_AI_PROMPT) && (
                  <span className="u-aux">未保存…</span>
                )}
              </div>
            </section>

            <section className="set-card">
              <header className="set-card__head"><FileText size={15} /> 整理全库提示词</header>
              <p className="u-aux">
                整库整理用的是一份**为批量场景单独写的**默认提示词：它比单篇那份克制得多 ——
                只规整排版、不重写句子；归类与链接归档都要求「只在明显成立时才做」，
                免得一次过几十篇时替你改稿、或者造出一堆同义目录。可以随意改，改完保存；
                点「恢复默认」回到内置版本。
              </p>
              <textarea
                className="field field--area field--code"
                rows={12}
                value={libPromptDraft}
                placeholder="留空 = 与「整理提示词」完全相同"
                onChange={(e) => setLibPromptDraft(e.target.value)}
                aria-label="全库整理提示词"
              />
              <div className="set-row set-row--end">
                <span />
                <button className="text-btn" onClick={() => setLibPromptDraft(DEFAULT_AI_LIBRARY_PROMPT)}>
                  恢复默认提示词
                </button>
                <button
                  className="text-btn text-btn--accent"
                  disabled={libPromptDraft === (settings.ai_library_prompt || DEFAULT_AI_LIBRARY_PROMPT)}
                  onClick={() => {
                    // 与内置默认一致就存空串 —— 表示「跟随默认」，将来默认更新也能跟上
                    const next = libPromptDraft === DEFAULT_AI_LIBRARY_PROMPT ? '' : libPromptDraft
                    void update('ai_library_prompt', next).then(() =>
                      onNotice(next ? '全库提示词已保存' : '已恢复内置默认提示词')
                    )
                  }}
                >
                  保存
                </button>
                {libPromptDraft !== (settings.ai_library_prompt || DEFAULT_AI_LIBRARY_PROMPT) && (
                  <span className="u-aux">未保存…</span>
                )}
              </div>
            </section>
          </>
        )}

        {tab === 'about' && (
          <section className="set-card">
            <header className="set-card__head"><Info size={15} /> 关于</header>
            <dl className="kv">
              <dt>应用</dt>
              <dd>知行 ZhiXing</dd>
              <dt>版本</dt>
              <dd>{info ? `v${info.version}` : '—'}</dd>
              <dt>Electron</dt>
              <dd>{info?.electron ?? '—'}</dd>
              <dt>Chromium</dt>
              <dd>{info?.chrome ?? '—'}</dd>
              <dt>Node</dt>
              <dd>{info?.node ?? '—'}</dd>
              <dt>数据库</dt>
              <dd>{info?.dbPath ?? '—'}</dd>
            </dl>
            <p className="u-aux">
              知行是一款<b>本地优先</b>的个人待办与知识管理桌面应用：任务支持多层子任务、清单、标签、
              重复规则与日历 / 四象限 / 看板多视图；笔记支持 Markdown、富文本、Word / Excel 与链接笔记，
              可以建双链、归类到文件夹；工作流把「做事的顺序」固化成可复用模板，实例里的每一步都会
              自动落成待办；图谱把任务与笔记之间的关联画出来，回顾页按周期帮你复盘。
            </p>
            <p className="u-aux">
              所有数据只存在本机的一只 SQLite 文件里：无需注册账号、不联网也能完整使用；
              可选接入大模型整理笔记，或从外部接口同步任务。
            </p>
          </section>
        )}
      </div>
      </div>

      {recycleOpen && (
        <RecycleBin
          onNotice={onNotice}
          onChanged={onChanged}
          onClose={() => setRecycleOpen(false)}
        />
      )}
      {tagsOpen && (
        <TagManager onNotice={onNotice} onChanged={onChanged} onClose={() => setTagsOpen(false)} />
      )}

      {/* 改键捕获浮层：按键由 window 级监听捕获，
          Enter 保存、Esc 取消，必须有修饰键 */}
      {rebinding && (
        <div
          className="modal-mask"
          role="dialog"
          aria-modal="true"
          aria-label="改键"
          onMouseDown={() => void finishRebind(false)}
        >
          {/* 内层必须吃掉 mousedown：否则点「保存」时，mousedown 会先从按钮冒泡到遮罩，
              被当成「点了浮层外面」而走取消分支 —— 表现就是「点保存却提示已取消」。
              其余弹窗都有这一行，这个浮层当初漏了。 */}
          <div
            className="modal"
            style={{ maxWidth: 380 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal__head">改键</div>
            <div className="modal__body">
              <p className="u-aux">
                按下新的组合键（必须包含 Ctrl / Alt / Shift / Cmd），
                <strong>再点「保存」（或按回车）才会生效</strong>
              </p>
              <p style={{ fontSize: 20, fontWeight: 600 }}>
                {captured || '等待按键…'}
              </p>
              {captured && (
                <p
                  className="u-aux"
                  style={probe === 'busy' ? { color: 'var(--danger)' } : undefined}
                >
                  {probe === 'checking'
                    ? '正在检查这个组合能不能用…'
                    : probe === 'ok'
                      ? '✓ 这个组合可用'
                      : '✗ 这个组合已被别的程序占用，建议换一个'}
                </p>
              )}
            </div>
            <div className="modal__foot">
              <button className="text-btn" onClick={() => void finishRebind(false)}>
                取消
              </button>
              <button
                className="text-btn"
                disabled={!captured}
                onClick={() => void finishRebind(true)}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
