/**
 * 任务活动流：提醒、稍后、不再提醒、状态变更的追加型记录。
 *
 * 为什么单独一张表而不是往 task 上加字段：这是**追加型**日志 —— 一条任务会有几十条，
 * 塞进主表会让每次读任务都拖着整段历史。任务速览的「活动记录」时间轴读的就是它。
 *
 * 与 reminder_at / reminder_fired 的分工：那两列是**提醒调度**的状态（下次什么时候响、
 * 这一轮第几次），这张表是**给人看的历史**。两者职责不同，不要互相替代。
 */
import { conn, nowStamp } from './connection'
import type { TaskActivity, TaskActivityKind } from '../../shared/types'

/**
 * 记一条活动。
 *
 * **吞掉异常**：活动流是旁路，写失败不该让提醒派发或状态变更整个失败 ——
 * 那会让「记不下来」升级成「功能不能用」，代价远大于丢一条历史。
 */
export function logTaskActivity(
  taskId: number,
  kind: TaskActivityKind,
  detail?: string | null,
  reason?: string | null
): void {
  if (!Number.isFinite(taskId) || taskId <= 0) return
  try {
    conn()
      .prepare('INSERT INTO task_activity (task_id, kind, detail, reason, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, kind, detail ?? null, reason ?? null, nowStamp())
  } catch (err) {
    console.error('[task-activity] 写入失败', err)
  }
}

/** 某条任务的活动记录，按时间**倒序**（速览里最新的在最上面），limit 默认 50 */
export function listTaskActivity(taskId: number, limit = 50): TaskActivity[] {
  return conn()
    .prepare(
      'SELECT id, task_id, kind, detail, reason, created_at FROM task_activity WHERE task_id = ? ORDER BY id DESC LIMIT ?'
    )
    .all(taskId, Math.max(1, Math.min(500, Math.round(limit)))) as TaskActivity[]
}
