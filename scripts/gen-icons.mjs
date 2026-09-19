#!/usr/bin/env node
/**
 * 生成 src/renderer/src/lib/icons.tsx —— 应用图标统一入口。
 * 扫描 renderer 源码里从 lucide-react（或本入口自身）导入的图标名，为每个名字生成一个
 * 「与 lucide-react 同签名」的组件，底层渲染交给 morphicons 的 MorphIcon。
 * 新增用到的图标后重跑：npm run gen:icons
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rendererSrc = join(root, 'src', 'renderer', 'src')
const target = join(rendererSrc, 'lib', 'icons.tsx')

/** 从统一入口导入的非图标名（类型与能力，不是图标） */
const NOT_ICONS = new Set([
  'LucideIcon',
  'MorphIcon',
  'Morph',
  'IconData',
  'MorphIconProps',
  'MorphHandle',
  'IconNode',
  'ReducedMotionMode',
  'IconInput',
])

const files = []
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(ts|tsx)$/.test(e.name) && p !== target) files.push(p)
  }
}
walk(rendererSrc)

const names = new Set()
const importRe = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'(?:lucide-react|@renderer\/lib\/icons)'/g
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  // 形变场景走的是 IconData.X 属性访问，不在 import 里 —— 一并收集
  const dataRe = /IconData\.([A-Z]\w*)/g
  let d
  while ((d = dataRe.exec(src))) names.add(d[1])
  let m
  while ((m = importRe.exec(src))) {
    for (const raw of m[1].split(',')) {
      // 'Tag as TagIcon' → 取 lucide 的原始名（别名是业务侧自己的事，入口只导出原名）
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
      if (!name || NOT_ICONS.has(name)) continue
      names.add(name)
    }
  }
}
const list = [...names].sort()
const lucideImport = list.map((n) => '  ' + n + ' as N' + n + ',').join('\n')
const iconData = list.map((n) => '  ' + n + ': unpack(N' + n + '),').join('\n')
const components = list.map((n) => 'export const ' + n + ' = make(N' + n + ')').join('\n')

const out = `import type { ReactElement } from 'react'
import { MorphIcon, type MorphIconProps, type ReducedMotionMode } from 'morphicons/react'
import type { IconNode } from 'morphicons'
import {
${lucideImport}
} from 'lucide'

/**
 * 应用图标统一入口：**形状数据来自 lucide（数据包），渲染与形变交给 morphicons**。
 *
 * 为什么要这一层：
 * 1. lucide 主入口导出的是 [svg, attrs, children] 包装，而 morphicons 的输入契约是
 *    [tag, attrs][] 且只认 path / line / circle / ellipse / rect / polyline / polygon ——
 *    直接传会报 'morphicons: unsupported tag <svg>'（实测）。这里统一解包成 IconNode。
 * 2. 导出与 lucide-react **同签名**的组件，业务代码只换 import 源、不必改用法。
 * 3. 统一注入动效策略：应用关掉动效（html[data-motion='none']）时直接切换，否则跟随系统的
 *    「减少动态效果」。morphicons 默认是 never（无视系统设置），这里不用它的默认值。
 *
 * 想让图标在「同一位置换图标」时平滑形变，用 <Morph icon={IconData.A} /> 换成
 * icon={IconData.B}；受控形变用 <Morph from={..} to={..} progress={..} />。
 *
 * 本文件由 npm run gen:icons（scripts/gen-icons.mjs）生成，请勿手改图标清单。
 */

/** lucide 的图标是 [svg, attrs, children]；morphicons 要的是 children 那层（不解包会抛错） */
const unpack = (icon: unknown): IconNode => (icon as unknown[])[2] as IconNode

/** 动效策略：应用关闭动效 → 直接切换；否则尊重系统的「减少动态效果」 */
export const motionPolicy = (): ReducedMotionMode =>
  typeof document !== 'undefined' && document.documentElement.dataset.motion === 'none'
    ? 'always'
    : 'user'

/** 与 lucide-react 同签名（size / strokeWidth / absoluteStrokeWidth / color / className 直通 svg） */
export type LucideIcon = (props: MorphIconProps) => ReactElement

const make = (data: unknown): LucideIcon => {
  const node = unpack(data)
  return function Icon(props: MorphIconProps): ReactElement {
    return <MorphIcon icon={node} reducedMotion={motionPolicy()} {...props} />
  }
}

/**
 * 形变图标：同一位置换 icon 就带弹簧飞过去；也支持 from / to / progress 受控形变。
 * 用法同 MorphIcon，只是已按本应用的动效策略配置好。
 */
export function Morph(props: MorphIconProps): ReactElement {
  return <MorphIcon reducedMotion={motionPolicy()} {...props} />
}

/** 已解包的形状数据：形变的两端从这里取，不要再用 lucide 的原始导出 */
export const IconData = {
${iconData}
} satisfies Record<string, IconNode>

export { MorphIcon }
export type { MorphIconProps, MorphHandle, ReducedMotionMode } from 'morphicons/react'
export type { IconInput, IconNode } from 'morphicons'

${components}
`

writeFileSync(target, out)
console.log('已生成 ' + target)
console.log('图标 ' + list.length + ' 个：' + list.join(', '))
