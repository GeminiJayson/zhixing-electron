import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 架构约束：渲染层不得在循环体内逐条调用 IPC。
 *
 * 为什么需要一条「扫源码」的测试：事务无法跨进程，所以 `for (...) await db.xxx()` 这种写法
 * 在第 N 条失败时，前 N-1 条已经落库，原理上就不可能原子。正确做法是收敛成单个批量 IPC
 * —— 主进程在一个事务里做完（见 docs/adr/0001-多步写的事务收口.md）。
 *
 * 这条约束以前只写在约定里，代价是可验证的：`batchMove` 明明三层齐全
 * （task-ops.ts:118 / db/index.ts:273 / preload/index.ts:526），TasksPage.tsx:588 却仍然
 * 手写循环逐条调 moveTaskToList。**约定拦不住，断言才拦得住。**
 */

/** 从仓库根遍历出所有需要检查的渲染层源码。 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'node_modules') continue
      walk(p, out)
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')) {
      out.push(p)
    }
  }
  return out
}

/** 缩进宽度（空格数；tab 记 2）。 */
const indentOf = (line: string): number => {
  const m = /^[ \t]*/.exec(line)
  if (!m) return 0
  return m[0].replace(/\t/g, '  ').length
}

/**
 * 找出「循环体内直接 await IPC」的位置。
 *
 * 覆盖两种写法：单行 `for (...) await db.x()`，以及块形式的 `for (...) { ... await db.x() ... }`
 * （块从 for 行往后扫，遇到缩进回落到 for 自身层级且以 } 开头的行为止）。
 */
export function findLoopIpc(source: string): { line: number; text: string }[] {
  const lines = source.split('\n')
  const hits: { line: number; text: string }[] = []
  const isCall = (s: string): boolean => /await\s+window\.zhixing\.db\./.test(s)
  for (let i = 0; i < lines.length; i++) {
    if (!/\bfor\s*\(/.test(lines[i])) continue
    if (isCall(lines[i])) {
      hits.push({ line: i + 1, text: lines[i].trim() })
      continue
    }
    const base = indentOf(lines[i])
    for (let j = i + 1; j < lines.length; j++) {
      const cur = lines[j]
      if (cur.trim() === '') continue
      if (indentOf(cur) <= base && /^\s*}/.test(cur)) break
      if (isCall(cur)) {
        hits.push({ line: j + 1, text: cur.trim() })
        break
      }
    }
  }
  return hits
}

describe('架构约束 · 渲染层不得在循环里逐条调 IPC', () => {
  it('扫遍 src/renderer/src 后一处都不该有', () => {
    const files = walk(join(process.cwd(), 'src', 'renderer', 'src'))
    expect(files.length).toBeGreaterThan(20)
    const offenders: string[] = []
    for (const f of files) {
      for (const hit of findLoopIpc(readFileSync(f, 'utf8'))) {
        offenders.push(`${f.replace(process.cwd(), '')}:${hit.line}  ${hit.text.slice(0, 90)}`)
      }
    }
    expect(offenders, '循环内逐条 IPC 会把一致性边界交到渲染层，请改用批量入口').toEqual([])
  })

  it('检测器本身要能抓到单行与块形式（防止护栏空转）', () => {
    expect(findLoopIpc('for (const id of ids) await window.zhixing.db.deleteTask(id)')).toHaveLength(1)
    expect(
      findLoopIpc(['for (const id of ids) {', '  await window.zhixing.db.deleteTask(id)', '}'].join('\n'))
    ).toHaveLength(1)
    expect(findLoopIpc('const rows = await window.zhixing.db.tasks()')).toHaveLength(0)
  })
})

/**
 * 第二道护栏：已收口的多步写必须真的包在事务里。
 *
 * 为什么用静态断言而不是「注入失败看回滚」：回滚是 better-sqlite3 保证的行为，这里能出错的
 * 只是「有没有用上它」。而 db 层跑在 Electron ABI 的 better-sqlite3 上，vitest 里拿不到连接，
 * 所以把「事务是否在场」这条钉在源码层更有效 —— 有人删掉事务，这条就红。
 */
describe('架构约束 · 已知的多步写必须包事务', () => {
  /** 取顶层函数体：到下一个列 0 的 } 为止（这些函数都定义在模块顶层）。 */
  const bodyOf = (source: string, decl: string): string => {
    const at = source.indexOf(decl)
    if (at < 0) return ''
    const end = source.indexOf('\n}', at)
    return source.slice(at, end < 0 ? source.length : end)
  }

  const cases: [string, string][] = [
    ['src/main/db/notes.ts', 'export function saveNote'],
    ['src/main/db/inbox.ts', 'export function mergeFlashes'],
    ['src/main/db/workflow.ts', 'export async function instantiateWorkflow'],
    ['src/main/task-sync.ts', 'export async function syncExternalTasks'],
  ]

  it.each(cases)('%s 的 %s 体内出现 transaction(', (file, decl) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8')
    const body = bodyOf(source, decl)
    expect(body, `在 ${file} 里找不到 ${decl}`).not.toBe('')
    expect(body).toContain('transaction(')
  })
})

/**
 * 第三道护栏：提醒派发的顺序约束 —— 必须先派发、后消费。
 *
 * 消费（清 reminder_at）不可回滚。先消费后派发的话，派发一旦抛错，那一批就永远推不出去了
 * （activeReminders 非空 → 下一轮 tick 直接 return）。这条断言把顺序钉住。
 */
describe('架构约束 · 提醒必须先派发后消费', () => {
  it('startReminderDispatch 体内 dispatchReminders 在 dismissReminder 之前', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const at = source.indexOf('function startReminderDispatch')
    expect(at, '找不到 startReminderDispatch').toBeGreaterThan(-1)
    const body = source.slice(at, source.indexOf('\n}', at))
    const push = body.indexOf('dispatchReminders()')
    const consume = body.indexOf('dismissReminder(')
    expect(push, '体内应有 dispatchReminders()').toBeGreaterThan(-1)
    expect(consume, '体内应有 dismissReminder(').toBeGreaterThan(-1)
    expect(push, '必须先派发、后消费').toBeLessThan(consume)
  })
})

/**
 * 第四道护栏：preload 的每个 on* 订阅都必须返回取消函数。
 *
 * 契约不一致的代价是实打实的：12 个订阅里曾有 10 个返回 void，调用方写不出 cleanup，
 * 渲染层只好在注释里写「没有取消订阅接口：只注册一次」—— 而 effect 每跑一次就叠一层监听，
 * 一次 delta 触发 N 次旧闭包回调（GraphPage 就是这样，进出一次图谱页加一层）。
 */
describe('架构约束 · preload 订阅必须可取消', () => {
  it('每个 on* 都返回 () => void，没有返回 void 的', () => {
    const lines = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8').split('\n')
    const bad: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s+(on[A-Z]\w*):\s*\(/.exec(lines[i])
      if (!m) continue
      // 只看签名区（声明最多跨三行）：必须声明返回一个取消函数。
      // 不能往后多看 —— 函数体里那句 handler 声明本身就写着 `): void =>`，会误伤。
      const sig = lines.slice(i, i + 4).join(' ')
      if (!/\(\(\) => void\)\s*=>/.test(sig)) bad.push(m[1] + ' @' + (i + 1))
    }
    expect(bad, '订阅接口必须返回 () => void，调用方才有 cleanup 可用').toEqual([])
  })
})

/**
 * 第五道护栏：HTML 消毒只有一份实现。
 *
 * 曾经有两套：shared 的白名单（逐 token、默认拒绝）和 MarkdownView 里的黑名单。
 * 黑名单挡不住 \`java\tscript:\`（浏览器解析 URL 会剥掉 tab），而笔记正文来自导入/粘贴/AI。
 * 共享模块自己的注释就写着「两边各写一套必然漂移」—— 那就让断言来保证不会再有第二套。
 */
describe('架构约束 · HTML 消毒只有一份', () => {
  it('MarkdownView 不得自建 sanitize，必须用 shared 的白名单', () => {
    const src = readFileSync(join(process.cwd(), 'src/renderer/src/components/MarkdownView.tsx'), 'utf8')
    expect(src, 'MarkdownView 又自建了一套消毒').not.toMatch(/function\s+sanitize\s*\(/)
    expect(src, '必须 import shared 的 sanitizeHtml').toContain("from '@shared/sanitize-html'")
  })
})

/**
 * 第六道护栏：广播域表不许漂移。
 *
 * \`handle(channel, fn)\` 靠 \`WRITE_DOMAINS[channel]\` 决定写完之后广播哪个域 —— 这个「写在哪生效」
 * 的知识是手抄的。审计发现它已经漂了两处：\`db:setFlashStatus\` 是死键（通道从未注册），
 * 而真正在跑的 \`db:archiveFlash\` 与 \`db:attachTaskNote\` 不在表里 —— 写库成功却零广播，
 * 其它页面与浮窗就停在旧数据上，而且不报错。
 */
describe('架构约束 · 广播域表不许漂移', () => {
  const src = readFileSync(join(process.cwd(), 'src/main/db/index.ts'), 'utf8')
  const tableStart = src.indexOf('const WRITE_DOMAINS')
  // 去掉行注释再取键，免得注释里提到的通道名被当成表项
  const table = src
    .slice(tableStart, src.indexOf('\n}', tableStart))
    .replace(/\/\/[^\n]*/g, '')
  const keys = new Set([...table.matchAll(/'([^']+)'\s*:/g)].map((m) => m[1]))
  const handlers = new Set(
    [...src.matchAll(/(?:handle|ipcMain\.on)\(\s*'([^']+)'/g)].map((m) => m[1])
  )

  it('表里不能有指向不存在通道的死键', () => {
    expect(keys.size).toBeGreaterThan(50)
    expect(
      [...keys].filter((k) => !handlers.has(k)),
      '死键永远触发不到广播 —— 它只让这张表看起来是完整的'
    ).toEqual([])
  })

  it('形如写操作的通道必须登记（否则写库成功却零广播）', () => {
    // 只在通道名**开头**匹配动词，且要求紧跟大写字母（camelCase 后缀）——
    // 否则 db:tags / db:settings / db:attachments 这类读通道会被动词子串误伤
    const WRITE =
      /^db:(set|update|create|delete|add|remove|attach|detach|archive|unarchive|move|rename|restore|purge|empty|batch|instantiate|save|toggle)[A-Z]/
    // 两个有意豁免，各有明确理由（不是漏登记）：
    //   db:createBlankOffice —— 只写文件，不写库
    //   db:restoreBackup     —— 整体替换库，在 handler 里显式广播全部五个域
    const EXEMPT = new Set(['db:createBlankOffice', 'db:restoreBackup'])
    expect(
      [...handlers].filter((c) => WRITE.test(c) && !keys.has(c) && !EXEMPT.has(c)),
      '写通道必须在 WRITE_DOMAINS 里登记域'
    ).toEqual([])
  })
})

/**
 * 第七道护栏：每个直接 INSERT task 的地方都要建全文索引。
 *
 * 任务的正规写入口是 tasks.ts / task-ops.ts 的仓储函数，它们会调 reindexTask。
 * 但工作流派根任务与步骤任务、闪念转任务/子任务都自己写了 INSERT —— 审计发现这四处
 * 都漏了索引，于是这些任务在用户**手工改一次标题**之前，全局搜索永远搜不到。
 */
describe('架构约束 · 直接插入的任务必须建索引', () => {
  it('src/main/db 下每处 INSERT INTO task 附近都要有 reindexTask', () => {
    const dir = join(process.cwd(), 'src/main/db')
    const missing: string[] = []
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.includes('.test.'))) {
      const lines = readFileSync(join(dir, f), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!line.includes('INSERT INTO task')) return
        // 索引重建可能在这个函数靠后的位置（cloneTaskTree 是递归插完再重建），给足窗口
        const window = lines.slice(i, i + 40).join('\n')
        if (!/reindexTask\(/.test(window)) missing.push(f + ':' + (i + 1))
      })
    }
    expect(missing, '直接 INSERT 的任务绕过了仓储函数，索引必须自己补').toEqual([])
  })
})

/**
 * 第八道护栏：任务「完成态」只有一个判据。
 *
 * 审计发现它有 4 份实现，实际清下来是 **9 处**（shared/task.ts 的 isTerminal、
 * TargetSelector 的本地副本、TasksPage 三处内联、query.ts 一份只认 status==='done' 的、
 * 还有看板/日历/四象限各一处）。分叉的后果是**同一条任务在不同视图里结论相反**：
 * abandoned 在列表与看板上显示为已完成，在 \`!done\` 智能清单里却被当成未完成。
 */
describe('架构约束 · 完成态判据只有一份', () => {
  it('渲染层与 shared 不得再手写 done+abandoned 的内联判定', () => {
    const offenders: string[] = []
    for (const root of ['src/renderer/src', 'src/shared']) {
      for (const f of walk(join(process.cwd(), root))) {
        readFileSync(f, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            // 只抓「任务终态」那种写法；工作流实例的 status==='running'/'done' 不受影响
            if (/status\s*===\s*'done'\s*\|\|\s*\w+\.status\s*===\s*'abandoned'/.test(line)) {
              offenders.push(f.replace(process.cwd(), '') + ':' + (i + 1))
            }
          })
      }
    }
    expect(offenders, '完成态请统一用 @shared/task 的 isTerminal').toEqual([])
  })

  it('query.ts 的匹配走 isTerminal，而不是自己比较 status', () => {
    const src = readFileSync(join(process.cwd(), 'src/shared/query.ts'), 'utf8')
    expect(src).toContain('isTerminal')
    // 去掉行注释再查：解释「原先怎么错」的注释里必然会出现这个写法，那不算违规
    const code = src.replace(/\/\/[^\n]*/g, '')
    expect(code, "不要再手写 status === 'done'").not.toMatch(/status\s*===\s*'done'/)
  })
})

/**
 * 第九道护栏：图谱的「全图基线」只能由全图视图写。
 *
 * graphCache / graphParams 是模块级共享状态，graphDelta() 拿它当上一帧做增量 diff。
 * 邻域查询（在图页点一下节点就会调）原先也走 buildGraphTracked，把基线换成了子图 ——
 * 此后每次写入算出的 diff 都把子图之外的节点当成「已删除」，界面闪出幻影增删。
 */
describe('架构约束 · 图谱基线只由全图视图更新', () => {
  it('graphNeighborhood 不得调用 buildGraphTracked', () => {
    const src = readFileSync(join(process.cwd(), 'src/main/db/graph.ts'), 'utf8')
    const at = src.indexOf('export function graphNeighborhood')
    expect(at, '找不到 graphNeighborhood').toBeGreaterThan(-1)
    // 剥掉行注释再查：解释「原先为什么错」的注释里必然会出现那个名字（这条护栏第一版就踩过）
    const body = src
      .slice(at, src.indexOf('\n}', at))
      .replace(/\/\/[^\n]*/g, '')
    expect(body, '邻域是另一个视图，不能覆盖全图基线').not.toContain('buildGraphTracked')
  })
})

/**
 * 第十道护栏：右键菜单只能有一个 owner。
 *
 * MarkdownEditor 原先有两条右键路径：`view.dom` 上挂的原生 contextmenu（做「关联任务」），
 * 以及外层 div 的 React onContextMenu（做「转为任务」）。事件从 view.dom 冒泡到外层，
 * 两边各自 preventDefault、各自开面板 —— 位置完全重叠，用户看到两个菜单摞在一起。
 */
describe('架构约束 · 右键菜单只有一个 owner', () => {
  it('MarkdownEditor 不得再挂原生 contextmenu 监听', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/MarkdownEditor.tsx'),
      'utf8'
    )
    const code = src.replace(/\/\/[^\n]*/g, '')
    expect(code, '同一次右键两个 owner 会弹出两个重叠菜单').not.toMatch(
      /addEventListener\(\s*'contextmenu'/
    )
  })
})

/**
 * 第十一道护栏：验证脚本不得污染真实库。
 *
 * 两个曾经同时存在的毛病，正好互相遮蔽：13 个脚本的「真实库未被写入」断言全用 macOS 路径
 * （Windows 上 process.env.HOME 是 undefined，join 直接抛 TypeError），于是**断言从未执行**；
 * 而 capture.mjs 又没设 ZHIXING_HOME，跑一次截图就把用户的 theme_mode 改掉了。
 * 断言失效 → 污染一直没人发现。
 */
describe('架构约束 · 验证脚本不得污染真实库', () => {
  const scriptsDir = join(process.cwd(), 'scripts')
  const listScripts = (): string[] => readdirSync(scriptsDir).filter((n) => n.endsWith('.mjs'))

  it('scripts 里不得出现 macOS 的库路径（只看代码，不算注释）', () => {
    const offenders: string[] = []
    for (const f of listScripts()) {
      readFileSync(join(scriptsDir, f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const t = line.trim()
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
          if (t.includes('Library/Application Support')) offenders.push(f + ':' + (i + 1))
        })
    }
    expect(offenders, 'Windows 上这些断言会抛错而不是失败，等于从未执行').toEqual([])
  })

  it('会写设置的脚本必须隔离 ZHIXING_HOME', () => {
    const offenders: string[] = []
    for (const f of listScripts()) {
      const src = readFileSync(join(scriptsDir, f), 'utf8')
      if (!/\.db\.setSetting\(|\.db\.setSettings\(/.test(src)) continue
      if (!src.includes('ZHIXING_HOME')) offenders.push(f)
    }
    expect(offenders, '写设置的脚本必须把 ZHIXING_HOME 指到库副本，否则改的是用户真实数据').toEqual([])
  })
})

/**
 * 第十二道护栏：验证脚本不许依赖外部 CLI。
 *
 * 一批脚本用 `execFileSync('sqlite3', ...)` 读库 —— 那要先装 sqlite3 命令行，本机与 CI 都没有。
 * 后果不是「报错很明显」，而是**脚本一跑到 sql() 就 ENOENT 崩掉，后面那些断言根本没机会执行**：
 * 其中就包括「真实库未被写入」——唯一能发现测试污染用户数据的关卡。
 * 改用 Node 自带的 node:sqlite（Node 22+）即可，不引外部依赖，也避开了 better-sqlite3 的 Electron ABI。
 */
describe('架构约束 · 验证脚本不依赖外部 CLI', () => {
  it('scripts 里不得再调 execFileSync(\'sqlite3\')', () => {
    const scriptsDir = join(process.cwd(), 'scripts')
    const offenders: string[] = []
    for (const f of readdirSync(scriptsDir).filter((n) => n.endsWith('.mjs'))) {
      const code = readFileSync(join(scriptsDir, f), 'utf8')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
      if (code.includes("execFileSync('sqlite3'") || code.includes('execFileSync("sqlite3"')) {
        offenders.push(f)
      }
    }
    expect(offenders, '本机没有 sqlite3 CLI —— 这些调用会让脚本在断言之前就崩掉').toEqual([])
  })
})
