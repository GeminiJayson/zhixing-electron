import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, SlidersHorizontal, Timer } from '@renderer/lib/icons'
import { parseSettings } from '@shared/settings'
import { applyAppearance } from './theme'

type Phase = 'focus' | 'break'

interface Session {
  taskId: number | null
  title: string
  phase: Phase
  total: number
  remain: number
  running: boolean
  /** 这一段是长休息（休息间隔到了）—— 标题与提示语据此说「长休息」 */
  long?: boolean
}

/** 小窗里的四项可调参数（与设置页同一份设置，改哪边另一边也变）。 */
interface PomoCfg {
  focus: number
  break: number
  longBreak: number
  /** 每几个番茄进一次长休息 */
  interval: number
  autoBreak: boolean
}

/** 手动中断专注的预设原因。 */
const INTERRUPT_REASONS = ['被打断', '临时有事', '分心', '任务调整', '其他']

/**
 * 番茄钟（独立小窗，\u003fpomodoro=1）。
 *
 * 2026-09-27 从主窗口右下角的浮条改成独立窗，理由见主进程的 openPomodoroWindow：
 * 它与主窗口的生命周期本来就不同 —— 主窗口收进托盘/浮窗时专注还该继续。
 *
 * 卡片骨架与全局热键唤出的捕获窗、工作流条件确认窗共用同一套 .modal，所以外观天然一致；
 * 这里只负责接 payload、跑计时、落库，并把「这一轮结束了」回执给主窗口。
 *
 * 记账口径与原浮条完全一致：
 * - stop() 不区分阶段：专注与休息只要走过 ≥1 分钟都落库，completed = 是否手动放弃；
 * - 手动中断专注先选原因并写入 reason 列（取消也会记一次，只是不带原因）；
 * - 新的一轮先记完上一轮，而不是直接覆盖会话。
 */
export function PomodoroWindowApp(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null)
  const [askReason, setAskReason] = useState(false)
  const [customReason, setCustomReason] = useState('')
  const [cfg, setCfg] = useState<PomoCfg>({ focus: 25, break: 5, longBreak: 15, interval: 4, autoBreak: false })
  /** 设置面板是否展开：番茄钟"开始的时候"就要能改时长，不必再跑去设置页 */
  const [cfgOpen, setCfgOpen] = useState(false)
  /** 收起态：窗口隐藏，倒计时交给浮窗上的悬浮表情显示（计时照跑） */
  const [collapsed, setCollapsed] = useState(false)
  /** 本次窗口内已完成的专注段数，用来判断该不该进长休息 */
  const doneRef = useRef(0)
  const ref = useRef<Session | null>(null)
  ref.current = session
  const askingRef = useRef(false)
  askingRef.current = askReason
  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  const rootRef = useRef<HTMLDivElement>(null)

  // 每次打开都重读设置并重铺外观：窗口是复用的，用户可能刚改过主题 / 字号 / 时长
  useEffect(() => {
    void (async () => {
      try {
        const s = parseSettings(await window.zhixing.db.settings())
        applyAppearance(s)
        setCfg({
          focus: s.pomodoro_focus_min,
          break: s.pomodoro_break_min,
          longBreak: s.pomodoro_long_break_min,
          interval: s.pomodoro_interval,
          autoBreak: s.pomodoro_auto_break,
        })
      } catch {
        // 读不到设置就用默认值，不能因此卡住窗口
      }
      window.zhixing.pomodoro.ready()
    })()
  }, [])

  /**
   * 改一项设置：**立即写库**（与设置页共用同一份 key，改哪边另一边都跟着变），
   * 并让"还没开始跑"的这一段就地用上新值 —— 刚打开就改时长是很自然的动作，
   * 不该逼用户结束这一轮重来。已经跑了一半的不动：时间突然跳变更莫名其妙。
   */
  const changeCfg = (key: 'focus' | 'break' | 'longBreak' | 'interval', value: number): void => {
    const lo = key === 'interval' ? 1 : 1
    const hi = key === 'focus' ? 90 : key === 'interval' ? 12 : 60
    const v = Math.min(hi, Math.max(lo, Math.round(value) || lo))
    setCfg({ ...cfgRef.current, [key]: v })
    const settingKey =
      key === 'focus'
        ? 'pomodoro_focus_min'
        : key === 'break'
          ? 'pomodoro_break_min'
          : key === 'longBreak'
            ? 'pomodoro_long_break_min'
            : 'pomodoro_interval'
    void window.zhixing.db.setSetting(settingKey, String(v))
    setSession((cur) => {
      if (!cur || cur.remain !== cur.total) return cur
      const untouched = cur.long ? 'longBreak' : 'break'
      const mine = cur.phase === 'focus' ? 'focus' : untouched
      if (mine !== key) return cur
      const total = v * 60
      return { ...cur, total, remain: total }
    })
  }

  /** 落库：分钟数按已经过的时间四舍五入，不足 1 分钟由 recordPomodoro 内部跳过。 */
  const record = useCallback((cur: Session, abandoned: boolean, reason = ''): void => {
    void window.zhixing.db.recordPomodoro(
      cur.taskId,
      Math.round((cur.total - Math.max(0, cur.remain)) / 60),
      !abandoned,
      reason
    )
  }, [])

  /** 结束这一轮并关窗：提示语交给主窗口去弹（它才是常驻的那个界面）。 */
  const finish = useCallback((message: string): void => {
    setSession(null)
    window.zhixing.pomodoro.done(message)
    window.zhixing.pomodoro.close()
  }, [])

  const start = useCallback(
    (taskId: number | null, title: string): void => {
      const prev = ref.current
      // 非 idle 先记完上一轮再开新一轮
      if (prev) record(prev, false)
      setAskReason(false)
      setCustomReason('')
      const total = Math.max(1, cfgRef.current.focus) * 60
      setSession({ taskId, title, phase: 'focus', total, remain: total, running: true })
    },
    [record]
  )

  useEffect(() => window.zhixing.pomodoro.onOpen((p) => start(p.taskId, p.title)), [start])

  // 每秒推进；专注阶段走完落库并（可选）转入休息
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
        // 完成一段专注 → 数够"休息间隔"就进长休息
        doneRef.current += 1
        const isLong = doneRef.current % Math.max(1, cfgRef.current.interval) === 0
        const minutes = isLong ? cfgRef.current.longBreak : cfgRef.current.break
        if (cfgRef.current.autoBreak) {
          const total = Math.max(1, minutes) * 60
          setSession({ ...cur, phase: 'break', long: isLong, total, remain: total, running: true })
          window.zhixing.pomodoro.done(isLong ? '专注结束，进入长休息' : '专注结束，进入休息')
        } else {
          finish(isLong ? '专注结束，该长休息了' : '专注结束，休息一下')
        }
      } else {
        finish('休息结束')
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [record, finish])

  /**
   * 每秒把状态报给主进程 → 转发给浮窗。
   *
   * 浮窗只在**收起时**显示这行倒计时：窗口还看得见的时候不必再多一处重复的数字。
   * session 每秒都在变，所以这条 effect 天然就是每秒一次的上报节奏。
   */
  useEffect(() => {
    if (!session) {
      window.zhixing.pomodoro.report(null)
      return
    }
    window.zhixing.pomodoro.report({
      phase: session.phase,
      long: session.long,
      remain: session.remain,
      running: session.running,
      title: session.title,
      collapsed,
    })
  }, [session, collapsed])

  // 从悬浮表情点回来时，主进程会通知小窗：同步收起态（否则浮窗上那行倒计时不会收掉）
  useEffect(() => window.zhixing.pomodoro.onExpanded(() => setCollapsed(false)), [])

  // 无边框窗口要贴合卡片：量出来回报主进程（与捕获窗同一套 window:fitHeight）
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const report = (): void =>
      window.zhixing.app.fitHeight(Math.ceil(el.getBoundingClientRect().height))
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [session, askReason, cfgOpen])

  /** 选中/输入原因后结束本轮：取消等于不带原因，但同样落库。 */
  const stopWithReason = (reason: string): void => {
    const cur = ref.current
    if (cur) record(cur, cur.phase === 'focus' && cur.remain > 0, reason.trim())
    finish('本轮已结束')
  }

  const mm = session ? String(Math.floor(session.remain / 60)).padStart(2, '0') : '--'
  const ss = session ? String(session.remain % 60).padStart(2, '0') : '--'
  const pct = session ? Math.round(((session.total - session.remain) / session.total) * 100) : 0
  const heading = askReason
    ? '专注中断'
    : session?.phase === 'break'
      ? session.long
        ? '长休息'
        : '休息'
      : '专注'

  return (
    <div className="pomo-host" ref={rootRef}>
      <div className="modal modal--pomodoro" role="dialog" aria-label="番茄钟">
        <header className="modal__head">
          <span className="dialog__icon" aria-hidden>
            <Timer size={15} />
          </span>
          <h2>{heading}</h2>
        </header>

        <div className="modal__body">
          {askReason ? (
            <>
              <p className="u-aux pomo-card__hint">这一轮还没走完，选一个中断原因记下来：</p>
              <div className="pomo-card__reasons">
                {INTERRUPT_REASONS.map((r) => (
                  <button key={r} className="text-btn" onClick={() => stopWithReason(r)}>
                    {r}
                  </button>
                ))}
              </div>
              <input
                className="field"
                value={customReason}
                placeholder="其他原因（可留空）"
                aria-label="自定义中断原因"
                onChange={(e) => setCustomReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') stopWithReason(customReason)
                }}
              />
            </>
          ) : session ? (
            <>
              <p className="pomo-card__time">
                {mm}:{ss}
              </p>
              {session.title ? (
                <p className="pomo-card__task" title={session.title}>
                  {session.title}
                </p>
              ) : null}
              <span className="pomo-card__bar" aria-hidden>
                <i style={{ width: `${pct}%` }} />
              </span>
              {/*
                设置面板：番茄钟"开始的时候"就能调 —— 专注多久、几个番茄休息一次、
                休息多久。改完立刻入库（与设置页同一份），还没跑的这一段就地生效。
              */}
              {cfgOpen ? (
                <div className="pomo-card__cfg">
                  <label className="pomo-card__cfg-row">
                    <span>专注</span>
                    <input
                      type="number"
                      className="field field--num"
                      min={1}
                      max={90}
                      value={cfg.focus}
                      aria-label="专注分钟"
                      onChange={(e) => changeCfg('focus', Number(e.target.value))}
                    />
                    <span className="u-aux">分钟</span>
                  </label>
                  <label className="pomo-card__cfg-row">
                    <span>休息间隔</span>
                    <input
                      type="number"
                      className="field field--num"
                      min={1}
                      max={12}
                      value={cfg.interval}
                      aria-label="休息间隔（几个番茄）"
                      onChange={(e) => changeCfg('interval', Number(e.target.value))}
                    />
                    <span className="u-aux">个番茄</span>
                  </label>
                  <label className="pomo-card__cfg-row">
                    <span>短休息</span>
                    <input
                      type="number"
                      className="field field--num"
                      min={1}
                      max={60}
                      value={cfg.break}
                      aria-label="短休息分钟"
                      onChange={(e) => changeCfg('break', Number(e.target.value))}
                    />
                    <span className="u-aux">分钟</span>
                  </label>
                  <label className="pomo-card__cfg-row">
                    <span>长休息</span>
                    <input
                      type="number"
                      className="field field--num"
                      min={1}
                      max={60}
                      value={cfg.longBreak}
                      aria-label="长休息分钟"
                      onChange={(e) => changeCfg('longBreak', Number(e.target.value))}
                    />
                    <span className="u-aux">分钟</span>
                  </label>
                </div>
              ) : null}
            </>
          ) : (
            <p className="u-aux">等待主窗口发起一轮专注…</p>
          )}
        </div>

        {!askReason && session ? (
          <footer className="modal__foot">
            {/* 小窗只有 300px：次要动作用**纯图标**（title/aria-label 里说全），
                否则四个按钮挤到临界，字号一变就折行（用户反馈） */}
            <button
              className="text-btn"
              aria-expanded={cfgOpen}
              aria-label="设置"
              title="设置专注 / 休息间隔 / 休息时长（与设置页同一份，改完立即生效）"
              onClick={() => setCfgOpen((v) => !v)}
            >
              <SlidersHorizontal size={13} />
            </button>
            <button
              className="text-btn"
              onClick={() => setSession((cur) => (cur ? { ...cur, running: !cur.running } : cur))}
            >
              {session.running ? '暂停' : '继续'}
            </button>
            <button
              className="text-btn"
              aria-label="收起"
              title="收起成悬浮表情上的倒计时（计时继续；点那行倒计时可以展开回来）"
              onClick={() => {
                setCollapsed(true)
                window.zhixing.pomodoro.collapse()
              }}
            >
              <ChevronDown size={13} />
            </button>
            <span className="modal__spacer" />
            <button
              className="text-btn text-btn--danger"
              onClick={() => {
                const cur = ref.current
                if (!cur) return
                // 专注且还剩时间 = 手动中断：先问原因
                if (cur.phase === 'focus' && cur.remain > 0) {
                  setAskReason(true)
                  return
                }
                // 休息提前结束：仍按「已完成」记账
                record(cur, false)
                finish('本轮已结束')
              }}
            >
              结束
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  )
}
