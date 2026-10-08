import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { usePresence } from '../lib/presence'

/**
 * 应用内对话框（替换 window.prompt / window.confirm）。
 *
 * 起因：Electron **不实现** window.prompt —— 调用不会报错，只是永远返回 null，
 * 于是「新建标签 / 新建文件夹 / 新建工作流 / 重命名」在打包版里全都静默失败。
 * confirm 虽然能用，但它弹的是原生框，与自绘界面风格割裂，也一并收回来。
 */

export interface PromptOptions {
  title: string
  label?: string
  defaultValue?: string
  placeholder?: string
  confirmText?: string
}

export interface ConfirmOptions {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  /** 弹框图标（一般取 @renderer/lib/icons 里的组件）。不传就没有图标 */
  icon?: ReactNode
  /** 图标底色语义；默认「危险操作跟着 danger，其余用强调色」 */
  tone?: 'info' | 'warning' | 'danger'
}

interface DialogApi {
  prompt: (options: PromptOptions) => Promise<string | null>
  confirm: (options: ConfirmOptions | string) => Promise<boolean>
}

const DialogContext = createContext<DialogApi | null>(null)

export function useDialog(): DialogApi {
  const api = useContext(DialogContext)
  if (!api) throw new Error('useDialog 必须在 DialogProvider 内使用')
  return api
}

type Pending =
  | { kind: 'prompt'; options: PromptOptions; resolve: (v: string | null) => void }
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (v: boolean) => void }

/** 退场时长：必须与 global.css 里 `.modal-mask.is-leaving` 与 `.modal-mask.is-leaving .modal`
    两条退场动画用的 --dur-fast 一致。 */
const EXIT_MS = 150

export function DialogProvider({ children }: { children: ReactNode }) {
  // 队列而不是单个：并存请求（如批量删除里连续确认）不会互相覆盖
  const [queue, setQueue] = useState<Pending[]>([])
  // 用 ref 持有同一份队列。resolve 必须在事件处理器里同步发生：
  // 之前把 resolve 写进 setQueue 的 updater（React 会延迟/重放它），
  // 结果是对话框照常关闭、但 await 之后的代码永远不执行——表现为「点确定什么都不发生」。
  const queueRef = useRef<Pending[]>([])
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const current = queue[0] ?? null

  // 遮罩与面板的退场（.is-leaving）：present 由「队列里还有没有对话框」驱动。
  // current 一变 null，标题 / 正文就再也取不到了 —— 退场窗口里要继续显示最后那张卡片，
  // 所以留一份快照。动效非 full 档时 usePresence 同步卸载，不让人白等。
  const { mounted, leaving } = usePresence(current !== null, EXIT_MS)
  const lastDialog = useRef<{ isPrompt: boolean; options: PromptOptions | ConfirmOptions } | null>(null)

  const open = useCallback((item: Pending) => {
    queueRef.current = [...queueRef.current, item]
    setQueue(queueRef.current)
  }, [])

  const settle = useCallback((value: string | null | boolean) => {
    const [head, ...rest] = queueRef.current
    if (!head) return
    queueRef.current = rest
    setQueue(rest)
    // 先更新界面，再结算 Promise；resolve 是副作用，只能留在这里
    if (head.kind === 'prompt') head.resolve(typeof value === 'string' ? value : null)
    else head.resolve(value === true)
  }, [])

  const api: DialogApi = {
    prompt: (options) =>
      new Promise<string | null>((resolve) => {
    setDraft(options.defaultValue ?? '')
        open({ kind: 'prompt', options, resolve })
      }),
    confirm: (options) =>
      new Promise<boolean>((resolve) => {
        const normalized = typeof options === 'string' ? { title: '确认', message: options } : options
        open({ kind: 'confirm', options: normalized, resolve })
      }),
  }

  // 每次换到新对话框时聚焦输入框
  useEffect(() => {
    if (current?.kind === 'prompt') {
      const t = window.setTimeout(() => inputRef.current?.select(), 30)
      return () => window.clearTimeout(t)
    }
  }, [current])

  useEffect(() => {
    // 记下「刚刚显示过的那张卡片」，退场窗口靠它继续渲染（写 ref 放在 effect 里，不在渲染阶段写）
    if (current) lastDialog.current = { isPrompt: current.kind === 'prompt', options: current.options }
  }, [current])

  const shown = current
    ? { isPrompt: current.kind === 'prompt', options: current.options }
    : lastDialog.current
  if (!mounted || !shown) return <DialogContext.Provider value={api}>{children}</DialogContext.Provider>

  const { isPrompt, options: opts } = shown
  const confirmOpts = isPrompt ? null : (opts as ConfirmOptions)
  const dangerBtn = confirmOpts?.danger === true
  const iconTone = confirmOpts?.tone ?? (confirmOpts?.danger ? 'danger' : 'info')

  return (
    <DialogContext.Provider value={api}>
      {children}
      <div
        className={'modal-mask' + (leaving ? ' is-leaving' : '')}
        /*
          点遮罩关闭 —— **必须判断目标是不是遮罩本身**。
          不判断的话，按钮的 mousedown 会冒泡上来，先 settle(false) 把对话框关掉，
          随后按钮自己的 click 再 settle(true) 已经无效：**真实鼠标点「确定」会被当成「取消」**。
          （自动化只用 dispatchEvent('click') 时没有 mousedown，所以这个 bug 只在真人点击时出现 ——
          症状就是「点了总结却什么都没发生」。）
        */
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) settle(isPrompt ? null : false)
        }}
      >
        <div
          className={'modal modal--dialog' + (leaving ? ' is-leaving' : '')}
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <header className="modal__head">
            {/* 图标是可选的：删除类操作用垃圾桶、回滚用撤销箭头 —— 一眼看出这条弹框在干什么 */}
            {confirmOpts?.icon ? (
              <span
                className={'dialog__icon' + (iconTone === 'info' ? '' : ` dialog__icon--${iconTone}`)}
                aria-hidden
              >
                {confirmOpts.icon}
              </span>
            ) : null}
            <h2>{opts.title}</h2>
          </header>
          {isPrompt ? (
            <label className="form-row modal__body">
              <span>{(opts as PromptOptions).label ?? opts.title}</span>
              <input
                ref={inputRef}
                className="field"
                value={draft}
                placeholder={(opts as PromptOptions).placeholder ?? ''}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') settle(draft)
                  if (e.key === 'Escape') settle(null)
                }}
              />
            </label>
          ) : (
            <div className="modal__body">
              <p className="dialog__message">{(opts as ConfirmOptions).message}</p>
            </div>
          )}
          <footer className="modal__foot">
            <span className="modal__spacer" />
            <button className="text-btn" onClick={() => settle(isPrompt ? null : false)}>
              {confirmOpts?.cancelText ?? '取消'}
            </button>
            <button
              className={dangerBtn ? 'text-btn text-btn--danger' : 'text-btn text-btn--accent'}
              onClick={() => settle(isPrompt ? draft : true)}
            >
              {opts.confirmText ?? '确定'}
            </button>
          </footer>
        </div>
      </div>
    </DialogContext.Provider>
  )
}
