import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from '@renderer/lib/icons'

/**
 * 密码保险箱。
 *
 * 三种形态（见 docs/specs/vault-design.md §7.2）：
 *   未初始化 → 设置主密码；已锁定 → 输入主密码；已解锁 → 列表 + 详情。
 *
 * **两条界面上的硬约束**：
 *   1. 锁定时必须把已解密的条码从 React 状态里清掉 —— 否则界面上还留着明文；
 *   2. 不做"记住我" —— 主密钥不进渲染层，刷新页面就是要重新解锁。
 */

type Status = 'uninitialized' | 'locked' | 'unlocked'

interface Entry {
  id: number
  title: string
  username: string
  password: string
  url: string
  notes: string
  tags: string[]
  created_at: string
  updated_at: string
}

const EMPTY: Omit<Entry, 'id' | 'created_at' | 'updated_at'> = {
  title: '',
  username: '',
  password: '',
  url: '',
  notes: '',
  tags: [],
}

const AUTO_LOCK_CHOICES = [
  { value: 1, label: '1 分钟' },
  { value: 5, label: '5 分钟' },
  { value: 15, label: '15 分钟' },
  { value: 30, label: '30 分钟' },
  { value: 0, label: '从不' },
]

export function VaultPage({
  onNotice,
  onBack,
}: {
  onNotice: (msg: string) => void
  /**
   * 返回知识库。保险箱现在是知识库页的第二个视图，不是独立页面 ——
   * 三个状态分支（未初始化 / 已锁定 / 已解锁）都要有出口，
   * 因为前两个分支里没有"锁定"按钮可依附。
   *
   * 早先做成固定定位的悬浮按钮，结果**位置不对也点不到**：
   * position: fixed 在祖先带 transform / filter 时会相对那个祖先定位，
   * 而且会被同层内容盖住。放在各分支自己的按钮旁边才是稳的。
   */
  onBack?: () => void
}): JSX.Element {
  const [status, setStatus] = useState<Status>('uninitialized')
  const [entries, setEntries] = useState<Entry[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [ack, setAck] = useState(false)

  const [draft, setDraft] = useState<typeof EMPTY>(EMPTY)
  const [tagText, setTagText] = useState('')
  const [strength, setStrength] = useState<{ score: number; label: string } | null>(null)
  const [autoLock, setAutoLock] = useState(5)
  const [confirmDestroy, setConfirmDestroy] = useState(false)
  /** 机器上可导入的浏览器（有已保存密码的才算） */
  const [browsers, setBrowsers] = useState<{ key: 'chrome' | 'edge'; label: string; profiles: string[] }[]>([])
  const [importing, setImporting] = useState(false)
  /** 剪贴板里疑似密码的内容；只提示，不自动保存 */
  const [clipCandidate, setClipCandidate] = useState('')
  /** 浏览器扩展要用的端口与令牌 */
  const [httpInfo, setHttpInfo] = useState<{ port: number; token: string } | null>(null)
  const [showToken, setShowToken] = useState(false)

  const api = window.zhixing?.vault
  const draftIdRef = useRef<number | null>(null)

  /** 清空所有已解密内容。**锁定路径上必须走它** —— 这是"锁定"在界面上的一半含义。 */
  const wipe = useCallback(() => {
    setEntries([])
    setSelectedId(null)
    setDraft(EMPTY)
    setTagText('')
    setQuery('')
    draftIdRef.current = null
  }, [])

  const refresh = useCallback(async () => {
    if (!api) return
    const st = await api.status()
    setStatus(st)
    if (st === 'unlocked') {
      const r = await api.list()
      if (r.ok) setEntries(r.entries)
      else {
        setError(r.message ?? '读取失败')
        wipe()
      }
    } else {
      wipe()
    }
  }, [api, wipe])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 主进程锁定（手动 / 自动）时同步清掉界面上的明文
  useEffect(() => {
    if (!api) return
    return api.onLocked(() => {
      setStatus('locked')
      wipe()
      setClipCandidate('')
      onNotice('保险箱已锁定')
    })
  }, [api, wipe, onNotice])

  /**
   * 剪贴板助手：**只在解锁期间运行**。
   * 它拿不到"这段文本是从哪复制的"，所以只把候选交给界面显示一条提示，
   * 由用户决定要不要存 —— 不自动建条目，也不弹窗打断。
   */
  useEffect(() => {
    if (!api || status !== 'unlocked') return
    void api.clipboardStart()
    const off = api.onClipboardCandidate((text) => setClipCandidate(text))
    return () => {
      off()
      void api.clipboardStop()
    }
  }, [api, status])

  // 解锁后看看有哪些浏览器可以导入
  useEffect(() => {
    if (!api || status !== 'unlocked') return
    void api.browsers().then(setBrowsers)
  }, [api, status])

  // 解锁后取一次扩展配置
  useEffect(() => {
    if (!api || status !== 'unlocked') return
    void api.httpInfo().then(setHttpInfo)
  }, [api, status])

  // 任何交互都算"有活动"，自动锁定的计时以它为准
  useEffect(() => {
    const handler = (): void => {
      if (status === 'unlocked') void api?.touch()
    }
    window.addEventListener('click', handler)
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('click', handler)
      window.removeEventListener('keydown', handler)
    }
  }, [api, status])

  // 草稿里的密码强度提示（本地计算，不联网）
  useEffect(() => {
    if (!api) return
    let alive = true
    void api.strength(draft.password).then((s) => {
      if (alive) setStrength(s)
    })
    return () => {
      alive = false
    }
  }, [api, draft.password])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.username.toLowerCase().includes(q) ||
        e.url.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q))
    )
  }, [entries, query])

  // ------------------------------------------------------------ 未初始化

  const doSetup = async (): Promise<void> => {
    if (!api) return
    setError('')
    if (pw1.length < 8) {
      setError('主密码至少 8 位')
      return
    }
    if (pw1 !== pw2) {
      setError('两次输入不一致')
      return
    }
    if (!ack) {
      setError('请确认「忘记主密码将无法找回」')
      return
    }
    setBusy(true)
    try {
      const r = await api.setup(pw1)
      if (!r.ok) setError(r.message ?? '设置失败')
      else {
        setPw1('')
        setPw2('')
        onNotice('主密码已设置')
        await refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  // ------------------------------------------------------------ 已锁定

  const doUnlock = async (): Promise<void> => {
    if (!api) return
    setError('')
    setBusy(true)
    try {
      const r = await api.unlock(pw1)
      if (!r.ok) setError(r.message ?? '主密码不正确')
      else {
        setPw1('')
        await refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  // ------------------------------------------------------------ 已解锁

  const selectEntry = (e: Entry): void => {
    setSelectedId(e.id)
    draftIdRef.current = e.id
    setDraft({
      title: e.title,
      username: e.username,
      password: e.password,
      url: e.url,
      notes: e.notes,
      tags: e.tags,
    })
    setTagText(e.tags.join(', '))
    setError('')
  }

  const startNew = (): void => {
    setSelectedId(null)
    draftIdRef.current = null
    setDraft(EMPTY)
    setTagText('')
    setError('')
  }

  const parseTags = (): string[] =>
    tagText
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean)

  const save = async (): Promise<void> => {
    if (!api) return
    if (!draft.title.trim()) {
      setError('标题不能为空')
      return
    }
    const input = { ...draft, tags: parseTags() }
    const r = draftIdRef.current
      ? await api.update(draftIdRef.current, input)
      : await api.create(input)
    if (!r.ok) {
      setError(r.message ?? '保存失败')
      return
    }
    onNotice('已保存')
    await refresh()
    // 新建之后选中刚存下的那条（按标题+时间找最近更新的）
    if (!draftIdRef.current) {
      const list = await api.list()
      if (list.ok && list.entries[0]) selectEntry(list.entries[0])
    }
  }

  const removeEntry = async (): Promise<void> => {
    if (!api || !draftIdRef.current) return
    const r = await api.remove(draftIdRef.current)
    if (!r.ok) {
      setError(r.message ?? '删除失败')
      return
    }
    onNotice('已删除')
    startNew()
    await refresh()
  }

  const copy = async (text: string, what: string): Promise<void> => {
    if (!api || !text) return
    await api.copy(text)
    onNotice(`${what}已复制，30 秒后自动清除`)
  }

  const rollPassword = async (): Promise<void> => {
    if (!api) return
    const next = await api.generate({ length: 20 })
    setDraft((d) => ({ ...d, password: next }))
  }

  const setAutoLockAndSave = async (minutes: number): Promise<void> => {
    setAutoLock(minutes)
    await window.zhixing?.db?.setSetting?.('vault_auto_lock_min', String(minutes))
    onNotice(minutes === 0 ? '已设为从不自动锁定' : `已设为 ${minutes} 分钟无操作后锁定`)
  }

  /** 把浏览器密码库导进来。原文只经过主进程内存，落库前已用保险箱的密钥重新加密。 */
  const doImport = async (key: 'chrome' | 'edge', label: string): Promise<void> => {
    if (!api) return
    setImporting(true)
    try {
      const r = await api.importBrowser(key)
      onNotice(r.ok ? `${label}：${r.message}` : `${label} 导入失败：${r.message}`)
      if (r.ok) await refresh()
    } finally {
      setImporting(false)
    }
  }

  /** 把剪贴板里的候选存成一条新条目（预填密码，站点/账号留给用户补）。 */
  const saveClipCandidate = (): void => {
    setSelectedId(null)
    draftIdRef.current = null
    setDraft({ ...EMPTY, password: clipCandidate })
    setTagText('')
    setClipCandidate('')
    onNotice('已填入密码，补上标题和站点后保存')
  }

  const doDestroy = async (): Promise<void> => {
    if (!api) return
    const r = await api.destroy()
    if (r.ok) {
      setConfirmDestroy(false)
      wipe()
      onNotice('保险箱已清空，请重新设置主密码')
      await refresh()
    }
  }

  // ------------------------------------------------------------ 渲染

  if (!api) {
    return <div className="page"><p className="u-aux">保险箱需要桌面端环境。</p></div>
  }

  if (status === 'uninitialized') {
    return (
      <div className="page vault-page">
        <div className="vault-center u-card">
          <CheckCircle2 size={28} />
          <h2>设置主密码</h2>
          <p className="u-aux">
            保险箱里的内容全部以密文存储。主密码只在你输入时用于派生密钥，
            <strong>不会以任何形式保存</strong>。
          </p>
          <input
            className="vault-input"
            type="password"
            placeholder="主密码（至少 8 位）"
            value={pw1}
            onChange={(e) => setPw1(e.target.value)}
            aria-label="主密码"
          />
          <input
            className="vault-input"
            type="password"
            placeholder="再输一次"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            aria-label="确认主密码"
          />
          {/* 这一条不能默认勾上 —— 它是用户对"数据可能永久丢失"的知情确认 */}
          <label className="vault-ack">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>我知道：<strong>忘记主密码将无法找回</strong>，届时只能清空保险箱重建</span>
          </label>
          {error && <p className="vault-error">{error}</p>}
          <button className="btn" disabled={busy} onClick={() => void doSetup()}>
            {busy ? '正在派生密钥…' : '创建保险箱'}
          </button>
          {onBack && (
            <button className="btn btn--ghost" onClick={onBack}>
              稍后再说
            </button>
          )}
          <p className="u-aux vault-hint">
            派生密钥需要约 1 秒，这是刻意的 —— 它让暴力破解的代价同样高昂。
          </p>
        </div>
      </div>
    )
  }

  if (status === 'locked') {
    return (
      <div className="page vault-page">
        <div className="vault-center u-card">
          <Archive size={28} />
          <h2>保险箱已锁定</h2>
          <input
            className="vault-input"
            type="password"
            placeholder="主密码"
            value={pw1}
            autoFocus
            onChange={(e) => setPw1(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doUnlock()
            }}
            aria-label="主密码"
          />
          {error && <p className="vault-error">{error}</p>}
          <button className="btn" disabled={busy} onClick={() => void doUnlock()}>
            {busy ? '正在解锁…' : '解锁'}
          </button>
          {onBack && (
            <button className="btn btn--ghost" onClick={onBack}>
              返回知识库
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="page vault-page vault-page--open">
      {/*
        剪贴板提示条。刻意做成"一条细横幅 + 两个按钮"而不是弹窗 ——
        它可能误报（任何短的无空白文本都算候选），打断用户是不合适的。
      */}
      {clipCandidate && (
        <div className="vault-clip">
          <span className="vault-clip__text">剪贴板里有一段内容，要存进保险箱吗？</span>
          <button className="btn" onClick={saveClipCandidate}>
            保存
          </button>
          <button className="btn btn--ghost" onClick={() => setClipCandidate('')}>
            忽略
          </button>
        </div>
      )}
      <aside className="vault-list u-card">
        <header className="vault-list__head">
          <input
            className="vault-input"
            placeholder="搜索标题 / 账号 / 标签…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索保险箱"
          />
          <button className="btn btn--ghost vault-icon" title="新建" onClick={startNew}>
            <Plus size={16} />
          </button>
          {/* 返回与锁定并排 —— 都是"离开当前视图"，位置也该在一起 */}
          {onBack && (
            <button className="btn btn--ghost vault-icon" title="返回知识库" onClick={onBack}>
              <ArrowLeft size={16} />
            </button>
          )}
          <button className="btn btn--ghost vault-icon" title="锁定" onClick={() => void api.lock()}>
            <Archive size={16} />
          </button>
        </header>
        <div className="vault-list__items">
          {filtered.length === 0 && (
            <p className="u-aux vault-empty">{entries.length === 0 ? '还没有条目' : '没有匹配的条目'}</p>
          )}
          {filtered.map((e) => (
            <button
              key={e.id}
              className={`vault-item${e.id === selectedId ? ' vault-item--active' : ''}`}
              onClick={() => selectEntry(e)}
            >
              <span className="vault-item__title">{e.title || '(无标题)'}</span>
              {e.username && <span className="u-aux vault-item__sub">{e.username}</span>}
            </button>
          ))}
        </div>
        <footer className="vault-list__foot">
          {/*
            导入的是**浏览器已经保存下来的密码**，读的是用户自己的数据文件，
            不需要任何键盘钩子 —— 这也是这条路径与"捕获输入"的根本区别。
          */}
          {browsers.length > 0 && (
            <div className="vault-import">
              {browsers.map((b) => (
                <button
                  key={b.key}
                  className="btn btn--ghost vault-import__btn"
                  disabled={importing}
                  title={`读取 ${b.label} 的已保存密码（${b.profiles.join(', ')}）`}
                  onClick={() => void doImport(b.key, b.label)}
                >
                  {importing ? '导入中…' : `从 ${b.label} 导入`}
                </button>
              ))}
            </div>
          )}
          <label className="vault-autolock">
            <span className="u-aux">无操作后锁定</span>
            <select
              className="vault-select"
              value={autoLock}
              onChange={(e) => void setAutoLockAndSave(Number(e.target.value))}
              aria-label="自动锁定时间"
            >
              {AUTO_LOCK_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </footer>
      </aside>

      <section className="vault-detail u-card">
        <header className="vault-detail__head">
          <h2>{draftIdRef.current ? '编辑条目' : '新建条目'}</h2>
          <div className="vault-detail__actions">
            <button className="btn btn--ghost" onClick={() => void save()}>
              保存
            </button>
            {draftIdRef.current && (
              <button className="btn btn--danger" title="删除" onClick={() => void removeEntry()}>
                <Trash2 size={15} />
              </button>
            )}
          </div>
        </header>

        <label className="set-row">
          <span>标题</span>
          <input
            className="vault-input"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            aria-label="标题"
          />
        </label>

        <label className="set-row">
          <span>账号</span>
          <input
            className="vault-input"
            value={draft.username}
            onChange={(e) => setDraft({ ...draft, username: e.target.value })}
            aria-label="账号"
          />
          <button className="btn btn--ghost vault-icon" title="复制账号" onClick={() => void copy(draft.username, '账号')}>
            <Copy size={15} />
          </button>
        </label>

        <label className="set-row">
          <span>密码</span>
          <input
            className="vault-input"
            type="text"
            value={draft.password}
            onChange={(e) => setDraft({ ...draft, password: e.target.value })}
            aria-label="密码"
          />
          {strength && <span className={`vault-strength vault-strength--${strength.score}`}>{strength.label}</span>}
          <button className="btn btn--ghost vault-icon" title="生成随机密码" onClick={() => void rollPassword()}>
            <RefreshCw size={15} />
          </button>
          <button className="btn btn--ghost vault-icon" title="复制密码" onClick={() => void copy(draft.password, '密码')}>
            <Copy size={15} />
          </button>
        </label>

        <label className="set-row">
          <span>网址</span>
          <input
            className="vault-input"
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            aria-label="网址"
          />
        </label>

        <label className="set-row">
          <span>标签</span>
          <input
            className="vault-input"
            placeholder="用逗号分隔"
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
            aria-label="标签"
          />
        </label>

        <label className="set-row set-row--area">
          <span>备注</span>
          <textarea
            className="vault-input"
            rows={5}
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            aria-label="备注"
          />
        </label>

        {error && <p className="vault-error">{error}</p>}

        <footer className="vault-detail__foot">
          {/*
            浏览器扩展的配置。令牌要显式点开才显示 —— 它会出现在屏幕上，
            而屏幕可能正被别人看着；但它不是主密码，拿到也只能"写"，
            且锁定状态下端点一律拒收。
          */}
          {httpInfo && (
            <div className="vault-ext">
              <div className="vault-ext__head">
                <span>浏览器扩展</span>
                <button className="btn btn--ghost vault-ext__toggle" onClick={() => setShowToken((v) => !v)}>
                  {showToken ? '隐藏令牌' : '连接浏览器'}
                </button>
              </div>
              {showToken && (
                <>
                  <p className="u-aux">
                    在扩展的「扩展程序选项」里填入下面这串令牌。扩展只会把凭据发到
                    <code>127.0.0.1:{httpInfo.port}</code>，不联网。
                  </p>
                  <div className="vault-ext__row">
                    <input className="vault-input" readOnly value={httpInfo.token} aria-label="扩展令牌" />
                    <button
                      className="btn btn--ghost vault-icon"
                      title="复制令牌"
                      onClick={() => void copy(httpInfo.token, '令牌')}
                    >
                      <Copy size={15} />
                    </button>
                    <button
                      className="btn btn--ghost"
                      title="重新生成（已配好的扩展需要重新粘贴）"
                      onClick={() => void api.rotateToken().then((r) => setHttpInfo({ ...httpInfo, token: r.token }))}
                    >
                      重新生成
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {confirmDestroy ? (
            <div className="vault-danger">
              <span>清空后所有条目都会消失，且无法恢复。确定？</span>
              <button className="btn btn--danger" onClick={() => void doDestroy()}>
                确认清空
              </button>
              <button className="btn btn--ghost" onClick={() => setConfirmDestroy(false)}>
                取消
              </button>
            </div>
          ) : (
            <button className="btn btn--ghost vault-danger__trigger" onClick={() => setConfirmDestroy(true)}>
              <RotateCcw size={15} /> 忘记主密码？清空并重设
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}
