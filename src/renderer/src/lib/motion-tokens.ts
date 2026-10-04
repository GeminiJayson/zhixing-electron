/**
 * 读 CSS 时长令牌的毫秒数。
 *
 * 原先 RecycleBin / NotesPage / TodayPage / WorkflowPage 各写了一份逐字相同的实现 ——
 * 四份都写着「读不到按 0 处理 = 直接切换」，但没有人保证它们会一起改。
 *
 * 时长只认 `--dur-*`：**动效关闭或系统减动效时这些令牌本身就是 0ms**，
 * 所以「读不到按 0」与「降级到无动画」是同一个行为，不需要额外判断。
 */
export function readTokenMs(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name)
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : 0
}
