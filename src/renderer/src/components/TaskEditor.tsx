import { useEffect, useState } from 'react'
import { PRIORITY_CHOICES } from '@shared/priority'
import { STATUS_CHOICES } from '@shared/task'
import type { RepeatPeriod, Task, TaskStatus } from '@shared/types'

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
  const [notes, setNotes] = useState(task.notes_md ?? '')
  const [repeat, setRepeat] = useState<RepeatPeriod>(task.repeat_period)
  const [repeatRule, setRepeatRule] = useState(task.repeat_rule ?? '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  const save = async (): Promise<void> => {
    setSaving(true)
    await onSave(task.id, {
      title,
      status,
      priority,
      due_date: due || null,
      start_date: start || null,
      notes_md: notes,
      repeat_period: repeat,
      repeat_rule: repeat === 'custom' ? repeatRule || null : null,
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

          <div className="form-grid">
            <label className="form-row">
              <span>状态</span>
              <select className="field" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
                {STATUS_CHOICES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-row">
              <span>优先级</span>
              <select className="field" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
                {PRIORITY_CHOICES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-row">
              <span>开始</span>
              <input type="date" className="field" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="form-row">
              <span>截止</span>
              <input type="date" className="field" value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
            <label className="form-row">
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
          </div>

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
