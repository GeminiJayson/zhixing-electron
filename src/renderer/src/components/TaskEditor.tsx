import { useCallback, useEffect, useState } from 'react'
import { PRIORITY_CHOICES } from '@shared/priority'
import { STATUS_CHOICES } from '@shared/task'
import type { Note, RepeatPeriod, Task, TaskNoteContext, TaskStatus } from '@shared/types'
import { joinStamp, splitStamp } from '../lib/date'
import { DatePicker } from './DatePicker'
import { TimePicker } from './TimePicker'

/** 只选了日期没选时刻时的默认提醒时刻 —— 半夜叫人起床没有意义。 */
const DEFAULT_REMIND_CLOCK = '09:00'

const REPEAT_CHOICES: { value: RepeatPeriod; label: string }[] = [
  { value: 'none', label: '不循环' },
  { value: 'daily', label: '每日' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'custom', label: '自定义' },
]

interface Props {
  task: Task
  onSave: (id: number, fields: Record<string, string | number | null>) => Promise<void>
  onDelete: (id: number) => Promise<void>
  onClose: () => void
}

/** 任务编辑弹窗：标题 / 状态 / 优先级 / 时间范围 / 备注（对齐手册 §5.3 的编辑页字段）。 */
export function TaskEditor({ task, onSave, onDelete, onClose }: Props) {
  const [title, setTitle] = useState(task.title)
  const [status, setStatus] = useState<TaskStatus>(task.status)
  const [priority, setPriority] = useState(task.priority)
  const [due, setDue] = useState(task.due_date ?? '')
  const [start, setStart] = useState(task.start_date ?? '')
  /** 时刻（HH:MM）：留空表示只精确到天 */
  const [dueTime, setDueTime] = useState(task.due_time ?? '')
  const [startTime, setStartTime] = useState(task.start_time ?? '')
  const [notes, setNotes] = useState(task.notes_md ?? '')
  const [repeat, setRepeat] = useState<RepeatPeriod>(task.repeat_period)
  const [repeatRule, setRepeatRule] = useState(task.repeat_rule ?? '')
  // T4：等待中可设「恢复于」（到期由 resume_due_today 自动回待办）
  const [resume, setResume] = useState(task.resume_at ?? '')
  /**
   * 提醒时刻。此前没有任何界面入口 —— 只有在快速捕获里写「明天3点」才能带上，
   * 任务一建好就再也改不了。这里补上，与「开始 / 截止」共用同一对自绘控件。
   */
  const [reminder, setReminder] = useState(() => splitStamp(task.reminder_at)[0])
  const [reminderTime, setReminderTime] = useState(() => splitStamp(task.reminder_at)[1])
  // T3：段落级上下文（关联笔记段落）与「写复盘」回写
  const [contexts, setContexts] = useState<TaskNoteContext[]>([])
  const [noteList, setNoteList] = useState<Note[]>([])
  const [pickNote, setPickNote] = useState('')
  const [blockKey, setBlockKey] = useState('')
  const [snippet, setSnippet] = useState('')
  const [saving, setSaving] = useState(false)

  const loadContexts = useCallback(async (): Promise<void> => {
    setContexts(await window.zhixing.db.linkedContexts(task.id))
  }, [task.id])

  useEffect(() => {
    void loadContexts()
    void (async () => setNoteList(await window.zhixing.db.notes()))()
  }, [loadContexts])

  const noteTitle = (id: number): string =>
    noteList.find((n) => n.id === id)?.title ?? `#${id}`

  const attachContext = async (): Promise<void> => {
    const noteId = Number(pickNote)
    if (!noteId || !blockKey.trim()) return
    await window.zhixing.db.attachBlock(task.id, noteId, blockKey.trim(), snippet.trim())
    setBlockKey('')
    setSnippet('')
    await loadContexts()
  }

  const detachContext = async (c: TaskNoteContext): Promise<void> => {
    await window.zhixing.db.detachBlock(task.id, c.note_id, c.block_key)
    await loadContexts()
  }

  /** 完成沉淀（对齐 app_controller._write_note_after_done）：有关联段落则追加「结论」，否则新建复盘笔记。 */
  const writeback = async (): Promise<void> => {
    setSaving(true)
    await window.zhixing.db.writeNoteAfterDone(task.id, task.title)
    setSaving(false)
    onClose()
  }

  useEffect(() => {
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  const save = async (): Promise<void> => {
    setSaving(true)
    // 提醒时刻：库列是 DATETIME，只给了日期就补默认时刻。日期为空即「不提醒」。
    // 拆分与拼回都在 lib/date.ts，那里有单测钉住「往返不丢信息」。
    const reminderAt = joinStamp(reminder, reminderTime, DEFAULT_REMIND_CLOCK)
    await onSave(task.id, {
      title,
      status,
      priority,
      reminder_at: reminderAt,
      due_date: due || null,
      due_time: dueTime || null,
      start_date: start || null,
      start_time: startTime || null,
      notes_md: notes,
      repeat_period: repeat,
      repeat_rule: repeat === 'custom' ? repeatRule || null : null,
      // 与 Python task_editor._commit_status 一致：非 waiting 显式清空恢复日期
      resume_at: status === 'waiting' ? resume || null : null,
    })
    setSaving(false)
    onClose()
  }

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="编辑任务"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal__head">
          <h2>编辑任务 #{task.id}</h2>
        </header>

        <div className="modal__body">
          <label className="form-row">
            <span>标题</span>
            <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </label>

          <div className="form-grid form-grid--task">
            <label className="form-row form-row--third">
              <span>状态</span>
              <select className="field" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
                {STATUS_CHOICES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-row form-row--third">
              <span>优先级</span>
              <select className="field" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
                {PRIORITY_CHOICES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-row form-row--third">
              <span>循环</span>
              <select
                className="field"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value as RepeatPeriod)}
              >
                {REPEAT_CHOICES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-row form-row--half">
              <span>开始</span>
              {/* 日期与时刻分开：日期仍进 start_date（与 Python 版共用的 DATE 列），
                  时刻进本应用私有的 start_time —— 这样「精确到分钟」不会污染共用 schema */}
              <span className="form-row__pair">
                {/* 两个都自绘：原生 date / time 面板都不进页面的样式树，尺度不受控 */}
                <DatePicker value={start} onChange={setStart} label="开始日期" />
                <TimePicker value={startTime} onChange={setStartTime} label="开始时间" />
              </span>
            </label>
            <label className="form-row form-row--half">
              <span>截止</span>
              <span className="form-row__pair">
                <DatePicker value={due} onChange={setDue} label="截止日期" />
                <TimePicker value={dueTime} onChange={setDueTime} label="截止时间" />
              </span>
            </label>
          </div>

          {/* 提醒时刻：与「截止」是两个字段 —— 截止决定进度条怎么算，提醒决定什么时候叫你。
              可以早于截止，也可以完全没有截止。 */}
          <label className="form-row">
            <span>提醒</span>
            <span className="form-row__pair">
              <DatePicker value={reminder} onChange={setReminder} label="提醒日期" />
              <TimePicker value={reminderTime} onChange={setReminderTime} label="提醒时间" />
            </span>
            <span>
              {reminder
                ? `到点提醒${reminderTime ? '' : `（默认 ${DEFAULT_REMIND_CLOCK}）`}`
                : '留空则不提醒。到点弹出提醒卡片，可稍后 5 / 15 / 30 分钟。'}
            </span>
          </label>

          {status === 'waiting' && (
            <label className="form-row">
              <span>恢复于（到期自动回待办）</span>
              <input
                type="date"
                className="field"
                value={resume}
                onChange={(e) => setResume(e.target.value)}
              />
            </label>
          )}

          <section className="form-row">
            <span>关联笔记段落（{contexts.length}）</span>
            {contexts.length === 0 ? (
              <p className="u-aux">暂无段落上下文。</p>
            ) : (
              <ul className="ctx-list">
                {contexts.map((c) => (
                  <li key={c.id} className="ctx-row">
                    <button
                      className="text-btn"
                      onClick={() =>
                        window.dispatchEvent(
                          new CustomEvent('zhixing:open-note', { detail: c.note_id })
                        )
                      }
                    >
                      {noteTitle(c.note_id)}
                    </button>
                    <span className="u-aux" title={c.snippet}>
                      {c.block_key}
                      {c.snippet ? ` · ${c.snippet.slice(0, 24)}` : ''}
                    </span>
                    <span className="modal__spacer" />
                    <button className="text-btn" onClick={() => void detachContext(c)}>
                      解除
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="ctx-add">
              <select
                className="field"
                value={pickNote}
                onChange={(e) => setPickNote(e.target.value)}
                aria-label="选择笔记"
              >
                <option value="">选择笔记…</option>
                {noteList.map((n) => (
                  <option key={n.id} value={String(n.id)}>
                    {n.title}
                  </option>
                ))}
              </select>
              <input
                className="field"
                placeholder="段落块键"
                value={blockKey}
                onChange={(e) => setBlockKey(e.target.value)}
              />
              <input
                className="field"
                placeholder="引文快照（可选）"
                value={snippet}
                onChange={(e) => setSnippet(e.target.value)}
              />
              <button
                className="text-btn"
                onClick={() => void attachContext()}
                disabled={!pickNote || !blockKey.trim()}
              >
                添加
              </button>
            </div>
          </section>

          {repeat === 'custom' && (
            <label className="form-row">
              <span>自定义规则（RRULE 子集，如 FREQ=WEEKLY;INTERVAL=2;COUNT=5）</span>
              <input
                className="field"
                value={repeatRule}
                onChange={(e) => setRepeatRule(e.target.value)}
                placeholder="FREQ=DAILY;INTERVAL=1"
              />
            </label>
          )}

          <label className="form-row">
            <span>备注</span>
            <textarea
              className="field field--area"
              rows={6}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="支持 Markdown 与 [[笔记标题]] 链接"
            />
          </label>
        </div>

        <footer className="modal__foot">
          <button className="text-btn text-btn--danger" onClick={() => void onDelete(task.id)}>
            删除
          </button>
          <button className="text-btn" onClick={() => void writeback()} disabled={saving}>
            写复盘笔记
          </button>
          <span className="modal__spacer" />
          <button className="text-btn" onClick={onClose}>
            取消
          </button>
          <button className="text-btn text-btn--accent" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  )
}
