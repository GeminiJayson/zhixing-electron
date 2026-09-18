import { useCallback, useEffect, useRef, useState } from 'react'
import { Pause, Play, Square } from 'lucide-react'

interface Props {
  focusMinutes: number
  breakMinutes: number
  autoBreak: boolean
  onNotice: (message: string) => void
}

type Phase = 'focus' | 'break'

interface Session {
  taskId: number | null
  title: string
  phase: Phase
  total: number
  remain: number
  running: boolean
}

/** 手动中断专注的预设原因（对齐 pomodoro.py 的 _ask_interrupt_reason）。 */
const INTERRUPT_REASONS = ['被打断', '临时有事', '分心', '任务调整', '其他']

/**
 * 番茄钟浮条：由任务行的「专注」按钮（派发 zhixing:pomodoro 事件）启动。
 *
 * 记账口径对齐 Python 的 PomodoroController（D18/D20）：
 * - stop() 不区分阶段：专注与休息只要走过 ≥1 分钟都落库，completed = 是否手动放弃；
 * - 手动中断专注先选原因并写入 reason 列（取消也会记一次，只是不带原因）；
 * - 新的一轮先 stop() 记完上一轮，而不是直接覆盖会话。
 */
export function PomodoroBar({ focusMinutes, breakMinutes, autoBreak, onNotice }: Props) {
  const [session, setSession] = useState<Session | null>(null)
  // 专注手动中断时的原因选择（D18）：true 表示正在询问
  const [askReason, setAskReason] = useState(false)
  const [customReason, setCustomReason] = useState('')
  const ref = useRef<Session | null>(null)
  ref.current = session
  const askingRef = useRef(false)
  askingRef.current = askReason

  /** 落库：分钟数按已经过的时间四舍五入，不足 1 分钟由 recordPomodoro 内部跳过。 */
  const record = useCallback((cur: Session, abandoned: boolean, reason = ''): void => {
    void window.zhixing.db.recordPomodoro(
      cur.taskId,
      Math.round((cur.total - Math.max(0, cur.remain)) / 60),
      !abandoned,
      reason
    )
  }, [])

  const start = useCallback(
    (taskId: number | null, title: string) => {
      const prev = ref.current
      // 对齐 pomodoro.start：非 idle 先 stop()（abandoned=False）记完上一轮再开新一轮
      if (prev) record(prev, false)
      setAskReason(false)
      setCustomReason('')
      const total = Math.max(1, focusMinutes) * 60
      setSession({ taskId, title, phase: 'focus', total, remain: total, running: true })
    },
    [focusMinutes, record]
  )

  useEffect(() => {
    const onStart = (e: Event): void => {
      const d = (e as CustomEvent<{ taskId: number | null; title: string }>).detail
      start(d.taskId, d.title)
    }
    window.addEventListener('zhixing:pomodoro', onStart)
    return () => window.removeEventListener('zhixing:pomodoro', onStart)
  }, [start])

  // 每秒推进；专注阶段走完写库并（可选）转入休息
  useEffect(() => {
    const timer = window.setInterval(() => {
      const cur = ref.current
      if (!cur || !cur.running || askingRef.current) return
      const remain = cur.remain - 1
      if (remain > 0) {
        setSession({ ...cur, remain })
        return
      }
      if (cur.phase === 'focus') {
        record(cur, false)
        onNotice('专注结束，休息一下')
        if (autoBreak) {
          const total = Math.max(1, breakMinutes) * 60
          setSession({ ...cur, phase: 'break', total, remain: total, running: true })
        } else {
          setSession(null)
        }
      } else {
        // 休息自然走完：对齐 pomodoro._tick 的 else 分支——直接回 idle、不落库；
        // 只有手动「结束」走 stop() 时才把已休息的分钟数记账（见下方按钮分支，D20）
        onNotice('休息结束')
        setSession(null)
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [breakMinutes, autoBreak, onNotice, record])

  /** 选中/输入原因后结束本轮（D18）：取消等于不带原因，但同样落库。 */
  const stopWithReason = (reason: string): void => {
    const cur = ref.current
    if (cur) record(cur, cur.phase === 'focus' && cur.remain > 0, reason.trim())
    setAskReason(false)
    setCustomReason('')
    setSession(null)
  }

  if (!session) return null

  const mm = String(Math.floor(session.remain / 60)).padStart(2, '0')
  const ss = String(session.remain % 60).padStart(2, '0')
  const pct = Math.round(((session.total - session.remain) / session.total) * 100)

  return (
    <>
      <div className={'pomo' + (session.phase === 'break' ? ' pomo--break' : '')} role="status">
        <span className="pomo__phase">{session.phase === 'focus' ? '专注' : '休息'}</span>
        <span className="pomo__time">
          {mm}:{ss}
        </span>
        <span className="pomo__task" title={session.title}>
          {session.title}
        </span>
        <span className="pomo__bar" aria-hidden>
          <span className="pomo__fill" style={{ width: `${pct}%` }} />
        </span>
        <button
          className="icon-btn"
          aria-label={session.running ? '暂停' : '继续'}
          title={session.running ? '暂停' : '继续'}
          onClick={() => setSession((cur) => (cur ? { ...cur, running: !cur.running } : cur))}
        >
          {session.running ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button
          className="icon-btn icon-btn--danger"
          aria-label="结束"
          title="结束本轮"
          onClick={() => {
            const cur = ref.current
            if (!cur) return
            // 专注且还剩时间 = 手动中断：先问原因（对齐 _request_stop，D18）
            if (cur.phase === 'focus' && cur.remain > 0) {
              setAskReason(true)
              return
            }
            // 休息提前结束：仍按「已完成」记账（对齐 stop(abandoned=False)，D20）
            record(cur, false)
            setSession(null)
          }}
        >
          <Square size={14} />
        </button>
      </div>
      {askReason && (
        <div
          className="reminder"
          role="dialog"
          aria-label="专注中断原因"
          style={{
            position: 'fixed',
            right: 'var(--space-5)',
            top: 'auto',
            bottom: 'calc(var(--space-5) + 72px)',
            width: 300,
          }}
        >
          <header className="reminder__head">专注中断 · 选择原因</header>
          <div className="reminder__actions">
            {INTERRUPT_REASONS.map((r) => (
              <button key={r} className="text-btn" onClick={() => stopWithReason(r)}>
                {r}
              </button>
            ))}
          </div>
          <input
            className="field"
            placeholder="或输入自定义原因"
            value={customReason}
            onChange={(e) => setCustomReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') stopWithReason(customReason)
            }}
          />
          <div className="reminder__actions">
            <button className="text-btn text-btn--accent" onClick={() => stopWithReason(customReason)}>
              确定
            </button>
            <button className="text-btn" onClick={() => stopWithReason('')}>
              取消
            </button>
          </div>
        </div>
      )}
    </>
  )
}
