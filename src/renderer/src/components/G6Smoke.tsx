/**
 * G6 冒烟页（P0 验收用）：`?g6smoke=1` 时替代主窗口渲染。
 *
 * 它只回答三个问题，答不上来后面几千行的迁移都不必开始：
 *   1. **@antv/g 的 Canvas 渲染器在 Electron 33 里能不能跑起来**（这个仓库有过「编译过、跑不起来」的记录）；
 *   2. **主题桥能不能让 canvas 上的东西跟着 CSS 变量走** —— 切主题包 / 切明暗后颜色是否真的变；
 *   3. **真实库的 251 节点 / 242 边能不能画出来、拖不拖得动**。
 *
 * 冒烟通过后这个文件就该删掉（P1 用真的图谱页取代它）。
 */
import { Graph } from '@antv/g6'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { toG6Data } from '@renderer/lib/g6-adapt'
import { g6Theme, subscribeG6Theme, tokNum } from '@renderer/lib/g6-theme'

export function G6Smoke(): ReactElement {
  const box = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('初始化…')

  useEffect(() => {
    const el = box.current
    if (!el) return
    let graph: Graph | null = null
    let stop: (() => void) | null = null
    let dead = false

    void (async () => {
      try {
        const payload = await window.zhixing.db.graph({ includeTasks: true })
        if (dead) return
        const data = toG6Data(payload)
        const t = g6Theme()

        graph = new Graph({
          container: el,
          autoFit: 'view',
          data,
          node: {
            style: {
              size: tokNum('--size-16'),
              ...t.node,
              labelText: (d: { data?: { label?: string } }) => d.data?.label ?? '',
              labelPlacement: 'bottom',
              labelMaxWidth: tokNum('--size-120'),
            },
          },
          edge: {
            style: {
              ...t.edge,
              // 归属=实线、引用=虚线 —— 语义取自 edgeKinds，不在这里重判
              lineDash: (d: { data?: { kind?: string } }): number[] =>
                d.data?.kind === 'ownership' ? [] : (t.edgeReference.lineDash as number[]),
            },
          },
          layout: { type: 'd3-force', link: { distance: tokNum('--size-40') } },
          behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element'],
        })

        await graph.render()
        if (dead) return
        setStatus('已渲染 ' + data.nodes.length + ' 节点 / ' + data.edges.length + ' 边')

        // 主题变更 → 只换样式，不重建图
        stop = subscribeG6Theme((next) => {
          if (!graph || dead) return
          graph.setOptions({
            node: { style: { ...graph.getOptions().node?.style, ...next.node } },
            edge: { style: { ...graph.getOptions().edge?.style, ...next.edge } },
          })
          void graph.draw()
          setStatus((s) => s + ' · 主题已刷新')
        })
      } catch (e) {
        setStatus('✗ ' + (e instanceof Error ? e.message : String(e)))
      }
    })()

    return () => {
      dead = true
      stop?.()
      // G6 是有状态对象：不 destroy 会留下 canvas、事件监听与 rAF 循环
      graph?.destroy()
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
        }}
      >
        <strong>G6 冒烟</strong>
        <span style={{ color: 'var(--fg-secondary)' }}>{status}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--fg-tertiary)' }}>
          滚轮缩放 · 拖拽平移 · 节点可拖 · 切主题看颜色是否跟随
        </span>
      </div>
      {/* 画布背景**不交给 G6**：`canvas: { background }` 不是 v5 的选项（实测，
          见 g6-theme.ts 的注释）。容器是真实 DOM，直接用 CSS 变量 —— 既跟随主题，
          又省掉一次 token → canvas 的转换。 */}
      <div ref={box} style={{ flex: 1, minHeight: 0, background: 'var(--bg-canvas)' }} />
    </div>
  )
}
