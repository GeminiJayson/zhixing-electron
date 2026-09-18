import { useEffect, useState } from 'react'
import { Award, CalendarCheck, CheckCircle2, CircleAlert, Inbox, Sparkles } from 'lucide-react'
import type { ReviewStats } from '@shared/types'
import { t } from '../i18n'

/** 回顾页：今日概览 + 周趋势 + 12 周热力图 + 标签分布 + 成就。图表全部自绘 SVG。 */
export function ReviewPage() {
  const [stats, setStats] = useState<ReviewStats | null>(null)

  useEffect(() => {
    void window.zhixing.db.reviewStats().then(setStats)
  }, [])

  // 加载态也带标题行：否则进页面时标题会闪一下，与其它页面的骨架不一致
  if (!stats) {
    return (
      <div className="page page--review">
        <div className="page__head">
          <h1 className="page__title">{t('page.review')}</h1>
          <p className="page__subtitle">{t('page.review.sub')}</p>
        </div>
        <div className="page__body">
          <p className="empty-hint">正在统计…</p>
        </div>
      </div>
    )
  }

  const counts = [
    { key: 'todayDue', label: '今日待办', value: stats.todayCounts.todayDue, icon: CalendarCheck, tone: 'accent' },
    { key: 'doneToday', label: '今日完成', value: stats.todayCounts.doneToday, icon: CheckCircle2, tone: 'success' },
    { key: 'overdue', label: '逾期', value: stats.todayCounts.overdue, icon: CircleAlert, tone: 'danger' },
    { key: 'inbox', label: '全部任务', value: stats.todayCounts.inbox, icon: Inbox, tone: 'neutral' },
    { key: 'flash', label: '待整理闪念', value: stats.todayCounts.flash, icon: Sparkles, tone: 'warm' },
  ] as const

  const weekMax = Math.max(1, ...stats.week.completed, ...stats.week.notes)
  const pomoMax = Math.max(1, ...stats.week.pomodoro)
  const heatMax = Math.max(1, ...stats.heatmap.flat().filter((v) => v >= 0))
  const tagTotal = Math.max(1, stats.tagDistribution.reduce((n, t) => n + t.count, 0))

  const barW = 34
  const chartH = 120

  return (
    <div className="page page--review">
      <div className="page__head">
        <h1 className="page__title">{t('page.review')}</h1>
        <p className="page__subtitle">{t('page.review.sub')}</p>
      </div>
      <div className="page__body">

      <section className="stat-grid review-grid" aria-label="今日概览">
        {counts.map((c) => {
          const Icon = c.icon
          return (
            <article key={c.key} className={`stat-card stat-card--${c.tone}`}>
              <Icon size={16} strokeWidth={2} aria-hidden />
              <span className="stat-card__value">{c.value}</span>
              <span className="stat-card__label">{c.label}</span>
            </article>
          )
        })}
        <article className="stat-card stat-card--accent">
          <Award size={16} strokeWidth={2} aria-hidden />
          <span className="stat-card__value">{stats.streak}</span>
          <span className="stat-card__label">连续完成天数</span>
        </article>
      </section>

      <section className="section">
        <header className="section__head">
          <h2>最近 7 天</h2>
          <span className="u-aux">柱=完成任务 · 线=新建笔记 · 底部数字=番茄分钟</span>
        </header>
        <svg className="chart" viewBox={`0 0 ${stats.week.labels.length * 46 + 20} ${chartH + 40}`} role="img" aria-label="最近 7 天完成趋势">
          {stats.week.labels.map((label, i) => {
            const x = 20 + i * 46
            const h = (stats.week.completed[i] / weekMax) * chartH
            const noteH = (stats.week.notes[i] / weekMax) * chartH
            return (
              <g key={label}>
                <rect
                  x={x}
                  y={chartH - h + 10}
                  width={barW}
                  height={Math.max(h, stats.week.completed[i] > 0 ? 3 : 0)}
                  rx={4}
                  className="chart__bar"
                />
                <rect
                  x={x + barW - 6}
                  y={chartH - noteH + 10}
                  width={6}
                  height={Math.max(noteH, stats.week.notes[i] > 0 ? 3 : 0)}
                  rx={3}
                  className="chart__bar chart__bar--note"
                />
                <text x={x + barW / 2} y={chartH + 26} textAnchor="middle" className="chart__label">
                  {label}
                </text>
                <text x={x + barW / 2} y={chartH + 40} textAnchor="middle" className="chart__sub">
                  {stats.week.pomodoro[i]} 分
                </text>
              </g>
            )
          })}
        </svg>
        <details className="u-aux">
          <summary>番茄钟最大值参考：{pomoMax} 分钟</summary>
        </details>
      </section>

      <section className="section">
        <header className="section__head">
          <h2>完成热力图</h2>
          <span className="u-aux">近 12 周，颜色越深完成越多</span>
        </header>
        <svg className="heatmap" viewBox={`0 0 ${stats.heatmap.length * 16 + 4} ${7 * 16 + 4}`} role="img" aria-label="完成热力图">
          {stats.heatmap.map((col, w) =>
            col.map((v, d) => (
              <rect
                key={`${w}-${d}`}
                x={w * 16 + 2}
                y={d * 16 + 2}
                width={13}
                height={13}
                rx={3}
                className="heat__cell"
                style={{
                  fill:
                    v < 0
                      ? 'transparent'
                      : v === 0
                        ? 'var(--bg-hover)'
                        : `color-mix(in srgb, var(--accent) ${Math.min(90, 25 + (v / heatMax) * 65)}%, var(--bg-hover))`,
                }}
              >
                <title>{`${v < 0 ? '未来' : `${v} 项完成`}`}</title>
              </rect>
            ))
          )}
        </svg>
      </section>

      <section className="section">
        <header className="section__head">
          <h2>标签分布</h2>
        </header>
        {stats.tagDistribution.length === 0 ? (
          <p className="u-aux">还没有使用过标签。</p>
        ) : (
          <ul className="tagdist">
            {stats.tagDistribution.map((t) => (
              <li key={t.name} className="tagdist__row">
                <span className="tagdist__name">{t.name}</span>
                <span className="tagdist__bar">
                  <span
                    className="tagdist__fill"
                    style={{ width: `${(t.count / tagTotal) * 100}%`, background: t.color }}
                  />
                </span>
                <span className="u-aux">{t.count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section">
        <header className="section__head">
          <h2>成就</h2>
          <span className="u-aux">{stats.achievements.filter((a) => a.unlocked).length}/{stats.achievements.length} 已解锁</span>
        </header>
        <ul className="achv">
          {stats.achievements.map((a) => (
            <li key={a.name} className={'achv__item' + (a.unlocked ? ' achv__item--on' : '')}>
              <Award size={16} strokeWidth={2} aria-hidden />
              <strong>{a.name}</strong>
              <span className="u-aux">{a.desc}</span>
            </li>
          ))}
        </ul>
      </section>
      </div>
    </div>
  )
}
