import { useState } from 'react'
import { Select } from './Select'
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
import {
  parseLogRules,
  serializeLogRules,
  type LogRule,
  type LogRules,
} from '@shared/workflow-log-rules'
import { Plus, Trash2, X } from '@renderer/lib/icons'

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
  /**
   * 可选的子流程（key=模板 id，label=名字）。
   * 由调用方过滤掉「自己」—— 一个流程接续自己就是死循环，不该出现在选项里。
   */
  subflowChoices: { id: number; name: string }[]
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
 * 挂到选中条件节点的某一条出边上（且**必须**选一条 —— 在条件节点上新增的步骤
 * 只能是分支步骤，不能退化成常规顺序步骤）。步骤的三类动作里，只有「任务」会生成待办，
 * 「命令」「脚本」由主进程执行并等待返回值，所以它们要填期望退出码。
 */
export function WorkflowStepDialog({
  node,
  isNew,
  selectedTitle,
  selectedIsCondition,
  noteChoices,
  subflowChoices,
  onSave,
  onCancel,
}: Props) {
  const [draft, setDraft] = useState<WorkflowNodePayload>({
    ...node,
    // 空值本来等价于 PowerShell，但让弹窗里显示成具体那一项更不容易误解
    action_runtime: node.action_runtime || DEFAULT_SCRIPT_RUNTIME,
  })
  const [asBranch, setAsBranch] = useState<BranchSlot | null>(null)
  /**
   * 日志规则：界面里以结构化对象编辑，落到 draft 时序列化成 JSON 字符串。
   * 解析与序列化都走 shared/workflow-log-rules —— 与主进程读的是同一份实现，
   * 不会出现"界面存进去、引擎读不懂"。
   */
  const [logRules, setLogRules] = useState<LogRules>(() => parseLogRules(node.log_rules))
  const applyLogRules = (next: LogRules): void => {
    setLogRules(next)
    setDraft((d) => ({ ...d, log_rules: serializeLogRules(next) }))
  }
  const patchRule = (i: number, patch: Partial<LogRule>): void => {
    applyLogRules({ ...logRules, rules: logRules.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  }

  /** 在条件节点上新增：必须挂到满足 / 不满足其中一条分支，没有「不挂分支」这个选项 */
  const needsBranch = isNew && selectedIsCondition && selectedTitle != null

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
          <button className="icon-btn" onClick={onCancel} title="关闭" aria-label="关闭">
            <X size={14} />
          </button>
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
              <Select
                  className="field field--compact"
                  ariaLabel="添加文档"
                  value=""
                  onChange={(v) => {
                    const id = Number(v)
                    if (Number.isFinite(id) && id > 0) toggleNote(id)
                  }}
                  options={[
                    { value: '', label: '＋ 添加文档…' },
                    ...noteChoices
                      .filter((x) => !draft.note_ids.includes(x.id))
                      .map((x) => ({ value: String(x.id), label: x.title || '（无标题）' })),
                  ]}
                />
            </div>
          </div>

          {isNew && selectedTitle != null && selectedIsCondition && (
            <label className="form-row">
              <span>挂到「{selectedTitle}」的</span>
              /* 在条件节点上新增只可能是分支步骤：这里不给「不挂分支」这一项 ——
                  选了它会落进顺序链，条件节点等于被绕过 */
              <Select
                className="field"
                ariaLabel="挂到哪个分支"
                value={asBranch ?? ''}
                onChange={(v) => setAsBranch((v || null) as BranchSlot | null)}
                options={[
                  { value: '', label: '（请选择满足或不满足分支）', disabled: true },
                  ...BRANCH_SLOTS.map((s) => ({
                    value: s.value,
                    label: s.label + '分支 —— 条件' + (s.value === 'true' ? '成立' : '不成立') + '时跳到此步',
                  })),
                ]}
              />
            </label>
          )}

          {/* 原来是 .form-grid（1fr 1fr）。.u-grid--2 用 minmax(0,1fr)：
              固定 1fr 在内容超宽时不肯收缩，会把网格撑破 */}
          <div className="u-grid u-grid--2">
            <label className="form-row">
              <span>动作</span>
              <Select
                className="field"
                ariaLabel="动作"
                value={legacy ? '__legacy' : kind}
                onChange={(v) => {
                  if (v === '__legacy') return
                  changeKind(v as StepActionKind)
                }}
                options={[
                  ...(legacy
                    ? [
                        {
                          value: '__legacy',
                          label: '历史动作：' + (LEGACY_ACTION_LABELS[draft.action_kind] ?? draft.action_kind),
                        },
                      ]
                    : []),
                  ...STEP_ACTION_KINDS.map((a) => ({ value: a.value, label: a.label })),
                ]}
              />
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

          {/* 日志规则：退出码说不清楚的事（失败也返回 0、结论写在日志里、跑一半停下来问 y/n）交给它 */}
          {kind !== 'task' && (
            <div className="form-block">
              <div className="form-row">
                <span>日志判定</span>
                <Select
                  className="field"
                  ariaLabel="日志判定"
                  value={logRules.judge}
                  onChange={(v) => applyLogRules({ ...logRules, judge: v as LogRules['judge'] })}
                  options={[
                    { value: 'exit', label: '只看退出码（默认）' },
                    { value: 'both', label: '日志优先，没命中再看退出码' },
                    { value: 'log', label: '只看日志，没命中算失败' },
                  ]}
                />
              </div>
              {logRules.rules.map((rule, i) => (
                <div key={i} className="form-row wf-rule">
                  <input
                    className="field"
                    value={rule.pattern}
                    placeholder={rule.mode === 'regex' ? '正则，如 ERROR|失败' : '关键字，如 BUILD SUCCESS'}
                    aria-label={'第 ' + (i + 1) + ' 条关键字'}
                    onChange={(e) => patchRule(i, { pattern: e.target.value })}
                  />
                  <Select
                    className="field"
                    ariaLabel={'第 ' + (i + 1) + ' 条匹配方式'}
                    value={rule.mode}
                    onChange={(v) => patchRule(i, { mode: v as LogRule['mode'] })}
                    options={[
                      { value: 'contains', label: '包含' },
                      { value: 'regex', label: '正则' },
                    ]}
                  />
                  <Select
                    className="field"
                    ariaLabel={'第 ' + (i + 1) + ' 条判定'}
                    value={rule.result}
                    onChange={(v) => patchRule(i, { result: v as LogRule['result'] })}
                    options={[
                      { value: 'ok', label: '算成功' },
                      { value: 'fail', label: '算失败' },
                      { value: 'wait_input', label: '等待输入' },
                    ]}
                  />
                  {rule.result === 'wait_input' && (
                    <input
                      className="field"
                      value={rule.reply ?? ''}
                      placeholder="命中后自动输入的内容，如 y\n"
                      aria-label={'第 ' + (i + 1) + ' 条自动输入'}
                      onChange={(e) => patchRule(i, { reply: e.target.value })}
                    />
                  )}
                  <button
                    className="icon-btn icon-btn--danger"
                    title="删掉这条关键字"
                    aria-label="删掉这条关键字"
                    onClick={() => applyLogRules({ ...logRules, rules: logRules.rules.filter((_, j) => j !== i) })}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              <div className="form-row">
                <span />
                <button
                  className="text-btn"
                  onClick={() =>
                    applyLogRules({
                      ...logRules,
                      rules: [...logRules.rules, { pattern: '', mode: 'contains', result: 'fail' }],
                    })
                  }
                >
                  <Plus size={13} /> 加一条关键字
                </button>
              </div>
              <p className="u-aux">
                按从上到下的顺序匹配，先命中的说了算；命中「等待输入」时会自动把回答写进 stdin
                （脚本步骤会因此改用不占 stdin 的喂法）。留空则只看退出码。
              </p>
            </div>
          )}

          <p className="u-aux">
            {STEP_ACTION_KINDS.find((a) => a.value === kind)?.hint}
            {legacy &&
              `　当前保存着历史动作「${LEGACY_ACTION_LABELS[draft.action_kind] ?? draft.action_kind}」，按「任务」处理；选一个新类型即可替换。`}
          </p>

          {/* 子流程：选一个模板整体接进来。选项由调用方排除掉自己 */}
          {kind === 'subflow' && (
            <label className="form-row">
              <span>接续哪个流程</span>
              <Select
                className="field"
                ariaLabel="接续哪个流程"
                value={draft.action_value}
                onChange={(v) => setDraft({ ...draft, action_value: v })}
                options={[
                  { value: '', label: '（请选择）' },
                  ...subflowChoices.map((t) => ({ value: String(t.id), label: t.name })),
                ]}
              />
            </label>
          )}

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
                <Select
                  className="field"
                  ariaLabel="运行环境"
                  value={runtime}
                  onChange={(v) =>
                    // 换语言等价于换脚本：旧内容留着多半是错的，直接清掉
                    setDraft({ ...draft, action_runtime: v, action_value: '' })
                  }
                  options={SCRIPT_RUNTIMES.map((r) => ({ value: r.value, label: r.label }))}
                />
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
          <button
            className="text-btn text-btn--accent"
            onClick={() => onSave(draft, asBranch)}
            disabled={needsBranch && asBranch == null}
            title={needsBranch && asBranch == null ? '先选择挂到满足还是不满足分支' : undefined}
          >
            保存
          </button>
        </footer>
      </div>
    </div>
  )
}
