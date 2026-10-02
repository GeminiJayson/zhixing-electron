import { randomInt } from 'node:crypto'

/**
 * 密码生成器。
 *
 * 用 `crypto.randomInt` 而不是 `Math.random` —— 后者是可预测的伪随机，
 * 拿来生成密码等于没有密码。
 *
 * 采样方式：先把候选字符集按类别分组各取一个（保证每类至少出现一次），
 * 再补齐剩余长度，最后整体洗牌 —— 避免"前四位必定是大写字母"这种可预测的形态。
 */

export interface GenerateOptions {
  length: number
  upper: boolean
  lower: boolean
  digits: boolean
  symbols: boolean
}

export const GENERATE_DEFAULTS: GenerateOptions = {
  length: 20,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
}

const SETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  /**
   * 符号集**刻意去掉了容易看错的几个**（引号、反斜杠、尖括号、空格）——
   * 密码要被手抄、被念出来、被粘进各种不兼容的输入框，可读性也是可用性。
   */
  symbols: '!@#$%^&*()-_=+[]{}:,.?',
} as const

export const LENGTH_MIN = 8
export const LENGTH_MAX = 64

function pick(chars: string): string {
  return chars[randomInt(chars.length)]
}

export function generatePassword(opts: Partial<GenerateOptions> = {}): string {
  const o = { ...GENERATE_DEFAULTS, ...opts }
  const length = Math.min(LENGTH_MAX, Math.max(LENGTH_MIN, Math.floor(o.length) || LENGTH_MIN))

  const groups: string[] = []
  if (o.upper) groups.push(SETS.upper)
  if (o.lower) groups.push(SETS.lower)
  if (o.digits) groups.push(SETS.digits)
  if (o.symbols) groups.push(SETS.symbols)

  // 一个字符集都没选：退回小写字母，而不是返回空串或抛错
  if (groups.length === 0) groups.push(SETS.lower)

  const pool = groups.join('')
  const out: string[] = []
  // 每类先来一个，保证"选了数字就一定有数字"
  for (const g of groups) {
    if (out.length < length) out.push(pick(g))
  }
  while (out.length < length) out.push(pick(pool))

  // Fisher–Yates 洗牌，抹掉"按类别分组"留下的位置规律
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out.join('')
}

export interface StrengthHint {
  /** 0–4，与常见密码强度条的档位一致 */
  score: number
  label: string
}

/**
 * 强度提示。**纯本地计算，不联网**（见方案 §10.8）。
 *
 * 用字符集大小估算熵（log2(poolSize) * length），分档阈值参考常见做法：
 * 40 / 60 / 80 / 100 比特。这不是精确的密码学度量（"Password123!" 的熵
 * 按这个算法会被高估），但对"提示用户换个更长的"这个目的是够用的 ——
 * 真要精确就得引入字典，那与"不联网"冲突。
 */
export function strengthOf(password: string): StrengthHint {
  if (!password) return { score: 0, label: '空' }
  let pool = 0
  if (/[a-z]/.test(password)) pool += 26
  if (/[A-Z]/.test(password)) pool += 26
  if (/[0-9]/.test(password)) pool += 10
  if (/[^A-Za-z0-9]/.test(password)) pool += 24
  const bits = Math.log2(Math.max(pool, 2)) * password.length
  if (bits < 40) return { score: 1, label: '弱' }
  if (bits < 60) return { score: 2, label: '中' }
  if (bits < 80) return { score: 3, label: '强' }
  return { score: 4, label: '很强' }
}
