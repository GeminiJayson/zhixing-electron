import { useEffect, useState } from 'react'
import { Diamond } from '@renderer/lib/icons'

/**
 * 工作流条件节点的人工确认 —— 跑在**自己的小窗口**里（`?condition=1`），不占主窗口。
 *
 * 主进程在「工作流跑到条件节点」时开这个窗口并把提示文案发过来；这里只做两件事：
 * 显示文案，把「成立 / 不成立」回传。窗口本身由主进程在应答后关闭。
 */
export function ConditionApp(): JSX.Element {
  const [ask, setAsk] = useState<{ id: string; prompt: string } | null>(null)

  useEffect(() => window.zhixing.condition.onAsk(setAsk), [])

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
      <header className="cond-win__head">
        <span className="dialog__icon dialog__icon--warning" aria-hidden>
          <Diamond size={15} />
        </span>
        <strong>工作流条件</strong>
      </header>
      <p className="cond-win__msg">{ask?.prompt ?? '正在读取条件…'}</p>
      <p className="u-aux cond-win__hint">选「成立」走条件分支，选「不成立」走顺序下一步。</p>
      <footer className="cond-win__foot">
        <button className="text-btn" onClick={() => answer(false)}>
          不成立
        </button>
        <button className="text-btn text-btn--accent" onClick={() => answer(true)}>
          成立
        </button>
      </footer>
    </div>
  )
}
