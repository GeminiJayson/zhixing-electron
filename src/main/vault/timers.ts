/**
 * 保险箱两个定时行为的**判据**（纯函数，与 electron 无关）。
 *
 * 从 ipc.ts 抽出来 —— 那里直接调 `clipboard` / `setInterval`，跑不了单测，
 * 于是这两条规则一直只有"端到端验过"，没有测试守着。而它们恰恰是最该被守住的：
 *
 *   · 剪贴板：**只在内容仍是我们写进去的那个值时才清**。否则用户在这 30 秒里
 *     复制了别的东西，会被我们误删 —— KeePass / Bitwarden 都是这个逻辑。
 *   · 自动锁定：0 分钟表示"从不"；只对已解锁状态生效；按**空闲时长**判断。
 *
 * 抽成纯函数后，两条规则都有了对应用例。
 */

/** 剪贴板到点后是否该清除：**只有当前内容仍等于我们写进去的值**才清。 */
export function shouldClearClipboard(current: string, written: string): boolean {
  return current === written
}

/**
 * 自动锁定的判据。minutes <= 0 表示"从不"。
 *
 * status 收三种：uninitialized（还没建过库）、locked、unlocked ——
 * 只有 unlocked 才谈得上"该锁了"。
 */
export function shouldAutoLock(
  minutes: number,
  status: 'uninitialized' | 'locked' | 'unlocked',
  idleMs: number
): boolean {
  if (minutes <= 0) return false
  if (status !== 'unlocked') return false
  return idleMs >= minutes * 60_000
}
