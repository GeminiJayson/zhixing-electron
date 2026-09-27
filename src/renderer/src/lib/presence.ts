/**
 * 退场动效的最小机制。
 *
 * 为什么需要它：CSS 只能对仍然存在的元素播放 transition / animation，而 React 的条件渲染
 * 在条件变为 false 的那一刻就把元素摘出 DOM —— 于是 --ease-exit 永远没有落点。
 * 本仓此前 5 处浮层（Toast / 信息条 / 弹出菜单 / 模态 / 提醒卡）全部是「直接卸载」。
 *
 * 两条口径必须守住：
 * 1. 动效不是 full 档时**同步卸载**，不等待动画 —— 否则用户关掉动效后弹层还要多留 250ms；
 * 2. 必须有兜底定时器：duration 为 0ms 的动画不保证派发 animationend，
 *    没有兜底的话，动效关闭时弹层会永久留在 DOM 里。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** 兜底余量：动画时长之外再等这么久就强制卸载。 */
const FALLBACK_MS = 100

/**
 * 当前是不是「完整动效」档。
 *
 * 读 dataset 而不是重新解析设置值：applyMotion（theme.ts）已经把 resolveMotionState 的结果
 * 写进了 data-motion，且 full 档写的是**空串**而不是 'full'（见 theme.ts:153），
 * 所以这里判空串与 undefined —— 写 `=== 'full'` 的话条件永远为假。
 */
export function isMotionFull(root: HTMLElement = document.documentElement): boolean {
  const state = root.dataset.motion
  return state === '' || state === undefined
}

export interface PresenceState {
  /** 现在是否应该渲染 */
  mounted: boolean
  /** 是否正在退场：调用方把它挂成 class（例如 .is-leaving） */
  leaving: boolean
}

/**
 * 把「想不想显示」变成带退场窗口的「要不要渲染」。
 *
 * @param present 业务上的显隐意图
 * @param exitMs  退场动画时长，必须与 CSS 里那条 animation 的时长一致，否则会被截断或空等
 */
export function usePresence(present: boolean, exitMs: number): PresenceState {
  const [mounted, setMounted] = useState(present)
  const [leaving, setLeaving] = useState(false)
  const mountedRef = useRef(present)
  const timerRef = useRef<number | null>(null)

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    clearTimer()
    if (present) {
      mountedRef.current = true
      setMounted(true)
      setLeaving(false)
      return
    }
    // 从未挂载过：没有东西要退场
    if (!mountedRef.current) return
    // 动效关闭 /「仅必要」/ 调用方给了 0：直接卸载，不等动画
    if (exitMs <= 0 || !isMotionFull()) {
      mountedRef.current = false
      setLeaving(false)
      setMounted(false)
      return
    }
    setLeaving(true)
    timerRef.current = window.setTimeout(() => {
      mountedRef.current = false
      setLeaving(false)
      setMounted(false)
      timerRef.current = null
    }, exitMs + FALLBACK_MS)
    return clearTimer
  }, [present, exitMs, clearTimer])

  useEffect(() => clearTimer, [clearTimer])

  return { mounted, leaving }
}
