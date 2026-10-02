/**
 * 核对清单的数据结构。设计见 docs/specs/knowledge-base-reorg.md §4 第 3 步。
 *
 * **为什么要结构化，而不是一个「已核对」复选框**：三个月后你看到一条结论，
 * 真正想知道的是「当初凭什么信它」，而不是「我打过勾」。
 *
 * 兼容性：`verify_note` 列在 v16 时存的是纯文本（第一版实现）。
 * 这里用一个 `v` 版本号区分：解析失败就当纯文本处理，绝不因为格式升级丢数据。
 */

export interface CheckNote {
  v: 1
  /** 关键说法有依据吗。**选 no 时不允许标为可用** —— 这是方案 §9 的硬规则 */
  evidence: 'yes' | 'partial' | 'no'
  /** 适用场景 / 不适用条件 */
  scope: string
  /** 与其他资料是否冲突，冲突的话是哪一条 */
  conflict: string
  /** 时效性：结论的有效期、有没有更新版本 */
  freshness: string
  /** 补充 */
  extra: string
}

export const EVIDENCE_LABELS: Record<CheckNote['evidence'], string> = {
  yes: '有依据',
  partial: '部分有依据',
  no: '没有依据',
}

export function emptyCheckNote(): CheckNote {
  return { v: 1, evidence: 'yes', scope: '', conflict: '', freshness: '', extra: '' }
}

/**
 * 解析 verify_note 列。
 *
 * 返回 null 表示这是第一版的纯文本（或空），调用方按纯文本显示。
 * **不抛异常、不丢内容** —— 格式升级不该让用户已写下的核对结论消失。
 */
export function parseCheckNote(raw: string | null | undefined): CheckNote | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Partial<CheckNote>
    if (o && o.v === 1 && (o.evidence === 'yes' || o.evidence === 'partial' || o.evidence === 'no')) {
      return {
        v: 1,
        evidence: o.evidence,
        scope: typeof o.scope === 'string' ? o.scope : '',
        conflict: typeof o.conflict === 'string' ? o.conflict : '',
        freshness: typeof o.freshness === 'string' ? o.freshness : '',
        extra: typeof o.extra === 'string' ? o.extra : '',
      }
    }
  } catch {
    // 第一版的纯文本走这里 —— 它本来就是合法输入，不是错误
  }
  return null
}

export function serializeCheckNote(c: CheckNote): string {
  return JSON.stringify(c)
}

/** 把结构化清单渲染成一行摘要，给列表和 tooltip 用。 */
export function summarizeCheckNote(c: CheckNote): string {
  const parts = [EVIDENCE_LABELS[c.evidence]]
  if (c.scope.trim()) parts.push('场景：' + c.scope.trim())
  if (c.conflict.trim()) parts.push('冲突：' + c.conflict.trim())
  return parts.join(' · ')
}
