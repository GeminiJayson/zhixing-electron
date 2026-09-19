import { useState } from 'react'
import type { WorkflowNodePayload } from '@shared/types'
import { WorkflowConditionEditor } from './WorkflowConditionEditor'

interface Props {
  node: WorkflowNodePayload
  isNew: boolean
  /** 「条件成立时跳到」的候选：当前模板里除自己以外的节点 */
  siblings: { id: number; title: string }[]
  onSave: (node: WorkflowNodePayload) => void
  onCancel: () => void
}

/**
 * 条件节点的编辑弹窗。
 *
 * 与 WorkflowStepDialog 是**两个独立组件**：条件节点不生成待办，所以没有 SOP 文档、
 * 也没有「动作」——它只有两件事：**怎么判定**（注入条件）与**成立后往哪走**（分支目标）。
 * 不成立时按顺序走下一步，由推进逻辑保证。
 */
export function WorkflowConditionDialog({ node, isNew, siblings, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState<WorkflowNodePayload>(node)

  return (
    <div className="modal-mask" onMouseDown={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <h2>{isNew ? '新增条件' : `编辑条件 #${node.id}`}</h2>
        </header>
        <div className="modal__body">
          <label className="form-row">
            <span>条件名称</span>
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
          <WorkflowConditionEditor
            value={draft.action_value}
            onChange={(next) => setDraft({ ...draft, action_value: next })}
          />
          <label className="form-row">
            <span>条件成立时跳到</span>
            <select
              className="field"
              value={draft.branch_node_id ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, branch_node_id: e.target.value ? Number(e.target.value) : null })
              }
            >
              <option value="">（按顺序走下一步）</option>
              {siblings.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
            </select>
          </label>
          <p className="u-aux">
            条件不成立时按顺序走下一步。条件节点到点自动求值、不生成待办，所以没有动作与 SOP。
          </p>
        </div>
        <footer className="modal__foot">
          <span className="modal__spacer" />
          <button className="text-btn" onClick={onCancel}>
            取消
          </button>
          <button className="text-btn text-btn--accent" onClick={() => onSave(draft)}>
            保存
          </button>
        </footer>
      </div>
    </div>
  )
}
