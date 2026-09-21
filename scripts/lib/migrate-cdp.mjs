/**
 * 把老脚本的内联 CDP 样板换成 scripts/lib/cdp.mjs 的迁移器。
 *
 * 用法：
 *   node scripts/lib/migrate-cdp.mjs --self-test      # 只跑扫描器自检
 *   node scripts/lib/migrate-cdp.mjs <脚本名…>        # 迁移（覆盖原文，先确认 git 干净）
 *
 * 为什么留成脚本而不是每次临时写：迁移里有四件反复踩的事，散在一次性的程序里就每次重踩：
 *
 *   1. **块边界要按行判断，且字符串/注释感知**。数括号会被字符串里的花括号带偏；
 *      纯行内判断又会被 () => { 里的 ) 骗到（深度提前归零）。所以：逐行累计深度，
 *      只在行边界判归零，行内的引号 / 模板 / 注释一律跳过。
 *   2. **保留下来的声明要按原顺序插回**。AI_BASE 引用 AI_PORT，按发现顺序插就是
 *      Cannot access before initialization。
 *   3. **引用分析要迭代到不动点**：被保留的声明自己还会引用别的声明。
 *   4. **语句也要保留，但只保留顶格的**。server.listen(...) 是语句不是声明，丢了假服务
 *      就起不来；缩进语句在某个函数体内部，搬到顶层会把结构拆坏。
 *
 * 迁移完必须真跑一遍那个脚本，并与迁移前的基线对照（见 docs/audit 里的基线表）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 一律不带过来的名字：lib 已负责，或本来就是脚本自己的一次性脚手架
const BOILER = new Set([
  'require', 'electronPath', 'root', 'repoRoot', 'tmpHome', 'profile', 'PORT', 'SYS_PATH',
  'child', 'list', 'listTargets', 'targets', 'connect', 'attach', 'main', 'conn', 'host',
  'page', 'ws', 'send', 'evaluate', 'ev', 'results', 'check', 'J', 'seedDb', 'liveDb',
  'backup', 'ROOT'
])

/** 扫一行，返回净深度；state 携带跨行的模板串与块注释状态。 */
export function scanLine(text, from, to, state) {
  let depth = 0
  let j = from
  while (j < to) {
    const c = text[j]
    if (state.block) {
      if (c === '*' && text[j + 1] === '/') { state.block = false; j += 2; continue }
      j++
      continue
    }
    if (state.tpl) {
      if (c === '\\') { j += 2; continue }
      if (c === '\u0060') { state.tpl = false; j++; continue }
      if (c === '$' && text[j + 1] === '{') {
        j += 2
        let d = 1
        while (j < to && d > 0) {
          if (text[j] === '{') d++
          else if (text[j] === '}') d--
          j++
        }
        continue
      }
      j++
      continue
    }
    if (c === '/' && text[j + 1] === '/') break
    if (c === '/' && text[j + 1] === '*') { state.block = true; j += 2; continue }
    if (c === "'" || c === '"') {
      const q = c
      j++
      while (j < to) {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === q) { j++; break }
        j++
      }
      continue
    }
    if (c === '\u0060') { state.tpl = true; j++; continue }
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') depth--
    j++
  }
  return depth
}

/** 从 startOffset 起，这条声明/语句占多少行。 */
export function declLineCount(text, startOffset) {
  const state = { tpl: false, block: false }
  let i = startOffset
  let total = 0
  let depth = 0
  while (i < text.length) {
    const nl = text.indexOf('\n', i)
    const to = nl < 0 ? text.length : nl
    depth += scanLine(text, i, to, state)
    total++
    if (depth <= 0) break
    if (nl < 0) break
    i = nl + 1
  }
  return total
}

/** conn./page./host. 一律改成 app.；裸的 evaluate/ev/send 调用也改到 app 上。 */
export function renameRefs(text) {
  let t = text
  for (const v of ['conn', 'page', 'host']) {
    t = t.replace(new RegExp('(?<![.\\w$])' + v + '\\.', 'g'), 'app.')
  }
  for (const v of ['evaluate', 'ev', 'send']) {
    t = t.replace(new RegExp('(?<![.\\w$])' + v + '\\(', 'g'), 'app.' + (v === 'ev' ? 'evaluate' : v) + '(')
  }
  return t
}

export function migrateSource(lines) {
  const text = lines.join('\n')
  const offs = []
  let o = 0
  for (const l of lines) { offs.push(o); o += l.length + 1 }
  const nAt = (i) => declLineCount(text, offs[i])
  const find = (re, from = 0) => {
    for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i
    return -1
  }
  const iImport = find(/^import \{.*\bspawn\b.*\} from 'node:child_process'/)
  const iAnchor = find(/^const results = \[\]/)
  const iFailed = find(/^const failed/)
  if (iImport < 0 || iAnchor < 0 || iFailed < 0) return { skip: '锚点不齐' }

  const keptImports = lines.slice(iImport, iAnchor).filter((l) => /^import /.test(l) && !/node:timers\/promises/.test(l))
  let iBody = iAnchor
  for (;;) {
    const l = lines[iBody]
    if (l === undefined) break
    if (/^const (results = \[\]|check = |J = )/.test(l)) { iBody += nAt(iBody); continue }
    if (l.trim() === '') { iBody++; continue }
    break
  }
  const bodyText = lines.slice(iBody, iFailed - 1).join('\n')
  const tailLines = lines.slice(iFailed - 1).filter(
    (l) => l.trim() !== '' && !/^(const failed|console\.log\(|process\.exit|rmSync\()/.test(l.trim())
  )

  const keptIdx = new Set()
  const stmtIdx = new Set()
  let refText = [bodyText, ...tailLines].join('\n')
  const declNames = () =>
    [...keptIdx]
      .map((i) => (lines[i].match(/^(?:const|let|var|async function|function)\s+([A-Za-z_$][\w$]*)/) || [])[1])
      .filter(Boolean)

  for (let round = 0; round < 6; round++) {
    let added = 0
    for (let i = iImport; i < iAnchor; i++) {
      const m = /^(?:const|let|var|async function|function)\s+([A-Za-z_$][\w$]*)/.exec(lines[i])
      if (!m || BOILER.has(m[1]) || keptIdx.has(i)) continue
      if (!new RegExp('(?<![.\\w$])' + m[1] + '(?![\\w$])').test(refText)) continue
      const n = nAt(i)
      const block = lines.slice(i, i + n)
      if (/\/json\/list/.test(block.join('\n'))) continue
      keptIdx.add(i)
      refText += '\n' + block.join('\n')
      added++
    }
    const names = declNames()
    for (let i = iImport; i < iAnchor; i++) {
      if (keptIdx.has(i) || stmtIdx.has(i)) continue
      if (/^\s/.test(lines[i])) continue
      if (/^import |^(const|let|var|async function|function)\s/.test(lines[i])) continue
      if (!names.some((nm) => new RegExp('(?<![.\\w$])' + nm + '(?![\\w$])').test(lines[i]))) continue
      if (/rmSync|mkdirSync|copyFileSync|spawn\(/.test(lines[i])) continue
      const n = nAt(i)
      stmtIdx.add(i)
      refText += '\n' + lines.slice(i, i + n).join('\n')
      added++
    }
    if (!added) break
  }

  const allSort = [...new Set([...keptIdx, ...stmtIdx])].sort((a, b) => a - b)
  const preserved = allSort.flatMap((i) => lines.slice(i, i + nAt(i)))
  const port = lines.find((l) => /^const PORT = /.test(l)).match(/(\d+)/)[1]
  const home = lines
    .find((l) => /^const (tmpHome|profile) = /.test(l))
    .match(/'([^']+)'/g)
    .pop()
    .replace(/'/g, '')

  let out = [
    ...lines.slice(0, iImport),
    ...keptImports,
    "import { ROOT, launchApp, createChecker, J, sleep } from './lib/cdp.mjs'",
    '',
    'const root = ROOT',
    'const require = createRequire(import.meta.url)',
    "const tmpHome = join(ROOT, '.screenshots', '" + home + "')",
    'const PORT = ' + port,
    renameRefs(preserved.join('\n')),
    '',
    'const app = await launchApp({ port: PORT, home: tmpHome })',
    'const { check, finish, results } = createChecker()',
    renameRefs(bodyText),
    renameRefs(tailLines.join('\n')),
    'process.exit(finish())'
  ].join('\n')

  out = out.split('rmSync(tmpHome, { recursive: true, force: true })').join('await app.close()')
  out = out
    .split('\n')
    .filter(
      (l) =>
        !/^\s*ws\.close\(\);?\s*(child\.kill)?|^\s*child\.kill\(\)|^\s*conn\.ws\.close\(\)|^\s*const failed =|^\s*process\.exit\(failed|^\s*rmSync\((tmpHome|profile)/.test(
          l
        )
    )
    .join('\n')
  const closes = (out.match(/await app\.close\(\)/g) || []).length
  if (closes === 0) out = out.replace('\nprocess.exit(finish())', '\nawait app.close()\nprocess.exit(finish())')
  else if (closes > 1) {
    let seen = false
    out = out
      .split('\n')
      .filter((l) => {
        if (!/await app\.close\(\)/.test(l)) return true
        if (seen) return false
        seen = true
        return true
      })
      .join('\n')
  }
  return { out, decls: keptIdx.size, stmts: stmtIdx.size }
}

const BT = String.fromCharCode(96)
const SELF_TESTS = [
  ["const a = 'x'", 1],
  ["const f = () => {\n  const s = '{ not json'\n  return s\n}", 4],
  ["const m = createServer((req, res) => {\n  res.end('ok')\n})\nawait m.listen(1)", 3],
  ["const g = () => {\n  // }\n  return 1\n}", 4],
  ["const k = { a: 1 }", 1],
  ["const h = (a, b) => a + b", 1],
  ["const s = {\n  v: " + BT + "x$" + "{ { a: 1 } }y" + BT + ",\n  w: 2\n}", 4],
  ["const f = async () => {\n  if (a) {\n    b()\n  }\n  return 1\n}", 6]
]

function selfTest() {
  let bad = 0
  for (const [src, want] of SELF_TESTS) {
    const got = declLineCount(src, 0)
    if (got !== want) {
      bad++
      console.log('✗ 期望 ' + want + ' 行，实得 ' + got + ' —— ' + JSON.stringify(src.slice(0, 40)))
    }
  }
  console.log(bad ? '有 ' + bad + ' 条不过' : '✓ 扫描器自检全过（' + SELF_TESTS.length + ' 条）')
  return bad
}

// 只有 node 直接执行这个文件时才跑 CLI。被 vitest import（做自检）时，
// process.argv 里是 vitest 的参数，照着迁移就会去动一堆莫名其妙的文件。
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url

if (invokedDirectly) {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test') || argv.length === 0) {
    process.exit(selfTest() ? 1 : 0)
  }
  for (const name of argv) {
    const file = join(process.cwd(), 'scripts', name.endsWith('.mjs') ? name : name + '.mjs')
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    const r = migrateSource(lines)
    if (r.skip) { console.log('✗ ' + name + '：' + r.skip); continue }
    writeFileSync(file, r.out, 'utf8')
    console.log('✓ ' + name + '（保留声明 ' + r.decls + '、语句 ' + r.stmts + '）')
  }
}

export { SELF_TESTS, selfTest }
