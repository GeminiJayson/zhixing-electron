/**
 * 锚定式弹层的定位：贴在触发按钮旁边，并保证**完整落在视口内**。
 *
 * 为什么抽成一个函数：这类弹层一共有五处（状态 / 优先级 / 日期 / 标签 / 通用菜单），
 * 原先每处各写一遍——其中三处只写了 `top = rect.bottom + 4`，什么约束都没有。
 * 结果就是任务项靠近窗口底部时，菜单直接从下沿探出去，用户看不见下面几项。
 * 这种"漏一处就复现"的逻辑，本来就该只有一份。
 *
 * 策略（按优先级）：
 *   1. 默认贴锚点下方、左对齐；
 *   2. 下方放不下 → **翻到上方**（不是硬夹进视口——夹进去会把菜单盖在按钮上，视线要重新找）；
 *   3. 上方也放不下（锚点几乎撑满一屏）→ 退回"夹进视口"，至少保证内容可见；
 *   4. 水平方向同理：右边放不下就往左收，仍放不下再夹到安全边距。
 *
 * 尺寸取 `offsetWidth/offsetHeight` 实测值，不估算 —— 菜单高度取决于项数、
 * 有没有说明行、有没有展开调色板，估算必然在某一项上失手。
 */
export interface AnchorRect {
  left: number
  top: number
  bottom: number
}

/** 视口安全边距：贴着窗口边缘会让阴影被切掉半截 */
const PAD = 8
/** 与锚点之间的间距 */
const GAP = 4

export function placeAnchored(el: HTMLElement, anchor: AnchorRect, gap = GAP): void {
  const w = el.offsetWidth
  const h = el.offsetHeight
  const vw = window.innerWidth
  const vh = window.innerHeight

  let left = anchor.left
  if (left + w + PAD > vw) left = vw - w - PAD
  if (left < PAD) left = PAD

  let top = anchor.bottom + gap
  if (top + h + PAD > vh) {
    const above = anchor.top - gap - h
    top = above >= PAD ? above : vh - h - PAD
    if (top < PAD) top = PAD
  }

  el.style.left = `${Math.round(left)}px`
  el.style.top = `${Math.round(top)}px`
}
