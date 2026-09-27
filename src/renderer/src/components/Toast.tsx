import { useRef } from 'react'
import { isMotionFull, usePresence } from '../lib/presence'

/**
 * 退场时长：必须与 app.css 里 `.toast.is-leaving` 那条退场动画的 --dur-normal 一致
 * （app.css 归另一个施工面，两边改动要一起走）。
 */
const EXIT_MS = 250
/** App.tsx 用 2600ms 的定时器把 message 清空；调用方不传时按它走，略有偏差可接受。 */
const DEFAULT_STAY_MS = 2600

/**
 * 全局提示。
 *
 * 分两层是刻意为之：
 * - .toast-host 是**常驻**的 role=status / aria-live=polite 容器，新的一条提示只换里面的节点 ——
 *   容器跟着重建的话，读屏会把同一条消息再播一遍；
 * - .toast 是看得见的那条提示，跟着 usePresence 进退场。退场窗口里 message 已经是 null，
 *   所以留一份最后文案，否则文字会先消失再淡出。
 */
export function Toast({
  message,
  durationMs = DEFAULT_STAY_MS,
}: {
  message: string | null
  /** 停留时长：与调用方的自动关闭定时器一致，底部进度线按它推进 */
  durationMs?: number
}) {
  const { mounted, leaving } = usePresence(message !== null, EXIT_MS)
  const lastText = useRef<string | null>(null)
  if (message) lastText.current = message
  const text = message ?? lastText.current
  // 进度线是「一直在动」的东西：动效不是 full 档时不挂它
  // （判档必须走 isMotionFull —— full 档的 data-motion 是空串，写 === 'full' 永远为假）
  const withBar = isMotionFull()

  return (
    <div className="toast-host" role="status" aria-live="polite">
      {mounted && text ? (
        <div className={'toast' + (leaving ? ' is-leaving' : '')}>
          {text}
          {withBar ? (
            <span
              className="toast__bar"
              aria-hidden
              style={{ animationDuration: `${durationMs}ms` }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
