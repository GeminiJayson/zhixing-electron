import { useCallback, useEffect, useState } from 'react'
import { subscribeDomain } from '@shared/events'
import { shiftDay, todayKey, type HabitView } from '@shared/habit'
import { Archive, Check, Plus, RotateCcw, Trash2 } from '@renderer/lib/icons'
import { useDialog } from './Dialogs'

/**
 * 今日页的「习惯打卡」卡片。
 *
 * 独立组件而不是塞进 TodayPage：那一页已经管着任务树、概览、最近笔记三块状态，
 * 习惯完全是另一条数据线（habit / habit_log），放一起只会让两边的改动互相牵动。
 *
 * 「今天」在每次渲染时重算：应用常开跨过午夜后，用户看到的应当是新的那一天 ——
 * 取一次存在 state 里就会停在昨天，而且没有任何东西会提醒它该更新。
 */
export function HabitCard({ onChanged }: { onChanged?: () => void }): React.JSX.Element {
  const dialog = useDialog()
  const [habits, setHabits] = useState<HabitView[]>([])
  const [draft, setDraft] = useState('')
  const today = todayKey()

  const load = useCallback(async (): Promise<void> => {
    setHabits(await window.zhixing.db.listHabits())
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 习惯打卡写库时广播的是 task 域（"今天要做的另一类事"，与今日待办同一批数据），
  // 订阅它，别的窗口 / 浮窗改了打卡这里也能跟上 —— 卡片自己的按钮本来就会 load，
  // 这条只是把"外面的改动"也接上
  useEffect(() => subscribeDomain(['task'], () => void load()), [load])

  /** 点小圆点是切「今天」，点周条上是明确设置那一天 */
  const toggle = async (habit: HabitView, day: string, done: boolean): Promise<void> => {
    if (day === today) await window.zhixing.db.toggleHabitDay(habit.id, day)
    else await window.zhixing.db.setHabitDay(habit.id, day, done)
    await load()
    onChanged?.()
  }

  const add = async (): Promise<void> => {
    const name = draft.trim()
    if (!name) return
    await window.zhixing.db.saveHabit({ name })
    setDraft('')
    await load()
    onChanged?.()
  }

  const rename = async (habit: HabitView): Promise<void> => {
    const name = await dialog.prompt({ title: '重命名习惯', label: '名称', defaultValue: habit.name })
    if (!name || !name.trim()) return
    await window.zhixing.db.saveHabit({
      id: habit.id,
      name: name.trim(),
      icon: habit.icon,
      color: habit.color,
    })
    await load()
  }

  const remove = async (habit: HabitView): Promise<void> => {
    const ok = await dialog.confirm({
      title: '删除这个习惯？',
      message: '连同它的全部打卡记录一起删掉，无法撤销。只想让它从今天起不再出现，用「归档」。',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    await window.zhixing.db.deleteHabit(habit.id)
    await load()
    onChanged?.()
  }

  return (
    <section className="section habit" aria-label="习惯打卡">
      <header className="section__head">
        <h2>习惯打卡</h2>
        <span className="u-aux">
          {habits.length
            ? '点左边圆点记今天；点周条上的小格可以补记前几天'
            : '每天要做的小事 —— 连续天数会自己长起来'}
        </span>
      </header>

      {habits.length > 0 && (
        <ul className="habit__list">
          {habits.map((h) => (
            <li key={h.id} className={'habit__row' + (h.archived_at ? ' is-archived' : '')}>
              <button
                className={'habit__check' + (h.doneToday ? ' is-done' : '')}
                aria-pressed={h.doneToday}
                aria-label={h.doneToday ? '取消今天的打卡' : '今天打卡'}
                title={h.doneToday ? '取消今天的打卡' : '今天打卡'}
                onClick={() => void toggle(h, today, !h.doneToday)}
              >
                {h.doneToday ? <Check size={13} strokeWidth={3} /> : null}
              </button>
              <span className="habit__name" onDoubleClick={() => void rename(h)} title="双击改名">
                {h.name}
              </span>
              <span className="habit__week" role="group" aria-label="近 7 天">
                {h.week.map((done, i) => {
                  const day = shiftDay(today, -(6 - i))
                  const label = day + (done ? ' 已打卡' : ' 未打卡')
                  return (
                    <button
                      key={day}
                      className={'habit__day' + (done ? ' is-done' : '')}
                      title={label}
                      aria-label={label}
                      onClick={() => void toggle(h, day, !done)}
                    />
                  )
                })}
              </span>
              <span className="habit__streak">{h.streak > 0 ? '连续 ' + h.streak + ' 天' : '—'}</span>
              <span className="u-aux habit__rate">{Math.round(h.rate * 100)}%</span>
              <button
                className="icon-btn"
                title={h.archived_at ? '恢复到列表' : '归档（保留记录）'}
                aria-label={h.archived_at ? '恢复到列表' : '归档'}
                onClick={() => void window.zhixing.db.archiveHabit(h.id, !h.archived_at).then(load)}
              >
                {h.archived_at ? <RotateCcw size={13} /> : <Archive size={13} />}
              </button>
              <button
                className="icon-btn icon-btn--danger"
                title="删除这个习惯"
                aria-label="删除这个习惯"
                onClick={() => void remove(h)}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="habit__add">
        <input
          className="field"
          value={draft}
          placeholder="加一个习惯：喝水 / 读书 20 分钟 / 拉伸"
          aria-label="新习惯名称"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
        />
        <button className="text-btn text-btn--accent" onClick={() => void add()}>
          <Plus size={13} /> 添加
        </button>
      </div>
    </section>
  )
}
