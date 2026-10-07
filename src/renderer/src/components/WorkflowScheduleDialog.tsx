import { useEffect, useState } from 'react'
import { Select } from './Select'
import type { WorkflowTemplateSummary } from '@shared/types'
import {
  describeSchedule,
  makeTriggerToken,
  parseSchedule,
  parseTriggers,
  serializeSchedule,
  serializeTriggers,
  type WorkflowSchedule,
  type WorkflowTrigger,
} from '@shared/workflow-trigger'
import { ClipboardList, Copy, FolderPlus, Plus, Timer, Trash2, X } from '@renderer/lib/icons'

/** 任务状态的可选项：与任务模块的取值一一对应 */
const STATUS_OPTIONS = [
  { value: 'todo', label: '待办' },
  { value: 'doing', label: '进行中' },
  { value: 'waiting', label: '等待中' },
  { value: 'done', label: '已完成' },
  { value: 'abandoned', label: '已放弃' },
]

interface Props {
  template: WorkflowTemplateSummary
  /** 当前实例的任务候选（用于「任务变成某状态就启动」） */
  taskChoices: { id: number; title: string; status: string }[]
  /** 外部触发端口的当前值（settings 里读出来的，没启动成功时是空串） */
  triggerPort: string
  onSave: (patch: { schedule: string; triggers: string }) => void
  onCancel: () => void
}

/**
 * 「什么时候自己跑起来」的编辑弹窗：定时计划 + 触发条件。
 *
 * 与条件节点分开：条件节点是流程**内部**走到某一步时的关卡，
 * 这里是流程根本还没开始时的入口。两者都能用关键字/状态，但作用的位置完全不同，
 * 混在一个弹窗里会让"这个条件到底什么时候生效"变得含糊。
 */
export function WorkflowScheduleDialog({
  template,
  taskChoices,
  triggerPort,
  onSave,
  onCancel,
}: Props): React.JSX.Element {
  const [schedule, setSchedule] = useState<WorkflowSchedule>(() => parseSchedule(template.schedule))
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>(() => parseTriggers(template.triggers))
  const [copied, setCopied] = useState(false)

  /** 从别的模板抄一个已有令牌没有意义，这里只负责生成 */
  const addHttp = (): void => {
    setTriggers((prev) => [...prev, { kind: 'http', token: makeTriggerToken() }])
  }
  const httpTokens = triggers.filter((t) => t.kind === 'http').map((t) => t.token ?? '')
  const hookUrl = (token: string): string =>
    triggerPort ? `http://127.0.0.1:${triggerPort}/hook/${token}` : `http://127.0.0.1:<端口>/hook/${token}`

  /** 目录只能走系统对话框选：手敲盘符路径既容易错，也没法当场验证存在性 */
  const pickFolder = async (index: number): Promise<void> => {
    const dir = await window.zhixing.db.pickDirectory()
    if (!dir) return
    setTriggers((prev) => prev.map((x, j) => (j === index ? { ...x, path: dir } : x)))
  }

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(t)
  }, [copied])

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal modal--dialog" onClick={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <Timer size={15} />
          <strong>计划与触发 · {template.name}</strong>
          <button className="icon-btn" onClick={onCancel} title="关闭" aria-label="关闭">
            <X size={14} />
          </button>
        </header>
        <div className="modal__body">
          <label className="form-row">
            <span>定时计划</span>
            <Select
              className="field"
              ariaLabel="自动运行方式"
              value={schedule.kind}
              onChange={(v) => {
                const kind = v as WorkflowSchedule['kind']
                setSchedule(
                  kind === 'interval'
                    ? { kind, everyMin: schedule.everyMin ?? 30 }
                    : kind === 'daily'
                      ? { kind, at: schedule.at ?? '09:00' }
                      : { kind: 'manual' }
                )
              }}
              options={[
                { value: 'manual', label: '不自动跑（只手动启动）' },
                { value: 'interval', label: '每隔一段时间' },
                { value: 'daily', label: '每天固定时刻' },
              ]}
            />
          </label>

          {schedule.kind === 'interval' && (
            <label className="form-row">
              <span>间隔（分钟）</span>
              <input
                className="field"
                type="number"
                min={1}
                value={schedule.everyMin ?? 30}
                onChange={(e) => setSchedule({ kind: 'interval', everyMin: Number(e.target.value) })}
              />
            </label>
          )}
          {schedule.kind === 'daily' && (
            <label className="form-row">
              <span>时刻</span>
              <input
                className="field"
                type="time"
                value={schedule.at ?? '09:00'}
                onChange={(e) => setSchedule({ kind: 'daily', at: e.target.value })}
              />
            </label>
          )}
          <p className="u-aux">
            应用没运行时不会触发，错过的时间也不补 —— 「每天九点」要的是九点那次，不是开机补一次。
            {schedule.kind !== 'manual' && ` 当前：${describeSchedule(schedule)}。`}
          </p>

          <div className="form-block">
            <div className="form-row">
              <span>触发条件</span>
              <span className="wf-trigger-actions">
                <button
                  className="text-btn"
                  disabled={!taskChoices.length}
                  title={taskChoices.length ? '某个任务变成某个状态就启动本流程' : '还没有可选的未完成任务'}
                  onClick={() =>
                    setTriggers((prev) => [
                      ...prev,
                      { kind: 'task_status', taskId: taskChoices[0]?.id, status: 'done' },
                    ])
                  }
                >
                  <Plus size={13} /> 任务状态触发
                </button>
                <button className="text-btn" onClick={addHttp} title="生成一个外部调用令牌">
                  <Plus size={13} /> 外部触发令牌
                </button>
                <button
                  className="text-btn"
                  onClick={() => setTriggers((prev) => [...prev, { kind: 'folder', path: '', pattern: '' }])}
                  title="盯一个目录：里面出现匹配的文件就启动本流程"
                >
                  <FolderPlus size={13} /> 目录变化触发
                </button>
                <button
                  className="text-btn"
                  onClick={() =>
                    setTriggers((prev) => [...prev, { kind: 'clipboard', pattern: '', mode: 'contains' }])
                  }
                  title="复制到匹配的文本就启动本流程"
                >
                  <ClipboardList size={13} /> 剪贴板匹配触发
                </button>
              </span>
            </div>

            {triggers.map((t, i) =>
              t.kind === 'task_status' ? (
                <div key={i} className="form-row wf-rule">
                  <Select
                    className="field"
                    ariaLabel="盯哪个任务"
                    value={String(t.taskId ?? '')}
                    onChange={(v) => setTriggers((prev) => prev.map((x, j) => (j === i ? { ...x, taskId: Number(v) } : x)))}
                    options={[
                      { value: '', label: '（选一个任务）' },
                      ...taskChoices.map((tk) => ({ value: String(tk.id), label: tk.title })),
                    ]}
                  />
                  <span className="u-aux">变成</span>
                  <Select
                    className="field"
                    ariaLabel="变成什么状态"
                    value={t.status ?? 'done'}
                    onChange={(v) => setTriggers((prev) => prev.map((x, j) => (j === i ? { ...x, status: v } : x)))}
                    options={STATUS_OPTIONS.map((x) => ({ value: x.value, label: x.label }))}
                  />
                  <button
                    className="icon-btn icon-btn--danger"
                    title="删掉这个触发"
                    aria-label="删掉这个触发"
                    onClick={() => setTriggers((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ) : t.kind === 'http' ? (
                <div key={i} className="form-row wf-rule">
                  <input className="field" readOnly value={t.token ?? ''} aria-label="触发令牌" />
                  <button
                    className="icon-btn"
                    title="复制调用地址"
                    aria-label="复制调用地址"
                    onClick={() => {
                      void navigator.clipboard.writeText(hookUrl(t.token ?? ''))
                      setCopied(true)
                    }}
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    className="icon-btn icon-btn--danger"
                    title="删掉这个令牌"
                    aria-label="删掉这个令牌"
                    onClick={() => setTriggers((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ) : t.kind === 'folder' ? (
                <div key={i} className="form-row wf-rule">
                  <input
                    className="field"
                    readOnly
                    value={t.path ?? ''}
                    placeholder="（还没选目录 —— 保存时会被丢掉）"
                    aria-label="盯哪个目录"
                  />
                  <button className="text-btn" onClick={() => void pickFolder(i)}>
                    选目录
                  </button>
                  <input
                    className="field"
                    value={t.pattern ?? ''}
                    placeholder="*.md（留空 = 任何文件）"
                    aria-label="文件名匹配"
                    onChange={(e) =>
                      setTriggers((prev) => prev.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)))
                    }
                  />
                  <button
                    className="icon-btn icon-btn--danger"
                    title="删掉这个触发"
                    aria-label="删掉这个触发"
                    onClick={() => setTriggers((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ) : t.kind === 'clipboard' ? (
                <div key={i} className="form-row wf-rule">
                  <Select
                    className="field"
                    ariaLabel="怎么匹配剪贴板"
                    value={t.mode ?? 'contains'}
                    onChange={(v) =>
                      setTriggers((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, mode: v as 'contains' | 'regex' } : x))
                      )
                    }
                    options={[
                      { value: 'contains', label: '包含' },
                      { value: 'regex', label: '匹配正则' },
                    ]}
                  />
                  <input
                    className="field"
                    value={t.pattern ?? ''}
                    placeholder={t.mode === 'regex' ? '^#\\d+\\s' : '复制的内容里有它就启动'}
                    aria-label="剪贴板匹配内容"
                    onChange={(e) =>
                      setTriggers((prev) => prev.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)))
                    }
                  />
                  <button
                    className="icon-btn icon-btn--danger"
                    title="删掉这个触发"
                    aria-label="删掉这个触发"
                    onClick={() => setTriggers((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ) : null
            )}

            {triggers.some((t) => t.kind === 'http') && (
              <p className="u-aux">
                {copied ? '调用地址已复制。' : '点复制拿到调用地址，然后用 POST 请求它即可启动本流程：'}
                <br />
                {hookUrl(httpTokens[0] ?? '')}
                {triggerPort ? '' : '（端口要从启动日志里找：应用启动时会打印，设置页也会显示）'}
              </p>
            )}
          </div>

          <p className="u-aux">
            这四种触发都是「启动本流程」的入口；要拿流程**内部**某一步的结果做关卡，
            用画布上那个条件节点（它可以按上一步的结果或日志判定）。
            <br />
            目录变化只看文件名（中间文件如 <code>~$</code> / <code>.tmp</code> 会被忽略），
            应用没运行时不会补触发；剪贴板匹配在本机内存里比对，复制的内容不会落库。
          </p>
        </div>
        <footer className="modal__foot">
          <button className="text-btn" onClick={onCancel}>
            取消
          </button>
          <button
            className="btn btn--accent"
            onClick={() =>
              onSave({ schedule: serializeSchedule(schedule), triggers: serializeTriggers(triggers) })
            }
          >
            保存
          </button>
        </footer>
      </div>
    </div>
  )
}
