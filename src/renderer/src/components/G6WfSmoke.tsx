/**
 * 工作流 G6 冒烟页：`?g6wf=1` 时替代主窗口渲染。
 *
 * 只回答一个问题：**把工作流的隐式图投影喂给 G6 的 antv-dagre，分层结果对不对。**
 * 对了再换 HTML 节点还原外观，不对就不必往下走。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { WorkflowCanvasG6, type WorkflowCanvasHandle } from '@renderer/components/WorkflowCanvasG6'
import type { LayoutNode } from '@renderer/lib/workflow-layout'

export function G6WfSmoke(): ReactElement {
  const [nodes, setNodes] = useState<LayoutNode[]>([])
  const [titles, setTitles] = useState<Map<number, string>>(new Map())
  const [status, setStatus] = useState('加载中…')
  const [selected, setSelected] = useState<number | null>(null)
  const [rankdir, setRankdir] = useState<'TB' | 'LR'>('TB')
  const handle = useRef<WorkflowCanvasHandle>(null)

  useEffect(() => {
    let dead = false
    void (async () => {
      try {
        const list = await window.zhixing.db.workflowTemplates()
        if (dead) return
        if (!list.length) {
          setStatus('库里没有工作流模板')
          return
        }
        // 只看第一个模板。
        // **不要为了「挑步骤最多的那个」去循环取模板** —— 那是渲染层在循环里逐条调 IPC，
        // architecture.test.ts 有一条断言专门拦这个（会红的）。冒烟验的是布局，一个模板够。
        const full = await window.zhixing.db.workflowTemplate(list[0].id)
        if (dead) return
        const ns = (full?.nodes ?? []) as unknown as {
          id: number
          title: string
          order_index: number
          branch_node_id: number | null
          branch_false_node_id?: number | null
        }[]
        setNodes(
          ns.map((n) => ({
            id: n.id,
            order_index: n.order_index,
            branch_node_id: n.branch_node_id,
            branch_false_node_id: n.branch_false_node_id ?? null,
          }))
        )
        setTitles(new Map(ns.map((n) => [n.id, n.title])))
        setStatus('已渲染 ' + ns.length + ' 个步骤（' + list[0].name + '）')
      } catch (e) {
        setStatus('✗ ' + (e instanceof Error ? e.message : String(e)))
      }
    })()
    return () => {
      dead = true
    }
  }, [])

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: 'var(--space-2) var(--space-3)',
          background: 'var(--bg-layer)',
          borderBottom: 'var(--border-w) solid var(--border)',
          fontSize: 'var(--text-aux)',
          color: 'var(--fg-primary)',
          display: 'flex',
          gap: 'var(--space-3)',
          alignItems: 'center',
        }}
      >
        <strong>工作流 G6 冒烟</strong>
        <span style={{ color: 'var(--fg-secondary)' }}>{status}</span>
        <span style={{ color: 'var(--fg-tertiary)' }}>
          选中：{selected == null ? '—' : (titles.get(selected) ?? selected)}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-2)' }}>
          <button className="text-btn" onClick={() => setRankdir((d) => (d === 'TB' ? 'LR' : 'TB'))}>
            方向 {rankdir}
          </button>
          <button className="text-btn" onClick={() => handle.current?.relayout()}>
            重新布局
          </button>
          <button className="text-btn" onClick={() => handle.current?.fit()}>
            适配视图
          </button>
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, background: 'var(--bg-canvas)' }}>
        {nodes.length > 0 && (
          <WorkflowCanvasG6
            nodes={nodes}
            labelOf={(id) => titles.get(id) ?? String(id)}
            selectedId={selected}
            rankdir={rankdir}
            onSelect={setSelected}
            onOpen={(id) => setStatus((s) => s.split(' · 打开')[0] + ' · 打开 ' + (titles.get(id) ?? id))}
            handleRef={handle}
          />
        )}
      </div>
    </div>
  )
}
