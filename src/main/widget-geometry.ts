/**
 * 悬浮球与浮窗的几何计算。
 *
 * 从 main/index.ts 抽出来（那个文件 2459 行）。这一组全是**常量与纯计算** ——
 * 不碰窗口、不碰 electron —— 却因为和窗口代码挤在一起而没有单测。
 *
 * 搬运时把注释一并带过来了：里面解释的**为什么**（下限从哪来、某个值为什么必须固定）
 * 比数字本身重要，留在原处容易在下次改动时被当成无用注释删掉。
 */

/** 球体边长下限（88px 起表情才清晰）/ 上限 / 默认值 / 窗口四周留白 */
export const BALL_SIZE_MIN = 88
export const BALL_SIZE_MAX = 160
export const BALL_SIZE_DEFAULT = 96
export const BALL_MARGIN = 8

/** 贴边吸附阈值：球（或浮窗）边缘贴进工作区 8px 内即吸附 / 收成球 */
export const DOCK_EDGE = 8

/** 球体边长 → 窗口边长（四周留 BALL_MARGIN：放 hover 放大与投影） */
export const ballWindowPx = (size: number): number => size + BALL_MARGIN * 2

/**
 * 钳住球体边长：下限 88px，再小表情就看不清了。
 *
 * `size || BALL_SIZE_DEFAULT` 覆盖 0 与 NaN —— 这个值来自设置（可能被写坏），
 * 而它决定窗口尺寸：传进 setBounds 一个 NaN 会让窗口直接消失。
 */
export const clampBallSize = (size: number): number =>
  Math.round(Math.max(BALL_SIZE_MIN, Math.min(BALL_SIZE_MAX, size || BALL_SIZE_DEFAULT)))

/**
 * 球形态窗口的最小边长（按最小球体算）。
 *
 * **固定不变**：最小尺寸一变，平台会异步重排窗口（保持左上角），把紧随其后的
 * setBounds 位置参数盖掉 —— 症状就是「球变大了、位置却没动」。
 * 所以缩放时不去动最小尺寸。
 */
export const BALL_WIN_MIN = BALL_SIZE_MIN + BALL_MARGIN * 2
