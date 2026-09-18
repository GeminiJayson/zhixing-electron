import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppWindow, Plus } from 'lucide-react'
import { buildTaskTree, effectiveDoneMap, type TaskNode } from '@shared/task'
import { bindHostEvents, subscribeDomain } from '@shared/events'
import { parseSettings } from '@shared/settings'
import { applyAppearance } from './theme'
import { TaskRow } from './components/TaskRow'

/**
 * 桌面浮窗视图（主窗口以外的第二个窗口，用 ?widget=1 区分）：
 * 顶部快速输入 + 今日待办（含子树）+ 底部「打开主程序」。
 * 与主窗口共用同一份数据层，勾选/新增都直接落库。
 */
export function WidgetApp() {
  const [tasks, setTasks] = useState<Awaited<ReturnType<typeof window.zhixing.db.todayTasks>> | null>(null)
  const [draft, setDraft] = useState('')
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    setTasks(await window.zhixing.db.todayTasks())
  }, [])

  useEffect(() => {
    void load()
    // 主窗口改了数据后，浮窗下一次轮询即同步（跨窗口没有共享状态，靠轮询最省心）
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [load])

  // 贴边交互：把手状态下鼠标进入即滑出；双击同样取消贴边；右键出菜单
  useEffect(() => {
    const onEnter = (): void => void window.zhixing.widget.undock()
    const onDouble = (): void => void window.zhixing.widget.undock()
    const onContext = (e: MouseEvent): void => {
      e.preventDefault()
      void window.zhixing.widget.contextMenu()
    }
    document.body.addEventListener('mouseenter', onEnter)
    document.body.addEventListener('dblclick', onDouble)
    document.body.addEventListener('contextmenu', onContext)
    return () => {
      document.body.removeEventListener('mouseenter', onEnter)
      document.body.removeEventListener('dblclick', onDouble)
      document.body.removeEventListener('contextmenu', onContext)
    }
  }, [])

  /**
   * 外观：浮窗是独立渲染进程，主窗口换主题 / 主题包只写 settings 表，
   * 靠主进程按 'settings' 域广播到这里，再整体重铺一遍（明暗 + 主题包 + 强调色 + 字号）。
   */
  useEffect(() => {
    bindHostEvents(window.zhixing.db)
    const syncAppearance = async (): Promise<void> => {
      applyAppearance(parseSettings(await window.zhixing.db.settings()))
    }
    void syncAppearance()
    return subscribeDomain(['settings'], () => void syncAppearance())
  }, [])

  const tree = useMemo(() => {
    if (!tasks) return []
    return buildTaskTree(tasks.subtree, effectiveDoneMap(tasks.subtree), new Map(), new Map())
  }, [tasks])

  const flash = (msg: string): void => {
    setNotice(msg)
    window.setTimeout(() => setNotice(''), 1600)
  }

  const quickAdd = async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    const created = await window.zhixing.db.quickAdd(text)
    if (!created) {
      flash('没解析出可用的标题')
      return
    }
    flash(`已添加「${created.title}」`)
    await load()
  }

  const renderNodes = (nodes: TaskNode[], depth = 0): React.ReactNode =>
    nodes.map((node) => (
      <div key={node.id}>
        <TaskRow
          node={node}
          depth={depth}
          selected={false}
          collapsed={collapsed.has(node.id)}
          onToggle={async (id) => {
            await window.zhixing.db.toggleTask(id)
            await load()
          }}
          onToggleCollapse={(id) =>
            setCollapsed((prev) => {
              const next = new Set(prev)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return next
            })
          }
          onSelect={() => undefined}
          onOpenPriority={() => flash('优先级请到主窗口修改')}
          onOpenTags={() => flash('标签请到主窗口修改')}
          onContextMenu={() => flash('更多操作请到主窗口')}
          onTitleCommit={async (id, title) => {
            await window.zhixing.db.setTitle(id, title)
            await load()
          }}
          onAddSubtask={async (id) => {
            await window.zhixing.db.createTask('新子任务', id)
            await load()
          }}
          onFocus={(id, title) =>
            window.dispatchEvent(
              new CustomEvent('zhixing:pomodoro', { detail: { taskId: id, title } })
            )
          }
          onEdit={() => flash('编辑请到主窗口')}
          onDelete={async (id) => {
            if (!window.confirm('删除该任务及其子任务？')) return
            await window.zhixing.db.deleteTask(id)
            await load()
          }}
          onDragStart={() => undefined}
          onDragOverRow={() => undefined}
          onDropRow={() => undefined}
          onDragEnd={() => undefined}
          dropHint={null}
        />
        {!collapsed.has(node.id) && renderNodes(node.children, depth + 1)}
      </div>
    ))

  return (
    <div className="widget">
      <div className="widget__card drag-region">
        <div className="widget__head no-drag">
          <span className="widget__title">今日待办</span>
          <span className="u-aux">{tasks?.roots.length ?? 0} 项</span>
        </div>
        <div className="widget__input no-drag">
          <input
            className="field"
            value={draft}
            placeholder="快速输入…回车即建"
            aria-label="快速添加任务"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void quickAdd()
            }}
          />
          <button className="icon-btn" aria-label="添加" title="添加" onClick={() => void quickAdd()}>
            <Plus size={15} />
          </button>
        </div>
        <div className="widget__list no-drag">
          {tree.length === 0 ? (
            <p className="u-aux widget__empty">今天没有任务</p>
          ) : (
            renderNodes(tree)
          )}
        </div>
        <div className="widget__foot no-drag">
          <button className="text-btn" onClick={() => void window.zhixing.widget.openMain()}>
            <AppWindow size={13} /> 打开主程序
          </button>
          <span className="modal__spacer" />
          <button className="text-btn" onClick={() => void window.zhixing.widget.close()}>
            隐藏
          </button>
        </div>
        {notice && <div className="widget__toast">{notice}</div>}
      </div>
    </div>
  )
}
