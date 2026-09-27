#!/usr/bin/env node
/**
 * 一条命令发版：构建 → 打包 → 源码归档 → 对齐标签 → 更新 GitHub Release → 校验。
 *
 * 为什么要有这个脚本：上一次发版时，**v1.0.0 标签停在旧提交**，导致 Release 页面上
 * 自动生成的源码归档是旧代码，而两个 exe 是新代码 —— 下载源码的人拿到的功能和安装包对不上。
 * 所以脚本把两个校验点写成硬性前置/后置检查：
 *   1) 开始时工作树必须是干净的（拒绝带着未提交改动发版）；
 *   2) 结束时必须核对 Release 的 targetCommitish 与 HEAD 一致，否则非零退出。
 *
 * 用法：
 *   node scripts/release.mjs              完整发版
 *   node scripts/release.mjs --dry-run    只检查与打印计划，不做任何写操作
 *   node scripts/release.mjs --skip-build 跳过构建打包（只重做源码归档与 Release）
 *   node scripts/release.mjs --no-push    不推送标签（本地演练）
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 受限执行环境（例如 DSH 沙箱）的 PATH 里可能连 C:\\Windows\\System32 都没有，
 * 而打包链里的 electron-builder 要用 powershell.exe 收集 node 模块，
 * 缺了它会在 packaging 阶段报 `spawn powershell.exe ENOENT`。这里只做**补齐**，
 * 不重排已有项 —— 与 scripts/*check.mjs 里补 SYS_PATH 同一套路。
 */
if (process.platform === 'win32') {
  const systemDirs = [
    'C:\\Windows\\System32',
    'C:\\Windows',
    'C:\\Windows\\System32\\Wbem',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
  ]
  const parts = (process.env.PATH ?? '').split(';').filter(Boolean)
  const lower = parts.map((p) => p.toLowerCase())
  const missing = systemDirs.filter((d) => !lower.includes(d.toLowerCase()))
  if (missing.length) process.env.PATH = [...parts, ...missing].join(';')
}

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const SKIP_BUILD = args.includes('--skip-build')
const NO_PUSH = args.includes('--no-push')

const log = (msg) => console.log(msg)
const step = (msg) => console.log('\n▶ ' + msg)
const fail = (msg) => {
  console.error('\n✗ ' + msg)
  process.exit(1)
}

function run(bin, argv, opts = {}) {
  return execFileSync(bin, argv, {
    cwd: root,
    encoding: 'utf8',
    shell: opts.shell === true,
    stdio: opts.quiet ? 'pipe' : 'inherit',
  })
}
/**
 * 直接用本地依赖的入口 JS 跑，而不是 `npx xxx`。
 *
 * 两个理由，第二个才是决定性的：
 * 1. npx 在 Windows 上是 .cmd，Node ≥20 不经 shell 拒绝 spawn（`spawnSync npx.cmd EINVAL`），
 *    所以必须开 shell —— 而一旦经 cmd，中文参数又要跟代码页打交道；
 * 2. 受限环境里（PATH 上没有 node，脚本只能借 Electron 的 Node 模式跑），
 *    npx.cmd 内部再 spawn `node` 时找不到真实 node.exe，直接失败。
 * 用 process.execPath 跑入口文件在「正常 node」与「Electron 的 Node 模式」下都成立。
 */
function runBin(relPath, argv) {
  return run(process.execPath, [join(root, 'node_modules', relPath), ...argv])
}
function capture(bin, argv) {
  // stderr 必须自吞：查「标签还不存在」时 git rev-parse 会往 stderr 写 fatal，
  // 直接继承会在发版过程里刷一屏误导性的红字
  return execFileSync(bin, argv, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
function tryCapture(bin, argv) {
  try {
    return capture(bin, argv)
  } catch {
    return ''
  }
}
function exists(bin, argv) {
  try {
    execFileSync(bin, argv, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// ---------- 0. 基本环境
const gh =
  (process.platform === 'win32'
    ? ['gh', 'C:\\Program Files\\GitHub CLI\\gh.exe', 'C:\\Program Files (x86)\\GitHub CLI\\gh.exe']
    : ['gh', '/usr/local/bin/gh', '/opt/homebrew/bin/gh']
  ).find((c) => exists(c, ['--version']))
if (!gh) fail('找不到 gh CLI：请先安装 GitHub CLI 并登录（gh auth login）')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = String(pkg.version)
const tag = 'v' + version
const head = capture('git', ['rev-parse', 'HEAD'])
const short = head.slice(0, 7)
log('知行 ZhiXing 发版脚本');
log('  版本      ' + version)
log('  标签      ' + tag)
log('  HEAD      ' + short)
log('  模式      ' + (DRY ? 'dry-run（不做写操作）' : SKIP_BUILD ? 'skip-build' : '完整发版'))

// ---------- 1. 前置校验：工作树必须干净
step('检查工作树')
const dirty = tryCapture('git', ['status', '--porcelain'])
if (dirty) {
  log(dirty)
  fail('工作树有未提交改动 —— 先提交或 stash，再发版（避免发出的源码与安装包不一致）')
}
log('  ✓ 干净')

// ---------- 2. 版本 vs 已有标签
step('检查标签指向')
const tagCommit = tryCapture('git', ['rev-parse', tag + '^{commit}'])
const behind = tagCommit ? Number(tryCapture('git', ['rev-list', '--count', tag + '..HEAD']) || '0') : 0
if (!tagCommit) {
  log('  ' + tag + ' 还不存在，将新建')
} else if (tagCommit === head) {
  log('  ✓ ' + tag + ' 已指向 HEAD')
} else {
  log('  ! ' + tag + ' 指向 ' + tagCommit.slice(0, 7) + '，落后 HEAD ' + behind + ' 个提交')
  log('    这会让 Release 的源码归档变成旧代码 —— 本次会把它移到 HEAD')
}

// ---------- 3. 构建 + 打包
const distDir = join(root, 'dist')
const fullDir = join(root, 'dist-full')
const assets = [
  join(distDir, 'Zhixing-' + version + '-x64-setup.exe'),
  join(distDir, 'Zhixing-' + version + '-x64-portable.exe'),
]
const sourceZip = join(distDir, 'Zhixing-' + version + '-source.zip')

if (SKIP_BUILD) {
  step('跳过构建与打包（--skip-build）')
} else if (DRY) {
  step('将会构建与打包')
  log('  electron-vite build')
  log('  electron-builder --win --x64 --config.directories.output=dist-full')
  log('  然后把两个 exe 复制到 dist/')
} else {
  step('构建与打包')
  // 用 process.execPath，而不是裸名 'node'：
  // 受限环境里（本机 PATH 里没有 node，脚本只能借 Electron 的 Node 模式跑）
  // execFileSync 不带 shell 时**不会解析 .cmd 包装**，裸名必然 spawnSync ENOENT；
  // 而正常的 node 环境下 process.execPath 就是 node.exe —— 两种环境都对。
  run(process.execPath, ['scripts/ensure-jieba-win-binding.mjs'])
  runBin(join('electron-vite', 'bin', 'electron-vite.js'), ['build'])
  runBin(join('electron-builder', 'cli.js'), [
    '--win',
    '--x64',
    '--config.directories.output=dist-full',
  ])
  mkdirSync(distDir, { recursive: true })
  // 直接用 fs 复制，别再绕 `node -e`：那串表达式里有空格，经 shell 会被拆成多个参数
  for (const asset of assets) copyFileSync(join(fullDir, basename(asset)), asset)
  log('  ✓ 两个安装包已就位')
}

// ---------- 4. 源码归档
step('生成源码归档')
if (DRY) {
  log('  git archive HEAD → dist/Zhixing-' + version + '-source.zip')
} else {
  mkdirSync(distDir, { recursive: true })
  run('git', ['archive', '--format=zip', '--prefix=zhixing-electron-' + version + '/', '-o', sourceZip, 'HEAD'])
  log('  ✓ ' + sourceZip.slice(root.length + 1) + '（' + Math.round(statSync(sourceZip).size / 1024) + ' KB）')
}

if (DRY) {
  log('\n（dry-run 结束：未做任何写操作）')
  process.exit(0)
}

// ---------- 5. 对齐标签并推送
step('对齐标签')
run('git', ['tag', '-f', tag, head])
if (NO_PUSH) {
  log('  ✓ 本地标签已更新（--no-push，未推送）')
} else {
  run('git', ['push', '-f', 'origin', tag])
  log('  ✓ 已推送 ' + tag + ' → ' + short)
}

// ---------- 6. 更新 GitHub Release
step('更新 GitHub Release')
const notesFile = join(root, 'docs', 'release-notes-' + tag + '.md')
const existsRelease = tryCapture(gh, ['release', 'view', tag, '--json', 'tagName', '--jq', '.tagName']) !== ''
const notesArgs = existsSync(notesFile) ? ['--notes-file', notesFile] : ['--notes', '知行 ZhiXing ' + version]
if (existsRelease) {
  run(gh, ['release', 'edit', tag, '--target', head, '--title', '知行 ZhiXing ' + version])
  log('  ✓ 已更新 Release 的 target')
} else {
  run(gh, ['release', 'create', tag, '--target', head, '--title', '知行 ZhiXing ' + version, ...notesArgs])
  log('  ✓ 已创建 Release')
}

step('上传资产')
for (const file of [...assets, sourceZip]) {
  if (!existsSync(file)) fail('缺少资产文件：' + file)
  run(gh, ['release', 'upload', tag, file, '--clobber'])
  log('  ✓ ' + file.slice(root.length + 1))
}

// ---------- 7. 后置校验：Release 的 target 必须等于 HEAD
step('校验')
const target = tryCapture(gh, ['release', 'view', tag, '--json', 'targetCommitish', '--jq', '.targetCommitish'])
const remoteAssets = tryCapture(gh, ['release', 'view', tag, '--json', 'assets', '--jq', '.assets[].name'])
log('  Release target: ' + target.slice(0, 7) + (target === head ? ' ✓ 与 HEAD 一致' : ' ✗ 与 HEAD 不一致'))
log('  远端资产:')
for (const line of remoteAssets.split('\n')) if (line.trim()) log('    - ' + line.trim())

if (target !== head) {
  fail('Release 的 targetCommitish 与 HEAD 不一致 —— 源码归档会是旧代码，请检查标签是否推送成功')
}
const missing = ['Zhixing-' + version + '-source.zip', 'Zhixing-' + version + '-x64-setup.exe', 'Zhixing-' + version + '-x64-portable.exe'].filter(
  (n) => !remoteAssets.includes(n)
)
if (missing.length) fail('Release 上缺少资产：' + missing.join('、'))

log('\n✅ 发版完成：' + 'https://github.com/' + capture('git', ['remote', 'get-url', 'origin']).replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '') + '/releases/tag/' + tag)
