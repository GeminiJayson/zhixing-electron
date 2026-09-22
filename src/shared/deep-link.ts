/**
 * `zhixing://` 深链解析：
 *   zhixing://task/<id> | note/<id> | flash/<id> | folder/<id>
 *   zhixing://note/<id>?block=<key>  （定位到笔记段落）
 * 保持纯函数，便于单测与主进程复用。
 */

export type DeepLinkKind = 'task' | 'note' | 'flash' | 'folder'

export interface DeepLink {
  kind: DeepLinkKind
  id: number
  block: string
}

const KINDS = new Set(['task', 'note', 'flash', 'folder'])

export function parseDeepLink(url: string): DeepLink | null {
  const raw = (url ?? '').trim()
  if (!raw.toLowerCase().startsWith('zhixing:')) return null
  let rest = raw.replace(/^zhixing:\/\//i, '').replace(/^zhixing:/i, '').replace(/^\/+/, '')
  const m = rest.match(/^(task|note|flash|folder)\/(\d+)(?:\?(.*))?$/)
  if (!m || !KINDS.has(m[1])) return null
  const id = Number(m[2])
  if (!Number.isFinite(id) || id <= 0) return null
  let block = ''
  if (m[3]) {
    try {
      block = new URLSearchParams(m[3]).get('block') ?? ''
    } catch {
      block = ''
    }
  }
  return { kind: m[1] as DeepLinkKind, id, block }
}

/** 从进程 argv 中挑出深链 URL（Windows/Linux 二次启动走这条路）。 */
export function extractDeepLink(argv: readonly string[]): string | null {
  for (const a of argv ?? []) {
    if (typeof a === 'string' && a.toLowerCase().startsWith('zhixing:')) return a
  }
  return null
}

/**
 * 热键写法（ctrl+alt+n）→ Electron Accelerator（Control+Alt+N）。
 * 无法识别的片段返回空串，调用方跳过注册。
 */
export function toAccelerator(hotkey: string): string {
  const parts = (hotkey ?? '')
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
  if (!parts.length) return ''
  const out: string[] = []
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') out.push('Control')
    else if (p === 'alt' || p === 'option') out.push('Alt')
    else if (p === 'shift') out.push('Shift')
    else if (p === 'cmd' || p === 'command' || p === 'meta' || p === 'super') out.push('Command')
    else if (/^f\d{1,2}$/.test(p)) out.push(p.toUpperCase())
    else if (p.length === 1) out.push(p.toUpperCase())
    else return ''
  }
  // 至少要有一个修饰键，否则会抢占普通按键输入
  const hasModifier = out.some((k) => ['Control', 'Alt', 'Shift', 'Command'].includes(k))
  return hasModifier ? out.join('+') : ''
}
