import { useCallback, useEffect, useState } from 'react'
import { cellKey, isCellRef, isSheetName, listNoteBlocks, type NoteBlock } from '@renderer/lib/block-fingerprint'
import { NotePicker } from './NotePicker'
import { RepeatRuleEditor } from './RepeatRuleEditor'
import { PRIORITY_CHOICES } from '@shared/priority'
import { STATUS_CHOICES } from '@shared/task'
import type { Note, NoteFolder, RepeatPeriod, Task, TaskNoteContext, TaskStatus } from '@shared/types'
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

/** 任务编辑弹窗：标题 / 状态 / 优先级 / 时间范围 / 备注。 */
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
  // 等待中可设「恢复于」（到期自动回待办）
  const [resume, setResume] = useState(task.resume_at ?? '')
  /**
   * 提醒时刻。此前没有任何界面入口 —— 只有在快速捕获里写「明天3点」才能带上，
   * 任务一建好就再也改不了。这里补上，与「开始 / 截止」共用同一对自绘控件。
   */
  const [reminder, setReminder] = useState(() => splitStamp(task.reminder_at)[0])
  const [reminderTime, setReminderTime] = useState(() => splitStamp(task.reminder_at)[1])
  // 段落级上下文（关联笔记段落）与「写复盘」回写
  const [contexts, setContexts] = useState<TaskNoteContext[]>([])
  const [noteList, setNoteList] = useState<Note[]>([])
  const [pickNote, setPickNote] = useState('')
  /**
   * 选中笔记后列出的**可关联段落**。
   *
   * 旧版这里是一个让用户手填「段落块键」的输入框 —— 键是内容指纹（fp: + sha1 前 12 位），
   * 纯内部标识符，用户根本无从得知该填什么，这就是"不知道怎么关联笔记段落"的根源。
   * 现在改成：选定笔记 → 解析它的段落 → 从列表里点一段。
   */
  const [blocks, setBlocks] = useState<NoteBlock[]>([])
  const [pickBlock, setPickBlock] = useState('')
  const [pickedNoteTitle, setPickedNoteTitle] = useState('')
  /**
   * 选中笔记的格式。Excel 是特例：它**在应用里拿不到内容**（正文在本地 .xlsx，
   * 应用只登记路径），所以没法像段落那样解析出来给用户挑，只能让用户照着
   * 系统应用里看到的填"工作表 + 单元格"。链接笔记则相反 —— 一条链接就是一项，
   * 直接进段落下拉。
   */
  const [pickedFormat, setPickedFormat] = useState('')
  const [cellSheet, setCellSheet] = useState('')
  const [cellRef, setCellRef] = useState('')
  /** 笔记选择器：原生 select 放不下图标与缩进，改成自绘弹层 */
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null)
  const [folders, setFolders] = useState<NoteFolder[]>([])
  const [saving, setSaving] = useState(false)

  /** 整篇级的关联（task_note_link 与 task_note_ref 合并去重） */
  const [linkedNotes, setLinkedNotes] = useState<Note[]>([])

  const loadContexts = useCallback(async (): Promise<void> => {
    setContexts(await window.zhixing.db.linkedContexts(task.id))
    setLinkedNotes(await window.zhixing.db.linkedNotes(task.id))
  }, [task.id])

  /** 解除整篇级关联：两张表都清一次（哪张有就删哪张） */
  const detachLinkedNote = async (noteId: number): Promise<void> => {
    await window.zhixing.db.unlinkTaskNote(task.id, noteId)
    await loadContexts()
  }

  useEffect(() => {
    void loadContexts()
    void (async () => setNoteList(await window.zhixing.db.notes()))()
    void (async () => setFolders(await window.zhixing.db.noteFolders()))()
  }, [loadContexts])

  const noteTitle = (id: number): string =>
    noteList.find((n) => n.id === id)?.title ?? `#${id}`

  /** 选定笔记 → 取出它的段落清单（markdown 按行、富文本/Word 按块级元素） */
  const loadBlocks = useCallback(async (noteId: number): Promise<void> => {
    if (!noteId) {
      setBlocks([])
      setPickedNoteTitle('')
      return
    }
    const note = await window.zhixing.db.note(noteId)
    if (!note) {
      setBlocks([])
      return
    }
    setPickedNoteTitle(note.title)
    setPickedFormat(note.format)
    setBlocks(listNoteBlocks(note.format, note.content_md ?? ''))
  }, [])

  useEffect(() => {
    void loadBlocks(Number(pickNote))
    setPickBlock('')
  }, [pickNote, loadBlocks])

  const attachContext = async (): Promise<void> => {
    const noteId = Number(pickNote)
    const block = blocks.find((b) => b.key === pickBlock)
    if (!noteId || !block) return
    // 引文快照自动取段落原文（前 200 字）：用户不必再手抄一遍，而且它本来就是"当时的原文"
    await window.zhixing.db.linkTaskNoteBlock(task.id, noteId, block.key, block.text.slice(0, 200))
    setPickBlock('')
    await loadContexts()
  }

  /** Excel 单元格：键由"工作表 + 坐标"拼，不需要内容指纹 */
  const attachCellContext = async (): Promise<void> => {
    const noteId = Number(pickNote)
    const ref = cellRef.trim().toUpperCase()
    if (!noteId || !isCellRef(ref)) return
    if (cellSheet.trim() && !isSheetName(cellSheet)) return
    const key = cellKey(cellSheet, ref)
    if (!key) return
    const label = cellSheet.trim() ? `${cellSheet.trim()}!${ref}` : ref
    await window.zhixing.db.linkTaskNoteBlock(task.id, noteId, key, label)
    setCellRef('')
    await loadContexts()
  }

  const detachContext = async (c: TaskNoteContext): Promise<void> => {
    await window.zhixing.db.unlinkTaskNoteBlock(task.id, c.note_id, c.block_key)
    await loadContexts()
  }

  /** 完成沉淀：有关联段落则追加「结论」，否则新建复盘笔记。 */
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
      // 非 waiting 显式清空恢复日期
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
            {/* vt-task-title：共享元素过渡（试点）的落点 —— 打开编辑器时，任务行标题
                会「长成」这个输入框（见 TasksPage 的 openEditorWithTransition 与 tasks.css） */}
            <input
              className="field vt-task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
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
              {/* 日期与时刻分开：日期仍进 start_date（DATE 列），
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

          {/*
            已关联笔记 —— 与下面的「关联笔记段落」是**同一种关系的两种精度**：
            这一块是整篇级（task_note_link / task_note_ref），下面那块是段落级
            （task_note_context）。按 docs/specs/ownership-vs-reference.md，
            任务对笔记的关联本质是引用，与"归属"（属于哪个清单）不是一回事。
          */}
          <section className="form-row">
            <span>已关联笔记（{linkedNotes.length}）</span>
            {linkedNotes.length === 0 ? (
              <p className="u-aux">还没有关联整篇笔记。</p>
            ) : (
              <ul className="ctx-list">
                {linkedNotes.map((n) => (
                  <li key={n.id} className="ctx-row">
                    <button
                      className="text-btn"
                      onClick={() =>
                        window.dispatchEvent(
                          new CustomEvent('zhixing:open-note', { detail: n.id })
                        )
                      }
                    >
                      {n.title}
                    </button>
                    <span className="u-aux">整篇</span>
                    <span className="modal__spacer" />
                    <button className="text-btn" onClick={() => void detachLinkedNote(n.id)}>
                      解除
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="ctx-add">
              <button
                type="button"
                className="text-btn"
                onClick={(e) => {
                  setPickerAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())
                  setPickerOpen(true)
                }}
              >
                关联整篇笔记…
              </button>
            </div>
          </section>

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
                    {/* 显示人看得懂的引文快照；键只在 tooltip 里留着备查 */}
                    <span className="u-aux" title={`${c.snippet || '（无引文）'}\n${c.block_key}`}>
                      {c.snippet ? c.snippet.slice(0, 40) : c.block_key}
                      {c.snippet && c.snippet.length > 40 ? '…' : ''}
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
              {/*
                笔记选择器：**带类型图标 + 文件夹分组**。
                原生 select 的 option 放不下图标也做不出缩进，而用户反馈的正是
                "不知道选的是哪个类型" —— 平铺一列标题解决不了这个。
              */}
              <button
                type="button"
                className="field note-pick-btn"
                aria-haspopup="listbox"
                aria-expanded={pickerOpen}
                aria-label="选择笔记"
                onClick={(e) => {
                  setPickerAnchor(e.currentTarget.getBoundingClientRect())
                  setPickerOpen((v) => !v)
                }}
              >
                {pickNote ? noteTitle(Number(pickNote)) : '1. 选择笔记…'}
                <span className="note-pick-btn__caret" aria-hidden>
                  ▾
                </span>
              </button>
              {pickerOpen && (
                <NotePicker
                  notes={noteList}
                  folders={folders}
                  value={pickNote}
                  anchor={pickerAnchor}
                  onPick={(id) => {
                    setPickNote(id)
                    setPickerOpen(false)
                  }}
                  onClose={() => setPickerOpen(false)}
                />
              )}
              {/*
                可关联项随笔记格式而异：
                  · markdown / 富文本 / Word —— 解析出段落，从列表里挑；
                  · 链接笔记 —— content_md 就是 [{title,target}]，**每条链接一项**，
                    同样进这个下拉（listNoteBlocks 的 link 分支）；
                  · Excel —— 应用里看不到内容（正文在本地 .xlsx），只能照着填工作表与坐标。

                旧版这里是一个让用户手填「段落块键」的输入框 —— 键是内容指纹，
                纯内部标识符，用户无从得知该填什么，所以"关联笔记段落"实际上没法用。
              */}
              {pickedFormat === 'excel' ? (
                <>
                  <input
                    className="field"
                    placeholder="工作表（可留空＝第一张）"
                    value={cellSheet}
                    onChange={(e) => setCellSheet(e.target.value)}
                    aria-label="工作表"
                  />
                  <input
                    className="field"
                    placeholder="单元格，如 B3"
                    value={cellRef}
                    onChange={(e) => setCellRef(e.target.value)}
                    aria-label="单元格"
                  />
                  <button
                    className="text-btn"
                    onClick={() => void attachCellContext()}
                    disabled={!pickNote || !isCellRef(cellRef)}
                  >
                    关联
                  </button>
                </>
              ) : (
                <>
                  <select
                    className="field"
                    value={pickBlock}
                    onChange={(e) => setPickBlock(e.target.value)}
                    disabled={!pickNote || blocks.length === 0}
                    aria-label="选择段落"
                  >
                    <option value="">
                      {!pickNote
                        ? '2. 先选笔记'
                        : blocks.length === 0
                          ? '这篇笔记没有可关联项'
                          : `2. 选择关联项（共 ${blocks.length} 项）…`}
                    </option>
                    {blocks.map((b) => (
                      <option key={b.key} value={b.key} title={b.text}>
                        第 {b.index} 项 · {b.text.slice(0, 40)}
                        {b.text.length > 40 ? '…' : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    className="text-btn"
                    onClick={() => void attachContext()}
                    disabled={!pickNote || !pickBlock}
                  >
                    关联
                  </button>
                </>
              )}
            </div>
            {pickNote && pickedFormat === 'excel' && (
              <p className="u-aux">
                「{pickedNoteTitle}」的正文在本地表格文件里，应用内读不到内容 ——
                用「{pickedNoteTitle}」旁边的打开按钮看一眼，再照着填工作表与单元格（如 B3、A1:C9 的起点）。
              </p>
            )}
            {pickNote && pickedFormat !== 'excel' && blocks.length === 0 && (
              <p className="u-aux">
                「{pickedNoteTitle}」里没有可关联项
                {pickedFormat === 'link' ? '（这条链接笔记还没有条目）' : '（内容为空，或只含空白行）'}。
              </p>
            )}
          </section>

          {/* 自定义循环：可视化选择。旧版要求手写 RRULE 串（FREQ=…;INTERVAL=…），
              字段名记不住、写错了还不报错（认不出的部分被静默忽略）。 */}
          {repeat === 'custom' && <RepeatRuleEditor value={repeatRule} onChange={setRepeatRule} />}

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
