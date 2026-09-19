import { useEffect, useState } from 'react'
import { Award } from 'lucide-react'
import type { ReviewStats } from '@shared/types'
import { t } from '../i18n'

/** 回顾页：周趋势 + 12 周热力图 + 标签分布 + 成就。图表全部自绘 SVG。
 *  顶部那块「任务统计」卡片已删：它的口径与今日页概览重复，这里只留图表；
 *  reviewStats() 查询本身保留（下面的图表继续用它）。 */
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

  const weekMax = Math.max(1, ...stats.week.completed, ...stats.week.notes)
  const pomoMax = Math.max(1, ...stats.week.pomodoro)
  const heatMax = Math.max(1, ...stats.heatmap.flat().filter((v) => v >= 0))
  const tagTotal = Math.max(1, stats.tagDistribution.reduce((n, t) => n + t.count, 0))

  // 柱状图的视图坐标按「卡片常见宽度」设计（约 1130）：铺满宽度时缩放≈1，柱宽和字号
  // 才是设计值。旧 viewBox 只有 342 宽，铺满 1136px 的卡片会被放大约 3.3 倍，一张 7 天图
  // 就有 500px 高 —— 「图表太高」的根因是坐标系设计宽度不对，光加 max-height 治不了。
  const colW = 156
  const barW = 88
  const chartH = 132
  const padX = 20
  const weekVbW = stats.week.labels.length * colW + padX * 2
  const weekVbH = chartH + 54

  return (
    <div className="page page--review">
      <div className="page__head">
        <h1 className="page__title">{t('page.review')}</h1>
        <p className="page__subtitle">{t('page.review.sub')}</p>
      </div>
      <div className="page__body">

      <section className="section">
        <header className="section__head">
          <h2>最近 7 天</h2>
          <span className="u-aux">柱=完成任务 · 线=新建笔记 · 底部数字=番茄分钟</span>
        </header>
        <svg className="chart" viewBox={`0 0 ${weekVbW} ${weekVbH}`} role="img" aria-label="最近 7 天完成趋势">
          {stats.week.labels.map((label, i) => {
            const x = padX + i * colW + (colW - barW) / 2
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
                <text x={x + barW / 2} y={chartH + 30} textAnchor="middle" className="chart__label">
                  {label}
                </text>
                <text x={x + barW / 2} y={chartH + 48} textAnchor="middle" className="chart__sub">
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

      {/* 热力图受 12 周 × 7 天的比例限制（宽度上限见 review.css），单占一行会剩一大片空白；
          标签分布本身也是个窄块，两者并排既互补又省一截页面高度。 */}
      <div className="review-pair">
        <section className="section">
          <header className="section__head">
            <h2>完成热力图</h2>
            <span className="u-aux">近 12 周，颜色越深完成越多</span>
          </header>
          {/* 视图坐标按「并排时那一栏的常见宽度」设计（12 × 44 + 边距 ≈ 532）：
              铺满时缩放≈1，格子边界落在整数像素上，不会被拉到半像素处显虚。
              列宽/行高都是整数，格子由 4 单位的间隙分隔（不靠描边）。 */}
          <svg
            className="heatmap"
            viewBox={`0 0 ${stats.heatmap.length * 44 + 4} ${7 * 24 + 4}`}
            role="img"
            aria-label="完成热力图"
          >
            {stats.heatmap.map((col, w) =>
              col.map((v, d) => (
                <rect
                  key={`${w}-${d}`}
                  x={w * 44 + 2}
                  y={d * 24 + 2}
                  width={40}
                  height={20}
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
      </div>

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
