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

/**
 * 番茄钟浮条：由任务行的「专注」按钮（派发 zhixing:pomodoro 事件）启动。
 * 专注结束写入 pomodoro_session，并按设置自动进入休息。
 */
export function PomodoroBar({ focusMinutes, breakMinutes, autoBreak, onNotice }: Props) {
  const [session, setSession] = useState<Session | null>(null)
  const ref = useRef<Session | null>(null)
  ref.current = session

  const start = useCallback(
    (taskId: number | null, title: string) => {
      const total = Math.max(1, focusMinutes) * 60
      setSession({ taskId, title, phase: 'focus', total, remain: total, running: true })
    },
    [focusMinutes]
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
      if (!cur || !cur.running) return
      const remain = cur.remain - 1
      if (remain > 0) {
        setSession({ ...cur, remain })
        return
      }
      if (cur.phase === 'focus') {
        void window.zhixing.db.recordPomodoro(cur.taskId, Math.round(cur.total / 60), true)
        onNotice('专注结束，休息一下')
        if (autoBreak) {
          const total = Math.max(1, breakMinutes) * 60
          setSession({ ...cur, phase: 'break', total, remain: total, running: true })
        } else {
          setSession(null)
        }
      } else {
        onNotice('休息结束')
        setSession(null)
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [breakMinutes, autoBreak, onNotice])

  if (!session) return null

  const mm = String(Math.floor(session.remain / 60)).padStart(2, '0')
  const ss = String(session.remain % 60).padStart(2, '0')
  const pct = Math.round(((session.total - session.remain) / session.total) * 100)

  return (
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
          if (cur?.phase === 'focus') {
            void window.zhixing.db.recordPomodoro(
              cur.taskId,
              Math.round((cur.total - cur.remain) / 60),
              false
            )
          }
          setSession(null)
        }}
      >
        <Square size={14} />
      </button>
    </div>
  )
}
