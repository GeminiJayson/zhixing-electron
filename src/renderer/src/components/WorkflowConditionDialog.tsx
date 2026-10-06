import { useState } from 'react'
import { Select } from './Select'
import type { WorkflowNodePayload } from '@shared/types'
import { WorkflowConditionEditor } from './WorkflowConditionEditor'
import { X } from '@renderer/lib/icons'

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
 * 也没有「动作」——它只有两件事：**怎么判定**（注入条件）与**结果往哪走**
 * （满足 / 不满足两条出边，各自的跳转目标）。哪条出边没配就按顺序走下一步。
 */
export function WorkflowConditionDialog({ node, isNew, siblings, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState<WorkflowNodePayload>(node)

  return (
    <div className="modal-mask" onMouseDown={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <h2>{isNew ? '新增条件' : `编辑条件 #${node.id}`}</h2>
          <button className="icon-btn" onClick={onCancel} title="关闭" aria-label="关闭">
            <X size={14} />
          </button>
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
            <span>满足时跳到</span>
            <Select
              className="field"
              ariaLabel="满足时跳到"
              value={draft.branch_node_id == null ? '' : String(draft.branch_node_id)}
              onChange={(v) => setDraft({ ...draft, branch_node_id: v ? Number(v) : null })}
              options={[
                { value: '', label: '（按顺序走下一步）' },
                ...siblings.map((n) => ({ value: String(n.id), label: n.title })),
              ]}
            />
          </label>
          <label className="form-row">
            <span>不满足时跳到</span>
            <Select
              className="field"
              ariaLabel="不满足时跳到"
              value={draft.branch_false_node_id == null ? '' : String(draft.branch_false_node_id)}
              onChange={(v) =>
                setDraft({ ...draft, branch_false_node_id: v ? Number(v) : null })
              }
              options={[
                { value: '', label: '（按顺序走下一步）' },
                ...siblings.map((n) => ({ value: String(n.id), label: n.title })),
              ]}
            />
          </label>
          <p className="u-aux">
            两条分支都可以留空 —— 留空就按顺序走下一个节点。也可以在画布上直接拖动条件节点
            的两个端口连线。条件节点到点自动求值、不生成待办，所以没有动作与 SOP。
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
