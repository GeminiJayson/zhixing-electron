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
import { isTerminal } from './task'
import type { TaskStatus } from './types'

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
  /**
   * 该任务的**有效完成态**（含 roll-up）。
   *
   * 列表里「子任务全部完成的父任务」显示为已完成，而 QueryTask 只是扁平一条、没有子嗣信息，
   * 所以这份判断必须由调用方注入（TasksPage 本来就算了 effectiveDoneMap）。
   * 不传则退化为「自身是否终态」。
   */
  doneOf?: (task: QueryTask) => boolean
}

/**
 * due 允许出现的值。
 *
 * 校验放在**解析期**：原先解析照单全收、匹配期 resolveDueToken 返回 null 就 return false，
 * 于是 \`due<瞎写\` 会把整张智能清单滤成空，而且一声不响。
 * （overdue 是关键字，不经 resolveDueToken 折算，所以这里要单独列出来。）
 */
function isValidDueValue(value: string): boolean {
  const v = value.trim().toLowerCase()
  return (
    v === 'today' ||
    v === 'tomorrow' ||
    v === 'yesterday' ||
    v === 'overdue' ||
    v === 'none' ||
    v === 'null' ||
    DATE_RE.test(v)
  )
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
        const v = value.trim().toLowerCase()
        // 认不出的值记进 unknown，交给 UI 提示 —— 而不是留到匹配期把清单滤空
        if (isValidDueValue(v)) out.due = { op: op as '<' | '<=' | '>' | '>=' | '=', value: v }
        else out.unknown.push(token)
      } else {
        out.unknown.push(token)
      }
      continue
    }
    if (token.startsWith('@')) {
      const v = token.slice(1).trim().toLowerCase()
      if (isValidDueValue(v)) out.due = { op: '=', value: v }
      else out.unknown.push(token)
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
    // 裸词 done = 已完成。文档第 11 行承诺过这个写法，但此前它落进了下面的全文搜索 ——
    // 用户以为筛出了已完成任务，其实是在搜标题里带「done」的任务。
    if (token.toLowerCase() === 'done') {
      out.notDone = false
      continue
    }
    // 其余裸词当全文搜索
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
  // 完成态按「终态」判：abandoned 与 done 一样在界面上显示为已完成。
  // 原先只认 status === 'done'，于是 !done 把 abandoned 当未完成 —— 与列表的结论正好相反。
  const done = ctx.doneOf ? ctx.doneOf(task) : isTerminal((task.status ?? 'todo') as TaskStatus)
  if (q.notDone === true && done) return false
  if (q.notDone === false && !done) return false
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
  ctx: Omit<QueryContext, 'today' | 'doneOf'> & {
    today: string
    tagsOf?: (t: T) => string[]
    /** 与 tagsOf 同理：完成态按**调用方**的任务类型逐个算（它才有 id / parent_id 去查 roll-up） */
    doneOf?: (t: T) => boolean
  }
): T[] {
  const q = parseQuery(expr)
  return tasks.filter((t) =>
    matchTask(t, q, {
      today: ctx.today,
      listNames: ctx.listNames,
      // 标签是「每个任务各自的」：调用方给 tagsOf 就逐个取，否则用全局 tags
      tags: ctx.tagsOf ? ctx.tagsOf(t) : ctx.tags,
      // 完成态由调用方注入（它有 effectiveDoneMap），否则退化为只看自身状态
      doneOf: ctx.doneOf as ((t: QueryTask) => boolean) | undefined,
    })
  )
}
