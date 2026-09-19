import { useState } from 'react'
import type { Note, WorkflowNodePayload } from '@shared/types'

/** 动作值的填写提示（对齐 runWorkflowAction 的解析口径）。 */
const ACTION_VALUE_HINT: Record<string, string> = {
  open_url: 'https://…',
  run_command: '例如：notepad.exe some-file.txt',
  open_note: '笔记 id',
}

interface Props {
  /** 初始值（新增时是带负临时 id 的草稿） */
  node: WorkflowNodePayload
  isNew: boolean
  /** 「条件分支到」的候选：当前模板里除自己以外的节点 */
  siblings: { id: number; title: string }[]
  /** 新增时若选中了某节点，用它的标题渲染「作为…的条件分支」；未选中为 null */
  selectedTitle: string | null
  noteChoices: Note[]
  onSave: (node: WorkflowNodePayload, asBranch: boolean) => void
  onCancel: () => void
}

/**
 * 普通步骤的编辑弹窗。
 *
 * 与 WorkflowConditionDialog 是**两个独立组件**：两类节点的字段没有交集 ——
 * 步骤有 SOP 文档、动作与动作值、进入条件；条件只有「怎么判定」与「成立了往哪走」。
 * 早先两者挤在同一个弹窗里、靠「动作」下拉切换，容易分不清自己在编哪一种。
 */
export function WorkflowStepDialog({
  node,
  isNew,
  siblings,
  selectedTitle,
  noteChoices,
  onSave,
  onCancel,
}: Props) {
  const [draft, setDraft] = useState<WorkflowNodePayload>(node)
  const [asBranch, setAsBranch] = useState(false)

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
              rows={4}
              value={draft.detail}
              onChange={(e) => setDraft({ ...draft, detail: e.target.value })}
            />
          </label>
          {/* I19 绑定 SOP 文档（对齐 note_combo → note_id）：下发步骤时会写成任务备注的 [[链接]] */}
          <label className="form-row">
            <span>SOP 文档</span>
            <select
              className="field"
              value={draft.note_id ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, note_id: e.target.value ? Number(e.target.value) : null })
              }
            >
              <option value="">（不绑定）</option>
              {noteChoices.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title || '（无标题）'}
                </option>
              ))}
            </select>
          </label>
          {isNew && selectedTitle != null && (
            <label className="form-row">
              <span>分支</span>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={asBranch}
                  onChange={(e) => setAsBranch(e.target.checked)}
                />
                作为「{selectedTitle}」的条件分支（条件满足时从其跳到此步）
              </label>
            </label>
          )}
          <div className="form-grid">
            <label className="form-row">
              <span>动作</span>
              <select
                className="field"
                value={draft.action_kind}
                onChange={(e) =>
                  // 动作值随类型切换：换类型时旧的参数（如笔记 id）留着会误导
                  setDraft({ ...draft, action_kind: e.target.value, action_value: '' })
                }
              >
                <option value="none">无</option>
                <option value="open_url">打开网址</option>
                <option value="run_command">执行命令</option>
                <option value="open_note">打开笔记</option>
              </select>
            </label>
            <label className="form-row">
              <span>动作值</span>
              <input
                className="field"
                value={draft.action_value}
                placeholder={ACTION_VALUE_HINT[draft.action_kind] ?? ''}
                onChange={(e) => setDraft({ ...draft, action_value: e.target.value })}
              />
            </label>
          </div>
          <label className="form-row">
            <span>进入条件（自由文本，供人工判断）</span>
            <input
              className="field"
              value={draft.condition}
              onChange={(e) => setDraft({ ...draft, condition: e.target.value })}
            />
          </label>
          <label className="form-row">
            <span>条件分支到</span>
            <select
              className="field"
              value={draft.branch_node_id ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, branch_node_id: e.target.value ? Number(e.target.value) : null })
              }
            >
              <option value="">不分支（按顺序走下一步）</option>
              {siblings.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
            </select>
          </label>
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
