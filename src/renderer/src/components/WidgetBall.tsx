import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'

/**
 * 悬浮球 —— 挂载 Emotion Ball 表情引擎（vendor/emotion-ball）。
 *
 * 引擎是四个零依赖的全局脚本（`window.EmotionBall`），这里**按需动态 import**：
 * 主窗口与展开态浮窗都不会为它付解析成本，只有真的收成球时才拉取这个 chunk。
 *
 * 职责切分：引擎只负责把表情画进容器，它**不监听 DOM**（见上游 emotion-integration
 * 技能文档）。所以「随机做表情」「鼠标注视」「久置打盹」都由本组件调度。
 *
 * 球的移动与缩放都归主进程：拖动只上报「正在拖」，位移按屏幕光标重算（光标会移出
 * 窗口）；滚轮只上报目标边长，窗口尺寸一变这里就跟着变大变小。
 */

/** 待机表情（引擎的回退位，自带自旋 / 弹跳待机小动作） */
const IDLE_ID = '02'
/** 唤醒表情：关键帧播完自动切回待机 */
const WAKE_ID = '01'
/** 睡眠表情：闭眼 + zzz */
const SLEEP_ID = '00'
/**
 * 随机表情池：只取「好奇 / 发呆 / 开心 / 疑惑 / 惊讶 / 害羞 / 专注 / 满意 / 困惑」
 * 与「思考中 / 任务完成 / 检索资料」。
 * 刻意避开睡眠、出错、拒绝、停止这类**状态性**表情 —— 它们是有语义的反馈，
 * 不该当随机噪声闪出来。
 */
const RANDOM_IDS = ['03', '04', '10', '11', '13', '14', '16', '19', '20', '30', '33', '40']
/** 这么久没人碰它就打个盹（ms） */
const SLEEP_AFTER = 150_000
/** 表情停留时长（ms） */
const HOLD_MIN = 1400
const HOLD_SPAN = 1200
/** 两次随机表情之间的间隔（ms） */
const GAP_MIN = 2600
const GAP_SPAN = 3200
/** 点击后先笑一下再展开的延迟：在「即时」感知阈值内，又足以看见表情切换 */
const RESTORE_DELAY = 180
/** 窗口比球体大出来的部分（对应主进程 BALL_MARGIN）：球体边长 = innerWidth - 16 */
const BALL_MARGIN = 8
/** 滚轮一格的步进（px） */
const SIZE_STEP = 8
/** 球体边长下限，与主进程 BALL_SIZE_MIN 一致（再小表情就看不清了） */
const SIZE_MIN = 88

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v))

/**
 * 球体边长 → 眼睛放大倍率，量化到 0.25 档。
 * 目的是让眼环的绝对像素尺寸基本恒定：球越小眼睛放得越大，88px 也看得清表情；
 * 量化是为了滚轮连续缩放时不必每一格都重建引擎实例。
 */
const eyeScaleFor = (size: number): number =>
  Math.round(Math.max(1, Math.min(1.8, (96 / Math.max(size, 1)) * 1.7)) * 4) / 4

export function WidgetBall({ onRestore }: { onRestore: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const ballRef = useRef<EmotionBallInstance | null>(null)
  const wakeRef = useRef<() => void>(() => undefined)
  const beatTimerRef = useRef(0)
  const restoreTimerRef = useRef(0)
  const asleepRef = useRef(false)
  const lastTouchRef = useRef(0)
  /** 拖动态：只在真的移动过之后才把随后的 click 当作拖动收尾（见 onClick） */
  const dragRef = useRef({ active: false, moved: false })
  const [ready, setReady] = useState(false)
  const [eyeScale, setEyeScale] = useState(() => eyeScaleFor(96))

  // 主进程改窗口尺寸（滚轮 / 右键菜单）后重算眼睛倍率；跨档才变，避免无谓重建
  useEffect(() => {
    const sync = (): void => {
      const size = Math.max(SIZE_MIN, window.innerWidth - BALL_MARGIN * 2)
      const next = eyeScaleFor(size)
      setEyeScale((cur) => (cur === next ? cur : next))
    }
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])

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

    /** 随机表情节拍：亮一个随机表情 → 停留一会儿 → 回待机 → 再等下一拍 */
    const beat = (): void => {
      after(GAP_MIN + Math.random() * GAP_SPAN, () => {
        const ball = ballRef.current
        if (!ball) return
        if (Date.now() - lastTouchRef.current > SLEEP_AFTER) {
          // 久置：打盹后不再排下一拍，等 wake() 唤醒
          asleepRef.current = true
          ball.setEmotion(SLEEP_ID)
          return
        }
        ball.setEmotion(RANDOM_IDS[Math.floor(Math.random() * RANDOM_IDS.length)])
        after(HOLD_MIN + Math.random() * HOLD_SPAN, () => {
          ballRef.current?.setEmotion(IDLE_ID)
          beat()
        })
      })
    }

    /** 任何互动都重置打盹计时；正在打盹则播「唤醒」并恢复随机节拍 */
    const wake = (): void => {
      lastTouchRef.current = Date.now()
      if (!asleepRef.current) return
      asleepRef.current = false
      ballRef.current?.setEmotion(WAKE_ID)
      beat()
    }
    wakeRef.current = wake

    const onMove = (e: PointerEvent): void => {
      const ball = ballRef.current
      const el = hostRef.current
      if (!ball || !el) return
      wake()
      const r = el.getBoundingClientRect()
      // 归一化到「球心 → 半径」：鼠标在窗口内任何位置都能把目光推到眼环边缘
      ball.setGaze(
        clamp1((e.clientX - (r.left + r.width / 2)) / (r.width / 2)),
        clamp1((e.clientY - (r.top + r.height / 2)) / (r.height / 2))
      )
    }
    window.addEventListener('pointermove', onMove)

    void (async () => {
      if (!hostRef.current) return
      // 四个脚本互为依赖（ball 读 rings，engine 读两者），必须串行按序加载
      await import('../vendor/emotion-ball/rings.js')
      await import('../vendor/emotion-ball/emotions.js')
      await import('../vendor/emotion-ball/ball.js')
      await import('../vendor/emotion-ball/engine.js')
      if (disposed || !hostRef.current) return
      ballRef.current = window.EmotionBall.create(hostRef.current, {
        emotion: IDLE_ID,
        eyeScale,
        // 小尺寸实例：关掉彩带彩纸特效，省电也省视觉噪音
        lite: true,
      })
      lastTouchRef.current = Date.now()
      setReady(true)
      beat()
    })()

    return () => {
      disposed = true
      clearBeat()
      window.removeEventListener('pointermove', onMove)
      if (restoreTimerRef.current) window.clearTimeout(restoreTimerRef.current)
      ballRef.current?.destroy()
      ballRef.current = null
    }
  }, [eyeScale])

  const onClick = (): void => {
    // 拖动松手后浏览器仍会补一个 click —— 那是拖动的收尾，不是「点球展开」
    if (dragRef.current.moved) {
      dragRef.current.moved = false
      return
    }
    ballRef.current?.setEmotion('10')
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
    const size = window.innerWidth - BALL_MARGIN * 2
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
      onPointerEnter={() => wakeRef.current()}
    >
      <div ref={hostRef} className="wball__host" />
    </button>
  )
}
