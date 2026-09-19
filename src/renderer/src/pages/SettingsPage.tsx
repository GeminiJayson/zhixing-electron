import { useCallback, useEffect, useRef, useState } from 'react'
import { Database, Download, FileText, Info, Palette, SlidersHorizontal, Sparkles, Tag, Timer, Trash2 } from '@renderer/lib/icons'
import { parseSettings, type AppSettings } from '@shared/settings'
import { AI_PROTOCOLS, DEFAULT_AI_PROMPT, normalizeAiProtocol } from '@shared/ai-note'
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

  // 提示词：库里有就用库里的，没有则铺上默认提示词（用户可在此基础上改）
  useEffect(() => {
    setPromptDraft(settings.ai_prompt || DEFAULT_AI_PROMPT)
  }, [settings.ai_prompt])

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
    if (
      !window.confirm(
        '将用该备份覆盖当前数据库（会先自动备份当前库）。\n恢复后需要重启应用。\n\n确定继续？'
      )
    )
      return
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
                  onClick={() => {
                    if (
                      !window.confirm(
                        '导入会用文件内容**覆盖**当前全部数据（任务/笔记/闪念/标签/设置）。\n\n导入前会自动把当前数据库备份到 backups/（与自动备份同一目录，保留最近 10 份）。\n\n确定继续？'
                      )
                    )
                      return
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
                用下面这几个变量把数据带进提示词：{'{{FOLDERS}}'} 现有文件夹、{'{{TITLE}}'} 标题、
                {'{{FORMAT}}'} 格式、{'{{ATTACHMENTS}}'} 图片/文件占位符清单、{'{{CONTENT}}'} 正文。
                其中 <b>{'{{CONTENT}}'}</b> 必须保留，否则模型拿不到正文，整理会被直接拒绝。
                正文里的图片与附件不会上传，只以 {'@@IMG1@@'}、{'@@FILE1@@'} 这类标记占位，返回后自动填回。
              </p>
              <textarea
                className="field field--area field--code"
                rows={18}
                value={promptDraft}
                onChange={(e) => setPromptDraft(e.target.value)}
                aria-label="整理提示词"
              />
              <div className="set-row">
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
          </>
        )}

        {tab === 'about' && (
          <section className="set-card">
            <header className="set-card__head"><Info size={15} /> 关于</header>
            <dl className="kv">
              <dt>应用</dt>
              <dd>知行 ZhiXing（Electron 重构版）{info ? ` v${info.version}` : ''}</dd>
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
              与原 Python 版共用同一份 SQLite（schema v12）与同一张 settings 表，切换客户端时数据与偏好保持一致。
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
