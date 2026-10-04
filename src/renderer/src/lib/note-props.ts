/**
 * 笔记属性的文本 ↔ JSON 转换，以及正文里 \`[[标题]]\` 行的增删。
 *
 * 这些原先散在 NotesPage 里（那个文件 2895 行）。它们都是**无状态纯函数** ——
 * 不碰 React、不碰 db —— 抽出来最安全，也最该抽：属性文本格式与「删哪一行」
 * 的规则是这篇笔记的数据契约，值得有一个独立的、可以被单测直接覆盖的落点。
 */

/** props（JSON 对象字符串）→ 每行一条 \`key: value\` 的文本。坏 JSON 当空。 */
export function propsToText(raw?: string | null): string {
  if (!raw) return ''
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    return Object.entries(obj)
      .map(([k, v]) => k + ': ' + String(v))
      .join('\n')
  } catch {
    return ''
  }
}

/** 文本 → props（JSON 对象字符串）。没有冒号的行忽略，键去空白后为空也忽略。 */
export function parsePropsText(text: string): string {
  const obj: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const k = line.slice(0, i).trim()
    const v = line.slice(i + 1).trim()
    if (k) obj[k] = v
  }
  return JSON.stringify(obj)
}

/**
 * 从正文里删掉那一行 \`[[标题]]\`。
 *
 * 用整行字符串比较而不是正则：标题里可能有正则元字符，转义漏一个就会误删别的行。
 */
export function dropLinkLine(contentMd: string, title: string): string {
  return contentMd
    .split('\n')
    .filter((line) => line.trim() !== '[[' + title + ']]')
    .join('\n')
}

/**
 * 哪些类型**才谈得上**缺来源。
 *
 * note（笔记）与 project（项目记录）不是知识类，本来就不需要来源 ——
 * 把它们算进「无来源」会让这个数字等于全部笔记（实测 32/32），指标就失去意义了。
 * 口径与主进程 knowledgeHealth 一致。
 */
export const NEEDS_SOURCE = new Set([
  'concept',
  'summary',
  'synthesis',
  'method',
  'output',
  'pitfall',
])

export function lacksSource(m: { kind: string; hasSource: boolean }): boolean {
  return NEEDS_SOURCE.has(m.kind) && !m.hasSource
}
