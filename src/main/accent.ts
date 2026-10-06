/**
 * 强调色 → 预设色的就近匹配。
 *
 * 从 main/index.ts 抽出来（那个文件 2497 行）。抽它的理由和 vault/timers 一样：
 * 这里全是**纯计算**（hex 解析 + 距离比较），却因为和窗口/托盘代码挤在一个文件里
 * 而没有单测守着 —— 而它恰好有边界（3 位简写、非法输入、自定义色的兜底）。
 */

/*
  图标按「预设强调色」在**构建期**烘好（scripts/gen-app-icons.cjs：8 色 × 应用/托盘两形态）。
  Windows 的窗口图标与托盘图标都能在运行时 setIcon / setImage，但换色意味着重新光栅化 SVG，
  而主进程里没有渲染器 —— 与其在运行时背一个渲染器，不如把 8 个预设色都烘出来按需取文件。
  设置页的自定义强调色取**最接近的预设**兜底（图标是 256px 的位图，色差在视觉上几乎看不出来）。
*/
/**
 * 预生成了图标的强调色（必须与 scripts/gen-app-icons.cjs 的 PRESET_ACCENTS 一致）。
 *
 * = 设置页的 8 个色板 + 所有主题包的推荐强调色。**后者不能省**：兜底是"取最接近的预设"，
 * 而墨黑（#525252）、奶咖棕、暖沙、暮色、柠檬黄这些包推荐色离那 8 个色板都挺远，
 * 映射过去就成了"换了主题包图标却没变"（用户报的正是墨黑）。
 */
export const PRESET_ACCENTS = [
  '#0D9488',
  '#2563EB',
  '#7C3AED',
  '#DB2777',
  '#EA580C',
  '#16A34A',
  '#D97706',
  '#0891B2',
  '#525252',
  '#A16207',
  '#B45309',
  '#C2410C',
  '#CA8A04',
  '#BE185D',
  '#059669',
  '#9333EA',
] as const

/** `#abc` 与 `#aabbcc` 都能解；调用方保证格式合法。 */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [
    parseInt(f.slice(0, 2), 16),
    parseInt(f.slice(2, 4), 16),
    parseInt(f.slice(4, 6), 16),
  ]
}

/**
 * 自定义强调色取最接近的预设色。
 *
 * **格式不合法时退回第一个预设**而不是抛错：这个值来自设置页，用户可以填任意字符串，
 * 而它决定了图标文件路径 —— 抛错会让托盘图标整个消失，那是更糟的回退。
 */
export function nearestAccent(hex: string): string {
  const raw = (hex || '').trim()
  if (!/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(raw)) return PRESET_ACCENTS[0]
  const [r, g, b] = hexToRgb(raw)
  let best: string = PRESET_ACCENTS[0]
  let bestD = Number.POSITIVE_INFINITY
  for (const cand of PRESET_ACCENTS) {
    const [cr, cg, cb] = hexToRgb(cand)
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
    if (d < bestD) {
      bestD = d
      best = cand
    }
  }
  return best
}
