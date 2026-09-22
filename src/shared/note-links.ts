/**
 * 链接笔记的条目模型：一条链接 = 标题 + 目标（URL 或本地路径）。
 *
 * 存储格式是写在 content_md 里的 `[{title,target}]` JSON 数组，
 * 所以**不新增表、不迁移数据**；同时容错三种历史形态：
 *   1. `[{"title":"…","target":"…"}]`
 *   2. `[{"title":"…","url":"…"}]`（别的写法）
 *   3. 裸 URL / 路径字符串，甚至 Markdown 的 `- [标题](链接)` 列表
 */
export interface NoteLinkItem {
  title: string
  target: string
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null
const firstText = (...vals: unknown[]): string => {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim()
  return ''
}

/** 把 note.content_md 解析成链接条目；坏数据不抛，尽力还原。 */
export function parseLinkItems(raw: string | null | undefined): NoteLinkItem[] {
  const text = (raw ?? '').trim()
  if (!text) return []

  // 1) JSON 数组
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (Array.isArray(parsed)) {
        const items = parsed
          .map((it) => {
            const rec = asRecord(it)
            if (!rec) return null
            const target = firstText(rec.target, rec.url, rec.href, rec.link)
            if (!target) return null
            return { title: firstText(rec.title, rec.name, rec.label) || target, target }
          })
          .filter((x): x is NoteLinkItem => x !== null)
        if (items.length) return items
        // 空数组是「明确没有链接」，不该再退化成一条 "[]" 链接
        if (!parsed.length) return []
      }
    } catch {
      // 不是 JSON：继续按文本解析
    }
  }

  // 2) Markdown 列表：- [标题](链接)
  const mdItems: NoteLinkItem[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[-*]?\s*\[([^\]]*)\]\(\s*([^)\s]+)\s*\)\s*$/.exec(line)
    if (m) mdItems.push({ title: m[1].trim() || m[2], target: m[2] })
  }
  if (mdItems.length) return mdItems

  // 3) 一行一条裸链接
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length > 1) return lines.map((l) => ({ title: l, target: l }))

  // 4) 整段就是一个链接
  return [{ title: text.length > 60 ? text.slice(0, 60) : text, target: text }]
}

/** 序列化回 content_md（只保留标题与目标，去空白）。 */
export function serializeLinkItems(items: NoteLinkItem[]): string {
  const clean = items
    .map((it) => ({ title: (it.title ?? '').trim() || it.target, target: (it.target ?? '').trim() }))
    .filter((it) => it.target)
  return JSON.stringify(clean)
}

/** 链接清单 → 写进提示词的可读列表。 */
export function describeLinkItems(items: NoteLinkItem[]): string {
  if (!items.length) return '（这篇链接笔记里还没有链接）'
  return items.map((it, i) => `${i + 1}. ${it.title} — ${it.target}`).join('\n')
}

/** 去重追加：同一个 target 已经存在就不再添加（归档时反复跑也不会重复）。 */
export function appendLinkItems(
  existing: NoteLinkItem[],
  incoming: NoteLinkItem[]
): { items: NoteLinkItem[]; added: number } {
  const have = new Set(existing.map((it) => it.target))
  const merged = [...existing]
  let added = 0
  for (const it of incoming) {
    const target = (it.target ?? '').trim()
    if (!target || have.has(target)) continue
    have.add(target)
    merged.push({ title: (it.title ?? '').trim() || target, target })
    added += 1
  }
  return { items: merged, added }
}

/** 两个链接条目是否指向同一处（归档时的比对口径）。 */
export function sameLink(a: NoteLinkItem, b: NoteLinkItem): boolean {
  return (a.target ?? '').trim() === (b.target ?? '').trim()
}
