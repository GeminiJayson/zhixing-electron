import { useCallback, useEffect, useRef, useState } from 'react'
import { Database, Download, Info, Palette, SlidersHorizontal, Tag, Timer, Trash2 } from 'lucide-react'
import { parseSettings, type AppSettings } from '@shared/settings'
import { THEME_PACK_NAMES } from '@shared/theme-packs'
import { t } from '../i18n'
import { applyAppearance } from '../theme'
import { useDialog } from '../components/Dialogs'
import type { AppInfo } from '@shared/types'
import { RecycleBin } from '../components/RecycleBin'
import { TagManager } from '../components/TagManager'

interface Props {
  onNotice: (message: string) => void
  onChanged: () => Promise<void>
}

type Tab = 'appearance' | 'tasks' | 'data' | 'about'

const ACCENTS = ['#0D9488', '#2563EB', '#7C3AED', '#DB2777', '#EA580C', '#16A34A', '#D97706', '#0891B2']

const TABS: { key: Tab; label: string }[] = [
  { key: 'appearance', label: '外观' },
  { key: 'tasks', label: '任务与提醒' },
  { key: 'data', label: '数据' },
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

  useEffect(() => {
    if (tab !== 'data') return
    void window.zhixing.db.listBackups().then(setBackups)
  }, [tab])

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
      <div className="page__head">
        <h1 className="page__title">{t('page.settings')}</h1>
        <p className="page__subtitle">{t('page.settings.sub')}</p>
      </div>
      <div className="page__body">
      <div className="seg" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

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
              </label>
            </section>

            <section className="set-card">
              <header className="set-card__head"><SlidersHorizontal size={15} /> 桌面浮窗</header>
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
              <label className="set-row">
                <span>字号</span>
                <input
                  type="range"
                  min={10}
                  max={18}
                  value={settings.font_size}
                  onChange={(e) => void update('font_size', e.target.value)}
                />
                <span className="u-aux">{settings.font_size}px</span>
              </label>
              <label className="set-row">
                <span>任务行高</span>
                <input
                  type="range"
                  min={22}
                  max={56}
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
                min={1}
                max={120}
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
                max={60}
                value={settings.pomodoro_break_min}
                onChange={(e) => void update('pomodoro_break_min', e.target.value)}
              />
              <span className="u-aux">分钟</span>
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
              <span>划词速记热键</span>
              <input
                className="field field--compact"
                value={settings.select_quick_hotkey}
                onChange={(e) => void update('select_quick_hotkey', e.target.value)}
              />
              <span className="u-aux">选中文字后按此键速记</span>
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
            <p className="u-aux">
              浮窗、全局划词捕获与热键重绑定尚未迁移，设置项保留在同一个 settings 表里，Python 版仍可读。
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
              <button
                className="text-btn"
                onClick={() => {
                  if (
                    !window.confirm(
                      '导入会用文件内容**覆盖**当前全部数据（任务/笔记/闪念/标签/设置）。\n\n导入前会自动把当前数据库备份到 backups/before-import/。\n\n确定继续？'
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
            </div>
            <div className="set-row">
              <span>备份</span>
              <button className="text-btn" onClick={() => void handleBackup()}>
                <Download size={13} /> 备份到指定目录
              </button>
            </div>
          </section>
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
    </div>
  )
}
