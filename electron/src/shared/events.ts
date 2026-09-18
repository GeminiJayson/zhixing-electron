/**
 * 数据变更事件层（O3）。
 *
 * 为什么是「主进程广播 + 渲染进程订阅」：写入发生在主进程的 IPC 里，
 * 而关心刷新的页面在渲染进程，两者不同进程，纯前端的 EventBus 覆盖不到。
 * 主进程在写操作后按「域」广播，页面只订阅自己关心的域，避免整页重查。
 */

export type DataDomain = 'task' | 'note' | 'flash' | 'workflow' | 'settings'

type Listener = (domain: DataDomain) => void

const listeners = new Set<Listener>()

/** 订阅任意域的数据变更，返回取消订阅函数。 */
export function subscribeDataChanged(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 只订阅指定域（其余域的通知会被忽略）。 */
export function subscribeDomain(domains: DataDomain[], fn: () => void): () => void {
  const want = new Set(domains)
  return subscribeDataChanged((domain) => {
    if (want.has(domain)) fn()
  })
}

export function emitDataChanged(domain: DataDomain): void {
  for (const fn of [...listeners]) fn(domain)
}

/**
 * 把主进程的写入通知接进订阅表；应用启动时调用一次即可。
 * 依赖由调用方注入，这样本模块不必引用 window，主进程侧编译也能通过。
 */
export function bindHostEvents(bridge: {
  onDataChanged: (cb: (domain: string) => void) => void
}): void {
  bridge.onDataChanged((domain) => emitDataChanged(domain as DataDomain))
}
