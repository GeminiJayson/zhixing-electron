/**
 * 保存的查询（智能清单）的表达式解析与匹配。
 *
 * 设计取舍：**纯函数 + 渲染层过滤**。任务列表本来就已经加载在内存里（个人库，量级可控），
 * 先做「语法 → 条件 → 过滤」这一层，不急着把 SQL 下推 —— 下推是优化，不是功能。
 *
 * 支持的写法（空格分隔，全部可选，多个条件之间是「与」）：
 *   `text:关键词`      标题或备注包含关键词
 *   `tag:写作`          任务带这个标签（需要调用方传入标签数组）
 *   `list:工作`         清单名（或纯数字 = 清单 id）
 *   `!done` / `done`    未完成 / 已完成
 *   `status:todo`       指定状态（todo / done / abandoned / waiting）
 *   `priority>=3`       优先级比较（支持 > >= < <= =）
 *   `due<today`         截止日期比较；today / tomorrow / overdue 是关键字，
 *                        也可以写 `due<2026-10-01` 或 `due=none`（没有截止）
 *   `@today`            别名：截止就是今天
 */
export interface ParsedQuery {
  text: string
  tag: string
  list: string
  status: string | null
  notDone: boolean | null
  priority: { op: '>' | '>=' | '<' | '<=' | '='; value: number } | null
  due: { op: '<' | '<=' | '>' | '>=' | '='; value: string } | null
  /** 解析时无法识别的片段，用于在 UI 上提示「这几段没懂」 */
  unknown: string[]
}

export interface QueryTask {
  title: string
  notes_md?: string | null
  status?: string | null
  priority?: number | null
  due_date?: string | null
  list_id?: number | null
}

export interface QueryContext {
  /** 任务标签（可选；不传则 tag: 条件不生效） */
  tags?: string[]
  /** 清单 id → 名称（用于 list:名称 匹配） */
  listNames?: Record<number, string>
  /** 当前日期 YYYY-MM-DD（便于测试注入） */
  today: string
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function offsetDate(today: string, days: number): string {
  const d = new Date(today + 'T00:00:00')
  d.setDate(d.getDate() + days)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/** 把 today / tomorrow / overdue 这类关键字折算成可比较的日期字符串 */
export function resolveDueToken(token: string, today: string): string | null {
  const t = token.trim().toLowerCase()
  if (t === 'today') return today
  if (t === 'tomorrow') return offsetDate(today, 1)
  if (t === 'yesterday') return offsetDate(today, -1)
  if (t === 'none' || t === 'null') return ''
  if (DATE_RE.test(t)) return t
  return null
}

export function parseQuery(expr: string): ParsedQuery {
  const out: ParsedQuery = {
    text: '',
    tag: '',
    list: '',
    status: null,
    notDone: null,
    priority: null,
    due: null,
    unknown: [],
  }
  for (const raw of (expr ?? '').split(/\s+/)) {
    const token = raw.trim()
    if (!token) continue
    if (token.startsWith('!')) {
      const word = token.slice(1).toLowerCase()
      if (word === 'done') out.notDone = true
      else out.unknown.push(token)
      continue
    }
    const m = /^([a-zA-Z]+)(<=|>=|<|>|=)(.*)$/.exec(token)
    if (m) {
      const [, key, op, value] = m
      const field = key.toLowerCase()
      if (field === 'priority') {
        const n = Number(value)
        if (Number.isFinite(n)) out.priority = { op: op as '>' | '>=' | '<' | '<=' | '=', value: n }
        else out.unknown.push(token)
      } else if (field === 'due' || field === 'reminder') {
        out.due = { op: op as '<' | '<=' | '>' | '>=' | '=', value: value.trim().toLowerCase() }
      } else {
        out.unknown.push(token)
      }
      continue
    }
    if (token.startsWith('@')) {
      out.due = { op: '=', value: token.slice(1).trim().toLowerCase() }
      continue
    }
    const mm = /^([a-zA-Z]+):(.*)$/.exec(token)
    if (mm) {
      const field = mm[1].toLowerCase()
      const value = mm[2].trim()
      if (field === 'text') out.text = value
      else if (field === 'tag') out.tag = value
      else if (field === 'list') out.list = value
      else if (field === 'status') out.status = value.toLowerCase()
      else if (field === 'done') out.notDone = !(value === '1' || value.toLowerCase() === 'true')
      else out.unknown.push(token)
      continue
    }
    // 裸词当全文搜索
    out.text = out.text ? out.text + ' ' + token : token
  }
  return out
}

function cmp(a: string, op: string, b: string): boolean {
  if (op === '<') return a < b
  if (op === '<=') return a <= b
  if (op === '>') return a > b
  if (op === '>=') return a >= b
  return a === b
}

/** 单条任务是否命中查询；`ctx` 提供标签、清单名与「今天」 */
export function matchTask(task: QueryTask, q: ParsedQuery, ctx: QueryContext): boolean {
  if (q.notDone === true && task.status === 'done') return false
  if (q.notDone === false && task.status !== 'done') return false
  if (q.status && (task.status ?? 'todo') !== q.status) return false

  if (q.text) {
    const hay = ((task.title ?? '') + '\n' + (task.notes_md ?? '')).toLowerCase()
    if (!hay.includes(q.text.toLowerCase())) return false
  }
  if (q.tag) {
    const tags = ctx.tags ?? []
    if (!tags.some((t) => t.toLowerCase() === q.tag.toLowerCase())) return false
  }
  if (q.list) {
    const byId = /^\d+$/.test(q.list) && Number(task.list_id) === Number(q.list)
    const name = ctx.listNames?.[Number(task.list_id ?? -1)] ?? ''
    if (!byId && name.toLowerCase() !== q.list.toLowerCase()) return false
  }
  if (q.priority) {
    const p = Number(task.priority ?? 0)
    const pass =
      q.priority.op === '>' ? p > q.priority.value
      : q.priority.op === '>=' ? p >= q.priority.value
      : q.priority.op === '<' ? p < q.priority.value
      : q.priority.op === '<=' ? p <= q.priority.value
      : p === q.priority.value
    if (!pass) return false
  }
  if (q.due) {
    const due = (task.due_date ?? '').slice(0, 10)
    if (q.due.value === 'overdue') {
      // overdue 是关键字，不走日期折算
      if (!due || due >= ctx.today) return false
    } else {
      const resolved = resolveDueToken(q.due.value, ctx.today)
      if (resolved === null) return false
      if (resolved === '') {
        // due=none：只留没有截止的
        if (q.due.op !== '=' || due !== '') return false
      } else {
        if (!due) return false
        if (!cmp(due, q.due.op, resolved)) return false
      }
    }
  }
  return true
}

export function filterTasks<T extends QueryTask>(
  tasks: T[],
  expr: string,
  ctx: Omit<QueryContext, 'today'> & { today: string; tagsOf?: (t: T) => string[] }
): T[] {
  const q = parseQuery(expr)
  return tasks.filter((t) =>
    matchTask(t, q, {
      today: ctx.today,
      listNames: ctx.listNames,
      // 标签是「每个任务各自的」：调用方给 tagsOf 就逐个取，否则用全局 tags
      tags: ctx.tagsOf ? ctx.tagsOf(t) : ctx.tags,
    })
  )
}
