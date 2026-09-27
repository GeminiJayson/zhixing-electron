#!/usr/bin/env node
/**
 * 生成应用图标资源。
 *
 * 产物：
 *   resources/icon.ico        打包进 exe / 快捷方式的那一份（Windows 的 exe 图标是静态资源，
 *                             只能在构建时定色，这里取默认的「青竹」）
 *   resources/icon-256.png    运行时窗口图标的兜底（渲染层还没把动态图标送过来时用）
 *   resources/theme-icons/app-<hex>.png    每个预设强调色一张窗口/任务栏图标（256px）
 *   resources/theme-icons/tray-<hex>.png   每个预设强调色一张托盘图标（32px，简化版）
 *
 * 为什么要为每个强调色预生成一份：Windows 的窗口图标与托盘图标都能在运行时 setIcon/setImage，
 * 但换色意味着**重新光栅化 SVG**——主进程里没有渲染器。两条路：运行时在渲染层用 canvas 画
 * （依赖主窗口活着），或者构建期把 8 个预设色都烘出来（主进程按当前 accent 直接选文件）。
 * 这里选后者：零运行时开销、主窗口关掉（只剩托盘）也照样正确。
 * 自定义强调色（设置页可以调色板之外的色）由主进程取**最接近的预设**兜底。
 *
 * 真源是 resources/icon.svg 与 resources/icon-tray.svg，用三个占位符表示
 * "随强调色变化的那一层"：{{ACCENT}} / {{ACCENT_LIGHT}} / {{ACCENT_DARK}}。
 *
 * 用法：npm run gen:app-icons
 */
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { Resvg } = require('@resvg/resvg-js')

const root = join(__dirname, '..')
const resources = join(root, 'resources')
const themeDir = join(resources, 'theme-icons')

/** 打包图标固定用默认强调色（青竹），与 shared/settings.ts 的 accent_color 默认值一致 */
const PACK_ACCENT = '#0D9488'
/** 与设置页的 8 个色板一致（SettingsPage 的 ACCENTS） */
const PRESET_ACCENTS = [
  '#0D9488',
  '#2563EB',
  '#7C3AED',
  '#DB2777',
  '#EA580C',
  '#16A34A',
  '#D97706',
  '#0891B2',
]

const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)))
const parseHex = (hex) => {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
const toHex = (rgb) => '#' + rgb.map((v) => clamp(v).toString(16).padStart(2, '0')).join('')

/** 朝白或黑混一档，给强调色做渐变两端（只改明度，不动色相） */
function mix(hex, target, amount) {
  const a = parseHex(hex)
  const b = parseHex(target)
  return toHex(a.map((v, i) => v + (b[i] - v) * amount))
}

function applyAccent(svg, accent) {
  return svg
    .replaceAll('{{ACCENT_LIGHT}}', mix(accent, '#ffffff', 0.34))
    .replaceAll('{{ACCENT_DARK}}', mix(accent, '#000000', 0.3))
    .replaceAll('{{ACCENT}}', accent)
}

/** SVG → 指定宽度的 PNG（透明底） */
function renderPng(svg, size) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  })
  return Buffer.from(resvg.render().asPng())
}

/**
 * 手写 ICO 容器：ICONDIR + n × ICONDIRENTRY + 各尺寸 PNG 数据。
 * Vista 之后 ICO 允许直接内嵌 PNG（不必再转 BMP + AND 掩码），所以这里只是拼字节。
 */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  let offset = 6 + entries.length * 16
  const dir = []
  for (const { size, buf } of entries) {
    const e = Buffer.alloc(16)
    // 256 在这一栏要写 0（8 位放不下）
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2) // 调色板数量
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // color planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(buf.length, 8)
    e.writeUInt32LE(offset, 12)
    dir.push(e)
    offset += buf.length
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.buf)])
}

mkdirSync(themeDir, { recursive: true })

// ---- 1. 打包图标（默认色，多尺寸 ICO）----
const appSvgSrc = readFileSync(join(resources, 'icon.svg'), 'utf8')
const packSvg = applyAccent(appSvgSrc, PACK_ACCENT)
const sizes = [16, 24, 32, 48, 64, 128, 256]
const entries = sizes.map((size) => ({ size, buf: renderPng(packSvg, size) }))
writeFileSync(join(resources, 'icon.ico'), buildIco(entries))
writeFileSync(join(resources, 'icon-256.png'), entries[entries.length - 1].buf)
console.log('✓ resources/icon.ico（' + sizes.join('/') + '）')
console.log('✓ resources/icon-256.png')

// ---- 2. 每个预设强调色一份窗口图标与托盘图标 ----
const traySvgSrc = readFileSync(join(resources, 'icon-tray.svg'), 'utf8')
for (const accent of PRESET_ACCENTS) {
  const key = accent.replace('#', '').toLowerCase()
  writeFileSync(join(themeDir, 'app-' + key + '.png'), renderPng(applyAccent(appSvgSrc, accent), 256))
  writeFileSync(join(themeDir, 'tray-' + key + '.png'), renderPng(applyAccent(traySvgSrc, accent), 32))
}
console.log('✓ resources/theme-icons/（' + PRESET_ACCENTS.length + ' 个强调色 × 2 形态）')
