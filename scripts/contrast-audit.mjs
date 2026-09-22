/**
 * 主题包对比度实测（WCAG 2.1 相对亮度，非估算）。
 *
 * 主题包需要可访问性下限（accent 明暗派生、fg2 ≥4.5、fg3 ≥4.0），
 * 这里逐套独立核对是否满足。
 *
 * 用法：node scripts/contrast-audit.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'src/shared/theme-packs.ts'), 'utf-8')

const srgb = (v) => {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const lum = (hex) => {
  const m = hex.trim().replace('#', '')
  return (
    0.2126 * srgb(parseInt(m.slice(0, 2), 16)) +
    0.7152 * srgb(parseInt(m.slice(2, 4), 16)) +
    0.0722 * srgb(parseInt(m.slice(4, 6), 16))
  )
}
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** theme-packs.ts 是「'包名': {」一行 + light 一行 + dark 一行的结构。 */
function parse(text) {
  const hexes = (body) =>
    Object.fromEntries([...body.matchAll(/(\w+):\s*'(#[0-9A-Fa-f]{6})'/g)].map((m) => [m[1], m[2]]))
  const packs = []
  let cur = null
  for (const line of text.split('\n')) {
    const idm = line.match(/^\s*'([^']+)':\s*\{/)
    if (idm) {
      cur = { id: idm[1], light: null, dark: null }
      packs.push(cur)
      continue
    }
    if (!cur) continue
    const lm = line.match(/light:\s*\{([^}]*)\}/)
    if (lm) {
      cur.light = hexes(lm[1])
      continue
    }
    const dm = line.match(/dark:\s*\{([^}]*)\}/)
    if (dm) cur.dark = hexes(dm[1])
  }
  return packs.filter((p) => p.light && p.dark)
}

const packs = parse(src)
if (!packs.length) {
  console.error('✗ 没能从 theme-packs.ts 解析出主题包')
  process.exit(1)
}

// 对比度下限：正文/次要 4.5:1（AA），辅助文字放宽到 4.0:1
const RULES = [
  { fg: 'fg', bgs: ['canvas', 'layer'], min: 4.5, label: '正文' },
  { fg: 'fg2', bgs: ['canvas', 'layer'], min: 4.5, label: '次要文字' },
  { fg: 'fg3', bgs: ['canvas', 'layer'], min: 4.0, label: '辅助文字' },
]

const fails = []
let checked = 0
for (const p of packs) {
  for (const mode of ['light', 'dark']) {
    const t = p[mode]
    for (const rule of RULES) {
      if (!t[rule.fg]) continue
      for (const bg of rule.bgs) {
        if (!t[bg]) continue
        checked++
        const r = ratio(t[rule.fg], t[bg])
        if (r < rule.min) {
          fails.push({
            pack: p.id,
            mode,
            role: rule.label,
            fg: t[rule.fg],
            bg: t[bg],
            ratio: r,
            min: rule.min,
          })
        }
      }
    }
  }
}

console.log(`主题包 ${packs.length} 个 · 实测 ${checked} 组前景/背景`)
console.log('')
if (!fails.length) {
  console.log('✓ 全部达标')
} else {
  const byRole = {}
  for (const f of fails) byRole[f.role] = (byRole[f.role] ?? 0) + 1
  for (const f of fails.sort((a, b) => a.ratio - b.ratio)) {
    console.log(
      `✗ ${f.pack} [${f.mode}] ${f.role} ${f.fg} on ${f.bg} = ${f.ratio.toFixed(2)}:1（需 ${f.min}）`
    )
  }
  console.log('')
  console.log(
    `不达标 ${fails.length} / ${checked} 组：` +
      Object.entries(byRole)
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ')
  )
  console.log('')
  console.log(
    '注：这些是主题包里的原始值。applyTheme 会用 src/shared/color.ts 的 ensureTextContrast\n' +
      '    在运行时校正到下限（正文/次要 4.5、辅助 4.0），校正结果的断言在 color.test.ts。'
  )
}
// 这是体检工具：原始数据不达标是已知且有意保留的（校正发生在运行时），不该让调用方以为失败
process.exit(0)
