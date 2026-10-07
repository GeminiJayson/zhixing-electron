import { useEffect, useMemo, useState } from 'react'
import type { WorkflowInstancePayload, WorkflowNodePayload, WorkflowRunLogEntry } from '@shared/types'
import { X } from '@renderer/lib/icons'

interface Props {
  instance: WorkflowInstancePayload
  /** 这次运行的记录，按时间正序（调用方负责排序） */
  runLog: WorkflowRunLogEntry[]
  onClose: () => void
}

/** run_log 的 kind → 中文。与实例行工具提示里那套保持一致。 */
const KIND_LABELS: Record<string, string> = {
  start: '开始',
  enter: '进入',
  done: '完成',
  finish: '结束',
  log: '日志',
}

/** 后端写的是「YYYY-MM-DD HH:MM:SS」本地时间；这里只取时分秒 —— 同一天的记录占绝大多数 */
function stamp(iso: string): string {
  return iso.slice(11, 19) || iso
}

/** 触发来源的中文名。渲染层不能直接引主进程模块，这里与那边保持同一套文案。 */
const TRIGGER_LABELS: Record<string, string> = {
  manual: '手动启动',
  schedule: '按计划',
  task_status: '任务状态触发',
  http: '外部调用',
  subflow: '父流程调用',
  folder: '目录变化',
  clipboard: '剪贴板匹配',
}

/**
 * 一次运行的执行记录（独立弹窗）。
 *
 * 为什么从侧栏内联搬到弹窗：时间轴天生是**长**内容 —— 一个跑了十几步的实例，
 * 内联展开会把实例列表挤得只剩两行，用户还得在侧栏的窄宽度里横向滚。
 * 弹窗能给出足够宽度，也就能把「步骤」和「它的日志」分层摆开。
 *
 * 分两层看：
 *   · 折叠态 = 时间轴（每一步什么时候跑的、结果如何）—— 回答"卡在哪了"
 *   · 展开态 = 这一步的完整日志 —— 回答"它到底吐了什么"
 * 日志有两个来源，在同一个展开区里按时间顺序接起来：
 *   · 步骤输出（命令/脚本的 stdout+stderr，流式落库，kind='log'）
 *   · 过程记录（进入 / 完成 / 关键字命中，kind='enter' / 'done'）
 */
export function WorkflowRunDialog({ instance, runLog, onClose }: Props): React.JSX.Element {
  /**
   * 节点名要按**这个实例自己的模板**去解析，不能用"当前打开的模板" ——
   * 实例列表一旦出现别的模板的运行（或用户开着 A 模板点开 B 的运行），
   * 拿 A 的节点表去翻译 B 的 node_id，每个名字都会退化成"已删除的步骤"。
   *
   * null = 还没查完（显示省略号），[] = 模板已删（显示编号）。
   * 这两种状态要分开：前者是"稍等一下"，后者是"这个名字再也找不回来了"。
   */
  const [nodes, setNodes] = useState<WorkflowNodePayload[] | null>(null)
  const [tplName, setTplName] = useState('')
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const tpl = await window.zhixing.db.workflowTemplate(instance.template_id)
        if (!alive) return
        setNodes(tpl?.nodes ?? [])
        setTplName(tpl?.name ?? '')
      } catch (err) {
        console.error('[workflow] 读取实例所属模板失败', err)
        if (alive) setNodes([])
      }
    })()
    return () => {
      alive = false
    }
  }, [instance.template_id])
  /**
   * 按节点分组。node_id 为 null 的是"实例级"记录（启动、结束），
   * 单独归到一组放在最后 —— 它们不属于任何一步。
   */
  const groups = useMemo(() => {
    const map = new Map<number | null, WorkflowRunLogEntry[]>()
    for (const e of runLog) {
      const key = e.node_id ?? null
      const list = map.get(key)
      if (list) list.push(e)
      else map.set(key, [e])
    }
    // 实例级的排最后：它是"整体情况"，放在各步骤之后更像小结
    const entries = [...map.entries()]
    return entries.sort((a, b) => (a[0] === null ? 1 : b[0] === null ? -1 : 0))
  }, [runLog])

  const status = instance.status === 'running' ? '进行中' : instance.status === 'done' ? '已完成' : '已中止'
  const titleOf = (nodeId: number | null): string => {
    if (nodeId == null) return '整体'
    // 还在读模板：先给省略号，别让"加载中"看起来像"这个名字没了"
    if (nodes === null) return '…'
    const n = nodes.find((x) => x.id === nodeId)
    // 模板改过或已删时 node_id 会指向不存在的节点，退化成编号而不是显示空白
    return n ? n.title : `已删除的步骤 #${nodeId}`
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal--run" onClick={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <strong>执行记录 · {instance.title}</strong>
          {tplName && <span className="u-aux">来自「{tplName}」</span>}
          <span className="u-aux">
            {status}
            {instance.trigger_kind ? ` · ${TRIGGER_LABELS[instance.trigger_kind] ?? instance.trigger_kind}` : ''}
            {' · '}开始 {stamp(instance.created_at)}
            {instance.finished_at ? ` · 结束 ${stamp(instance.finished_at)}` : ''}
          </span>
          <button className="icon-btn" onClick={onClose} title="关闭" aria-label="关闭执行记录">
            <X size={14} />
          </button>
        </header>

        <div className="modal__body">
          {runLog.length === 0 ? (
            <p className="u-aux">这次运行还没有留下记录。</p>
          ) : (
            groups.map(([nodeId, entries]) => {
              const logs = entries.filter((e) => e.kind === 'log')
              const events = entries.filter((e) => e.kind !== 'log')
              const text = logs.map((e) => e.detail ?? '').join('')
              const first = entries[0]
              const last = entries[entries.length - 1]
              const verdict = [...events].reverse().find((e) => e.kind === 'done' || e.kind === 'finish')
              return (
                <details key={String(nodeId)} className="run-step" open={nodeId === null}>
                  <summary className="run-step__sum">
                    <span className="run-step__name">{titleOf(nodeId)}</span>
                    <span className="run-step__time">
                      {stamp(first.created_at)}
                      {entries.length > 1 ? ` → ${stamp(last.created_at)}` : ''}
                    </span>
                    <span className="run-step__verdict">{verdict?.detail ?? ''}</span>
                  </summary>

                  {events.length > 0 && (
                    <ol className="run-step__events">
                      {events.map((e) => (
                        <li key={e.id}>
                          <span className="run-step__t">{stamp(e.created_at)}</span>
                          <span className="run-step__k">{KIND_LABELS[e.kind] ?? e.kind}</span>
                          <span className="run-step__d">{e.detail ?? ''}</span>
                        </li>
                      ))}
                    </ol>
                  )}

                  {text ? (
                    <pre className="run-step__log" aria-label="执行日志">
                      {text}
                    </pre>
                  ) : (
                    <p className="u-aux">
                      {nodeId === null
                        ? '整体只有过程记录，没有输出。'
                        : '这一步没有输出：人工任务本来就只留过程记录，命令 / 脚本还没跑完时也一样。'}
                    </p>
                  )}
                </details>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
