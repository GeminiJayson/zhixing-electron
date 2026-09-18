import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent
} from 'react'
import {
  fitView,
  panBy,
  scaleOf,
  toViewBoxString,
  wheelFactor,
  zoomAt,
  type ViewBox
} from './panzoom'

export interface PanZoomOptions {
  /** 基准尺寸（画布实际坐标系的大小，例如图谱用 width/height、工作流用 900×520）。 */
  baseW: number
  baseH: number
  /**
   * 非平移时的指针移动：交给页面自己的节点拖拽。
   * 第二个参数是已经换算好的**画布世界坐标**，页面不用自己碰 rect 和缩放。
   */
  onMove?: (e: ReactPointerEvent<SVGSVGElement>, world: { x: number; y: number } | null) => void
  /** 非平移时的指针抬起 / 离开：同上。 */
  onEnd?: (e: ReactPointerEvent<SVGSVGElement>) => void
}

export interface PanZoomApi {
  /** 直接喂给 <svg viewBox=…> */
  viewBox: string
  /** 绑到 <svg ref> 上（滚轮监听与坐标换算都要用它） */
  svgRef: MutableRefObject<SVGSVGElement | null>
  handlers: {
    onPointerDown: (e: ReactPointerEvent<SVGSVGElement>) => void
    onPointerMove: (e: ReactPointerEvent<SVGSVGElement>) => void
    onPointerUp: (e: ReactPointerEvent<SVGSVGElement>) => void
    onPointerLeave: (e: ReactPointerEvent<SVGSVGElement>) => void
  }
  /** 正在拖动画布 —— 用来切光标。 */
  panning: boolean
  /** 当前缩放倍数。 */
  scale: number
  /**
   * 屏幕坐标 → 画布世界坐标。
   * 节点拖拽必须走这里：它拿到的 clientX/Y 是像素，缩放后直接当世界坐标用会「跟不上鼠标」。
   */
  toWorld: (clientX: number, clientY: number) => { x: number; y: number } | null
  reset: () => void
}

/**
 * 画布平移 / 缩放（图谱页与工作流页共用）。
 *
 * 两个关键点：
 *   1. 只有点在画布**背景**上才平移（`e.target === e.currentTarget`），
 *      点在节点上时交给节点自己的拖拽，不用每个节点各写一遍 stopPropagation；
 *   2. 滚轮必须用 `addEventListener(..., { passive: false })` 绑定：React 的 onWheel
 *      是挂在 root 上的 passive 监听，在那里 preventDefault() 无效，页面会跟着一起滚。
 */
export function usePanZoom({ baseW, baseH, onMove, onEnd }: PanZoomOptions): PanZoomApi {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [view, setView] = useState<ViewBox>(() => fitView(baseW, baseH))
  const [panning, setPanning] = useState(false)
  const panOrigin = useRef<{ x: number; y: number } | null>(null)
  // toWorld 要被节点拖拽在事件里调用，用 ref 拿最新的视图状态
  const viewRef = useRef(view)
  viewRef.current = view

  // 基准尺寸变化（窗口改变导致图谱重算宽高）时回到适配视图，避免视图卡在旧坐标系里
  useEffect(() => {
    setView(fitView(baseW, baseH))
  }, [baseW, baseH])

  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const cursor = {
        rx: (e.clientX - rect.left) / rect.width,
        ry: (e.clientY - rect.top) / rect.height
      }
      setView((v) => zoomAt(v, baseW, baseH, cursor, wheelFactor(e.deltaY)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [baseW, baseH])

  const onPointerDown = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    // 点在节点 / 连线上的不算拖画布
    if (e.target !== e.currentTarget) return
    panOrigin.current = { x: e.clientX, y: e.clientY }
    setPanning(true)
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId)
    } catch {
      // 指针已经失效（快速交互 / 合成事件）时忽略：捕获失败不影响平移本身
    }
  }, [])

  /** 屏幕坐标 → 世界坐标（onMove 与页面的节点拖拽共用同一套换算）。 */
  const worldAt = useCallback((clientX: number, clientY: number) => {
    const el = svgRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    const v = viewRef.current
    return {
      x: v.x + ((clientX - rect.left) / rect.width) * v.w,
      y: v.y + ((clientY - rect.top) / rect.height) * v.h
    }
  }, [])

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const origin = panOrigin.current
      if (!origin) {
        onMove?.(e, worldAt(e.clientX, e.clientY))
        return
      }
      const rect = e.currentTarget.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const dx = (e.clientX - origin.x) / rect.width
      const dy = (e.clientY - origin.y) / rect.height
      panOrigin.current = { x: e.clientX, y: e.clientY }
      setView((v) => panBy(v, dx, dy))
    },
    [onMove, worldAt]
  )

  const finishPan = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    if (!panOrigin.current) return false
    panOrigin.current = null
    setPanning(false)
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    } catch {
      // 同上：没捕获成功过就无需释放
    }
    return true
  }, [])

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      if (finishPan(e)) return
      onEnd?.(e)
    },
    [finishPan, onEnd]
  )

  const onPointerLeave = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      if (finishPan(e)) return
      onEnd?.(e)
    },
    [finishPan, onEnd]
  )

  const reset = useCallback(() => setView(fitView(baseW, baseH)), [baseW, baseH])

  return {
    viewBox: toViewBoxString(view),
    svgRef,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerLeave },
    panning,
    scale: scaleOf(view, baseW),
    toWorld: worldAt,
    reset
  }
}
