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
 *   2. **向下优先**：下方放得下就往下弹；下方不够高时**不是翻上去**，而是把菜单压到剩余空间、
 *      交给它自己的 `overflow-y: auto` 滚 —— 下拉的视线习惯是"从控件往下读"，
 *      翻转会让菜单跳到视线上方、反而要重新找（用户："向下弹出布局优先"）；
 *   3. 只有下方**窄到连一两行都放不下**时（锚点贴住窗口底沿）才翻到上方；
 *   4. **任何情况下都不覆盖锚点** —— 用户要一直看得见自己在操作哪个控件；
 *   5. 水平方向：右边放不下就往左收，仍放不下再夹到安全边距。
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

/**
 * 找出浮层的**包含块偏移**。
 *
 * `position: fixed` 的元素本该相对视口定位，但只要**任一祖先**带 `transform` / `filter` /
 * `backdrop-filter` / `contain` / `will-change` / `perspective`，那个祖先就会**创建包含块** ——
 * 此时 `left/top` 变成"相对该祖先"的坐标。弹窗里的下拉正好踩中：算出来的是视口坐标，
 * 应用下去却被当成相对弹窗的坐标，于是整个偏掉（用户截图：状态的下拉跑到了"提醒"那一行）。
 *
 * 这里把偏移量找出来，调用方减掉它，浮层就仍然落在正确的视口位置。
 * 返回 `null` 表示没有干扰 —— 那时不做任何补偿（绝大多数情况）。
 */
function containingBlockOffset(el: HTMLElement): { x: number; y: number } | null {
  let cur: HTMLElement | null = el.parentElement
  while (cur && cur !== document.documentElement) {
    const cs = getComputedStyle(cur)
    if (
      cs.transform !== 'none' ||
      cs.filter !== 'none' ||
      cs.backdropFilter !== 'none' ||
      cs.contain !== 'none' ||
      cs.perspective !== 'none' ||
      (cs.willChange !== 'auto' && cs.willChange !== '')
    ) {
      const r = cur.getBoundingClientRect()
      return { x: r.left, y: r.top }
    }
    cur = cur.parentElement
  }
  return null
}
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

  /**
   * **永远吸附在原控件下方**（用户明确要求："吸附在原控件下方优先"）。
   *
   * 不再有"翻到上方"这条分支 —— 下拉的视线习惯是"从控件往下读"，翻上去会让菜单
   * 跳到视线上方、与触发它的控件断开。空间不足时**压缩菜单高度 + 内部滚动**，
   * 而不是换个方向；也**不遮盖锚点**（那是"夹进视口"的老做法，已废弃）。
   *
   * `maxHeight` 只在放不下时才写：放得下就保留 CSS 里的上限，免得把菜单压得比它本来的上限还矮。
   */
  let top = anchor.bottom + gap
  const below = vh - top - PAD
  if (below < h) {
    // 至少留 80px —— 比这更矮就连一行选项都看不见了，那时宁可贴底溢出
    el.style.maxHeight = Math.max(80, below) + 'px'
  }
  if (top > vh - PAD) top = vh - PAD
  /* 减去包含块偏移 —— 见 containingBlockOffset 的注释 */
  const block = containingBlockOffset(el)
  if (block) {
    left -= block.x
    top -= block.y
  }

  el.style.left = `${Math.round(left)}px`
  el.style.top = `${Math.round(top)}px`
}
