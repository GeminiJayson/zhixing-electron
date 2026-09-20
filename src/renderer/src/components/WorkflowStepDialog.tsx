import { useState } from 'react'
import type { Note, WorkflowNodePayload } from '@shared/types'
import {
  DEFAULT_EXPECT_CODE,
  DEFAULT_SCRIPT_RUNTIME,
  LEGACY_ACTION_LABELS,
  SCRIPT_RUNTIMES,
  STEP_ACTION_KINDS,
  isLegacyActionKind,
  normalizeActionKind,
  normalizeScriptRuntime,
  scriptRuntimeSpec,
  type StepActionKind,
} from '@shared/workflow-action'
import { BRANCH_SLOTS, type BranchSlot } from '@shared/workflow-branch'

/** 「命令」类动作的填写提示（脚本类的示例随运行环境变化，见 scriptRuntimeSpec）。 */
const COMMAND_HINT = '例如：notepad.exe some-file.txt'

interface Props {
  /** 初始值（新增时是带负临时 id 的草稿） */
  node: WorkflowNodePayload
  isNew: boolean
  /** 新增时若选中了某节点，用它的标题渲染「作为…的条件分支」；未选中为 null */
  selectedTitle: string | null
  /** 选中节点是不是条件节点：只有条件节点才承接分支，所以只有它才给这个勾选框 */
  selectedIsCondition: boolean
  noteChoices: Note[]
  /** 新增时如果挂到选中的条件节点上，这里说明挂的是「满足」还是「不满足」分支 */
  onSave: (node: WorkflowNodePayload, asBranch: BranchSlot | null) => void
  onCancel: () => void
}

/**
 * 普通步骤的编辑弹窗。
 *
 * 与 WorkflowConditionDialog 是**两个独立组件**：两类节点的字段没有交集 ——
 * 步骤管「做什么、要哪些文档、什么算做完」，条件管「怎么判定、成立了往哪走」。
 *
 * 这里**没有**「进入条件」与「条件分支到」：那是条件节点的职责（条件节点用
 * 满足 / 不满足两条出边承担分支）。步骤只管顺序执行，唯一例外是新增时可以顺便
 * 挂到选中条件节点的某一条出边上，省得再回画布拖一次。步骤的三类动作里，
 * 只有「任务」会生成待办，
 * 「命令」「脚本」由主进程执行并等待返回值，所以它们要填期望退出码。
 */
export function WorkflowStepDialog({
  node,
  isNew,
  selectedTitle,
  selectedIsCondition,
  noteChoices,
  onSave,
  onCancel,
}: Props) {
  const [draft, setDraft] = useState<WorkflowNodePayload>({
    ...node,
    // 空值本来等价于 PowerShell，但让弹窗里显示成具体那一项更不容易误解
    action_runtime: node.action_runtime || DEFAULT_SCRIPT_RUNTIME,
  })
  const [asBranch, setAsBranch] = useState<BranchSlot | null>(null)

  const kind = normalizeActionKind(draft.action_kind)
  const legacy = isLegacyActionKind(draft.action_kind)
  const runtime = normalizeScriptRuntime(draft.action_runtime)
  const runtimeSpec = scriptRuntimeSpec(draft.action_runtime)
  const chosen = noteChoices.filter((n) => draft.note_ids.includes(n.id))

  /** 切换动作类型：旧参数（命令文本 / 脚本内容）留着会误导，一并清掉。 */
  const changeKind = (next: StepActionKind): void => {
    setDraft({
      ...draft,
      action_kind: next,
      action_value: '',
      action_expect: next === 'task' ? '' : String(DEFAULT_EXPECT_CODE),
      // 脚本要有个明确的运行环境；空值虽然等价于 PowerShell，但让用户看见更好
      action_runtime: next === 'script' ? normalizeScriptRuntime(draft.action_runtime) : '',
    })
  }

  /** 增删 SOP 绑定：写出时主进程会把第一条同步到兼容列 note_id。 */
  const toggleNote = (id: number): void => {
    const has = draft.note_ids.includes(id)
    setDraft({
      ...draft,
      note_ids: has ? draft.note_ids.filter((n) => n !== id) : [...draft.note_ids, id],
    })
  }

  return (
    <div className="modal-mask" onMouseDown={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <h2>{isNew ? '新增步骤' : `编辑步骤 #${node.id}`}</h2>
        </header>
        <div className="modal__body">
          <label className="form-row">
            <span>标题</span>
            <input
              className="field"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label className="form-row">
            <span>详情</span>
            <textarea
              className="field field--area"
              rows={3}
              value={draft.detail}
              onChange={(e) => setDraft({ ...draft, detail: e.target.value })}
            />
          </label>

          {/* SOP 可以绑多条：下发步骤时会把它们全部写成任务备注里的 [[链接]] */}
          <div className="form-row">
            <span>SOP 文档（可绑多条）</span>
            <div className="sop-picker">
              <div className="sop-picker__chips">
                {draft.note_ids.map((id) => {
                  const n = chosen.find((x) => x.id === id)
                  return (
                    <span key={id} className="sop-chip">
                      {n ? n.title || '（无标题）' : `#${id}`}
                      <button
                        type="button"
                        className="sop-chip__x"
                        aria-label="移除"
                        onClick={() => toggleNote(id)}
                      >
                        ×
                      </button>
                    </span>
                  )
                })}
                {draft.note_ids.length === 0 && <span className="u-aux">（未绑定）</span>}
              </div>
              <select
                className="field field--compact"
                value=""
                onChange={(e) => {
                  const id = Number(e.target.value)
                  if (Number.isFinite(id) && id > 0) toggleNote(id)
                }}
              >
                <option value="">＋ 添加文档…</option>
                {noteChoices
                  .filter((n) => !draft.note_ids.includes(n.id))
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.title || '（无标题）'}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          {isNew && selectedTitle != null && selectedIsCondition && (
            <label className="form-row">
              <span>挂到「{selectedTitle}」的</span>
              <select
                className="field"
                value={asBranch ?? ''}
                onChange={(e) => setAsBranch((e.target.value || null) as BranchSlot | null)}
              >
                <option value="">（不挂分支，只按顺序执行）</option>
                {BRANCH_SLOTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}分支 —— 条件{s.value === 'true' ? '成立' : '不成立'}时跳到此步
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="form-grid">
            <label className="form-row">
              <span>动作</span>
              <select
                className="field"
                value={legacy ? '__legacy' : kind}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === '__legacy') return
                  changeKind(v as StepActionKind)
                }}
              >
                {legacy && (
                  <option value="__legacy">
                    历史动作：{LEGACY_ACTION_LABELS[draft.action_kind] ?? draft.action_kind}
                  </option>
                )}
                {STEP_ACTION_KINDS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            {kind !== 'task' && (
              <label className="form-row">
                <span>期望退出码</span>
                <input
                  className="field"
                  type="number"
                  value={draft.action_expect === '' ? DEFAULT_EXPECT_CODE : draft.action_expect}
                  onChange={(e) => setDraft({ ...draft, action_expect: e.target.value })}
                />
              </label>
            )}
          </div>

          <p className="u-aux">
            {STEP_ACTION_KINDS.find((a) => a.value === kind)?.hint}
            {legacy &&
              `　当前保存着历史动作「${LEGACY_ACTION_LABELS[draft.action_kind] ?? draft.action_kind}」，按「任务」处理；选一个新类型即可替换。`}
          </p>

          {kind === 'command' && (
            <label className="form-row">
              <span>命令</span>
              <input
                className="field"
                value={draft.action_value}
                placeholder={COMMAND_HINT}
                onChange={(e) => setDraft({ ...draft, action_value: e.target.value })}
              />
            </label>
          )}
          {kind === 'script' && (
            <>
              {/* 运行环境必须显式选：同一段内容在 PowerShell / cmd / Python / Node 下含义完全不同 */}
              <label className="form-row">
                <span>运行环境</span>
                <select
                  className="field"
                  value={runtime}
                  onChange={(e) =>
                    // 换语言等价于换脚本：旧内容留着多半是错的，直接清掉
                    setDraft({ ...draft, action_runtime: e.target.value, action_value: '' })
                  }
                >
                  {SCRIPT_RUNTIMES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="u-aux">{runtimeSpec.hint}</p>
              <label className="form-row">
                <span>脚本内容</span>
                <textarea
                  className="field field--area field--code"
                  rows={6}
                  value={draft.action_value}
                  placeholder={runtimeSpec.placeholder}
                  onChange={(e) => setDraft({ ...draft, action_value: e.target.value })}
                />
              </label>
            </>
          )}
          {kind === 'task' && (
            <p className="u-aux">任务型步骤会在实例跑到它时生成一条待办；你在任务页勾完它，流程才继续。</p>
          )}
        </div>
        <footer className="modal__foot">
          <span className="modal__spacer" />
          <button className="text-btn" onClick={onCancel}>
            取消
          </button>
          <button className="text-btn text-btn--accent" onClick={() => onSave(draft, asBranch)}>
            保存
          </button>
        </footer>
      </div>
    </div>
  )
}
