/**
 * 用户脚本：扫描 `<数据目录>/scripts/` 并执行其中的脚本。
 *
 * 目录约定（与备份目录同级）：脚本放进去就能在命令面板里找到，
 * 不用注册、不用重启 —— 每次打开命令面板扫一次目录，几十个文件的 readdir 是零成本。
 *
 * 安全边界只有两条，但都是硬的：
 *   1. 只接受**纯文件名**（isSafeScriptFile），路径一律拒绝；
 *   2. 解析后的真实路径必须落在脚本目录内（realpath 比对）—— 软链接指到别处也不行。
 * 脚本本身是以当前用户身份跑的，这一点无法也不该在这里兜底：
 * 用户放进来的脚本就是用户自己的程序，与他在资源管理器里双击它等价。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { conn, dataDir } from './db/connection'
import { getNote } from './db/notes'
import { normalizeScriptRuntime } from '../shared/workflow-action'
import {
  SCRIPT_RUNTIME_EXT,
  describeScript,
  isSafeScriptFile,
  lintBatch,
  parseCheckOutput,
  runtimeOf,
  scriptFileFor,
  scriptNameOf,
  scriptTemplate,
  sortScripts,
  type ScriptProblem,
  type ScriptRunResult,
  type ScriptRuntime,
  type UserScript,
} from '../shared/user-scripts'

/** 单次运行的输出上限：脚本刷屏时不该把主进程内存吃光 */
const MAX_OUTPUT = 64 * 1024
/** 默认超时：脚本是"干一件事就退出"的，一分钟还没完基本是卡住了 */
const DEFAULT_TIMEOUT_MS = 60_000

export function scriptsDir(): string {
  return join(dataDir(), 'scripts')
}

/**
 * 目录不存在就建，并放一份说明。
 *
 * 说明文件是必须的：光看一个空目录，用户不知道该放什么、认哪些扩展名、
 * 描述写在哪里 —— 而这些都是"放进去之前"就要知道的。
 */
export function ensureScriptsDir(): string {
  const dir = scriptsDir()
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const readme = join(dir, 'README.txt')
    if (!existsSync(readme)) {
      writeFileSync(
        readme,
        [
          '把脚本放进这个目录，就能在命令面板（Ctrl/Cmd+K）里搜到并直接运行。',
          '',
          '认这些扩展名：',
          '  .ps1  → powershell -NoProfile -ExecutionPolicy Bypass -File',
          '  .cmd / .bat → cmd /c',
          '  .py   → python',
          '  .js / .mjs → node',
          '',
          '想让命令面板显示一句说明，在脚本开头写一行注释：',
          '  # desc: 把下载目录里的发票归档到「财务」文件夹',
          '  // desc: 生成上周的周报草稿',
          '',
          '脚本以当前用户身份运行，输出会显示在应用内提示里（上限 64KB，超时 60 秒）。',
          '只认这个目录下的**文件名**，子目录不会被扫描。',
          '',
        ].join('\r\n'),
        'utf8'
      )
    }
  } catch (err) {
    console.error('[scripts] 准备脚本目录失败', err)
  }
  return dir
}

/** 目录里的脚本清单。只扫顶层：子目录留给用户自己组织，不递归（免得误跑一堆）。 */
export function listUserScripts(): UserScript[] {
  const dir = ensureScriptsDir()
  const out: UserScript[] = []
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch (err) {
    console.error('[scripts] 读取脚本目录失败', err)
    return []
  }
  for (const file of names) {
    const runtime = runtimeOf(file)
    if (!runtime) continue
    try {
      const full = join(dir, file)
      const st = statSync(full)
      if (!st.isFile()) continue
      // 描述只读文件开头：脚本可能很大，没必要为了取一行注释把它整个读进来
      const head = readFileSync(full, 'utf8').slice(0, 4000)
      out.push({
        file,
        name: scriptNameOf(file),
        runtime,
        description: describeScript(head),
        mtime: st.mtime.toLocaleString('sv-SE').slice(0, 16),
        size: st.size,
      })
    } catch (err) {
      // 单个文件读不了（权限 / 编码）不该让整份清单消失
      console.error('[scripts] 读取脚本失败：' + file, err)
    }
  }
  const sorted = sortScripts(out)
  const pins = pinnedScripts()
  for (const s of sorted) s.pinned = pins.includes(s.file)
  // 钉住的排最前（按钉的顺序），其余保持"最近改过的在前"—— 与笔记树的置顶同一个读法
  return sorted.sort((a, b) => {
    const ia = pins.indexOf(a.file)
    const ib = pins.indexOf(b.file)
    if (ia >= 0 && ib >= 0) return ia - ib
    if (ia >= 0) return -1
    if (ib >= 0) return 1
    return 0
  })
}

/**
 * 钉住的脚本清单。
 *
 * 存 settings 而不是文件系统：钉住是"我怎么看这份清单"的偏好，不是脚本本身的属性 ——
 * 它不该跟着脚本文件一起被复制给别人。
 */
export function pinnedScripts(): string[] {
  try {
    const row = conn().prepare("SELECT value FROM settings WHERE key = 'script_pinned'").get() as
      | { value: string }
      | undefined
    const v: unknown = JSON.parse(row?.value ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function setScriptPinned(file: string, pinned: boolean): boolean {
  if (!isSafeScriptFile(file)) return false
  const list = pinnedScripts().filter((f) => f !== file)
  if (pinned) list.unshift(file)
  try {
    conn()
      .prepare(
        "INSERT INTO settings(key, value) VALUES('script_pinned', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(JSON.stringify(list.slice(0, 50)))
    return true
  } catch (err) {
    console.error('[scripts] 写入钉住列表失败', err)
    return false
  }
}

/**
 * 哪些工作流步骤在用它。
 *
 * 引用关系只在 workflow_node.action_value 里（存的是文件名，不是路径）——
 * 所以脚本改名之后这些步骤会失效，界面上要能提前看见。
 */
export function scriptReferences(file: string): { template: string; node: string }[] {
  try {
    return conn()
      .prepare(
        `SELECT wt.name AS template, wn.title AS node
           FROM workflow_node wn JOIN workflow_template wt ON wt.id = wn.template_id
          WHERE wn.action_kind = 'user_script' AND wn.action_value = ?
          ORDER BY wt.name, wn.order_index`
      )
      .all(file) as { template: string; node: string }[]
  } catch (err) {
    console.error('[scripts] 查询引用失败', err)
    return []
  }
}

/** 运行时 → 命令行。参数表按各运行时的惯例给（powershell 要 -File，cmd 要 /c）。 */
function commandOf(runtime: ScriptRuntime, full: string): { bin: string; args: string[] } {
  if (runtime === 'powershell') {
    return { bin: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', full] }
  }
  if (runtime === 'cmd') return { bin: 'cmd', args: ['/c', full] }
  if (runtime === 'python') return { bin: 'python', args: [full] }
  // node：用 PATH 里的 node，而不是 process.execPath（那是 electron.exe，
  // 直接拿它跑脚本会变成"再开一个 Electron"）
  return { bin: 'node', args: [full] }
}

/** 路径必须落在脚本目录内（比对 realpath：软链接指出去的一律拒绝）。 */
function resolveInside(dir: string, file: string): string | null {
  if (!isSafeScriptFile(file)) return null
  const full = join(dir, file)
  try {
    if (!existsSync(full)) return null
    // realpath 之后再比：软链接指到脚本目录外面的一律拒绝
    const realDir = realpathSync(dir)
    const realFull = realpathSync(full)
    const prefix = realDir.endsWith(sep) ? realDir : realDir + sep
    // Windows 的路径大小写不敏感，统一小写再比
    return realFull.toLowerCase().startsWith(prefix.toLowerCase()) ? full : null
  } catch {
    return null
  }
}

/**
 * 跑一个进程并收集输出 —— 文件版与笔记版共用。
 *
 * cwd 给脚本目录 / 系统临时目录：脚本里的相对路径应当落在"它自己那一份"旁边，
 * 而不是应用启动时的当前目录（那是安装目录，写进去要出权限问题）。
 */
function runProcess(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ScriptRunResult> {
  return new Promise((resolve) => {
    let output = ''
    let done = false
    const finish = (res: ScriptRunResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(res)
    }
    let child
    try {
      child = spawn(bin, args, { cwd, windowsHide: true })
    } catch (err) {
      resolve({ ok: false, code: null, output: '', message: '启动失败：' + (err as Error).message })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 已经退出了
      }
      finish({ ok: false, code: null, output, message: `超时（${Math.round(timeoutMs / 1000)} 秒）已终止` })
    }, timeoutMs)
    const collect = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf8')
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (err) => {
      // 最常见的是没装这个运行时（python / node 不在 PATH 里）
      finish({ ok: false, code: null, output, message: '起不来「' + bin + '」：' + err.message })
    })
    child.on('close', (code) => {
      const ok = code === 0
      finish({
        ok,
        code,
        output: output.slice(0, MAX_OUTPUT),
        message: ok ? '运行完成' : `退出码 ${code}`,
      })
    })
  })
}

/** 文件版：<数据目录>/scripts/ 下的脚本（外部脚本目录，命令面板与旧模板用它）。 */
export function runUserScript(
  file: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ScriptRunResult> {
  const dir = scriptsDir()
  const full = resolveInside(dir, file)
  if (!full) {
    return Promise.resolve({ ok: false, code: null, output: '', message: '找不到这个脚本（只认脚本目录下的文件名）' })
  }
  const runtime = runtimeOf(file)
  if (!runtime) {
    return Promise.resolve({ ok: false, code: null, output: '', message: '不认识的脚本类型' })
  }
  const { bin, args } = commandOf(runtime, full)
  return runProcess(bin, args, dir, timeoutMs)
}

/**
 * 笔记版：把脚本笔记的正文落成临时文件再跑。
 *
 * 为什么不走 stdin：四种运行环境里只有一半能从标准输入吃脚本，
 * 而"脚本自己读文件"（常见的写法）需要它有一个真实路径。
 * 临时文件带正确扩展名，解释器据此识别语言。
 */
export async function runScriptText(
  runtime: ScriptRuntime,
  content: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ScriptRunResult> {
  const tmp = join(
    tmpdir(),
    'zx-run-' + process.pid + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + SCRIPT_RUNTIME_EXT[runtime]
  )
  try {
    writeFileSync(tmp, content, 'utf8')
  } catch (err) {
    return { ok: false, code: null, output: '', message: '写入临时脚本失败：' + (err as Error).message }
  }
  const { bin, args } = commandOf(runtime, tmp)
  const res = await runProcess(bin, args, tmpdir(), timeoutMs)
  try {
    unlinkSync(tmp)
  } catch {
    // 临时文件删不掉不是用户的问题
  }
  return res
}

/** 跑一条脚本笔记：正文与运行时都从库里取。 */
export function runNoteScript(noteId: number, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<ScriptRunResult> {
  const note = getNote(noteId)
  if (!note) {
    return Promise.resolve({ ok: false, code: null, output: '', message: '这篇脚本不存在' })
  }
  if (note.format !== 'script') {
    return Promise.resolve({ ok: false, code: null, output: '', message: '这不是脚本笔记' })
  }
  return runScriptText(normalizeScriptRuntime(note.script_runtime), note.content_md ?? '', timeoutMs)
}

// ---------------------------------------------------------------- 脚本文件读写

export interface ScriptFileResult {
  ok: boolean
  message: string
}

/** 读一个脚本的正文（编辑区用）。 */
export function readUserScript(file: string): { ok: boolean; content: string; message: string } {
  const dir = ensureScriptsDir()
  const full = resolveInside(dir, file)
  if (!full) return { ok: false, content: '', message: '找不到这个脚本' }
  try {
    return { ok: true, content: readFileSync(full, 'utf8'), message: '已读取' }
  } catch (err) {
    return { ok: false, content: '', message: '读取失败：' + (err as Error).message }
  }
}

/**
 * 写入脚本正文（文件不存在就新建）。
 *
 * 路径仍然走 resolveInside 那两道校验：编辑区传进来的必须是**脚本目录下的纯文件名**。
 * 写入用 utf8 无 BOM —— PowerShell 5.1 对无 BOM 的 UTF-8 中文会按 ANSI 读，
 * 所以模板里的说明文字尽量用英文以外的字符时要注意；这里保持无 BOM 是主流工具的默认。
 */
export function writeUserScript(file: string, content: string): ScriptFileResult {
  const dir = ensureScriptsDir()
  if (!isSafeScriptFile(file) || !runtimeOf(file)) return { ok: false, message: '文件名不合法' }
  const full = join(dir, file)
  try {
    // 已存在的走 resolveInside（防软链接指出去）；新建的直接写在目录里
    if (existsSync(full) && !resolveInside(dir, file)) return { ok: false, message: '这个路径不允许写入' }
    writeFileSync(full, String(content ?? ''), 'utf8')
    return { ok: true, message: '已保存' }
  } catch (err) {
    return { ok: false, message: '保存失败：' + (err as Error).message }
  }
}

/** 新建脚本：文件名由「名字 + 运行时」拼出，冲突时自动加序号。 */
export function createUserScript(
  name: string,
  runtime: ScriptRuntime
): { ok: boolean; file: string; message: string } {
  const dir = ensureScriptsDir()
  let file = scriptFileFor(name, runtime)
  const dot = file.lastIndexOf('.')
  const stem = file.slice(0, dot)
  const ext = file.slice(dot)
  // 重名不覆盖：直接加 -2 / -3 后缀。覆盖别人的脚本是不可接受的默认行为
  for (let i = 2; existsSync(join(dir, file)) && i < 100; i++) file = stem + '-' + i + ext
  const res = writeUserScript(file, scriptTemplate(runtime))
  return { ok: res.ok, file: res.ok ? file : '', message: res.ok ? '已新建 ' + file : res.message }
}

/** 改名（保持扩展名与运行时不换）：本质上是一次"读到内存 → 写新文件 → 删旧文件"。 */
export function renameUserScript(file: string, newName: string): { ok: boolean; file: string; message: string } {
  const dir = ensureScriptsDir()
  const runtime = runtimeOf(file)
  const full = resolveInside(dir, file)
  if (!runtime || !full) return { ok: false, file: '', message: '找不到这个脚本' }
  const next = scriptFileFor(newName, runtime)
  if (next === file) return { ok: true, file, message: '名字没变' }
  if (existsSync(join(dir, next))) return { ok: false, file: '', message: '已经有同名的脚本了' }
  try {
    const content = readFileSync(full, 'utf8')
    writeFileSync(join(dir, next), content, 'utf8')
    unlinkSync(full)
    return { ok: true, file: next, message: '已改名为 ' + next }
  } catch (err) {
    return { ok: false, file: '', message: '改名失败：' + (err as Error).message }
  }
}

export function deleteUserScript(file: string): ScriptFileResult {
  const dir = ensureScriptsDir()
  const full = resolveInside(dir, file)
  if (!full) return { ok: false, message: '找不到这个脚本' }
  try {
    unlinkSync(full)
    return { ok: true, message: '已删除 ' + file }
  } catch (err) {
    return { ok: false, message: '删除失败：' + (err as Error).message }
  }
}

// ---------------------------------------------------------------- 语法校验

/** 每种运行时的"只解析、不执行"命令。cmd 没有解析器，走 shared 的启发式检查。 */
function commandOf2(runtime: ScriptRuntime, full: string): { bin: string; args: string[] } | null {
  if (runtime === 'powershell') {
    // ParseFile 只解析：不会执行脚本里的任何一行。错误用「行号:消息」输出，好解析
    const quoted = full.replace(/'/g, "''")
    const ps = [
      // Windows PowerShell 5.1 默认按控制台的 ANSI 代码页输出，中文错误消息到 Node 这边就是乱码。
      // 先把输出编码顶成 UTF-8 —— 它只影响这一次进程的 stdout，不写任何用户设置。
      // catch 里必须放一条语句：这个仓库的护栏会拦"什么都不做的 catch"（宁可写成显式丢弃）
      'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { $null = $_ }',
      '$errs = $null',
      '[void][System.Management.Automation.Language.Parser]::ParseFile(\'' + quoted + '\', [ref]$null, [ref]$errs)',
      'if ($errs) { $errs | ForEach-Object { "$($_.Extent.StartLineNumber):$($_.Message)" }; exit 1 }',
      'exit 0',
    ].join('; ')
    return { bin: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', ps] }
  }
  if (runtime === 'python') {
    // ast.parse 只解析不执行，也不会像 py_compile 那样写 __pycache__
    const py = "import ast,sys;ast.parse(open(r'" + full.replace(/'/g, "\\'") + "',encoding='utf-8',errors='replace').read())"
    return { bin: 'python', args: ['-c', py] }
  }
  if (runtime === 'node') return { bin: 'node', args: ['--check', full] }
  return null
}

/**
 * 语法校验：**只解析，不执行**。
 *
 * 这一条是硬要求：编辑区里按一次"检查"就真的跑起来，等于给了一个"点错就执行任意脚本"的按钮。
 * 三种解析器都只做语法分析（PowerShell 的 Parser.ParseFile / Python 的 ast.parse / Node 的 --check），
 * cmd 没有解析器，退回 shared 里的启发式检查（只查引号与括号配平，宁可漏报不误报）。
 */
/**
 * 只校验**脚本正文** —— 运行时由调用方给。
 *
 * 文件版看扩展名、笔记版看 note.script_runtime，两者共用这一份实现：
 * 解析器怎么跑、输出怎么解析，不该有两套。
 */
export async function checkScriptText(
  runtime: ScriptRuntime,
  content: string
): Promise<{ ok: boolean; problems: ScriptProblem[]; message: string }> {
  if (runtime === 'cmd') {
    const problems = lintBatch(content)
    return { ok: problems.length === 0, problems, message: problems.length ? 'cmd 只能做括号与引号检查' : '检查通过' }
  }

  // 走临时文件：解析器都吃文件，而这里要校验的是编辑框里的内容（可能还没保存）。
  // 临时文件用完就删，放在系统临时目录，不碰脚本目录本身。
  const tmp = join(
    tmpdir(),
    'zx-check-' + process.pid + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + SCRIPT_RUNTIME_EXT[runtime]
  )
  try {
    writeFileSync(tmp, content, 'utf8')
  } catch (err) {
    return { ok: false, problems: [{ line: 0, message: '写入临时文件失败' }], message: (err as Error).message }
  }
  const spec = commandOf2(runtime, tmp)
  if (!spec) {
    return { ok: false, problems: [{ line: 0, message: '不认识的脚本类型' }], message: '不认识的脚本类型' }
  }
  const { bin, args } = spec
  let attempt = await runChecker(bin, args)
  // Python 在 Windows 上有三个入口：python（可能只是商店的占位程序，跑起来立刻非零退出、
  // 一声不吭）、python3、py。前一个"起不来"就换下一个 —— 与工作流脚本步骤的做法一致。
  if (runtime === 'python' && (attempt.spawnError || (attempt.code !== 0 && !attempt.output.trim()))) {
    const second = await runChecker('py', args)
    if (!second.spawnError && second.output.trim()) attempt = second
  }
  try {
    unlinkSync(tmp)
  } catch {
    // 临时文件删不掉不是用户的问题
  }
  if (attempt.spawnError) {
    const msg = '起不来「' + attempt.spawnError + '」检查器：本机可能没装它'
    return { ok: false, problems: [{ line: 0, message: msg }], message: msg }
  }
  if (attempt.code === 0) return { ok: true, problems: [], message: '检查通过' }
  const problems = parseCheckOutput(attempt.output)
  if (problems.length === 0) {
    // 非零退出却一句话都没说：多半是解释器本身的问题（商店占位程序就是这样），
    // 而不是脚本语法错 —— 这时候说"语法错误"会把人带偏
    const msg = '「' + bin + '」没有给出任何输出（本机可能没装它，或它只是个占位程序）'
    return { ok: false, problems: [{ line: 0, message: msg }], message: msg }
  }
  return { ok: false, problems, message: problems[0].message }
}

/** 文件版：运行时看扩展名；content 省略时校验磁盘上那一份。 */
export async function checkUserScript(
  file: string,
  content?: string
): Promise<{ ok: boolean; problems: ScriptProblem[]; message: string }> {
  const runtime = runtimeOf(file)
  if (!runtime) return { ok: false, problems: [{ line: 0, message: '不认识的脚本类型' }], message: '不认识的脚本类型' }
  // 校验的是**编辑框里的内容**，不是磁盘上的旧版本：用户按检查时想知道的正是"我刚写的这段对不对"
  let text = content
  if (text === undefined) {
    const read = readUserScript(file)
    if (!read.ok) return { ok: false, problems: [{ line: 0, message: read.message }], message: read.message }
    text = read.content
  }
  return checkScriptText(runtime, text)
}

/** 笔记版：脚本笔记的正文存在库里，运行时看 note.script_runtime。 */
export async function checkNoteScript(
  noteId: number,
  content: string
): Promise<{ ok: boolean; problems: ScriptProblem[]; message: string }> {
  const note = getNote(noteId)
  if (!note) return { ok: false, problems: [{ line: 0, message: '这篇脚本不存在' }], message: '这篇脚本不存在' }
  return checkScriptText(normalizeScriptRuntime(note.script_runtime), content)
}

/** 跑一次检查器，把退出码与输出交回来（不在这里判断对错）。 */
function runChecker(
  bin: string,
  args: string[]
): Promise<{ code: number | null; output: string; spawnError: string | null }> {
  return new Promise((resolve) => {
    let output = ''
    let done = false
    const finish = (res: { code: number | null; output: string; spawnError: string | null }): void => {
      if (done) return
      done = true
      resolve(res)
    }
    let child
    try {
      child = spawn(bin, args, { windowsHide: true })
    } catch (err) {
      finish({ code: null, output: '', spawnError: bin + '：' + (err as Error).message })
      return
    }
    child.stdout?.on('data', (c: Buffer) => (output += c.toString('utf8')))
    child.stderr?.on('data', (c: Buffer) => (output += c.toString('utf8')))
    child.on('error', (err) => finish({ code: null, output, spawnError: bin + '：' + err.message }))
    child.on('close', (code) => finish({ code, output, spawnError: null }))
  })
}

