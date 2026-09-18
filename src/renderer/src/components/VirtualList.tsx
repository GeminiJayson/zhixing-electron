import { useEffect, useRef, useState, type ReactNode } from 'react'

interface Props {
  /** 总行数 */
  count: number
  /** 固定行高（任务/笔记行都是等高，才能用这个简化实现） */
  rowHeight: number
  /** 可视区外的预渲染行数，减少快速滚动时的白屏 */
  overscan?: number
  renderRow: (index: number) => ReactNode
  className?: string
}

/**
 * 固定行高虚拟列表（O4）：只渲染可视窗口内的行。
 *
 * 为什么自写而不引依赖：这里的行高本就由 --row-h 固定，
 * 需要的只是「计算窗口 + 偏移容器」这一步，几十行足够；
 * 引入 react-window 反而要处理它自己的样式与大数据 API。
 */
export function VirtualList({ count, rowHeight, overscan = 8, renderRow, className }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(0)

  // 容器高度用实测值：页面主区域会随窗口变化，写死会在放大窗口后出现空白
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = (): void => setHeight(host.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  const total = count * rowHeight
  const visible = height > 0 ? Math.ceil(height / rowHeight) : count
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(count, start + visible + overscan * 2)

  const rows: ReactNode[] = []
  for (let i = start; i < end; i += 1) {
    rows.push(
      <div
        key={i}
        className="vlist__row"
        style={{ height: rowHeight, transform: `translateY(${i * rowHeight}px)` }}
      >
        {renderRow(i)}
      </div>
    )
  }

  return (
    <div
      ref={hostRef}
      className={`vlist${className ? ' ' + className : ''}`}
      onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)}
    >
      <div className="vlist__inner" style={{ height: Math.max(total, 1) }}>
        {rows}
      </div>
    </div>
  )
}
