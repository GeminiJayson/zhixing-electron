/**
 * Windows 打包前置：确保 @node-rs/jieba 的 win32-x64 binding 已就位。
 *
 * 为什么需要：@node-rs 把各平台 binding 放在 optionalDependencies 里，npm 只安装
 * **当前平台**那一份。在 macOS 上打 Windows 包时，包里就缺 jieba.win32-x64-msvc.node，
 * Windows 启动会报「Cannot find native binding」并直接崩掉主进程。
 * 版本跟随 @node-rs/jieba 声明的 optionalDependencies，不写死。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const NAME = '@node-rs/jieba-win32-x64-msvc'
const target = join(root, 'node_modules', '@node-rs', 'jieba-win32-x64-msvc')
const binding = join(target, 'jieba.win32-x64-msvc.node')

if (existsSync(binding)) {
  console.log('[binding] win32-x64 已就位')
  process.exit(0)
}

const jiebaPkgPath = join(root, 'node_modules', '@node-rs', 'jieba', 'package.json')
if (!existsSync(jiebaPkgPath)) {
  console.error('[binding] 未找到 @node-rs/jieba，请先执行 npm install')
  process.exit(1)
}
const jiebaPkg = JSON.parse(readFileSync(jiebaPkgPath, 'utf-8'))
const version = jiebaPkg.optionalDependencies?.[NAME]
if (!version) {
  console.error('[binding] 无法从 @node-rs/jieba 解析 ' + NAME + ' 版本')
  process.exit(1)
}

console.log('[binding] 下载 ' + NAME + '@' + version)
// Windows 上 npm 是 npm.cmd：Node 18+（含本项目 Electron 33 附带的 Node 20）禁止
// 不带 shell 直接 spawn .cmd/.bat（EINVAL），因此在 Windows 上显式走 shell。
// 参数里没有空格等需要再转义的内容，shell 模式是安全的。
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const out = execFileSync(npmCmd, ['pack', NAME + '@' + version], {
  cwd: root,
  encoding: 'utf-8',
  shell: process.platform === 'win32',
})
const tgz = out.trim().split('\n').pop().trim()
mkdirSync(target, { recursive: true })
execFileSync('tar', ['-xzf', join(root, tgz), '-C', target, '--strip-components=1'])
rmSync(join(root, tgz), { force: true })
if (!existsSync(binding)) {
  console.error('[binding] 解压后仍未找到 ' + binding)
  process.exit(1)
}
console.log('[binding] 已放入 node_modules/@node-rs/jieba-win32-x64-msvc')
