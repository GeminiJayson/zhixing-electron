import { useEffect, useState } from 'react'
import {
  CONDITION_SOURCES,
  describeCondition,
  parseCondition,
  serializeCondition,
  type ConditionConfig,
  type ConditionSource,
} from '@shared/workflow-condition'
import { quietFailure } from '@shared/quiet-failure'

interface Props {
  /** 节点的 action_value（条件配置的 JSON 字符串） */
  value: string
  onChange: (next: string) => void
}

/**
 * 条件节点的配置编辑器：选「注入条件的来源」并填参数，结果写回节点的 action_value。
 *
 * 四种来源对应四种真实判定：
 *   提示确认   —— 推进时弹模态确认框，用户选「是」即成立（人工闸门）
 *   任务状态   —— 查某个任务是否已完成（这里用下拉选真实任务，不让用户敲 id）
 *   脚本返回   —— 运行脚本并比较**退出码**（独立进程、不经 shell、有超时）
 *   上一步结果 —— 读紧邻的上一个执行节点的返回值：命令/脚本看退出码、任务看是否完成。
 *                这是「把上一步的结果传进下一个节点」在界面上的落点。
 */
export function WorkflowConditionEditor({ value, onChange }: Props) {
  const cfg = parseCondition(value)
  const kind: ConditionSource = cfg?.kind ?? 'confirm'
  const [tasks, setTasks] = useState<{ id: number; title: string }[]>([])

  // 任务下拉：拿近期任务列表；拿不到就退化成手填 id
  useEffect(() => {
    void (async () => {
      try {
        const rows = await window.zhixing.db.tasks(200)
        setTasks(rows.map((t) => ({ id: t.id, title: t.title })))
      } catch (e) {
        // 下拉会变空，用户只能手填 id，却不知道为什么
        quietFailure('读取任务候选（条件节点）', e)
        setTasks([])
      }
    })()
  }, [])

  const update = (patch: Partial<ConditionConfig>): void => {
    onChange(serializeCondition({ ...(cfg ?? {}), kind, ...patch } as ConditionConfig))
  }

  const hint = CONDITION_SOURCES.find((s) => s.value === kind)?.hint ?? ''

  return (
    <div className="wf-cond">
      <label className="form-row">
        <span>注入条件</span>
        <select
          className="field"
          value={kind}
          onChange={(e) => update({ kind: e.target.value as ConditionSource })}
        >
          {CONDITION_SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <p className="u-aux">{hint}</p>

      {kind === 'confirm' && (
        <label className="form-row">
          <span>提示文案</span>
          <input
            className="field"
            value={cfg?.prompt ?? ''}
            placeholder="例如：资料齐全、可以进入审批吗？"
            onChange={(e) => update({ prompt: e.target.value })}
          />
        </label>
      )}

      {kind === 'task' && (
        <div className="u-grid u-grid--2">
          <label className="form-row">
            <span>判定任务</span>
            <select
              className="field"
              value={cfg?.taskId ?? ''}
              onChange={(e) => update({ taskId: e.target.value ? Number(e.target.value) : undefined })}
            >
              <option value="">（未选择）</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title.length > 24 ? t.title.slice(0, 24) + '…' : t.title}
                </option>
              ))}
            </select>
          </label>
          <label className="form-row">
            <span>期望状态</span>
            <select
              className="field"
              value={cfg?.expectDone === false ? 'notDone' : 'done'}
              onChange={(e) => update({ expectDone: e.target.value === 'done' })}
            >
              <option value="done">已完成</option>
              <option value="notDone">未完成</option>
            </select>
          </label>
        </div>
      )}

      {kind === 'prev' && (
        <div className="u-grid u-grid--2">
          <label className="form-row">
            <span>期望结果</span>
            <select
              className="field"
              value={cfg?.expectOk === false ? 'fail' : 'ok'}
              onChange={(e) => update({ expectOk: e.target.value === 'ok' })}
            >
              <option value="ok">成功</option>
              <option value="fail">失败</option>
            </select>
          </label>
          <label className="form-row">
            <span>期望退出码（可留空）</span>
            <input
              className="field"
              type="number"
              value={cfg?.expectCode ?? ''}
              placeholder="留空 = 只看成功与否"
              onChange={(e) =>
                update({ expectCode: e.target.value === '' ? undefined : Number(e.target.value) })
              }
            />
          </label>
        </div>
      )}

      {kind === 'script' && (
        <div className="u-grid u-grid--2">
          <label className="form-row">
            <span>命令</span>
            <input
              className="field"
              value={cfg?.command ?? ''}
              placeholder="例如：check-tests.cmd --fast"
              onChange={(e) => update({ command: e.target.value })}
            />
          </label>
          <label className="form-row">
            <span>期望退出码</span>
            <input
              className="field"
              type="number"
              value={cfg?.expectCode ?? 0}
              onChange={(e) => update({ expectCode: Number(e.target.value) })}
            />
          </label>
        </div>
      )}

      <p className="u-aux">当前条件：{describeCondition(value)}</p>
      {kind === 'prev' && (
        <p className="u-aux">
          判定的是「紧邻的上一个执行节点」的结果：命令/脚本用它的退出码，人工任务用「是否完成」。
          条件节点自身不产生结果，串联的条件节点会一直看到同一个上一步。
        </p>
      )}
      {kind === 'script' && (
        <p className="u-aux">
          脚本在独立进程中运行、不经 shell，最长等 15 秒；退出码等于期望值即「条件成立」。
        </p>
      )}
    </div>
  )
}
