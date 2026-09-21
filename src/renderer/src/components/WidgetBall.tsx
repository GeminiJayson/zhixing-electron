import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { BloubAvatar, type BloubGaze } from './BloubAvatar'
import type { StateId } from '../vendor/bloub/bot/states'

/**
 * 悬浮球 —— 挂载 bloub 引擎（vendor/bloub，MIT；见该目录的 UPSTREAM.md）。
 *
 * bloub 的引擎是**无时钟的纯函数**：`engine.sample(t)` 给定时刻就得到那一帧，
 * 动画状态由引擎自己按时间推。所以这里只调度「什么时候切到哪个状态」——
 * 随机表情、鼠标注视、久置打盹 —— 并把指针换算成归一化坐标喂给渲染层。
 *
 * 球的移动与缩放都归主进程：拖动只上报「正在拖」，位移按屏幕光标重算（光标会移出
 * 窗口）；滚轮只上报目标边长，窗口尺寸一变这里就跟着变大变小。
 */

/** 待机：bloub 的默认状态，自带呼吸 / 视线漂移 / 眨眼 */
const IDLE: StateId = 'idle'
/** 唤醒：久置打盹后有人靠近，先亮一下再回待机 */
const WAKE: StateId = 'alert'
/** 打盹：闭眼 + zzz */
const SLEEP: StateId = 'sleep'
/**
 * 随机表情池。刻意避开三个：
 *   idle  —— 待机位本身；
 *   sleep —— 有语义，那是真的睡着了，不该被当随机噪声放出来；
 *   swirl —— 上游拿它做设置页的入场过渡，不在常规状态表里。
 */
const RANDOM_STATES: StateId[] = [
  'thinking',
  'wink',
  'wide',
  'exclaim',
  'notify',
  'egg',
  'hexagon',
  'play',
  'orbit',
  'burst',
  'comet',
]
/** 这么久没人碰它就打个盹（ms） */
const SLEEP_AFTER = 150_000
/** 表情停留时长（ms） */
const HOLD_MIN = 1400
const HOLD_SPAN = 1200
/** 两次随机表情之间的间隔（ms） */
const GAP_MIN = 2600
const GAP_SPAN = 3200
/** 点击后先眨个眼再展开的延迟：在「即时」感知阈值内，又足以看见那一下 */
const RESTORE_DELAY = 180
/** 窗口比球体大出来的部分（对应主进程 BALL_MARGIN）：球体边长 = innerWidth - 16 */
const BALL_MARGIN = 8
/** 滚轮一格的步进（px） */
const SIZE_STEP = 8
/** 球体边长下限，与主进程 BALL_SIZE_MIN 一致（再小表情就看不清了） */
const SIZE_MIN = 88

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v))

interface Props {
  shape: string
  onRestore: () => void
  /** 待处理的提醒条数：>0 时停在 notify 表情，让「有事找你」先被看见 */
  notice?: number
}

export function WidgetBall({ shape, onRestore, notice = 0 }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  /** 节拍 effect 只挂一次，读不到最新的 notice —— 用 ref 搭个桥 */
  const noticeRef = useRef(notice)
  /** 当前状态：bloub 的 StateId，由下面的节拍与交互驱动 */
  const [state, setState] = useState<StateId>(IDLE)
  /** 指针注视（归一化）；null = 交给引擎自己漂移 */
  const [gaze, setGaze] = useState<BloubGaze | null>(null)
  const beatTimerRef = useRef(0)
  const restoreTimerRef = useRef(0)
  const asleepRef = useRef(false)
  const lastTouchRef = useRef(0)
  /** 拖动态：只在真的移动过之后才把随后的 click 当作拖动收尾（见 onClick） */
  const dragRef = useRef({ active: false, moved: false })
  const [ready, setReady] = useState(false)

  // 首帧就绪：bloub 的 sample(0) 是同步的，挂载后同一帧里就有画面，这里只是把
  // 容器从「缩着且透明」放到正常态，免得看见一张空容器
  useEffect(() => setReady(true), [])

  /**
   * notice 一变就同步进 ref 并立刻切表情 —— 不等下一拍节拍，
   * 提醒该在球上马上看得见（节拍那侧负责「保持」，见 beat）。
   */
  useEffect(() => {
    noticeRef.current = notice
    if (notice > 0) setState('notify')
  }, [notice])

  useEffect(() => {
    let disposed = false

    const clearBeat = (): void => {
      if (beatTimerRef.current) window.clearTimeout(beatTimerRef.current)
      beatTimerRef.current = 0
    }
    const after = (delay: number, fn: () => void): void => {
      clearBeat()
      beatTimerRef.current = window.setTimeout(() => {
        beatTimerRef.current = 0
        if (!disposed) fn()
      }, delay)
    }

    /** 随机表情节拍：亮一个随机状态 → 停留一会儿 → 回待机 → 再等下一拍 */
    const beat = (): void => {
      after(GAP_MIN + Math.random() * GAP_SPAN, () => {
        // 有未处理的提醒就停在 notify：随机表情会把「有事找你」冲掉，
        // 而那恰恰是最该被看见的时候。提醒处理完 notice 归零，节拍照旧。
        if (noticeRef.current > 0) {
          setState('notify')
          beat()
          return
        }
        if (Date.now() - lastTouchRef.current > SLEEP_AFTER) {
          // 久置：打盹后不再排下一拍，等 wake() 唤醒
          asleepRef.current = true
          setState(SLEEP)
          return
        }
        setState(RANDOM_STATES[Math.floor(Math.random() * RANDOM_STATES.length)])
        after(HOLD_MIN + Math.random() * HOLD_SPAN, () => {
          setState(IDLE)
          beat()
        })
      })
    }

    /** 任何互动都重置打盹计时；正在打盹则播「唤醒」并恢复随机节拍 */
    const wake = (): void => {
      lastTouchRef.current = Date.now()
      if (!asleepRef.current) return
      asleepRef.current = false
      setState(WAKE)
      beat()
    }

    const onMove = (e: PointerEvent): void => {
      const el = hostRef.current
      if (!el) return
      wake()
      const r = el.getBoundingClientRect()
      // 归一化到「球心 → 半径」：鼠标在窗口内任何位置都能把目光推到边缘
      setGaze({
        nx: clamp1((e.clientX - (r.left + r.width / 2)) / (r.width / 2)),
        ny: clamp1((e.clientY - (r.top + r.height / 2)) / (r.height / 2)),
      })
    }
    // 指针离开球面就把注视交回引擎：它会自己接着漂移，而不是定在最后那个方向
    const onLeave = (): void => setGaze(null)
    window.addEventListener('pointermove', onMove)
    document.addEventListener('pointerleave', onLeave)

    lastTouchRef.current = Date.now()
    beat()

    return () => {
      disposed = true
      clearBeat()
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeave)
      if (restoreTimerRef.current) window.clearTimeout(restoreTimerRef.current)
    }
  }, [])

  const onClick = (): void => {
    // 拖动松手后浏览器仍会补一个 click —— 那是拖动的收尾，不是「点球展开」
    if (dragRef.current.moved) {
      dragRef.current.moved = false
      return
    }
    setState('wink')
    restoreTimerRef.current = window.setTimeout(onRestore, RESTORE_DELAY)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return
    dragRef.current.active = true
    dragRef.current.moved = false
    void window.zhixing.widget.dragStart()
  }

  const onPointerMove = (): void => {
    if (!dragRef.current.active) return
    dragRef.current.moved = true
    void window.zhixing.widget.dragTo()
  }

  const onPointerUp = (): void => {
    if (!dragRef.current.active) return
    dragRef.current.active = false
    void window.zhixing.widget.dragEnd(dragRef.current.moved)
  }

  /** 滚轮调大小：主进程按球心缩放窗口，这里只是报目标边长 */
  const onWheel = (e: ReactWheelEvent<HTMLButtonElement>): void => {
    const size = Math.max(SIZE_MIN, window.innerWidth - BALL_MARGIN * 2)
    void window.zhixing.widget.setBallSize(size + (e.deltaY < 0 ? SIZE_STEP : -SIZE_STEP))
  }

  return (
    <button
      type="button"
      className={ready ? 'wball wball--ready' : 'wball'}
      title="点击展开浮窗 · 拖动可移动 · 滚轮缩放"
      aria-label="展开浮窗"
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      <div ref={hostRef} className="wball__host">
        <BloubAvatar state={state} gaze={gaze} shape={shape} />
      </div>
    </button>
  )
}
