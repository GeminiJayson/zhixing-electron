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

/**
 * 能不能在这里起一个正则字面量：看它前面的代码像不像「等着一个操作数」。
 * 不做这层判定的话，正则里字符类中的转义括号会被当成真实括号 —— 真实案例
 * 「/\\[\\[[^\\]]+\\]\\]/g」与「/https?:\\/\\/[^\\s)\\]，。]+/g」把一条 48 行的声明
 * 少算了 3 个括号，于是收尾的「})」被丢掉，后面的 await 落进了非 async 的箭头函数里。
 */
const BEFORE_REGEX = /(?:\b(?:return|typeof|case|in|of|new|delete|void|instanceof))$|[([{,;:=!&|?+\-*%^~<>]$/

/** 扫一行，返回净深度；state 携带跨行的模板串/块注释状态与本行的行尾 token。 */
export function scanLine(text, from, to, state) {
  let depth = 0
  let j = from
  // 本行的代码（字符串与正则记成 S，注释与模板内容不记），用来判断这一行能不能收尾。
  let code = ''
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
    if (c === '/' && (code.trim() === '' || BEFORE_REGEX.test(code.trim()))) {
      j++
      let inClass = false
      while (j < to) {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === '[') inClass = true
        else if (text[j] === ']') inClass = false
        else if (text[j] === '/' && !inClass) { j++; break }
        j++
      }
      while (j < to && /[a-z]/i.test(text[j])) j++
      code += 'S'
      continue
    }
    if (c === "'" || c === '"') {
      code += 'S'
      const q = c
      j++
      while (j < to) {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === q) { j++; break }
        j++
      }
      continue
    }
    if (c === '\u0060') { state.tpl = true; code += 'S'; j++; continue }
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') depth--
    code += c
    j++
  }
  state.tail = code.trim()
  return depth
}

/**
 * 行尾是这些 token 时，这一行**不能**收尾，声明要继续吃下一行。
 * 反例就是踩过的坑：`const mouse = (type) =>` 括号是平衡的，光看深度会判成单行声明，
 * 于是把表达式体的函数体整段丢掉（`const mouse = (type) =>` + 下一行的调用）。
 * 不含 `/`：行尾的斜杠几乎总是正则字面量（`const re = /\d+/`），不是除法续行。
 */
const CONTINUES = /(?:=>|[=,+\-*%&|?:.<>]|\b(?:return|await|typeof|instanceof|new|in|of|void|delete))$/

/** 从 startOffset 起，这条声明/语句占多少行。 */
export function declLineCount(text, startOffset) {
  const state = { tpl: false, block: false, tail: '' }
  let i = startOffset
  let total = 0
  let depth = 0
  // 「上一行要求我继续」—— 空行与纯注释行只有在续行途中才能被跳过。
  // 少了这个区分，以注释行开头的块就会一路吃到下一条声明：
  // 真实症状是 let payload = [] 被输出两遍（Identifier 'payload' has already been declared）。
  let pending = false
  while (i < text.length) {
    const nl = text.indexOf('\n', i)
    const to = nl < 0 ? text.length : nl
    depth += scanLine(text, i, to, state)
    total++
    if (depth > 0 || state.tpl || state.block) {
      pending = true
    } else if (state.tail === '') {
      if (!pending) return total
    } else if (CONTINUES.test(state.tail)) {
      pending = true
    } else {
      return total
    }
    if (nl < 0) break
    i = nl + 1
  }
  return total
}

/** 替换本身：把四类引用改到 app 上。 */
function renameNames(text) {
  let t = text
  for (const v of ['conn', 'page', 'host']) {
    t = t.replace(new RegExp('(?<![.\\w$])' + v + '\\.', 'g'), 'app.')
  }
  for (const v of ['evaluate', 'ev', 'send']) {
    t = t.replace(new RegExp('(?<![.\\w$])' + v + '\\(', 'g'), 'app.' + (v === 'ev' ? 'evaluate' : v) + '(')
  }
  // 正文里直接调脚手架版的 list()（就是拉 /json/list 的那个）时，改到 lib 的 app.targets()。
  // list 在 BOILER 里 —— 它那份多行实现（含 new WebSocket）永远不会被保留，
  // 于是正文里的调用必须落到 lib 的同款能力上，否则就是 list is not defined。
  t = t.replace(/(?<![.\w$])list\(/g, 'app.targets(')
  return t
}

/**
 * conn./page./host. 一律改成 app.；裸的 evaluate/ev/send 调用也改到 app 上。
 *
 * 只改**代码段**。这条限制是被真实失败逼出来的：flashhotkeycheck 里有一句页面侧的
 * 「if (host) host.focus()」，host 在那段字符串里只是个 DOM 元素；盲改之后变成
 * app.focus() —— 浏览器上下文里根本没有 app，报错是 ReferenceError: app is not defined，
 * 堆栈全在 <anonymous>，很难认。模板串里的插值也一并当内容跳过（那里同样是页面侧的名字）。
 */
export function renameRefs(text) {
  let out = ''
  let code = ''
  let i = 0
  const flush = () => { out += renameNames(code); code = '' }
  while (i < text.length) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      flush()
      const nl = text.indexOf('\n', i)
      const end = nl < 0 ? text.length : nl
      out += text.slice(i, end)
      i = end
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      flush()
      const end = text.indexOf('*/', i)
      const e = end < 0 ? text.length : end + 2
      out += text.slice(i, e)
      i = e
      continue
    }
    if (c === "'" || c === '"' || c === '\u0060') {
      flush()
      const start = i
      const q = c
      i++
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === q) { i++; break }
        i++
      }
      out += text.slice(start, i)
      continue
    }
    code += c
    i++
  }
  flush()
  return out
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

  // 样板区段里若有脚本自己的文件准备（造夹具），机械迁移**不安全**：
  // lib 的 launchApp 会先 rmSync(home) 再重建，脚本提早写进去的夹具会被清掉。
  // 症状是断言里读文件直接 ENOENT —— 看起来像迁好了，跑起来才炸。
  // 宁可拒绝迁移，也不产出这种脚本（importcheck / officecheck / wfdialog / wflinkcheck 都是这一族）。
  const BOILER_FS = /(?:rmSync|mkdirSync|copyFileSync)\(\s*(?:tmpHome|profile|realDb|seedDb|liveDb)\b/
  const FIXTURE_FS = /\b(?:writeFileSync|appendFileSync|renameSync|mkdirSync|copyFileSync|rmSync)\s*\(/
  for (let i = iImport; i < iAnchor; i++) {
    if (!FIXTURE_FS.test(lines[i]) || BOILER_FS.test(lines[i])) continue
    if (/^\s/.test(lines[i])) continue
    return { skip: '样板区段有脚本自己的文件准备（launchApp 会清空 home，需手工迁移）' }
  }

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
      if (/^(\/\/|\*|\/\*)/.test(lines[i])) continue
      if (/^import |^(const|let|var|async function|function)\s/.test(lines[i])) continue
      if (!names.some((nm) => new RegExp('(?<![.\\w$])' + nm + '(?![\\w$])').test(lines[i]))) continue
      // 跳过的是**样板**的落库动作，不是脚本自己的夹具准备。
      // 只按函数名过滤会把「给这次验证造 good.json」一起丢掉 —— importcheck 就是这么坏的：
      // 夹具目录从没被建出来，断言里读文件直接 ENOENT。
      if (/rmSync|mkdirSync|copyFileSync|spawn\(/.test(lines[i]) &&
          /\b(tmpHome|profile|realDb|seedDb|liveDb|backup|electronPath|child)\b/.test(lines[i])) continue
      const n = nAt(i)
      stmtIdx.add(i)
      refText += '\n' + lines.slice(i, i + n).join('\n')
      added++
    }
    if (!added) break
  }

  const allSort = [...new Set([...keptIdx, ...stmtIdx])].sort((a, b) => a - b)
  // 去重叠：索引互不相同，但切片仍可能叠在一起（注释行被当语句抓走时，它的块会吃到
  // 紧随其后的那条声明），叠了就会把同一条声明输出两遍。
  const emitted = new Set()
  const preserved = []
  for (const i of allSort) {
    if (emitted.has(i)) continue
    const block = lines.slice(i, i + nAt(i))
    for (let k = i; k < i + block.length; k++) emitted.add(k)
    preserved.push(...block)
  }
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
  ["const f = async () => {\n  if (a) {\n    b()\n  }\n  return 1\n}", 6],
  // 真实踩坑形状：表达式体的箭头函数，函数体在下一行
  ["const mouse = (type, x, y, buttons) =>\n  conn.send('Input.dispatch', { type })", 2],
  ["const centerOf = (expr) =>\n  evaluate(expr)", 2],
  // 字符串字面量能收尾一行，别把它当续行
  ["const s = 'a'\nconst t = 2", 1],
  ["const sel = '.row'\nconst n = 1", 1],
  // 正则字面量结尾不是除法续行
  ["const re = /\\d+/\nconst n = 1", 1],
  // 显式续行 token
  ["const url = base +\n  '/api'", 2],
  ["const x = 1\n\nconst y = 2", 1],
  // 正则字面量里的转义括号不是真括号（真实案例：ailibcheck 的 const server 少算 3 个括号）
  ["const re = /\\[\\[[^\\]]+\\]\\]/g\nconst next = 1", 1],
  ["const urls = [...prompt.matchAll(/https?:\\/\\/[^\\s)\\]，。]+/g)].map((m) => m[0])\nconst next = 1", 1],
  // 以注释行开头的块不能一路吃下去（真实案例：tasksynccheck 的 let payload 输出两遍）
  ["// 只是注释\nconst a = 1", 1],
  // 但续行途中的注释行要跳过
  ["const a =\n  // 说明\n  5", 3]
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
