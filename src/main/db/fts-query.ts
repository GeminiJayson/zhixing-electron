/**
 * FTS5 的分词与查询表达式。
 *
 * 单独成文件是为了能在 vitest（node 环境）里直接验证分词结果：fts.ts 依赖
 * better-sqlite3（Electron ABI 的原生模块），在单测里加载不了。
 *
 * 写入与查询必须用同一套分词：写入时用 jieba 的 cut_for_search 把正文切成
 * 空格分隔的词交给 unicode61 索引 —— 分词不一致会让检索互相漏检。
 */
type JiebaLike = {
  cut(s: string): string[]
  cutForSearch(s: string): string[]
}

/**
 * 用 require 而不是 import：binding 缺失时 require 抛的是**模块顶层**异常，
 * 静态 import 会被 rollup 提到 bundle 最前面，主进程还没建窗口就整个挂掉
 * （Windows 上表现为启动即崩的报错弹窗）。这里降级为逐字分词，检索变糙但不崩。
 */
let jieba: JiebaLike | null = null
try {
  const jiebaMod = require('@node-rs/jieba') as typeof import('@node-rs/jieba')
  const dictMod = require('@node-rs/jieba/dict') as typeof import('@node-rs/jieba/dict')
  jieba = jiebaMod.Jieba.withDict(dictMod.dict)
} catch (err) {
  console.warn('[fts] 中文分词原生模块加载失败，退化为逐字分词：', err)
}

/** FTS5 词法：只保留数字/字母/汉字，其余当分隔符。 */
const TOKEN_PAT = /[0-9A-Za-z\u4e00-\u9fff]+/g

/** 索引时用的分词。 */
export function tokenize(text: string): string {
  const t = (text ?? '').trim()
  if (!t) return ''
  const seg = jieba
  if (!seg) return [...t].join(' ')
  try {
    return seg
      .cutForSearch(t)
      .filter((w) => w.trim())
      .join(' ')
  } catch {
    return [...t].join(' ')
  }
}

/** 把用户查询拆成安全的 FTS 词。 */
function ftsTerms(text: string): string[] {
  const t = (text ?? '').trim()
  if (!t) return []
  let raw: string[]
  const seg = jieba
  if (!seg) {
    raw = [...t]
  } else {
    try {
      raw = seg.cut(t).filter((w) => w.trim())
    } catch {
      raw = [...t]
    }
  }
  const out: string[] = []
  for (const w of raw) {
    const hits = w.match(TOKEN_PAT)
    if (hits) out.push(...hits)
  }
  if (out.length === 0) {
    const m = t.match(TOKEN_PAT)
    return m ? [m[0]] : []
  }
  return out.slice(0, 8)
}

/** 用户查询 → FTS5 MATCH 表达式：前缀匹配 AND 组合。 */
export function queryTerms(q: string): string {
  const tokens = ftsTerms(q)
  if (!tokens.length) return ''
  return tokens.map((w) => '"' + w + '"*').join(' AND ')
}
