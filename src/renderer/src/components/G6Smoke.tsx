/**
 * G6 冒烟页（P0/P1 验收用）：`?g6smoke=1` 时替代主窗口渲染。
 *
 * 它只回答三个问题，答不上来后面几千行的迁移都不必开始：
 *   1. **@antv/g 的 Canvas 渲染器在 Electron 33 里能不能跑起来**（这个仓库有过「编译过、跑不起来」的记录）；
 *   2. **主题桥能不能让 canvas 上的东西跟着 CSS 变量走** —— 切主题包 / 切明暗后颜色是否真的变；
 *   3. **真实库的 251 节点 / 242 边能不能画出来、拖不拖得动**。
 *
 * P1 起它改成直接挂 `GraphCanvasG6`（真的那个组件），这样验的是要上线的实现，
 * 而不是一份平行的样例代码。整页迁移完成后这个文件就该删掉。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { GraphCanvasG6, type GraphCanvasHandle } from '@renderer/components/GraphCanvasG6'
import { colorOf } from '@renderer/lib/graph-colors'
import { graphPositions } from '@renderer/lib/graph-positions'
import type { GraphPayload } from '@shared/types'

export function G6Smoke(): ReactElement {
  const [data, setData] = useState<GraphPayload | null>(null)
  const [status, setStatus] = useState('初始化…')
  const [selected, setSelected] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const handle = useRef<GraphCanvasHandle>(null)

  useEffect(() => {
    let dead = false
    void window.zhixing.db
      .graph({ includeTasks: true })
      .then((p) => {
        if (dead) return
        setData(p)
        setStatus('已渲染 ' + p.nodes.length + ' 节点 / ' + p.edges.length + ' 边')
      })
      .catch((e: unknown) => setStatus('✗ ' + (e instanceof Error ? e.message : String(e))))
    return () => {
      dead = true
    }
  }, [])

  const nameOf = (id: number | null): string =>
    id == null ? '—' : (data?.nodes.find((n) => n.id === id)?.label ?? String(id))

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
        <strong>G6 图谱画布</strong>
        <span style={{ color: 'var(--fg-secondary)' }}>{status}</span>
        <span style={{ color: 'var(--fg-tertiary)' }}>
          选中：{nameOf(selected)} · 悬浮：{nameOf(hover)}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-3)' }}>
          <button className="text-btn" onClick={() => handle.current?.relayout()}>
            重新布局
          </button>
          <button className="text-btn" onClick={() => handle.current?.resetView()}>
            重置视图
          </button>
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, background: 'var(--bg-canvas)' }}>
        {data && (
          <GraphCanvasG6
            data={data}
            colorOf={colorOf}
            positions={graphPositions}
            selected={selected}
            hover={hover}
            focused={null}
            searchHits={null}
            linkFrom={null}
            onSelect={setSelected}
            onHover={setHover}
            onFocus={() => {}}
            onOpenNode={(n) => setStatus((s) => s.split(' · 打开')[0] + ' · 打开「' + n.label + '」')}
            onPositions={(pos) => {
              for (const [id, p] of pos) graphPositions.set(id, p)
            }}
            handleRef={handle}
          />
        )}
      </div>
    </div>
  )
}
