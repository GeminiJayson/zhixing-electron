/**
 * 极简 JSON 路径：`a.b[0].c` 这种写法取值。
 *
 * 外部接口的字段常常藏在几层包装里（`data.items[].attributes.name`），
 * 让用户在设置页直接填路径，比让他改接口或加一层适配代码现实得多。
 * 只支持两件事：点号分隔的属性、方括号里的数组下标 —— 够用且不会被误用成表达式。
 */
export function getByPath(input: unknown, path: string | null | undefined): unknown {
  const raw = (path ?? '').trim()
  if (!raw || raw === '$' || raw === '.') return input
  const tokens: (string | number)[] = []
  for (const part of raw.replace(/^\$\.?/, '').split('.')) {
    if (!part) continue
    // name[0][1] → name, 0, 1
    const m = /^([^\[\]]*)((?:\[[^\]]*\])*)$/.exec(part)
    if (!m) {
      tokens.push(part)
      continue
    }
    if (m[1]) tokens.push(m[1])
    for (const idx of m[2].matchAll(/\[([^\]]*)\]/g)) {
      const v = idx[1].trim().replace(/^["']|["']$/g, '')
      tokens.push(/^\d+$/.test(v) ? Number(v) : v)
    }
  }
  let cur: unknown = input
  for (const t of tokens) {
    if (cur === null || cur === undefined) return undefined
    if (typeof t === 'number') {
      if (!Array.isArray(cur)) return undefined
      cur = cur[t]
    } else {
      if (typeof cur !== 'object') return undefined
      cur = (cur as Record<string, unknown>)[t]
    }
  }
  return cur
}
