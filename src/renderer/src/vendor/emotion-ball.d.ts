/**
 * Emotion Ball 上游是「零依赖全局脚本」形态（不参与 TS 检查、无类型声明）。
 * 这里只补两件事：
 *   1. 让四个 .js 的动态 import 通过 TS 解析（本项目 allowJs 未开启）；
 *   2. 给 window.EmotionBall 一个最小可用的类型面（只列我们实际调用的方法）。
 * 源码按原始文件引进，见 vendor/emotion-ball/UPSTREAM.md。
 */
declare module '*.js'

interface EmotionBallOptions {
  /** 初始表情 ID（两位字符串，如 '02'） */
  emotion?: string
  /** 体型：blob 圆胖 / wedge 三角 / gem 菱形 */
  shape?: 'blob' | 'wedge' | 'gem'
  /** 主题体色覆盖（会盖掉表情自带的情绪色，故本处不传） */
  color?: string
  eyeColor?: string
  /** 眼睛放大倍率，小于 80px 的实例建议 1.5~1.8 */
  eyeScale?: number
  /** 待机行为；true 会启用 60s 待机 / 180s 睡眠的引擎内节拍 */
  idle?: boolean | Record<string, unknown>
  /** false 时只渲染静态帧，不进 rAF 循环 */
  autostart?: boolean
  /** 精简模式：关闭彩带 / 彩纸特效 */
  lite?: boolean
  /** 未知 ID 的回退表情，默认 '02' */
  fallbackId?: string
}

interface EmotionBallInstance {
  setEmotion(id: string, options?: { auto?: boolean }): void
  /** 归一化目光 [-1,1]；引擎内部做球面投影与平滑 */
  setGaze(nx: number, ny: number): void
  setStyle(style: Record<string, unknown>): void
  /** 视口外停帧省电 */
  setActive(active: boolean): void
  renderStatic(): void
  spin(turns?: number): void
  burst(count?: number): void
  bounce(): void
  handleAIMessage(message: string | Record<string, unknown>): void
  on(event: 'change' | 'tips' | 'error', handler: (payload: unknown) => void): void
  destroy(): void
}

interface EmotionBallSdk {
  create(target: Element | string, options?: EmotionBallOptions): EmotionBallInstance
  config: {
    exportConfig(): unknown
    importConfig(raw: unknown): unknown
  }
}

interface Window {
  EmotionBall: EmotionBallSdk
}
