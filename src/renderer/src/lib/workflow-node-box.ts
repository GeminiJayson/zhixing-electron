/**
 * 工作流节点的**盒尺寸与文字排版** —— 单一来源。
 *
 * 这些值原先分居两处：`WorkflowPage` 的 `NODE_W` / `NODE_H`，和
 * `workflow-layout.ts` 的 `LAYOUT_NODE_W` / `LAYOUT_NODE_H`，后者还带着一句注释
 * 「与 WorkflowPage 的 NODE_W / NODE_H 保持一致」。**靠注释维持一致就是迟早会不一致** ——
 * 换成 G6 之后画布也要用同一套尺寸，这里收成一份。
 */

/** 节点盒尺寸（普通步骤）。 */
export const NODE_W = 150
export const NODE_H = 56

/** 标题可用宽度：两侧各留 11px。 */
export const NODE_TEXT_W = NODE_W - 22
/** 条件节点用菱形，中间窄 —— 标题宽度按 60% 算。 */
export const COND_TEXT_W = Math.round(NODE_W * 0.6)

/**
 * 估算一个字符在某字号下的宽度（相对字号的倍数）。
 *
 * 汉字与全角标点接近一个字号宽，西文约 0.56。系数**刻意保守**：
 * 宁可早一点出现省略号，也不要让文字画到框外 —— SVG 的 `<text>` 既不会换行也不会缩小。
 */
const charWidth = (ch: string): number =>
  /[\u1100-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 1.02 : 0.56

/** 一段文字在给定字号下的估算宽度。 */
const textWidth = (text: string, size: number): number =>
  [...text].reduce((w, ch) => w + charWidth(ch) * size, 0)

/**
 * 节点内文字的排版：**长标题先缩字号，再按像素截断**。
 *
 * SVG 的 `<text>` 不会自动换行也不会自动缩小，超出的部分会直接画到节点框外。
 * 旧写法按「字符数 > 10」截断，而一个汉字约等于两个西文字母宽 ——
 * 10 个汉字加一个全角标点就能顶出框外（用户看到的就是这个）。
 */
export function fitNodeText(
  raw: string,
  baseSize: number,
  minSize: number,
  maxWidth: number = NODE_TEXT_W
): { text: string; size: number } {
  const title = raw ?? ''
  let size = baseSize
  while (size > minSize && textWidth(title, size) > maxWidth) size -= 0.5
  if (textWidth(title, size) <= maxWidth) return { text: title, size }
  const ellipsis = size * 0.9
  let out = ''
  let w = 0
  for (const ch of title) {
    const cw = charWidth(ch) * size
    if (w + cw > maxWidth - ellipsis) break
    out += ch
    w += cw
  }
  return { text: out + '…', size }
}
