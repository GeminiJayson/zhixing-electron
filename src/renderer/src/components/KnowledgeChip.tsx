import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, CircleAlert } from '@renderer/lib/icons'

/**
 * 编辑区标题行上的**知识徽标**。设计见 docs/specs/knowledge-base-reorg.md。
 *
 * 它回答两个问题，一个字都不多：**这一篇是什么类型**、**它可信吗**。
 * 点开之后才是操作（切换类型、核对通过、退回待确认）。
 *
 * 为什么放在标题行而不是右侧信息栏：那里放的是出链 / 反链，属于「这一篇连到哪里」；
 * 而类型与可信状态属于「这一篇是什么」—— 与标题、保存状态、标签是同一类信息。
 */

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

const LABEL: Record<string, string> = Object.fromEntries(KINDS.map((k) => [k.key, k.label]))

export interface KnowledgeMetaLite {
  kind: string
  verified: boolean
}

export function KnowledgeChip({
  noteId,
  meta,
  onChanged,
  onNotice,
}: {
  noteId: number
  meta: KnowledgeMetaLite | undefined
  onChanged: () => void
  onNotice: (m: string) => void
}): JSX.Element {
  const api = window.zhixing?.knowledge
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  /** 已有的来源。知识类条目必须至少有一条才能标为可用 —— 面板上要看得见它 */
  const [sources, setSources] = useState<{ title: string; kind: string; noteId: number | null }[]>([])
  const [srcQuery, setSrcQuery] = useState('')
  const [srcHits, setSrcHits] = useState<{ id: number; title: string; kind: string }[]>([])
  const [srcBusy, setSrcBusy] = useState(false)

  const loadSources = async (): Promise<void> => {
    setSources((await api?.sources(noteId)) ?? [])
  }

  // 换笔记时收起面板并清空草稿 —— 否则上一条的核对结论会跟着跑到下一条上
  useEffect(() => {
    setOpen(false)
    setNote('')
    setSrcQuery('')
    setSrcHits([])
    void loadSources()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId])

  // 搜来源：输入停下 250ms 再查，避免每敲一个字都过一遍全表
  useEffect(() => {
    if (!api || !srcQuery.trim()) {
      setSrcHits([])
      return
    }
    const t = setTimeout(() => {
      void api.searchSources(srcQuery).then(setSrcHits)
    }, 250)
    return () => clearTimeout(t)
  }, [api, srcQuery])

  // 点外面 / Escape 收起
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!api || !meta) return <></>

  const verified = meta.verified
  const needsSource = KINDS.find((k) => k.key === meta.kind)?.needsSource ?? false

  const changeKind = async (kind: string): Promise<void> => {
    const r = await api.setKind(noteId, kind)
    if (!r.ok) {
      onNotice('切换类型失败')
      return
    }
    // 改成需要来源的类型而它没有来源 —— 主进程会顺手把它退回待确认，这里要说清楚
    onNotice(r.demoted ? '已改为「' + (LABEL[kind] ?? kind) + '」，但因为没有来源，已退回待确认' : '已改为「' + (LABEL[kind] ?? kind) + '」')
    onChanged()
  }

  const doVerify = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.verify(noteId, note)
      if (!r.ok) {
        onNotice(r.message ?? '核对失败')
        return
      }
      onNotice('已标为可用')
      setNote('')
      setOpen(false)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const doReject = async (): Promise<void> => {
    if (!note.trim()) {
      onNotice('退回要填原因 —— 那是你下次不再踩同一个坑的依据')
      return
    }
    setBusy(true)
    try {
      await api.unverify(noteId, note)
      onNotice('已退回待确认')
      setNote('')
      setOpen(false)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const addSource = async (id: number): Promise<void> => {
    if (!api) return
    setSrcBusy(true)
    try {
      await api.link(noteId, id)
      setSrcQuery('')
      setSrcHits([])
      await loadSources()
      onChanged()
    } finally {
      setSrcBusy(false)
    }
  }

  const removeSource = async (title: string): Promise<void> => {
    if (!api) return
    await api.unlink(noteId, title)
    await loadSources()
    onChanged()
  }

  return (
    <div className="kbchip" ref={boxRef}>
      <button
        type="button"
        className={'chip chip--kb' + (verified ? ' chip--kb-ok' : ' chip--kb-draft')}
        aria-expanded={open}
        title={
          (LABEL[meta.kind] ?? meta.kind) +
          ' · ' +
          (verified ? '可用（已核对）' : '待确认（还没核对，不该被当成结论引用）')
        }
        onClick={() => setOpen((v) => !v)}
      >
        {verified ? <CheckCircle2 size={12} /> : <CircleAlert size={12} />}
        {LABEL[meta.kind] ?? meta.kind}
        {!verified && <span className="kbchip__draft">待确认</span>}
      </button>

      {open && (
        <div className="popmenu popmenu--pop kbchip__pop">
          <label className="kbchip__row">
            <span className="u-aux">类型</span>
            <select
              className="kbchip__select"
              value={meta.kind}
              aria-label="知识类型"
              onChange={(e) => void changeKind(e.target.value)}
            >
              {KINDS.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>

          {/*
            来源。它排在核对之前 —— 因为对知识类条目来说，**没有来源就不能标为可用**，
            用户该先看到"这条有没有来源"，而不是先看到一个会被拒绝的按钮。
          */}
          <div className="kbchip__src">
            <span className="u-aux">来源</span>
            <div className="kbchip__srclist">
              {sources.length === 0 && <span className="u-aux">还没有来源</span>}
              {sources.map((s) => (
                <span key={s.title} className="kbchip__srctag">
                  {s.title}
                  <button
                    type="button"
                    className="kbchip__srcdel"
                    aria-label={'移除来源 ' + s.title}
                    onClick={() => void removeSource(s.title)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <input
              className="kbchip__srcinput"
              placeholder="搜笔记标题，选中即挂为来源"
              value={srcQuery}
              aria-label="搜索来源笔记"
              onChange={(e) => setSrcQuery(e.target.value)}
            />
            {srcHits.length > 0 && (
              <div className="kbchip__hits">
                {srcHits.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    className="kbchip__hit"
                    disabled={srcBusy}
                    onClick={() => void addSource(h.id)}
                  >
                    {h.title}
                  </button>
                ))}
              </div>
            )}
          </div>

          {verified ? (
            <>
              <p className="u-aux kbchip__hint">
                知识会被推翻。发现这条不再成立时，「退回待确认」并记下原因 ——
                不要删掉，删掉的话下次还会踩同一个坑。
              </p>
              <textarea
                className="kbchip__area"
                rows={3}
                placeholder="退回原因"
                value={note}
                aria-label="退回原因"
                onChange={(e) => setNote(e.target.value)}
              />
              <button className="btn btn--ghost kbchip__act" disabled={busy} onClick={() => void doReject()}>
                退回待确认
              </button>
            </>
          ) : (
            <>
              <p className="u-aux kbchip__hint">
                核对通过之前它不会被当成结论
                {needsSource ? '；这个类型还必须先挂上来源。' : '。'}
              </p>
              <textarea
                className="kbchip__area"
                rows={3}
                placeholder="核对结论（关键说法有无依据 / 适用场景 / 是否与其他资料冲突）"
                value={note}
                aria-label="核对结论"
                onChange={(e) => setNote(e.target.value)}
              />
              <button className="btn kbchip__act" disabled={busy} onClick={() => void doVerify()}>
                <CheckCircle2 size={14} /> 核对通过，标为可用
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
