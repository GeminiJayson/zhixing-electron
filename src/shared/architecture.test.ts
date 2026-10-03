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
  it('startReminderDispatch 体内 dispatchReminders 在记账之前', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const at = source.indexOf('function startReminderDispatch')
    expect(at, '找不到 startReminderDispatch').toBeGreaterThan(-1)
    const body = source.slice(at, source.indexOf('\n}', at))
    const push = body.indexOf('dispatchReminders()')
    // 记账 = 写回「第几次提醒」并在次数用完时清 reminder_at。它同样不可回滚。
    const consume = body.indexOf('recordReminderFire(')
    expect(push, '体内应有 dispatchReminders()').toBeGreaterThan(-1)
    expect(consume, '体内应有 recordReminderFire(').toBeGreaterThan(-1)
    expect(push, '必须先派发、后记账').toBeLessThan(consume)
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
 * 而真正在跑的 \`db:archiveFlash\` 与 \`db:linkTaskNote\` 不在表里 —— 写库成功却零广播，
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
        // 表名以 task 开头的**别的表**（task_activity / task_note_link / task_tag …）不是任务本身：
        // 判据漏了这一层，往 task_activity 写一条活动就会被误报成「漏建索引」。
        if (/INSERT INTO task_/.test(line)) return
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
  const listScripts = (): string[] => readdirSync(scriptsDir).filter((n) => n.endsWith('.mjs') && !n.startsWith('.'))

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
      // 用 lib/cdp.mjs 的脚本由 launchApp 统一设 ZHIXING_HOME（并强制拷贝库副本），
      // 不必再在脚本里手写一遍 —— 判据是「隔离有没有落实」，不是「有没有出现这个词」。
      if (src.includes('ZHIXING_HOME') || src.includes("from './lib/cdp.mjs'")) continue
      offenders.push(f)
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
    for (const f of readdirSync(scriptsDir).filter((n) => n.endsWith('.mjs') && !n.startsWith('.'))) {
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

/**
 * 第十三道护栏：提醒卡片与应用弹框共用一套样式。
 *
 * 此前同一个应用里有两张不一样的卡片：提醒用暖色描边 + lg 圆角 + lg 投影，
 * 弹框（以及跑在独立窗口里的捕获 / 条件确认）用 --border + xl 圆角 + xl 投影。
 * 现在三个面共用 .modal，主题换了也只有一处要跟。
 */
describe('架构约束 · 提醒卡片与应用弹框共用一套样式', () => {
  const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')

  it('两个提醒面都用 .modal 那张卡片', () => {
    // 卡片本体后来抽成了 components/ReminderCard.tsx（两个宿主共用一份，见该文件注释），
    // 所以"用 .modal"这件事只需在卡片里成立；两个宿主改成断言"确实用了这张卡"——
    // 否则把宿主换成自绘卡片时，这条护栏会一声不吭地失效。
    expect(
      read('src/renderer/src/components/ReminderCard.tsx'),
      '提醒卡应复用 .modal 卡片'
    ).toContain('modal modal--reminder')
    for (const f of [
      'src/renderer/src/components/ReminderPopup.tsx',
      'src/renderer/src/ReminderApp.tsx'
    ]) {
      expect(read(f), f + ' 应渲染 ReminderCard').toContain('<ReminderCard')
    }
  })

  it('提醒卡片不许再自己画一遍外观', () => {
    const reminderCss = read('src/renderer/src/styles/reminder.css')
    // 判据是「有没有引用卡片外观令牌」，而不是「有没有 background 这个词」——
    // 这个文件本来就要把 surface 的底色压成 transparent（透明窗口的硬性要求）
    for (const token of ['--bg-layer', '--radius-', '--shadow-']) {
      expect(reminderCss.includes(token), 'reminder.css 不该再引用卡片外观令牌 ' + token).toBe(false)
    }
    // 投影是唯一的例外：透明窗口里必须显式去掉（否则被窗口边界裁成方角残影）
    expect(reminderCss).toContain('box-shadow: none')
  })
})

/**
 * 第十四道护栏：检查脚本必须能失败。
 *
 * seedmonitor 覆盖最广，却只打印问题计数、从不设退出码 —— CI 里恒通过。
 * 判据不是「有没有 print」，而是「有没有终止码」：脚本末尾必须有 process.exit 或 exitCode。
 */
describe('架构约束 · 检查脚本必须能失败', () => {
  it('统计了问题的脚本必须有终止码', () => {
    const dir = join(process.cwd(), 'scripts')
    const offenders: string[] = []
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs') && !n.startsWith('.'))) {
      const src = readFileSync(join(dir, f), 'utf8')
      // 只看「收集了失败」的脚本：它们有 problems/failed 之类的计数
      if (!/problems\.length|failed\.length|results\.filter/.test(src)) continue
      if (!/process\.exit\(|process\.exitCode/.test(src)) offenders.push(f)
    }
    // 只报「既统计失败又从不设退出码」的 —— 那才是恒通过的假绿灯
    expect(offenders, '统计了失败却不设退出码，等于这道检查永远不会红').toEqual([])
  })
})
/**
 * 第十五道护栏：任务↔笔记关联必须能掉链。
 *
 * 这张表曾经只增不减 —— 正文里删掉 [[标题]]，⇄N 计数和图谱边永远不消失。
 * 修复靠两件事，缺一不可：写入时记来源（source），对账时按来源删行。
 * 少任何一件，缺陷都会以另一种形式回来：不记来源 → 手动关联被误删；
 * 不删行 → 又变回只增不减。
 */
describe('架构约束 · 任务↔笔记关联必须能掉链', () => {
  const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')
  // 对账逻辑已挪到叶子模块 task-note-links.ts；写入点还剩 linkTaskNote 在 tasks.ts。
  // 两处都要扫 —— 只扫一处正是「改了 A 忘了 B」的老毛病。
  const WRITERS = ['src/main/db/task-note-links.ts', 'src/main/db/tasks.ts']
  const src = WRITERS.map(read).join('\n')

  it('每条 INSERT 都要写明来源，否则对账时分不清该不该删', () => {
    for (const m of src.matchAll(/INSERT OR IGNORE INTO task_note_link[^`]*/g)) {
      expect(m[0], '写 task_note_link 必须带 source 列：' + m[0].slice(0, 80)).toContain('source')
    }
  })

  it('对账函数必须真的删行，而不是只往上加', () => {
    const links = read('src/main/db/task-note-links.ts')
    const fn = links.slice(links.indexOf('export function syncTaskNoteLinks'))
    const body = fn.slice(0, fn.indexOf('export function relinkTasksForTitle'))
    expect(body, 'syncTaskNoteLinks 里没有 DELETE，就又变回只增不减了').toContain(
      'DELETE FROM task_note_link'
    )
    expect(body, '一删一增要同事务，否则会留下半截关联').toContain('c.transaction(')
    // 判定逻辑必须在可单测的纯函数里，别把规则散回 SQL
    expect(body).toContain('planTaskNoteLinks(')
  })

  it('判据表结构：source 列要走 ensureAppExtensions，不许动 SCHEMA_VERSION', () => {
    expect(read('src/main/db/connection.ts')).toContain("add('task_note_link', 'source'")
  })
})
/**
 * 第十六道护栏：CDP 样板只许减少，不许再长。
 *
 * 审计里这是严重项：同一套「拉起 Electron → 连 CDP → send → evaluate → check」
 * 曾在 50 多个脚本里逐字复制，且已经分叉 —— rollcheck 只修了其中一份，
 * 其余同款缺陷就一直留着。样板每多一份，修一处就要想「还有几份没改」。
 *
 * 这一轮只做到「抽出 scripts/lib/cdp.mjs + 迁移能验证的脚本」，没有硬套批量替换：
 * 普查显示 55 个脚本里只剩 7 个还能被机械识别成同一形状，试改 11 个就有 6 个
 * 在样板区段里藏着自己的常量（MARKER / shotDir / root）或第三种 connect() 实现。
 * 盲改只会把 44 个本机验不了的脚本改坏，所以留一条棘轮把现状钉住：
 * 份数只许往下走，迁移一个就把下面的数字减一。
 *
 * 2026-09-22：棘轮 20 → 15。迁移器（scripts/lib/migrate-cdp.mjs）修掉三个真实缺陷后
 * 把 ai* 三家与热键/同步/双链三个脚本迁绿（表达式体箭头函数的函数体写在下一行被丢掉；
 * 正则里的转义括号被当成真括号；改名连接对象时连字符串里的页面侧代码一起改）。
 *
 * 一度想一次迁 11 个，逐条与原版对照后只留了 5 个，其余按「没跑绿就不迁」退回：
 *   - importcheck / officecheck：样板区段里造夹具，而 lib 的 launchApp 会先清空 home
 *     —— 机械迁移必然产出一个读文件 ENOENT 的脚本（迁移器现在直接拒绝这类）。
 *   - aicheck：原版 16/25，迁后更差一项。
 *   - layoutcheck / wfdialog：原版自己也起不来（无法连接渲染进程），无从验证。
 *   - flashhotkeycheck：本机没有可用交互会话，读选区那一项永远为空。
 * 顺带把 lib 的 CDP 超时从 15s 抬到 45s（可配）：wflinkcheck 差点被这 15s 记成迁移回归。
 * 教训：迁移数不是指标，「迁完还跑得动」才是；而跑不动要先分清是脚本坏了还是机器忙。
 */
describe('架构约束 · CDP 样板只许减少', () => {
  const dir = join(process.cwd(), 'scripts')

  it('lib 里必须有完整的一份实现（连接 / id 配对 / 超时 / evaluate）', () => {
    const lib = readFileSync(join(dir, 'lib', 'cdp.mjs'), 'utf8')
    // 判据用结构，不用提示语原文 —— 旧样板里的超时文案已经分了三种，
    // 拿某一种去比，这条断言会变成永远为真的空话。
    expect(lib, 'lib 里没有建立连接').toContain('new WebSocket')
    expect(lib, 'lib 里没有按消息 id 配对').toContain('x.id !== id')
    expect(lib, 'lib 里没有超时').toContain('setTimeout')
    expect(lib, 'lib 里没有 evaluate').toContain('Runtime.evaluate')
  })

  it('已经迁到 lib 的脚本不许再退回自带 WebSocket', () => {
    const migrated: string[] = []
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs') && !n.startsWith('.'))) {
      const code = readFileSync(join(dir, f), 'utf8')
      if (code.includes("from './lib/cdp.mjs'")) migrated.push(f)
    }
    // 迁到库上的脚本至少要凑够本轮验过的那几个，否则有人可能整批退回
    expect(migrated.length, '迁到 lib/cdp.mjs 的脚本太少了').toBeGreaterThanOrEqual(3)
    for (const f of migrated) {
      const code = readFileSync(join(dir, f), 'utf8')
      expect(code.includes('new WebSocket'), f + ' 已经用 lib 了，不该再自己 new WebSocket').toBe(false)
      // 判据是「有没有自己手写 send 的配对逻辑」，不是「有没有出现 Runtime.evaluate」——
      // app.send('Runtime.evaluate', …) 是 lib 提供的接口，用来「发了不等」是正当用法
      //（condwincheck 就是这么 fire 实例化的）。手写配对的标志是自己在监听 message 并按 id 配对。
      expect(code.includes("addEventListener('message'"), f + ' 已经用 lib 了，不该再自己手写 send 配对').toBe(false)
      expect(code.includes('x.id !== id'), f + ' 已经用 lib 了，不该再自己手写 send 配对').toBe(false)
    }
  })

  it('复制着旧样板的脚本份数不得超过 15（只许减）', () => {
    const copies = readdirSync(dir)
      .filter((n) => n.endsWith('.mjs') && !n.startsWith('.'))
      .filter((n) => readFileSync(join(dir, n), 'utf8').includes('new WebSocket'))
    // 棘轮值：迁掉一个就往下改一位。目标是把这里改到 0，然后删掉这条断言。
    expect(copies.length, '又有人复制了 CDP 样板：' + copies.join(', ')).toBeLessThanOrEqual(15)
  })
})
/**
 * 第十七道护栏：笔记出现之后，任务正文里的 [[标题]] 必须能补上链。
 *
 * 缺陷原样：任务正文是**先**写的（那时笔记还不存在），syncTaskNoteLinks 解析不到标题
 * 就不落链，而没有任何人事后再解析一遍 —— 用户看到「[[标题]] 明明写着、⇄N 却是 0」，
 * 全程不报错。所以断言钉在「笔记侧有没有触发回绑」上，而不是钉某个函数的实现。
 */
describe('架构约束 · 笔记出现后任务正文要能补链', () => {
  const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')

  it('新建与改名两条路都要触发回绑', () => {
    const s = read('src/main/db/notes.ts')
    const hits = s.match(/relinkTasksForTitle\(/g) ?? []
    expect(hits.length, 'notes.ts 至少要 3 处调用：新建 1 处 + 改名 2 处（旧标题掉链、新标题补链）').toBeGreaterThanOrEqual(3)
  })

  it('对账模块必须是叶子，不许反向依赖 notes/tasks（否则成环）', () => {
    const s = read('src/main/db/task-note-links.ts')
    expect(s.includes("from './notes'"), 'task-note-links 不能 import notes').toBe(false)
    expect(s.includes("from './tasks'"), 'task-note-links 不能 import tasks').toBe(false)
  })

  it('修复历史数据的显式入口要挂到 IPC 上', () => {
    expect(read('src/main/db/index.ts')).toContain("'db:linkTaskWikiNotes'")
    expect(read('src/preload/index.ts')).toContain('linkTaskWikiNotes')
  })
})

/**
 * 第十九道护栏：catch 不许悄悄吞掉原因。
 *
 * 审计把静默失败列为中优先项（数据层 11 / 页面层 8 / 主进程 10 处）：catch 之后直接
 * 返回 [] / false / 兜底文案，上层分不清「本来就没有」与「出错了」。
 *
 * 三层判据，从宽到严：
 *  A. 全局：不许存在真空 catch（既无代码也无注释）。
 *  B. 命名文件：每个 catch 要么用上错误对象，要么经 quietFailure 报告。
 *  C. 点名过的用户操作路径：必须留下那条记录（这几处曾经是「用户操作悄悄失败」）。
 *
 * C 的清单是要维护的：新增一条用户操作路径时把它加进来，别指望人去记。
 */
describe('架构约束 · catch 不许悄悄吞掉原因', () => {
  const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')

  /** 从 catch 的 { 开始配平花括号，取出整块正文。 */
  const catchBlocks = (src: string): string[] => {
    const out: string[] = []
    const re = /\}\s*catch\s*(?:\(([^)]*)\))?\s*\{/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      let i = m.index + m[0].length
      let depth = 1
      const start = i
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++
        else if (src[i] === '}') depth--
        i++
      }
      out.push(src.slice(start, i - 1))
    }
    return out
  }

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'vendor') walk(p, out)
      } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.includes('.test.')) out.push(p)
    }
    return out
  }

  it('A. 不许有真空 catch（既无代码也无注释）', () => {
    const offenders: string[] = []
    for (const f of [...walk(join(process.cwd(), 'src', 'main')), ...walk(join(process.cwd(), 'src', 'renderer', 'src'))]) {
      for (const b of catchBlocks(readFileSync(f, 'utf8'))) {
        if (b.trim() === '') offenders.push(f.replace(process.cwd(), ''))
      }
    }
    expect(offenders, '空 catch 是最纯的静默失败，至少写清为什么可以忽略').toEqual([])
  })

  it('B. 命名文件的每个 catch 都要用上错误对象或经 quietFailure 报告', () => {
    for (const f of ['src/main/db/fts.ts', 'src/main/db/graph.ts', 'src/main/db/export.ts']) {
      const blocks = catchBlocks(read(f))
      expect(blocks.length, f + ' 里应该还有 catch，锚点可能失效了').toBeGreaterThan(0)
      for (const b of blocks) {
        const reported = b.includes('quietFailure') || /\b(e|err|error)\b/.test(b)
        expect(reported, f + ' 里这段 catch 把原因丢掉了：' + b.trim().slice(0, 60)).toBe(true)
      }
    }
  })

  it('C. 点名过的用户操作路径必须留下记录', () => {
    const REQUIRED: [string, string][] = [
      // 设了快捷键却什么也不发生
      ['src/main/index.ts', '注册全局快捷键'],
      // 导出会静默少文件
      ['src/main/db/export.ts', '导出时遍历目录'],
      // 附件列表显示成 0 字节，像文件坏了
      ['src/main/db/attachments.ts', '读取附件大小'],
      // 下面四处：加载失败会显示成「空列表」，看起来像数据没了
      ['src/renderer/src/pages/TasksPage.tsx', '读取智能清单'],
      ['src/renderer/src/components/WorkflowConditionEditor.tsx', '读取任务候选'],
      ['src/renderer/src/pages/WorkflowPage.tsx', '读取笔记候选'],
      ['src/renderer/src/pages/SettingsPage.tsx', '读取附件统计']
    ]
    for (const [f, scope] of REQUIRED) {
      expect(read(f), f + ' 里少了 quietFailure 记录：' + scope).toContain(scope)
    }
  })
})
/**
 * 第二十道护栏：E2E 默认必须跑夹具库，不许默认拷用户的生产库。
 *
 * 这条是被真实事故推出来的：脚本一直拷真实库来跑，等生产库里灌进 167 条种子数据之后，
 * 凡「照着列表里有什么来找自己那条」的脚本开始成片失败 —— 而「绿」也就不再等价于
 * 「功能正常」，只是「库恰好长得合适」。基线随用户数据漂移，报告出来的通过率没有意义。
 *
 * 夹具 = 给一个空目录，应用启动时 seedIfEmpty() 生成固定基线（两个分组 + 我的清单
 * + 2 条欢迎任务 + 1 篇欢迎笔记），lib 再补齐每种格式的示例笔记与一个工作流实例。
 * 确实需要真实数据的脚本要**显式**传 copyDb: true。
 */
describe('架构约束 · E2E 默认跑夹具库', () => {
  it('launchApp 的默认必须是夹具（copyDb = false）', () => {
    const lib = readFileSync(join(process.cwd(), 'scripts', 'lib', 'cdp.mjs'), 'utf8')
    expect(lib, '默认改回拷生产库，基线就会重新随用户数据漂移').toContain('copyDb = false')
    expect(lib.includes('copyDb = true,'), '只有脚本显式传参时才允许拷真实库').toBe(false)
  })

  it('夹具要覆盖脚本依赖的那几样内容', () => {
    const lib = readFileSync(join(process.cwd(), 'scripts', 'lib', 'cdp.mjs'), 'utf8')
    // 一批脚本要「找到一篇富文本/word 笔记」，另一批要「实例项也有编辑胶囊」
    expect(lib, '夹具没有补齐笔记格式').toContain('richtext')
    expect(lib, '夹具没有造工作流实例').toContain('instantiateWorkflow')
  })
})
/**
 * 第二十一道护栏：INSERT 的列数与值数必须一致。
 *
 * 这条是被一个真 bug 逼出来的：cloneTaskTree 的 INSERT 列了 17 列、VALUES 只给了 16 个值
 * （少的是 repeat_rule 的占位符）。后果是**勾选一个循环任务直接抛**
 * SqliteError: 16 values for 17 columns —— 克隆下一次子任务失败，用户根本勾不动重复任务。
 *
 * 为什么一直没人发现：SQLite 只在**执行到**这条语句时才报错，而写它的那条路径
 * （顶层任务 + repeat_period != none）不是每次自测都会走到。静态数一遍括号就抓得住。
 */
describe('架构约束 · INSERT 的列数与值数必须一致', () => {
  const dir = join(process.cwd(), 'src', 'main', 'db')
  const grab = (s: string, start: number): { text: string; end: number } | null => {
    let depth = 0
    for (let i = start; i < s.length; i++) {
      if (s[i] === '(') depth++
      else if (s[i] === ')') {
        depth--
        if (depth === 0) return { text: s.slice(start + 1, i), end: i }
      }
    }
    return null
  }

  it('每条 INSERT ... VALUES 的两边个数都要对得上', () => {
    const offenders: string[] = []
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.includes('.test.'))) {
      const src = readFileSync(join(dir, f), 'utf8')
      const re = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(/gi
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) {
        const line = src.slice(0, m.index).split('\n').length
        const cols = grab(src, m.index + m[0].length - 1)
        if (!cols) continue
        const vIdx = src.indexOf('VALUES', cols.end)
        if (vIdx < 0) continue
        const after = src.slice(vIdx + 6).trimStart()
        if (!after.startsWith('(')) continue // INSERT ... SELECT：值来自查询，不在这里数
        const vals = grab(src, vIdx + 6 + (src.slice(vIdx + 6).length - after.length))
        if (!vals) continue
        // 值里带函数调用/子表达式的，逗号数不可靠，跳过
        if (/[()]/.test(vals.text.replace(/\([^()]*\)/g, ''))) continue
        const nc = cols.text.split(',').length
        const nv = vals.text.split(',').length
        if (nc !== nv) offenders.push(f + ':' + line + ' ' + m[1] + ' 列=' + nc + ' 值=' + nv)
      }
    }
    expect(offenders, 'INSERT 的列与值个数不一致，执行到就会抛 SqliteError').toEqual([])
  })
})

/**
 * 架构约束：判断「这个 URL 是不是应用自己的页面」必须做精确比较。
 *
 * 这条判定守着 will-navigate —— 命中就放行。原实现是 url.startsWith(自身 URL)，于是
 *   http://localhost:5173.evil.com/    （dev 分支）
 *   file:///…/renderer/index.html.evil （**打包分支也中**）
 * 都以前缀命中被放行，外部页面会进到一个带着 preload 与全部 IPC 的窗口里。
 *
 * 单独写护栏而不是只留单测，是因为这个函数太容易被"顺手简化"回前缀比较：
 * startsWith 看起来等价，而唯一能拦住的证据是那两个畸形 URL。
 */
describe('架构约束 · 自身 URL 判定必须是精确比较', () => {
  // 只看代码，注释里为解释这个缺陷提到 startsWith 不该算违规
  const code = (rel: string): string =>
    readFileSync(join(process.cwd(), rel), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
  const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

  it('security.ts 与 shared/app-url.ts 里都不许出现 startsWith', () => {
    const offenders = ['src/main/security.ts', 'src/shared/app-url.ts'].filter((f) => code(f).includes('startsWith'))
    expect(offenders, 'URL 前缀匹配会被 localhost:5173.evil.com / index.html.evil 绕过').toEqual([])
  })

  it('security.ts 的判定必须来自 shared/app-url，不许就地实现', () => {
    expect(read('src/main/security.ts')).toContain("from '../shared/app-url'")
  })
})

/**
 * 布局方向只用于「打开模板时按当前方向排一次」。原实现把 rankdir 放进了 openTemplate
 * 的 useCallback 依赖，而下面的初始化 effect 又依赖 openTemplate —— 于是**切换方向就会
 * 重跑初始化**，把用户正在看的模板换成列表里的第一个。修法是用 ref 读最新方向。
 *
 * 之所以写成断言而不是只留注释：把 rankdir 加回依赖数组看起来正是「补全依赖」的规范操作，
 * 只有这条回归断言能拦住它。
 */
describe('架构约束 · 切换布局方向不得重置当前模板', () => {
  const src = readFileSync(join(process.cwd(), 'src/renderer/src/pages/WorkflowPage.tsx'), 'utf8')
  const grab = (): RegExpExecArray | null =>
    /const openTemplate = useCallback\(([\s\S]*?)\n  \}, \[([^\]]*)\]\)/.exec(src)

  it('openTemplate 的依赖里不许有 rankdir', () => {
    const m = grab()
    if (!m) throw new Error('没找到 openTemplate 的 useCallback')
    expect(m[2], 'rankdir 回到依赖里 → 切换方向会重跑初始化、把当前模板换成列表第一个').not.toContain('rankdir')
  })

  it('openTemplate 里读的是 rankdirRef.current', () => {
    const m = grab()
    if (!m) throw new Error('没找到 openTemplate 的 useCallback')
    expect(m[1]).toContain('rankdirRef.current')
  })
})
