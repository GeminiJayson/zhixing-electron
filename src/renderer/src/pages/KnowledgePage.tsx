import { useCallback, useEffect, useState } from 'react'
import { Archive, CheckCircle2, CircleAlert, RotateCcw } from '@renderer/lib/icons'

/**
 * 知识库。设计见 docs/specs/knowledge-base-reorg.md。
 *
 * 界面上的两条硬约束：
 *   1. **默认只显示「可用」** —— 待确认的不是结论，不该混在默认视图里；
 *   2. **新建一律进待确认** —— 这里没有「直接创建可用知识」的入口（方案 §4）。
 */

interface Row {
  id: number
  title: string
  kind: string
  verified_at: string | null
  archived_at: string | null
  verify_note: string | null
  updated_at: string | null
}

const KINDS: { key: string; label: string; needsSource: boolean }[] = [
  { key: 'concept', label: '概念', needsSource: true },
  { key: 'summary', label: '摘要', needsSource: true },
  { key: 'synthesis', label: '综合分析', needsSource: true },
  { key: 'method', label: '方法论', needsSource: true },
  { key: 'output', label: '输出', needsSource: true },
  { key: 'pitfall', label: '踩坑', needsSource: true },
  { key: 'note', label: '笔记', needsSource: false },
  { key: 'project', label: '项目记录', needsSource: false },
]

const KIND_LABEL: Record<string, string> = Object.fromEntries(KINDS.map((k) => [k.key, k.label]))

export function KnowledgePage({ onNotice }: { onNotice: (m: string) => void }): JSX.Element {
  const api = window.zhixing?.knowledge
  const [rows, setRows] = useState<Row[]>([])
  const [counts, setCounts] = useState<Record<string, { verified: number; draft: number }>>({})
  const [kind, setKind] = useState<string>('all')
  const [status, setStatus] = useState<'verified' | 'draft' | 'all'>('verified')
  const [selected, setSelected] = useState<Row | null>(null)
  const [composing, setComposing] = useState(false)

  // 新建表单
  const [nTitle, setNTitle] = useState('')
  const [nKind, setNKind] = useState('concept')
  const [nContent, setNContent] = useState('')
  const [nSource, setNSource] = useState('')

  // 核对 / 退回
  const [checkNote, setCheckNote] = useState('')
  const [rejectNote, setRejectNote] = useState('')

  const refresh = useCallback(async () => {
    if (!api) return
    const [list, c] = await Promise.all([api.list({ kind, status }), api.counts()])
    setRows(list)
    setCounts(c)
  }, [api, kind, status])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const total = (s: 'verified' | 'draft'): number =>
    Object.values(counts).reduce((sum, v) => sum + (s === 'verified' ? v.verified : v.draft), 0)

  const doCreate = async (): Promise<void> => {
    if (!api) return
    const src = Number.parseInt(nSource, 10)
    const r = await api.create({
      title: nTitle,
      content: nContent,
      kind: nKind,
      sourceNoteId: Number.isFinite(src) ? src : null,
    })
    if (!r.ok) {
      onNotice(r.message ?? '创建失败')
      return
    }
    onNotice('已存入待确认 —— 核对通过后才会进可用区域')
    setComposing(false)
    setNTitle('')
    setNContent('')
    setNSource('')
    setStatus('draft')
    await refresh()
  }

  const doVerify = async (): Promise<void> => {
    if (!api || !selected) return
    const r = await api.verify(selected.id, checkNote)
    if (!r.ok) {
      onNotice(r.message ?? '核对失败')
      return
    }
    onNotice('已标为可用')
    setCheckNote('')
    setSelected(null)
    await refresh()
  }

  const doReject = async (): Promise<void> => {
    if (!api || !selected || !rejectNote.trim()) {
      onNotice('退回要填原因 —— 那是你下次不再踩同一个坑的依据')
      return
    }
    await api.unverify(selected.id, rejectNote)
    onNotice('已退回待确认')
    setRejectNote('')
    setSelected(null)
    await refresh()
  }

  if (!api) return <div className="page"><p className="u-aux">知识库需要桌面端环境。</p></div>

  return (
    <div className="page kb-page">
      <header className="kb-bar">
        <div className="kb-kinds">
          <button className={'kb-tab' + (kind === 'all' ? ' kb-tab--on' : '')} onClick={() => setKind('all')}>
            全部
          </button>
          {KINDS.map((k) => {
            const c = counts[k.key]
            const n = c ? c.verified + c.draft : 0
            return (
              <button
                key={k.key}
                className={'kb-tab' + (kind === k.key ? ' kb-tab--on' : '')}
                onClick={() => setKind(k.key)}
              >
                {k.label}
                {n > 0 && <span className="kb-tab__n">{n}</span>}
              </button>
            )
          })}
        </div>
        <div className="kb-status">
          <button className={'kb-tab' + (status === 'verified' ? ' kb-tab--on' : '')} onClick={() => setStatus('verified')}>
            可用 {total('verified')}
          </button>
          <button className={'kb-tab' + (status === 'draft' ? ' kb-tab--on' : '')} onClick={() => setStatus('draft')}>
            待确认 {total('draft')}
          </button>
          <button className={'kb-tab' + (status === 'all' ? ' kb-tab--on' : '')} onClick={() => setStatus('all')}>
            全部
          </button>
          <button className="btn kb-new" onClick={() => setComposing((v) => !v)}>
            新建
          </button>
        </div>
      </header>

      {composing && (
        <section className="kb-compose u-card">
          <div className="kb-compose__row">
            <input className="kb-input" placeholder="标题" value={nTitle} onChange={(e) => setNTitle(e.target.value)} aria-label="标题" />
            <select className="kb-select" value={nKind} onChange={(e) => setNKind(e.target.value)} aria-label="类型">
              {KINDS.map((k) => (
                <option key={k.key} value={k.key}>{k.label}</option>
              ))}
            </select>
            <input className="kb-input kb-input--src" placeholder="来源笔记 id（知识类必填）" value={nSource} onChange={(e) => setNSource(e.target.value)} aria-label="来源" />
            <button className="btn" onClick={() => void doCreate()}>存为待确认</button>
          </div>
          <textarea className="kb-input kb-textarea" rows={5} placeholder="内容" value={nContent} onChange={(e) => setNContent(e.target.value)} aria-label="内容" />
          <p className="u-aux kb-hint">
            新建的条目一律是「待确认」—— 这里没有「直接创建可用知识」的入口。
            知识类条目还要挂上来源，核对通过后才会进可用区域。
          </p>
        </section>
      )}

      <div className="kb-body">
        <div className="kb-list">
          {rows.length === 0 && (
            <p className="u-aux kb-empty">
              {status === 'draft' ? '没有待确认的条目' : status === 'verified' ? '还没有可用条目' : '还没有内容'}
            </p>
          )}
          {rows.map((r) => (
            <button
              key={r.id}
              className={'kb-item' + (selected?.id === r.id ? ' kb-item--on' : '')}
              onClick={() => setSelected(r)}
            >
              {/* 待确认标记必须在列表上就看得见，否则这个状态白设 */}
              {r.verified_at ? (
                <CheckCircle2 size={14} className="kb-item__ok" />
              ) : (
                <CircleAlert size={14} className="kb-item__draft" />
              )}
              <span className="kb-item__title">{r.title}</span>
              <span className="kb-badge">{KIND_LABEL[r.kind] ?? r.kind}</span>
              {r.archived_at && <span className="kb-badge kb-badge--dim">已归档</span>}
            </button>
          ))}
        </div>

        {selected && (
          <aside className="kb-detail u-card">
            <h2>{selected.title}</h2>
            <p className="u-aux">
              {KIND_LABEL[selected.kind] ?? selected.kind} ·{' '}
              {selected.verified_at ? '可用' : '待确认'}
            </p>
            {selected.verify_note && <p className="kb-note">{selected.verify_note}</p>}

            {selected.verified_at ? (
              <>
                <p className="u-aux kb-hint">
                  知识会被推翻。发现这条不再成立时，「退回待确认」并记下原因 ——
                  不要删掉，删掉的话下次还会踩同一个坑。
                </p>
                <textarea className="kb-input kb-textarea" rows={3} placeholder="退回原因" value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} aria-label="退回原因" />
                <div className="kb-actions">
                  <button className="btn btn--ghost" onClick={() => void doReject()}>
                    <RotateCcw size={14} /> 退回待确认
                  </button>
                  <button className="btn btn--ghost" onClick={() => void api.archive(selected.id).then(refresh)}>
                    <Archive size={14} /> 归档
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="u-aux kb-hint">
                  核对通过之前，它不会出现在可用区域，也不该被当成结论引用。
                  知识类条目还必须先挂上来源。
                </p>
                <textarea className="kb-input kb-textarea" rows={3} placeholder="核对结论（关键说法有无依据 / 适用场景 / 是否与其他资料冲突）" value={checkNote} onChange={(e) => setCheckNote(e.target.value)} aria-label="核对结论" />
                <div className="kb-actions">
                  <button className="btn" onClick={() => void doVerify()}>
                    <CheckCircle2 size={14} /> 核对通过，标为可用
                  </button>
                </div>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}
