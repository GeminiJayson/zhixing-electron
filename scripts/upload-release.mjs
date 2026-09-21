/**
 * 把 dist/ 下的 Windows 安装包上传到 Gitee Release。
 *
 * 用法：
 *   node scripts/upload-release.mjs v0.1.0            # 预演，只列出将上传的文件
 *   node scripts/upload-release.mjs v0.1.0 --upload   # 真正创建 Release 并上传附件
 *
 * Token 来源优先级：--token=xxx > 环境变量 GITEE_TOKEN > git remote origin URL 里的凭据。
 * 默认预演，避免误操作；不加 --upload 不会碰任何远端数据。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(root, 'dist')

const args = process.argv.slice(2)
const tag = args.find((a) => !a.startsWith('--'))
const doUpload = args.includes('--upload')
const tokenArg = args.find((a) => a.startsWith('--token='))?.slice('--token='.length)

if (!tag) {
  console.error('用法: node scripts/upload-release.mjs <tag> [--upload] [--token=xxx]')
  process.exit(1)
}

/** 从 origin 的 remote URL 解析 owner/repo 与内嵌 token。 */
function parseRemote() {
  const url = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin']).toString().trim()
  const m = url.match(/^https:\/\/(?:([^:@/]+)(?::([^@/]+))?@)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!m) throw new Error('无法解析 origin: ' + url)
  return { user: m[1] || '', token: m[2] || '', host: m[3], owner: m[4], repo: m[5] }
}

const remote = parseRemote()
const token = tokenArg || process.env.GITEE_TOKEN || remote.token
if (!token) {
  console.error('✗ 没有可用的 Gitee token（--token / GITEE_TOKEN / git remote 里的凭据都没有）')
  process.exit(1)
}

if (!existsSync(distDir)) {
  console.error('✗ 找不到 dist/，请先运行 npm run dist:win')
  process.exit(1)
}

// 只挑安装包与免安装包，跳过 unpacked 目录、yml 清单与 blockmap
const assets = readdirSync(distDir)
  .filter((f) => /\.(exe|zip|7z)$/i.test(f))
  .map((f) => ({ name: f, path: join(distDir, f), size: statSync(join(distDir, f)).size }))

if (assets.length === 0) {
  console.error('✗ dist/ 下没有可上传的安装包（.exe/.zip/.7z）')
  process.exit(1)
}

console.log(`仓库: ${remote.owner}/${remote.repo}`)
console.log(`标签: ${tag}`)
console.log('待上传:')
for (const a of assets) console.log(`  - ${a.name}  (${(a.size / 1024 / 1024).toFixed(1)} MB)`)

if (!doUpload) {
  console.log('\n这是预演。加 --upload 才会真正创建 Release 并上传。')
  process.exit(0)
}

const api = `https://gitee.com/api/v5/repos/${remote.owner}/${remote.repo}`

/** 创建或复用 Release：重跑脚本时同一个 tag 必然已存在，不该整个流程失败。 */
async function ensureRelease() {
  const created = await fetch(`${api}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: token,
      tag_name: tag,
      name: `知行 ZhiXing ${tag}`,
      body: 'Electron 重构版 Windows 安装包（NSIS 安装版 + 免安装 portable）。',
      target_commitish: 'main',
    }),
  })
  if (created.ok) {
    const r = await created.json()
    console.log('已创建 Release:', r.id)
    return r
  }
  const existing = await fetch(`${api}/releases/tags/${tag}?access_token=${encodeURIComponent(token)}`)
  if (!existing.ok) {
    console.error('✗ 创建 Release 失败:', created.status, (await created.text()).slice(0, 300))
    process.exit(1)
  }
  const r = await existing.json()
  console.log('复用已有 Release:', r.id)
  return r
}

const release = await ensureRelease()

// 上传走 curl：Node 的 fetch 要把整个文件读进内存再发，87 MB 的包会撞 undici 的
// headers timeout（实测 UND_ERR_HEADERS_TIMEOUT，Release 建好了附件全丢）。
// curl 直接流式发文件；token 经 --config 的 stdin 传入，不出现在命令行里（ps 看不到）。
let failed = 0
for (const a of assets) {
  let ok = false
  let detail = ''
  try {
    const cfg = `form = "access_token=${token}"\nform = "file=@${a.path}"\n`
    const out = execFileSync('curl', ['-sS', '--config', '-', `${api}/releases/${release.id}/attach_files`], {
      input: cfg,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    })
    try {
      ok = Boolean(JSON.parse(out)?.id)
    } catch {
      ok = false
    }
    if (!ok) detail = out.slice(0, 200)
  } catch (err) {
    // curl 自己失败（网络 / 鉴权）会抛：不让它中断循环，剩下的附件还要试一遍
    detail = err instanceof Error ? err.message : String(err)
  }
  if (ok) {
    console.log(`✓ 已上传 ${a.name}`)
  } else {
    failed += 1
    console.error(`✗ 上传失败 ${a.name}: ${detail}`)
  }
}

/**
 * 失败必须让调用方看得见。
 *
 * 本文件开头那段注释就记着历史：「Release 建好了附件全丢」—— 而当时循环只打印结果、
 * 从不设退出码，调用方（与看日志的人）看到的仍是成功。发版这种一次性动作，静默失败最贵。
 */
if (failed) {
  console.error(`\n✗ ${failed} / ${assets.length} 个附件没上传成功，远端 Release 不完整`)
  process.exit(1)
}
console.log('\n完成。Release 页面：' + `https://gitee.com/${remote.owner}/${remote.repo}/releases/${tag}`)
