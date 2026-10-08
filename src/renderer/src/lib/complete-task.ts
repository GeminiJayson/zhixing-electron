import { useCallback } from 'react'
import type { Task } from '@shared/types'
import { useDialog } from '../components/Dialogs'

interface SummaryDialog {
  confirm: (o: {
    title: string
    message: string
    confirmText?: string
    cancelText?: string
  }) => Promise<boolean>
  prompt: (o: { title: string; label?: string; multiline?: boolean }) => Promise<string | null>
}

/**
 * 完成任务；**关联了笔记时先问要不要总结**。
 *
 * 三选一（不总结 / AI 总结 / 自己写）用现有的两个对话框拼出来，不新造组件：
 * 第一问「直接完成 / 总结一下」，选总结再问「用 AI / 自己写」。两次点击，语义清楚。
 *
 * 总结**追加**到任务备注（带日期小标题），不覆盖用户原来写的内容 ——
 * 它有可能是任务描述，被覆盖掉是不可接受的。
 *
 * 未完成 → 完成才走这一套；取消完成直接放行（收回一件事不需要总结）。
 */
export async function completeTaskWithSummary(opts: {
  taskId: number
  dialog: SummaryDialog
  onNotice: (msg: string) => void
  onDone?: () => void | Promise<void>
}): Promise<void> {
  const { taskId, dialog, onNotice, onDone } = opts
  const db = window.zhixing.db
  /*
    诊断标记：出问题时在控制台读 window.__z —— 一眼看出卡在哪一环
    （走进了没有 / 关联几篇 / 要不要总结 / 选了 AI 还是自己写 / 浮层收到没有）。
    界面上的表现是「点了没反应」，这类问题光看代码猜不出来。
  */
  const mark = (k: string, v: unknown): void => {
    const w = window as unknown as Record<string, unknown>
    w['__z_' + k] = v
  }
  mark('called', (Number((window as unknown as Record<string, unknown>).__z_called) || 0) + 1)
  const all: Task[] = await db.tasks()
  const before = all.find((t) => t.id === taskId)
  // 只有「未完成 → 完成」才问；取消完成直接放行（收回一件事不需要总结）
  const willComplete = !!before && before.status !== 'done' && before.status !== 'abandoned'
  mark('willComplete', willComplete)
  let summary: string | null = null
  if (willComplete) {
    const notes = await db.linkedNotes(taskId)
    mark('notes', notes.length)
    if (notes.length > 0) {
      const want = await dialog.confirm({
        title: '完成任务',
        message: `它关联了 ${notes.length} 篇笔记，要总结一下吗？`,
        confirmText: '总结一下',
        cancelText: '直接完成',
      })
      mark('want', want)
      if (want) {
        const useAi = await dialog.confirm({
          title: '总结方式',
          message: '用 AI 根据这些笔记生成，还是自己写？',
          confirmText: '用 AI 总结',
          cancelText: '自己写',
        })
        mark('useAi', useAi)
        if (useAi) {
          // IPC 失败（handler 没注册、主进程抛错）**也要说话** ——
          // 曾经因为没包 try 而整个静默：点了「用 AI 总结」什么都不发生。
          let r: { ok: boolean; text?: string; message?: string; basedOn?: number; skipped?: string[] } = {
            ok: false,
            message: '调用失败',
          }
          try {
            r = await db.summarizeTaskNotes(taskId)
          } catch (e) {
            r = { ok: false, message: (e as Error).message || '调用失败' }
          }
          if (r && r.ok && r.text) {
            summary = r.text
            const skip = r.skipped && r.skipped.length ? `，跳过 ${r.skipped.length} 篇读不到的` : ''
            onNotice(`AI 已根据 ${r.basedOn ?? 0} 篇笔记总结${skip}`)
          } else {
            onNotice('AI 总结失败：' + ((r && r.message) || '未知原因'))
          }
        } else {
          /*
            自己写：交给 SummaryEditor（App 挂着的浮层，复用快速笔记那套 tiptap）。
            写与保存都在那边完成，**包括把任务标记完成** —— 所以这里直接返回，
            不再走下面的 toggle，否则会完成两次。
          */
          mark('fired', true)
          window.dispatchEvent(
            new CustomEvent('zhixing:summary', { detail: { taskId, taskTitle: before?.title ?? '任务' } })
          )
          await onDone?.()
          return
        }
      }
    }
  }
  if (summary) {
    /*
      总结**落库知识库**：新建一篇笔记并关联到任务。

      不塞任务备注 —— 那样它搜不到、引用不了、图谱里也看不见，
      而总结恰恰是最该被复用、被引用、被再次读到的内容。关联关系走 task_note_link，
      所以任务详情里立刻能看到它，反向链接也成立。
    */
    const stamp = new Date().toISOString().slice(0, 10)
    const title = `总结 · ${before?.title ?? '任务'}（${stamp}）`
    try {
      const note = await db.createNote(title, null, summary, 'markdown')
      if (note) {
        await db.linkTaskNote(taskId, note.id)
        onNotice(`总结已存成笔记「${note.title}」并关联到本任务`)
      } else {
        onNotice('总结保存失败：笔记没建成')
      }
    } catch (e) {
      onNotice('总结保存失败：' + ((e as Error).message || '未知原因'))
    }
  }
  await db.toggleTask(taskId)
  await onDone?.()
}
/**
 * 完成任务的 hook：内部拿对话框，页面里只需一行。
 *
 *   const complete = useCompleteTask(onNotice)
 *   <checkbox onChange={() => void complete(id, refresh)} />
 */
export function useCompleteTask(onNotice: (msg: string) => void): (
  taskId: number,
  onDone?: () => void | Promise<void>
) => Promise<void> {
  const dialog = useDialog()
  return useCallback(
    (taskId: number, onDone?: () => void | Promise<void>) =>
      completeTaskWithSummary({ taskId, dialog, onNotice, onDone }),
    [dialog, onNotice]
  )
}