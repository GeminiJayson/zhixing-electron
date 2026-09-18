/**
 * 快速捕获语法糖，逐条对齐 model/domain/capture_grammar.py + task_rules.parse_natural_date：
 * `周五前 交付方案 !2 @工作 #客户` → 标题「交付方案」、P5、列表「工作」、标签「客户」、截止=本周五。
 * 时刻短语（明天3点 / 周五 14:30）解析为 reminder_at。
 */

export interface ParsedCapture {
  title: string
  priority: number
  listName: string | null
  tags: string[]
  dueDate: string | null
  dueClock: [number, number] | null
}

/** 老快捷语义：数字/叹号越少优先级越高（!1=最高 P8、!2=中 P5、!3=低 P2）。 */
const PRIORITY_TOKEN: Record<string, number> = {
  '!1': 8,
  '!2': 5,
  '!3': 2,
  '!!!': 8,
  '!!': 5,
  '!': 2,
}

const WEEKDAY_CN: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }

const pad = (n: number): string => String(n).padStart(2, '0')
const dayOf = (d: Date): string => d.toISOString().slice(0, 10)
const parseDay = (s: string): Date => new Date(`${s}T00:00:00Z`)
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000)

/** 解析日期词（含可选时刻），对齐 parse_natural_date / parse_natural_datetime。 */
export function parseNaturalDate(
  word: string,
  today: string
): { date: string | null; clock: [number, number] | null } {
  const t = parseDay(today)
  let text = word.trim()
  let clock: [number, number] | null = null

  // 时刻：中文「3点/3点半/3点15分」或 24h「14:30」
  const clockMatch = text.match(/(早晨|凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|夜晚)?(\d{1,2})点(?:(半)|(\d{1,2})分)?\s*$|(\d{1,2}):(\d{2})\s*$/)
  if (clockMatch) {
    if (clockMatch[5] !== undefined) {
      clock = [Number(clockMatch[5]), Number(clockMatch[6])]
    } else {
      let h = Number(clockMatch[2])
      const part = clockMatch[1] ?? ''
      const min = clockMatch[3] ? 30 : clockMatch[4] ? Number(clockMatch[4]) : 0
      if (['下午', '傍晚', '晚上', '夜里', '夜晚'].includes(part) && h < 12) h += 12
      else if (part === '中午' && h < 12) h += 12
      // 无修饰的 1-6 点按口语「下午」处理（对齐 _resolve_hour：3点 → 15:00）
      else if (!part && h >= 1 && h <= 6) h += 12
      clock = [h, min]
    }
    // 非法时刻一律丢弃（对齐 parse_clock 的 h<24 / m<60 校验）；
    // 此前「明天25:99」会把 (25,99) 直接写进 reminder_at。
    if (clock && !(clock[0] >= 0 && clock[0] < 24 && clock[1] >= 0 && clock[1] < 60)) clock = null
    text = text.slice(0, clockMatch.index).trim()
  }

  let date: string | null = null
  if (text === '今天') date = dayOf(t)
  else if (text === '明天') date = dayOf(addDays(t, 1))
  else if (text === '后天') date = dayOf(addDays(t, 2))
  else if (text === '大后天') date = dayOf(addDays(t, 3))
  else {
    // 「周X / 下周X」按字面语义：周X 落在本周（已过则顺延到下周同一天），下周X 落在下一周。
    // 注：Python 的 parse_natural_date 把「下周X」实现成了「下一个 X」，与字面不符，
    // 这里按字面语义实现（差异已记入 docs/optimization-proposals.md）。
    const wk = text.match(/^(下)?周([一二三四五六日天])$/)
    if (wk) {
      const target = WEEKDAY_CN[wk[2]]
      // JS 的 0=周日 换算成 0=周一
      const todayWd = (t.getUTCDay() + 6) % 7
      const thisMonday = addDays(t, -todayWd)
      const candidate = addDays(thisMonday, target + (wk[1] ? 7 : 0))
      const past = !wk[1] && candidate.getTime() < t.getTime()
      date = dayOf(past ? addDays(candidate, 7) : candidate)
    } else {
      const cn = text.match(/^(\d{1,2})月(\d{1,2})[日号]?$/)
      const iso = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
      const md = text.match(/^(\d{1,2})[-/](\d{1,2})$/)
      if (iso) {
        date = `${iso[1]}-${pad(Number(iso[2]))}-${pad(Number(iso[3]))}`
      } else if (cn || md) {
        const m = Number((cn ?? md)![1])
        const d = Number((cn ?? md)![2])
        let candidate = new Date(Date.UTC(t.getUTCFullYear(), m - 1, d))
        // JS 的 Date 会把 2月30日 自动进位成 3月2日；Python 的 date() 直接抛错返回 None。
        // 只有回写后仍在同一月（含闰年 2/29 合法）才认这个日期，否则视为非法。
        if (Number.isNaN(candidate.getTime()) || candidate.getUTCMonth() !== m - 1) {
          return { date: null, clock }
        }
        if (candidate < t) candidate = new Date(Date.UTC(t.getUTCFullYear() + 1, m - 1, d))
        if (candidate.getUTCMonth() !== m - 1) return { date: null, clock }
        date = dayOf(candidate)
      }
    }
  }
  return { date, clock }
}

/** 解析一行快速输入；语法糖 token 会从标题中剔除。 */
export function parseCapture(input: string, today: string): ParsedCapture {
  const result: ParsedCapture = {
    title: '',
    priority: 0,
    listName: null,
    tags: [],
    dueDate: null,
    dueClock: null,
  }
  let text = (input ?? '').trim()
  if (!text) return result

  const DATE_WORDS =
    /(今天|明天|后天|大后天|下下周?[一二三四五六日天]|周[一二三四五六日天]|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}月\d{1,2}[日号]?|\d{1,2}[-/]\d{1,2})(\s*(?:凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|夜晚)?\d{1,2}点(?:半|\d{1,2}分)?|\s*\d{1,2}:\d{2})?/
  const dm = text.match(DATE_WORDS)
  if (dm) {
    const parsed = parseNaturalDate((dm[1] + (dm[2] ?? '')).trim(), today)
    result.dueDate = parsed.date
    result.dueClock = parsed.clock
    text = (text.slice(0, dm.index) + ' ' + text.slice((dm.index ?? 0) + dm[0].length)).trim()
  }

  for (const token of ['!!!', '!!', '!1', '!2', '!3']) {
    const re = new RegExp(`(^|\\s)${token.replace(/!/g, '!')}(\\s|$)`)
    if (re.test(text)) {
      result.priority = PRIORITY_TOKEN[token]
      text = text.replace(re, ' ').trim()
      break
    }
  }
  if (result.priority === 0 && /(^|\s)!(\s|$)/.test(text)) {
    result.priority = 2
    text = text.replace(/(^|\s)!(\s|$)/, ' ').trim()
  }

  const lm = text.match(/(^|\s)@([\w\u4e00-\u9fff-]+)/)
  if (lm) {
    result.listName = lm[2]
    text = text.replace(lm[0], ' ').trim()
  }

  const tagRe = /(^|\s)#([\w\u4e00-\u9fff-]+)/g
  let tm: RegExpExecArray | null
  while ((tm = tagRe.exec(text)) !== null) {
    if (!result.tags.includes(tm[2])) result.tags.push(tm[2])
  }
  text = text.replace(tagRe, ' ').replace(/\s+/g, ' ').trim()

  // 有日期词时清掉「周五前 / 明天之内」残留的修饰词（对齐 capture_grammar 的 _DATE_WORDS 后处理）
  if (dm) {
    text = text
      .replace(/^(前|之前|以前|之内|内)(?=\s|$)/, ' ')
      .replace(/(?<=\S)(前|之前|以前)$/, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }
  // 首尾的「-，,」清掉（对齐 Python 的 strip(" -，,")）
  result.title = text.replace(/\s{2,}/g, ' ').trim().replace(/^[\s\-，,]+|[\s\-，,]+$/g, '')
  return result
}
