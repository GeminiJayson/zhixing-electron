/**
 * 两个「静默失效」缺陷的端到端验证。
 *
 * 来由（第 12 轮灌种子数据时暴露）：
 *  ① 任务正文里先写 [[标题]]、之后才建同名笔记 —— 链接永远落不上。
 *     syncTaskNoteLinks 在建任务/改正文时就解析，那时笔记还不存在；
 *     而应用没有「笔记建好后重新解析任务正文」的入口（Python 版有 link_wiki_notes）。
 *  ② 中文检索跨分词边界查不到 —— **复核后不成立，这条是我此前误判**。
 *     我当时拿裸 SQL「task_fts MATCH '多步写'」测得 0 条就下了结论；
 *     而应用自己的检索路径会先用 jieba 把查询词切开再拼前缀匹配
 *     （query.terms → "多"* AND "步"* AND "写"*），实测命中正常。
 *     所以这条从「待修缺陷」改成**回归护栏**：跨分词边界的检索必须一直能命中。
 *
 * ①②都是**静默**的：①不报错、只是关联为 0；所以断言必须写成行为而不是实现。
 */
import { join } from 'node:path'
import { ROOT, launchApp, createChecker, sleep } from './lib/cdp.mjs'

const app = await launchApp({
  port: 9412,
  home: join(ROOT, '.screenshots', 'search-home')
})
const { check, finish } = createChecker()

const BROWSER = [
  '(async () => {',
  '  const db = window.zhixing.db',
  '  const stamp = String(Date.now()).slice(-6)',
  '  const out = { stamp: stamp }',
  '  const folders = await db.listFolders()',
  '  const f = folders.find((x) => x.kind === "note") || folders[0] || null',
  '  const folderId = f ? f.id : null',
  '  const linked = async (taskId) => (await db.linkedNotes(taskId)).length',
  '',
  '  // ① 先写正文、后建笔记',
  '  const futureTitle = "未来笔记" + stamp',
  '  const t1 = await db.createTask("先写正文后建笔记验证 " + stamp, null, null)',
  '  await db.updateTask(t1.id, { notes_md: "[[" + futureTitle + "]]" })',
  '  out.beforeNote = await linked(t1.id)',
  '  const n1 = await db.createNote(futureTitle, folderId, "等待被引用的笔记", "markdown")',
  '  out.afterNote = await linked(t1.id)',
  '',
  '  // 基线：先建笔记、再写正文（这条路一直是对的）',
  '  const n2 = await db.createNote("已有笔记" + stamp, folderId, "已经存在", "markdown")',
  '  const t2 = await db.createTask("先建笔记后引用验证 " + stamp, null, null)',
  '  await db.updateTask(t2.id, { notes_md: "[[" + n2.title + "]]" })',
  '  out.baselineOrder = await linked(t2.id)',
  '',
  '  // ② 检索：含一段会被 jieba 切开的连续汉字',
  '  const marker = "多步写"',
  '  const t3 = await db.createTask("兜底验证-" + marker + "-" + stamp, null, null)',
  '  const hitCross = await db.globalSearch(marker)',
  '  const crossTitles = ((hitCross && hitCross.task) || []).map((x) => x.title)',
  '  out.crossTokenHits = crossTitles.length',
  '  out.crossTokenFoundOurs = crossTitles.some((s) => s.indexOf(stamp) >= 0)',
  '  const hitWord = await db.globalSearch("收口")',
  '  out.wordHits = ((hitWord && hitWord.task) || []).length',
  '  const hitNone = await db.globalSearch("这个串一定不存在zz" + stamp)',
  '  out.noneHits = ((hitNone && hitNone.task) || []).length',
  '',
  // 显式重解析入口（对齐 Python 的 link_wiki_notes）—— 修历史数据要用它
  '  const repaired = await db.linkTaskWikiNotes(t2.id)',
  '  out.repairIsArray = Array.isArray(repaired)',
  '',
  '  try { await db.deleteTask(t1.id); await db.deleteTask(t2.id); await db.deleteTask(t3.id); await db.deleteNote(n1.id); await db.deleteNote(n2.id) } catch (e) {}',
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
  check('① 写正文时笔记还不存在 → 暂时无关联（符合预期）', out.beforeNote === 0, 'linkedNotes=' + out.beforeNote)
  check('① 笔记建好之后，派生关联应自动落上', out.afterNote === 1, 'linkedNotes=' + out.afterNote)
  check('基线：先建笔记再写正文，关联为 1', out.baselineOrder === 1, 'linkedNotes=' + out.baselineOrder)
  check('② 搜成词「收口」仍能命中（兜底不能把正常检索弄坏）', out.wordHits > 0, '命中 ' + out.wordHits + ' 条')
  check(
    '② 搜跨分词边界的连续字「多步写」应命中本任务',
    out.crossTokenFoundOurs === true,
    '命中 ' + out.crossTokenHits + ' 条，其中含本任务=' + out.crossTokenFoundOurs
  )
  check('② 不存在的串仍是 0 条', out.noneHits === 0, '命中 ' + out.noneHits + ' 条')
  check('③ 显式重解析入口可用（修历史数据）', out.repairIsArray === true, 'linkTaskWikiNotes 返回数组=' + out.repairIsArray)
} catch (err) {
  check('脚本跑完', false, err instanceof Error ? err.message : String(err))
}
await app.close()
process.exit(finish())
