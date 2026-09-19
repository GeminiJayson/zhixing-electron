/**
 * 控件高度一致性检查（静态）。
 *
 * 约定（docs/03 §2.7）：**输入类控件与按钮的高度只能来自 --control-h 家族**，
 * 不允许写死 px —— 写死的那一刻就与设置页「控件高度」分叉了，这正是本轮修掉的 bug。
 *
 * 本脚本只做静态扫描：找出「控件选择器」里出现的裸 px 高度。
 * 豁免清单是**行内尺度**（任务行内的勾选框 / 胶囊 / 动作按钮 / 重命名框）与
 * **独立尺度**（色板、多行文本域、浮动主操作），它们刻意不跟控件高度走。
 *
 * 用法：node scripts/ctlheightcheck.mjs     —— 退出码 0 表示无违规
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const styleDir = join(root, 'src', 'renderer', 'src', 'styles')

/** 控件选择器：高度必须用 var(--control-h) / var(--control-h-sm) */
const CONTROL = /(^|[\s.,>])(field|icon-btn|text-btn|seg|popmenu__item|palette__item|ntree__search|editor__title|kcol__add|palette__input)([\s:.,>[]|$)/
/** 豁免：行内尺度 / 独立尺度，理由见 docs/03 §2.7 */
const ALLOW = [
  ['.field--area', '多行文本域最小高度'],
  ['.trow__input', '任务行内重命名框（行内尺度）'],
  ['.trow__actions .icon-btn', '任务行内动作按钮（行内尺度）'],
  ['.chip', '标签胶囊（行内尺度）'],
  ['.check', '任务勾选框（行内尺度）'],
  ['.flag', '优先级旗标（行内尺度）'],
  ['.trow__caret', '折叠箭头（行内尺度）'],
  ['.swatch', '色板圆点（WCAG 24×24 固定）'],
  ['.ntree__search input', '去壳输入，高度由外层容器承担'],
]

const files = readdirSync(styleDir).filter((f) => f.endsWith('.css'))
const bad = []
for (const f of files) {
  const text = readFileSync(join(styleDir, f), 'utf8')
  // 逐字符按深度取「选择器 → 属性」，避免正则跨规则误配
  let i = 0, depth = 0, buf = '', prop = '', stack = []
  const lineOf = (p) => text.slice(0, p).split('\n').length
  while (i < text.length) {
    if (text.startsWith('/*', i)) {
      const e = text.indexOf('*/', i)
      i = e < 0 ? text.length : e + 2
      continue
    }
    const ch = text[i]
    if (ch === '{') { stack.push(buf.trim().split(/[{}]/).pop()); buf = ''; prop = ''; depth++; i++; continue }
    if (ch === '}') { stack.pop(); buf = ''; prop = ''; depth--; i++; continue }
    if (ch === ';') {
      if (depth > 0) {
        const m = /(^|\s)(min-height|height)\s*:\s*(.+)$/.exec(prop.replace(/\s+/g, ' ').trim())
        const sel = stack.filter((s) => !s.startsWith('@')).join(' ')
        // 只拦「写死的 px 数值」：100% / 0 / auto / calc(...var(...)) 都算跟随容器或设置
        if (m) {
          const hardcoded = /\d+px/.test(m[3]) && !/var\(/.test(m[3])
          if (hardcoded && CONTROL.test(sel) && !ALLOW.some(([s]) => sel.includes(s))) {
            bad.push(join(f) + ':' + lineOf(i - prop.length) + '  [' + stack.filter((s) => !s.startsWith('@')).join(' > ') + ']  ' + m[2] + ': ' + m[3].trim())
          }
        }
      }
      prop = ''; i++; continue
    }
    if (depth === 0) buf += ch; else prop += ch
    i++
  }
}

if (bad.length) {
  console.error('✗ 控件高度被写死（应改用 var(--control-h) / var(--control-h-sm)）：')
  for (const b of bad) console.error('   ' + b)
  console.error('  豁免尺度见 docs/03 §2.7；确属行内/独立尺度请加进本脚本的 ALLOW 并写明理由。')
  process.exit(1)
}
console.log('✓ 控件高度检查通过：' + files.length + ' 个样式文件里，控件选择器的高度全部来自 --control-h 家族')
