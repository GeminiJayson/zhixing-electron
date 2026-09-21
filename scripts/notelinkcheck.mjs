/**
 * 任务↔笔记关联「要能掉链」的行为验证。
 *
 * 来由：task_note_link 原先只增不减 —— 把 [[标题]] 从任务正文里删掉，行还留着，
 * 任务行的 ⇄N 计数与图谱里的任务-笔记边于是永远不消失。
 * 反过来直接清空重写又会误伤手动关联（笔记页「归属任务」、图谱拉边写入的行，
 * 它根本不出现在正文里）。所以这里两条都要断言：
 *   ① 删掉 [[标题]] 必须真的掉链；
 *   ② 手动关联不许被这次对账顺带清掉。
 */
import { join } from 'node:path'
import { ROOT, launchApp, createChecker, sleep } from './lib/cdp.mjs'

const app = await launchApp({
  port: 9389,
  home: join(ROOT, '.screenshots', 'notelink-home')
})
const { check, finish } = createChecker()

// 浏览器侧一次性跑完，避免来回插值。只增不减这条路径必须用真库验，纯函数单测挡不住接线错误。
const BROWSER = [
  '(async () => {',
  '  const db = window.zhixing.db',
  '  const stamp = String(Date.now())',
  '  // 建笔记要的是笔记文件夹 id；用 listFolders() 拿到的是清单文件夹，在生产库上因为两边 id 恰好撞上而侥幸通过',
  '  const folders = await db.noteFolders()',
  '  const f = folders.find((x) => x.kind === "note") || folders[0] || null',
  '  const task = await db.createTask("掉链验证任务 " + stamp, null, null)',
  '  const n1 = await db.createNote("甲" + stamp, f ? f.id : null, "", "markdown")',
  '  const n2 = await db.createNote("乙" + stamp, f ? f.id : null, "", "markdown")',
  '  const out = { error: null }',
  '  const link = "[[" + n1.title + "]]"',
  '  const count = async () => (await db.linkedNotes(task.id)).length',
  '  try {',
  '    await db.updateTask(task.id, { notes_md: link })',
  '    out.afterAdd = await count()',
  '    await db.updateTask(task.id, { notes_md: "" })',
  '    out.afterRemove = await count()',
  '    await db.updateTask(task.id, { notes_md: link })',
  '    out.afterReAdd = await count()',
  '    await db.attachTaskNote(task.id, n2.id)',
  '    out.afterManual = await count()',
  '    await db.updateTask(task.id, { notes_md: "" })',
  '    out.afterManualThenClear = await count()',
  '    await db.detachTaskNote(task.id, n2.id)',
  '    out.afterDetach = await count()',
  '  } catch (e) {',
  '    out.error = String((e && e.message) || e)',
  '  }',
  '  try {',
  '    await db.deleteTask(task.id)',
  '    await db.deleteNote(n1.id)',
  '    await db.deleteNote(n2.id)',
  '  } catch (e) { /* 清理失败不影响判定 */ }',
  '  return out',
  '})()'
].join('\n')

try {
  console.log('【就绪】等界面稳定…')
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    if (i % 3 === 2) console.log('  ' + Math.round((i + 1) * 0.5) + 's')
  }

  const out = await app.evaluate(BROWSER)
  if (!out || out.error) {
    check('浏览器侧探针跑完', false, (out && out.error) || '无返回')
  } else {
    check('正文写入 [[标题]] 后落链', out.afterAdd === 1, 'linkedNotes=' + out.afterAdd)
    check('从正文删掉 [[标题]] 后掉链', out.afterRemove === 0, 'linkedNotes=' + out.afterRemove)
    check('正文重新写回后再次落链', out.afterReAdd === 1, 'linkedNotes=' + out.afterReAdd)
    check('手动关联与派生关联并存', out.afterManual === 2, 'linkedNotes=' + out.afterManual)
    check(
      '清空正文不得误删手动关联的那条',
      out.afterManualThenClear === 1,
      'linkedNotes=' + out.afterManualThenClear
    )
    check('解除手动关联后清空', out.afterDetach === 0, 'linkedNotes=' + out.afterDetach)
  }

  // 计数器与关联列表必须同源（⇄N 走的是 noteCounts）
  const counts = await app.evaluate(
    '(async () => { const rows = await window.zhixing.db.noteCounts(); return rows.filter((r) => r.c > 0).length })()'
  )
  check('noteCounts 可读（⇄N 计数同源）', typeof counts === 'number', '非零计数行=' + counts)
} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}
await app.close()
process.exit(finish())
