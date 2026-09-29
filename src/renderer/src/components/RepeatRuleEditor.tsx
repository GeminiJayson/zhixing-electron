import { useState } from 'react'
import { describeRRule, formatRRule, parseRRule, type RRule } from '@shared/recurrence'
import { todayStr } from '@renderer/lib/date'

interface Props {
  /** 当前的 RRULE 串（可能为空 = 还没配过） */
  value: string
  onChange: (rule: string) => void
}

type EndKind = 'never' | 'count' | 'until'

const FREQS: { value: RRule['freq']; label: string; unit: string }[] = [
  { value: 'daily', label: '天', unit: '天' },
  { value: 'weekly', label: '周', unit: '周' },
  { value: 'monthly', label: '月', unit: '个月' },
]

/**
 * 自定义循环的**可视化**编辑：只做选择，不让人写规则串。
 *
 * 旧版是一个要求填 `FREQ=WEEKLY;INTERVAL=2;COUNT=5` 的输入框 —— RRULE 是 iCalendar 的
 * 标准写法，但让用户记它的字段名与分隔符没有道理，写错了还不会报错（parseRRule 对
 * 认不出的部分直接忽略，于是"配了个寂寞"）。现在三个下拉/输入覆盖 parseRRule 支持的
 * 全部字段（FREQ / INTERVAL / COUNT / UNTIL）。
 *
 * 生成的串仍然显示出来（并配一句人话）：串是真正落库的东西，让人看得见，
 * 排查问题或手写导入时对得上。
 */
export function RepeatRuleEditor({ value, onChange }: Props): React.JSX.Element {
  const info: RRule = parseRRule(value) ?? { freq: 'daily', interval: 1, count: null, until: null }
  const endKind: EndKind = info.count != null ? 'count' : info.until ? 'until' : 'never'
  /** 切到"共 N 次"但还没填数时用的默认值，避免生成 COUNT=0 这种立刻结束的规则 */
  const [lastCount, setLastCount] = useState(info.count ?? 5)

  const emit = (patch: Partial<RRule>): void => {
    onChange(formatRRule({ ...info, ...patch }))
  }
  const setEndKind = (kind: EndKind): void => {
    if (kind === 'never') emit({ count: null, until: null })
    else if (kind === 'count') emit({ count: lastCount, until: null })
    else emit({ count: null, until: info.until ?? todayStr() })
  }

  const unit = FREQS.find((f) => f.value === info.freq)?.unit ?? '天'

  return (
    <section className="form-row">
      <span>循环规则</span>
      <div className="repeat-rule">
        <div className="repeat-rule__line">
          <span className="repeat-rule__label">频率</span>
          <div className="seg seg--plain">
            {FREQS.map((f) => (
              <button
                key={f.value}
                type="button"
                className={'seg__btn' + (info.freq === f.value ? ' seg__btn--on' : '')}
                aria-pressed={info.freq === f.value}
                onClick={() => emit({ freq: f.value })}
              >
                每{f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="repeat-rule__line">
          <span className="repeat-rule__label">间隔</span>
          <input
            className="field field--compact"
            type="number"
            min={1}
            max={365}
            value={info.interval}
            aria-label={`每隔几个${unit}`}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10)
              emit({ interval: Number.isFinite(n) && n >= 1 ? n : 1 })
            }}
          />
          <span className="u-aux">
            每 {info.interval} {unit}一次
          </span>
        </div>

        <div className="repeat-rule__line">
          <span className="repeat-rule__label">结束</span>
          <div className="seg seg--plain">
            {(
              [
                { key: 'never', label: '一直重复' },
                { key: 'count', label: '重复 N 次' },
                { key: 'until', label: '到某天为止' },
              ] as { key: EndKind; label: string }[]
            ).map((o) => (
              <button
                key={o.key}
                type="button"
                className={'seg__btn' + (endKind === o.key ? ' seg__btn--on' : '')}
                aria-pressed={endKind === o.key}
                onClick={() => setEndKind(o.key)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {endKind === 'count' && (
          <div className="repeat-rule__line">
            <span className="repeat-rule__label" />
            <input
              className="field field--compact"
              type="number"
              min={1}
              max={999}
              value={info.count ?? lastCount}
              aria-label="总共重复几次"
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10)
                const v = Number.isFinite(n) && n >= 1 ? n : 1
                setLastCount(v)
                emit({ count: v })
              }}
            />
            <span className="u-aux">次之后自动停下</span>
          </div>
        )}

        {endKind === 'until' && (
          <div className="repeat-rule__line">
            <span className="repeat-rule__label" />
            <input
              className="field field--compact"
              type="date"
              value={info.until ?? ''}
              aria-label="重复到哪天为止"
              onChange={(e) => emit({ until: e.target.value || null })}
            />
            <span className="u-aux">这一天之后不再生成</span>
          </div>
        )}

        {/* 串是真正落库的东西，显示出来 + 一句人话，改完对得上 */}
        <p className="u-aux repeat-rule__preview">
          {describeRRule(info)}
          <code className="repeat-rule__code">{formatRRule(info)}</code>
        </p>
      </div>
    </section>
  )
}
