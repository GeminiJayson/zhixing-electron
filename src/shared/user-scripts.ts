/**
 * 用户脚本扩展点：`<数据目录>/scripts/` 下的脚本，可以当命令用。
 *
 * 这里只放"光看文件就能判断"的规则 —— 哪些扩展名认、算哪个运行环境、
 * 描述从哪来。真正的扫描与执行在主进程（src/main/user-scripts.ts），
 * 那部分碰 fs 与 child_process，只能靠真跑一次来验。
 *
 * 为什么是"文件即插件"而不是一套 Extension API：
 * 这个应用是离线桌面软件，用户要的多半是"把我自己那个脚本挂上来"，
 * 而一套 API 意味着要维护版本兼容、沙箱与加载顺序 —— 那些东西的维护成本
 * 远高于它解决的问题。脚本文件自带运行环境（扩展名决定），也自带文档（头部注释）。
 */

/** 与工作流步骤的脚本运行环境保持一致（见 shared/workflow-action.ts） */
export type ScriptRuntime = 'powershell' | 'cmd' | 'python' | 'node'

export interface UserScript {
  /** 文件名（含扩展名）—— 命令面板与执行都按它定位，不接受路径 */
  file: string
  /** 去掉扩展名的名字，列表里显示这个 */
  name: string
  runtime: ScriptRuntime
  /** 头部注释里的说明，空 = 没写 */
  description: string
  /** 文件修改时间（YYYY-MM-DD HH:MM），列表按它倒序 */
  mtime: string
  /** 钉住的排在最前（与笔记项的「置顶」同一个意思）。列表来自 settings，不是文件属性 */
  pinned?: boolean
  /** 文件字节数（信息区显示用） */
  size?: number
}

/** 一次运行的结果（IPC 合同：主进程返回、渲染层提示） */
export interface ScriptRunResult {
  ok: boolean
  /** 退出码；被超时杀掉或压根没起来时是 null */
  code: number | null
  /** 合并后的 stdout + stderr（上限 64KB） */
  output: string
  /** 给界面看的一行结论 */
  message: string
}

/** 认得的扩展名 → 运行环境。不在这里的一律不列出来。 */
export const SCRIPT_EXTENSIONS: Record<string, ScriptRuntime> = {
  '.ps1': 'powershell',
  '.cmd': 'cmd',
  '.bat': 'cmd',
  '.py': 'python',
  '.js': 'node',
  '.mjs': 'node',
}

/** 这个文件名算哪个运行环境；不认识的扩展名返回 null。 */
export function runtimeOf(file: string): ScriptRuntime | null {
  const name = String(file ?? '').toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  return SCRIPT_EXTENSIONS[name.slice(dot)] ?? null
}

export function scriptNameOf(file: string): string {
  const name = String(file ?? '')
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * 只接受**纯文件名**。
 *
 * 执行入口收的是渲染层传来的字符串，而那个字符串来自界面 ——
 * 一旦允许路径（..\..\Windows\System32\x.cmd），这个入口就变成"用应用的身份
 * 跑任意程序"。主进程还会再用 realpath 校验一次落在脚本目录内，这里先挡住最明显的一类。
 */
export function isSafeScriptFile(file: string): boolean {
  const f = String(file ?? '')
  if (!f || f.length > 200) return false
  if (f.includes('/') || f.includes('\\')) return false
  if (f.includes('..')) return false
  // Windows 保留字符：允许的话能构造出奇怪的名字
  return !/[<>:"|?*]/.test(f)
}

/**
 * 从脚本头部注释里取一句说明。
 *
 * 约定（不强制，但写了就显示）：
 *   # desc: 把下载目录里的发票归档        （PowerShell / Python / Node）
 *   // desc: ...                          （Node）
 *   REM desc: ...                        （cmd / bat）
 * 没写 desc: 就退回第一条非空注释 —— 脚本开头那行注释本来就多半是干这个的。
 */
export function describeScript(text: string): string {
  const lines = String(text ?? '').split(/\r?\n/).slice(0, 30)
  let first = ''
  for (const line of lines) {
    // cmd 家族用 REM（以及 :: 那个约定俗成的标签写法）当注释
    const m = /^\s*(?:#|\/\/|REM\s+|::\s*)\s*(.*)$/i.exec(line)
    if (!m) continue
    const body = m[1].trim()
    if (!body) continue
    const d = /^desc\s*[:：]\s*(.+)$/i.exec(body)
    if (d) return d[1].trim().slice(0, 100)
    if (!first) first = body
  }
  return first.slice(0, 100)
}

/** 列表排序：最近改过的排前面，同时间按名字 —— 结果稳定，扫描两次不会跳来跳去。 */
export function sortScripts(list: UserScript[]): UserScript[] {
  return [...list].sort((a, b) => (b.mtime ?? '').localeCompare(a.mtime ?? '') || a.file.localeCompare(b.file))
}

// ---------------------------------------------------------------- 新建与校验

/** 运行环境的中文名：树上、编辑区、工作流下拉共用同一份文案。 */
export const SCRIPT_RUNTIME_LABELS: Record<ScriptRuntime, string> = {
  powershell: 'PowerShell',
  cmd: 'CMD 批处理',
  python: 'Python',
  node: 'JavaScript (Node)',
}

export function scriptRuntimeLabelOf(runtime: string): string {
  return SCRIPT_RUNTIME_LABELS[runtime as ScriptRuntime] ?? runtime
}

/** 每种运行环境对应的扩展名（新建脚本时按它拼文件名）。 */
export const SCRIPT_RUNTIME_EXT: Record<ScriptRuntime, string> = {
  powershell: '.ps1',
  cmd: '.cmd',
  python: '.py',
  node: '.js',
}

/**
 * 把用户输入的名字拼成合法文件名。
 *
 * 只保留纯文件名：路径分隔符与 Windows 保留字符一律去掉 —— 这些字符会让
 * `isSafeScriptFile` 在写之前就把请求拒掉，与其让用户对着"保存失败"发呆，
 * 不如在源头把它们摘干净。
 */
export function scriptFileFor(name: string, runtime: ScriptRuntime): string {
  const base = String(name ?? '')
    .trim()
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 60)
    .trim()
  const ext = SCRIPT_RUNTIME_EXT[runtime] ?? '.txt'
  // 用户自己写了扩展名就不再叠一层（"备份.py" + python 不该变成 "备份.py.py"）
  const stem = base.toLowerCase().endsWith(ext) ? base.slice(0, -ext.length) : base
  return (stem || 'script') + ext
}

/**
 * 树上内联输入的名字 → 文件名。
 *
 * 与 scriptFileFor 的差别是**运行时从哪来**：那个由调用方先选定运行时；
 * 这里没有选择框 —— 用户写 `备份.py` 就是 Python，不写扩展名就按默认的 PowerShell。
 * 少一步选择，也少一个"选了 Python 却忘了改扩展名"的坑。
 */
export function scriptFileFromInput(input: string): string {
  const cleaned = String(input ?? '')
    .trim()
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim()
  if (!cleaned) return ''
  return runtimeOf(cleaned) ? cleaned : cleaned + SCRIPT_RUNTIME_EXT.powershell
}

/** 新脚本的骨架：第一行就是 desc，命令面板与笔记树都按它显示说明。 */
export function scriptTemplate(runtime: ScriptRuntime, description = '说明这个脚本做什么'): string {
  if (runtime === 'cmd') return `@echo off\r\nREM desc: ${description}\r\n\r\necho hello\r\n`
  if (runtime === 'python') return `# desc: ${description}\n\nprint('hello')\n`
  if (runtime === 'node') return `// desc: ${description}\n\nconsole.log('hello')\n`
  return `# desc: ${description}\n\nWrite-Output 'hello'\n`
}

export interface ScriptProblem {
  /** 1 起的行号；0 = 说不清在哪一行（整体性问题） */
  line: number
  message: string
}

/**
 * cmd / bat 的检查。
 *
 * cmd 没有可用的语法解析器（`cmd /c` 只会**执行**它），所以这里只做能确定的检查：
 * 引号与括号的配平。**不假装自己是编译器** —— 宁可漏报，也不要在用户写对了的时候报错：
 * 一次误报就会让人不再相信这个提示。
 */
export function lintBatch(text: string): ScriptProblem[] {
  const problems: ScriptProblem[] = []
  const lines = String(text ?? '').split(/\r?\n/)
  let depth = 0
  /** 引号是否停在"开着"的状态（跨行延续，见下面的说明） */
  let openQuote = false
  lines.forEach((line, i) => {
    const no = i + 1
    // 行尾的 ^ 是续行符：那一行的引号本来就该是不闭合的
    const continued = /\^\s*$/.test(line)
    const body = continued ? line.replace(/\^\s*$/, '') : line
    // 引号要**跨行**看：cmd 里一行开到一半、用 ^ 续到下一行是常见写法，
    // 逐行数字符会把这种正确写法判成错（一次误报就没人再信这个提示了）。
    // 只有"这一行没写续行符、却停在引号里"才是真的没闭合。
    let inQuote = openQuote
    for (const ch of body) if (ch === '"') inQuote = !inQuote
    if (inQuote && !continued) {
      problems.push({ line: no, message: '双引号没有闭合' })
      openQuote = false
    } else {
      openQuote = inQuote
    }
    // 注释行与 goto 标签不参与括号配平
    const trimmed = body.trim()
    if (trimmed.startsWith('REM ') || trimmed.startsWith('::')) return
    depth += (body.match(/\(/g) ?? []).length - (body.match(/\)/g) ?? []).length
    if (depth < 0) {
      problems.push({ line: no, message: '多了一个右括号' })
      depth = 0
    }
  })
  if (depth > 0) problems.push({ line: 0, message: `有 ${depth} 个左括号没有闭合` })
  return problems
}

/**
 * 把解析器的输出解析成「行号 + 消息」。
 *
 * 三种解析器的输出格式各不相同（PowerShell 是 `行号:消息`、Python 是
 * `File "...", line N`、Node 是 `路径:N`），而它们都只在**失败时**才说话。
 * 认不出格式时退化成一条整体消息（line 0）—— 界面上宁可显示一句看不懂的原文，
 * 也不要因为解析失败而显示"没有错误"。
 */
export function parseCheckOutput(output: string): ScriptProblem[] {
  const text = String(output ?? '').trim()
  if (!text) return []
  const lines = text.split(/\r?\n/)
  const problems: ScriptProblem[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    // PowerShell：我们自己拼的「行号:消息」
    const own = /^(\d+):\s*(.+)$/.exec(line)
    if (own) {
      problems.push({ line: Number(own[1]), message: own[2].trim().slice(0, 200) })
      continue
    }
    // Python：File "<unknown>", line 3
    const py = /line (\d+)/.exec(line)
    if (py) {
      problems.push({ line: Number(py[1]), message: '语法错误' })
      continue
    }
    // Node：/tmp/x.js:3（只在还没定位到行时用）
    const nd = /:(\d+)\s*$/.exec(line)
    if (nd && problems.length === 0) {
      problems.push({ line: Number(nd[1]), message: '语法错误' })
    }
  }
  const errLine = lines.find((l) => /(SyntaxError|ParserError|ParseException|Unexpected token)/i.test(l))
  if (problems.length === 0) {
    const tail = lines[lines.length - 1]?.trim() ?? ''
    problems.push({ line: 0, message: (errLine ?? tail).slice(0, 200) || '语法检查未通过' })
  } else if (errLine) {
    problems[0].message = errLine.trim().slice(0, 200)
  }
  return problems
}
