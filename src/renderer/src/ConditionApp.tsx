import { useEffect, useState } from 'react'
import { Diamond } from '@renderer/lib/icons'
import { parseSettings } from '@shared/settings'
import { applyAppearance } from './theme'

/**
 * 工作流条件节点的人工确认 —— 跑在**自己的小窗口**里（`?condition=1`），不占主窗口。
 *
 * 卡片**复用应用内弹框的那套 DOM 与样式**（`.modal modal--dialog` + `.modal__head/body/foot`），
 * 所以它的圆角、边框、按钮、字号与其它确认框完全一致，也一起受主题控制 ——
 * 这里做的只是「把遮罩换成窗口本身」。
 */
export function ConditionApp(): JSX.Element {
  const [ask, setAsk] = useState<{ id: string; prompt: string } | null>(null)

  useEffect(
    () =>
      window.zhixing.condition.onAsk((ask) => {
        setAsk(ask)
        // 每次来问都重新应用一次外观（窗口是复用的，主题可能变了）
        void (async () => {
          try {
            applyAppearance(parseSettings(await window.zhixing.db.settings()))
          } catch {
            // 读不到就用默认
          }
        })()
      }),
    []
  )

  // 应用与主窗口一致的主题（含字号、动效级别），完成后再让主进程显示窗口
  useEffect(() => {
    void (async () => {
      try {
        applyAppearance(parseSettings(await window.zhixing.db.settings()))
      } catch {
        // 读不到设置就用默认，不能因为这个把确认框卡住
      }
      window.zhixing.condition.ready()
    })()
  }, [])

  // 无边框窗口要贴合卡片：量出卡片高度回报给主进程（内容换行时会重新量）
  useEffect(() => {
    const el = document.querySelector('.modal')
    if (!el) return
    const report = (): void => window.zhixing.app.fitHeight(Math.ceil(el.getBoundingClientRect().height))
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const answer = (ok: boolean): void => {
    if (!ask) return
    window.zhixing.condition.answer(ask.id, ok)
    setAsk(null)
  }

  // Enter = 成立、Esc = 不成立（与原生模态的默认按钮 / 取消一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') answer(false)
      else if (e.key === 'Enter') answer(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="cond-win">
      <div className="modal modal--dialog" role="dialog" aria-modal="true">
        <header className="modal__head">
          <span className="dialog__icon dialog__icon--warning" aria-hidden>
            <Diamond size={15} />
          </span>
          <h2>工作流条件</h2>
        </header>
        <div className="modal__body">
          <p className="dialog__message">{ask?.prompt ?? '正在读取条件…'}</p>
          <p className="u-aux">选「成立」走条件分支，选「不成立」走顺序下一步。</p>
        </div>
        <footer className="modal__foot">
          <span className="modal__spacer" />
          <button className="text-btn" onClick={() => answer(false)}>
            不成立
          </button>
          <button className="text-btn text-btn--accent" onClick={() => answer(true)}>
            成立
          </button>
        </footer>
      </div>
    </div>
  )
}
