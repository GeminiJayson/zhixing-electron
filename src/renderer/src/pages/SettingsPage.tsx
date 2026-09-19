import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert, Database, Download, FileText, Info, Palette, RefreshCw, SlidersHorizontal, Sparkles, Tag, Timer, Trash2 } from '@renderer/lib/icons'
import { parseSettings, type AppSettings } from '@shared/settings'
import {
  AI_PROTOCOLS,
  DEFAULT_AI_LIBRARY_PROMPT,
  DEFAULT_AI_PROMPT,
  normalizeAiProtocol,
} from '@shared/ai-note'
import { THEME_PACK_NAMES } from '@shared/theme-packs'
import { t } from '../i18n'
import { Toolbar } from '../components/Toolbar'
import { applyAppearance, prefersReducedMotion } from '../theme'
import { useDialog } from '../components/Dialogs'
import type { AppInfo } from '@shared/types'
import { RecycleBin } from '../components/RecycleBin'
import { TagManager } from '../components/TagManager'

interface Props {
  onNotice: (message: string) => void
  onChanged: () => Promise<void>
}

type Tab = 'appearance' | 'tasks' | 'data' | 'ai' | 'about'

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
 * 可改键的四项全局热键（对齐 Python settings_page._build_capture 的四行）。
 * hint 是改键失败时的降级说明 —— 注册不上的热键一律回到托盘菜单。
 */
const HOTKEY_ROWS: { key: keyof AppSettings; label: string; hint: string }[] = [
  { key: 'capture_hotkey', label: '划词捕获', hint: '捕获当前选中内容' },
  {
    key: 'select_quick_hotkey',
    label: '读取选中并速记',
    hint: '读取选中文字预填快速捕获',
  },
  { key: 'quick_capture_hotkey', label: '快速任务', hint: '弹出快速捕获窗口' },
  { key: 'widget_hotkey', label: '浮窗显隐', hint: '显示 / 隐藏桌面浮窗' },
]

const TABS: { key: Tab; label: string }[] = [
  { key: 'appearance', label: '外观' },
  { key: 'tasks', label: '任务与提醒' },
  { key: 'data', label: '数据' },
  { key: 'ai', label: 'AI 整理' },
  { key: 'about', label: '关于' },
]

export function SettingsPage({ onNotice, onChanged }: Props) {
  const dialog = useDialog()
  const [tab, setTab] = useState<Tab>('appearance')
  const [settings, setSettings] = useState<AppSettings>(() => parseSettings())
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [recycleOpen, setRecycleOpen] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  /** settings 表的原始 KV 快照：写库前用它算出「乐观设置」，好让界面先动起来 */
  const rawRef = useRef<Record<string, string>>({})
  /** 自动备份列表（进入「数据」页时刷新） */
  const [backups, setBackups] = useState<{ name: string; path: string; bytes: number }[]>([])
  /** 系统级「减少动态效果」探测结果（对齐 Python 的 _os_reduce_motion） */
  const [osReducedMotion, setOsReducedMotion] = useState(() => prefersReducedMotion())
  /** 热键注册状态：settings 键 → 中文状态串（对齐 Python 的 hotkey_status） */
  const [hotkeys, setHotkeys] = useState<Record<string, string>>({})
  /** 正在改键的 settings 键；null = 未在改键 */
  const [rebinding, setRebinding] = useState<keyof AppSettings | null>(null)
  /** 捕获到的组合键（显示用；真正取值走 ref，避免键盘监听闭包读到旧值） */
  const [captured, setCaptured] = useState('')
  const capturedRef = useRef('')

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

  // 读一次热键注册状态（对齐 Python 设置页构造时的 hotkey_status 回填）
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
      if (save && key && combo) {
        try {
          await window.zhixing.db.setSetting(key, combo)
          rawRef.current = await window.zhixing.db.settings()
          setSettings(parseSettings(rawRef.current))
        } catch (err) {
          onNotice(`热键未能保存：${(err as Error).message}`)
        }
      }
      // 取消也要重注册：进入捕获态时已把全部热键注销了
      try {
        setHotkeys(await window.zhixing.app.rebindHotkeys())
      } catch {
        // 主进程重注册失败不阻塞界面，状态标签保留上一次结果
      }
      if (save && key && combo) onNotice(`热键已改为 ${combo}`)
    },
    [rebinding, onNotice]
  )

  /** 改键捕获：必须有修饰键；Enter 确认、Esc 取消（对齐 HotkeyCaptureDialog）。 */
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
      // 写库失败（库只读 / 被 Python 版占用）不该让整次切换看起来毫无反应——
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
        title={t('page.settings')}
        subtitle={t('page.settings.sub')}
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
        {tab === 'appearance' && (
          <>
            <section className="set-card">
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
                    // update() 内部已经 applyAppearance，换主题包立即预览，不必重启
                    void update('theme_pack', picked)
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
            </section>

            <section className="set-card">
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

            <section className="set-card">
              <header className="set-card__head"><SlidersHorizontal size={15} /> 密度</header>
              {/* 滑杆区间与 parseSettings 的钳位区间同源（Python constants.py：
                  字号 9–20、控件高度 24–48、行高 24–72），不再自定一套偏移区间 */}
              <label className="set-row">
                <span>字号</span>
                <input
                  type="range"
                  min={9}
                  max={20}
                  value={settings.font_size}
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

        {tab === 'tasks' && (
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
            <div className="set-grid-2">
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

        {tab === 'tasks' && (
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
                  setRebinding(row.key)
                  // 捕获期间先注销全部全局热键，否则组合键被系统层吞掉（对齐 _suspend_hotkeys）
                  void window.zhixing.app.suspendHotkeys()
                }}>
                  改键
                </button>
                <span className="u-aux">{hotkeys[row.key] ?? row.hint}</span>
              </div>
            ))}
            <p className="u-aux">
              改键后立即生效；被系统或其他程序占用时会降级为托盘菜单项（状态显示在行尾）。
              「读取选中并速记」在 Electron 侧无跨应用模拟复制能力，降级为读取系统剪贴板。
            </p>
          </section>
        )}

        {tab === 'data' && (
          <section className="set-card">
            <header className="set-card__head"><Database size={15} /> 数据</header>
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
                {/* D26：整包 Markdown（ZIP），与 Python 的 export_markdown_zip 对齐 */}
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
                {/* D25：Markdown 文件夹导入（preload 已暴露，走系统目录选择框） */}
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

      {/* 改键捕获浮层（对齐 HotkeyCaptureDialog）：按键由 window 级监听捕获，
          Enter 保存、Esc 取消，必须有修饰键 */}
      {rebinding && (
        <div
          className="modal-mask"
          role="dialog"
          aria-modal="true"
          aria-label="改键"
          onMouseDown={() => void finishRebind(false)}
        >
          <div className="modal" style={{ maxWidth: 380 }}>
            <div className="modal__head">改键</div>
            <div className="modal__body">
              <p className="u-aux">按下新的组合键（必须包含 Ctrl / Alt / Shift / Cmd）</p>
              <p style={{ fontSize: 20, fontWeight: 600 }}>
                {captured || '等待按键…'}
              </p>
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
