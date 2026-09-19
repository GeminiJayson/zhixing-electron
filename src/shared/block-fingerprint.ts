/**
 * 段落定位键（block_key）与「整理后重新找段落」的工具。
 *
 * 这套算法原本只活在渲染层的 MarkdownEditor 里，但 AI 整理会**重写正文**，
 * 而任务关联的段落锚（task_note_context.block_key）是靠段落文本的 sha1 指纹定位的 ——
 * 正文一变，指纹就全对不上了。主进程必须能算同样的指纹、并在新正文里重新找回那一段，
 * 所以把它提到 shared，两端共用同一份实现（与 Python 的 _block_fingerprint 逐字一致）。
 */

/** 纯 JS SHA-1（渲染进程不可用 node:crypto；与 Python hashlib.sha1 同算法）。 */
export function sha1Hex(input: string): string {
  const utf8 = Array.from(new TextEncoder().encode(input))
  const ml = utf8.length
  const withOne = utf8.concat(0x80)
  while (withOne.length % 64 !== 56) withOne.push(0)
  const hi = Math.floor((ml * 8) / 0x100000000)
  const lo = (ml * 8) >>> 0
  withOne.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff)
  withOne.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff)
  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const rol = (n: number, s: number): number => ((n << s) | (n >>> (32 - s))) >>> 0
  for (let i = 0; i < withOne.length; i += 64) {
    const w = new Array<number>(80)
    for (let j = 0; j < 16; j++) {
      w[j] =
        (withOne[i + j * 4] << 24) |
        (withOne[i + j * 4 + 1] << 16) |
        (withOne[i + j * 4 + 2] << 8) |
        withOne[i + j * 4 + 3]
    }
    for (let j = 16; j < 80; j++) w[j] = rol(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1)
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4]
    for (let j = 0; j < 80; j++) {
      let f: number
      let k: number
      if (j < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (j < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (j < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const tmp = (rol(a, 5) + (f >>> 0) + e + k + (w[j] >>> 0)) >>> 0
      e = d
      d = c
      c = rol(b, 30)
      b = a
      a = tmp
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }
  return [h0, h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, '0')).join('')
}

/** 指纹前的归一：空白折叠 + 去首尾 + 小写。 */
export function normalizeBlockText(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * 段落定位键（对齐 Python MarkdownEditor._block_fingerprint）：
 * 空白折叠 + 去首尾 + 小写后取 sha1 前 12 位，前缀 `fp:`。
 * 与 Python 共享同一张 task_note_context 表，键必须逐字一致才能互相定位。
 */
export function blockFingerprint(text: string, length = 12): string {
  const norm = normalizeBlockText(text)
  if (!norm) return ''
  return 'fp:' + sha1Hex(norm).slice(0, length)
}

/** 字符 bigram 的 Dice 系数：0 完全不同，1 完全相同。 */
function diceCoefficient(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) return 0.9
  const gram = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const ga = gram(a)
  const gb = gram(b)
  if (!ga.size || !gb.size) return 0
  let shared = 0
  let total = 0
  for (const [g, n] of ga) {
    total += n
    const other = gb.get(g)
    if (other) shared += Math.min(n, other)
  }
  for (const n of gb.values()) total += n
  return (2 * shared) / total
}

export interface LineMatch {
  /** 新正文里命中的那一行（原文） */
  line: string
  /** 行号（从 0 起） */
  index: number
  score: number
}

/**
 * 在新正文里找回「原来那一段」。优先精确命中（正文没被改动的部分），
 * 否则取相似度最高的一行；低于阈值一律算找不到 —— 宁可留着旧锚，
 * 也不能把它指到一段无关的文字上。
 */
export function findBestLine(content: string, snippet: string, threshold = 0.5): LineMatch | null {
  const target = normalizeBlockText((snippet ?? '').split('\n')[0])
  if (!target) return null
  const lines = (content ?? '').split('\n')
  let best: LineMatch | null = null
  for (let i = 0; i < lines.length; i++) {
    const norm = normalizeBlockText(lines[i])
    if (!norm) continue
    const score = norm === target ? 1 : diceCoefficient(norm, target)
    if (score < threshold) continue
    if (!best || score > best.score) {
      best = { line: lines[i], index: i, score }
      if (score === 1) break
    }
  }
  return best
}
