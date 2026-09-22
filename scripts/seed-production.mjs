/**
 * 把一套真实语义的种子数据落到知行库。
 *
 * 用法：
 *   node scripts/seed-production.mjs            # 默认在**库副本**上试跑，不碰真实库
 *   node scripts/seed-production.mjs --apply    # 真写到 %APPDATA%\ZhiXing（生产库）
 *   node scripts/seed-production.mjs --apply --db <目录>
 *
 * 三条安全设计：
 *  1. 默认跑副本：用 VACUUM INTO 从目标库取一份一致快照再写，试跑永远动不到真实库。
 *  2. --apply 时用独立的 --user-data-dir（Electron 的单实例锁按它区分），
 *     因此可以与用户正在运行的实例并存；WAL + busy_timeout 下两个进程读写同一只库是安全的。
 *  3. 全程不走裸 SQL —— 全部经由应用自身的写入接口，FTS 索引、wiki 链接、计数、排序键
 *     都由真实代码路径维护。写完落一份清单文件（标题→id），要回滚可以按它精确删。
 */
import { join } from 'node:path'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { launchApp } from './lib/cdp.mjs'
import { buildSeed } from './seed-data.mjs'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const dbIdx = argv.indexOf('--db')
const targetDir = dbIdx >= 0 ? argv[dbIdx + 1] : join(process.env.APPDATA ?? '', 'ZhiXing')
const prodDb = join(targetDir, 'zhixing.db')
if (!existsSync(prodDb)) {
  console.error('找不到目标库：' + prodDb)
  process.exit(1)
}

const workHome = join(process.cwd(), '.screenshots', 'seed-home')
const profileDir = join(process.cwd(), '.screenshots', 'seed-profile')

if (!apply) {
  rmSync(workHome, { recursive: true, force: true })
  mkdirSync(workHome, { recursive: true })
  const src = new DatabaseSync(prodDb)
  src.exec("VACUUM INTO '" + join(workHome, 'zhixing.db').replace(/\\/g, '/') + "'")
  src.close()
  console.log('【副本】已从目标库取快照 → ' + join(workHome, 'zhixing.db'))
} else {
  console.log('【生产】直接写入 ' + prodDb)
}

const home = apply ? targetDir : workHome
const app = await launchApp({
  port: 9410,
  home,
  copyDb: false,
  clean: false,
  profile: profileDir,
  settle: 4000
})

// 把内容当 JSON 注入：JSON 是 JS 的子集，比拼字符串安全得多
const seed = buildSeed()
await app.evaluate('window.__SEED = ' + JSON.stringify(seed) + '; null', true)

const BROWSER = [
  '(async () => {',
  '  const S = window.__SEED',
  '  const db = window.zhixing.db',
  '  const R = { ids: {}, notes: {}, folders: {}, lists: {}, tags: {}, workflows: {}, counts: {}, errors: [] }',
  '  const step = async (label, fn) => {',
  '    try { return await fn() } catch (e) { R.errors.push(label + " — " + ((e && e.message) || String(e))); return null }',
  '  }',
  '  const base = new Date()',
  '  const dayStr = (n) => new Date(base.getTime() + n * 86400000).toISOString().slice(0, 10)',
  '',
  '  // ---- 清单',
  '  for (const name of ["知行 2.0 迭代", S.daily.list]) {',
  '    const row = await step("建清单 " + name, () => db.createListFolder(name, "list", null))',
  '    if (row) R.lists[name] = row.id',
  '  }',
  '  const mainList = R.lists["知行 2.0 迭代"] || null',
  '',
  '  // ---- 标签',
  '  for (const t of ["深度工作", "等待他人", "外出", "电话", "复习", "待归档", "研究", "复盘", "架构"]) {',
  '    const id = await step("建标签 " + t, () => db.createTag(t))',
  '    if (id) R.tags[t] = id',
  '  }',
  '',
  '  // ---- 任务树：递归建，ID 记在 R.ids 里供后面关联用',
  '  const mk = async (spec, parentId, listId) => {',
  '    const t = await step("建任务 " + spec.title, () => db.createTask(spec.title, parentId, listId))',
  '    if (!t) return null',
  '    R.ids[spec.title] = t.id',
  '    if (spec.status) await step("状态 " + spec.title, () => db.setStatus(t.id, spec.status))',
  '    if (spec.priority) await step("优先级 " + spec.title, () => db.setPriority(t.id, spec.priority))',
  '    if (spec.due != null) await step("截止 " + spec.title, () => db.setDueDate(t.id, dayStr(spec.due)))',
  '    if (spec.resume != null) await step("恢复日 " + spec.title, () => db.pauseTask(t.id, dayStr(spec.resume)))',
  '    if (spec.repeat) await step("重复 " + spec.title, () => db.updateTask(t.id, { repeat_period: spec.repeat }))',
  '    if (spec.notes_md) await step("正文链接 " + spec.title, () => db.updateTask(t.id, { notes_md: spec.notes_md }))',
  '    if (spec.tags && spec.tags.length) await step("标签 " + spec.title, () => db.setTaskTags(t.id, spec.tags))',
  '    for (const c of (spec.children || [])) await mk(c, t.id, listId)',
  '    return t',
  '  }',
  '',
  '  // 一级任务的正文挂真实笔记标题 —— 走 [[标题]] 派生关联这条路',
  '  const L1_NOTES = ["架构决策：多步写一律进事务", "需求澄清：提醒策略的三个开关", "渲染层页面拆分草案", "端到端基线：哪些脚本还能跑", "发布检查清单"]',
  '  for (let i = 0; i < S.tree.length; i++) {',
  '    await mk(S.tree[i], null, mainList)',
  '  }',
  '  for (const spec of S.inbox) await mk(Object.assign({ tags: spec.tags }, spec), null, null)',
  '  for (const spec of S.daily.tasks) await mk(spec, null, R.lists[S.daily.list] || null)',
  '',
  '  // ---- 笔记文件夹（三层，先建父再建子）',
  '  for (const f of S.noteFolders) {',
  '    const parentId = f.parent ? (R.folders[f.parent] || null) : null',
  '    const row = await step("建笔记文件夹 " + f.name, () => db.createNoteFolder(f.name, parentId))',
  '    if (row) R.folders[f.key] = row.id',
  '  }',
  '',
  '  // ---- 笔记（5 种格式）',
  '  for (const n of S.notes) {',
  '    const body = n.url ? (n.url + "\\n\\n" + n.content) : n.content',
  '    const row = await step("建笔记 " + n.title, () => db.createNote(n.title, R.folders[n.folder] || null, body, n.format))',
  '    if (!row) continue',
  '    R.notes[n.key] = row.id',
  '    const patch = {}',
  '    if (n.pinned) patch.pinned = true',
  '    if (S.noteProps[n.key]) patch.props = JSON.stringify(S.noteProps[n.key])',
  '    if (Object.keys(patch).length) await step("笔记属性 " + n.title, () => db.saveNote(row.id, patch))',
  '  }',
  '',
  '  // ---- 回填一级任务的正文链接',
  '  // 必须放在笔记建好之后：syncTaskNoteLinks 解析不到标题就不落链，',
  '  // 而应用目前没有「笔记建好后重新解析任务正文」的入口。',
  '  for (let i = 0; i < S.tree.length; i++) {',
  '    const tid = R.ids[S.tree[i].title]',
  '    if (tid) await step("正文链接 " + S.tree[i].title, () => db.updateTask(tid, { notes_md: "[[" + L1_NOTES[i] + "]]" }))',
  '  }',
  '',
  '  // ---- 手动「归属」关联（任务 ↔ 笔记）',
  '  const MANUAL = [',
  '    ["用事务包裹跨表写入", "adr"], ["架构护栏与变异验证", "baseline"],',
  '    ["清点提醒派发链路", "req"], ["合并重复的状态写入", "render"],',
  '    ["发版后校验与回滚", "checklist"], ["资产上传与失败退出码", "lkgh"]',
  '  ]',
  '  for (const pair of MANUAL) {',
  '    const tid = R.ids[pair[0]], nid = R.notes[pair[1]]',
  '    if (tid && nid) await step("归属 " + pair[0], () => db.attachTaskNote(tid, nid))',
  '  }',
  '',
  '  // ---- 段落级关联（任务 ↔ 笔记的某个块）',
  '  for (const b of S.noteBlocks) {',
  '    const tid = R.ids[b.task], nid = R.notes[b.note]',
  '    if (tid && nid) await step("段落 " + b.task, () => db.attachNoteBlock(tid, nid, b.block, b.snippet))',
  '  }',
  '',
  '  // ---- 闪记收件箱',
  '  const flashIds = []',
  '  for (const f of S.flashes) {',
  '    const row = await step("建闪记 " + f.content.slice(0, 12), () => db.addFlash(f.content, f.remark || "", f.source_app || "", f.source_url || ""))',
  '    if (!row) continue',
  '    flashIds.push(row.id)',
  '    if (f.tags && f.tags.length) await step("闪记标签", () => db.tagFlash(row.id, f.tags))',
  '  }',
  '  // 一条闪记转成任务、一条转成子任务 —— 覆盖 converted 分支',
  '  if (flashIds[0]) await step("闪记转任务", () => db.flashToTask(flashIds[0]))',
  '  if (flashIds[1] && R.ids["清点全部多步写点"]) await step("闪记转子任务", () => db.flashToSubtask(flashIds[1], R.ids[S.inbox[0].title]))',
  '',
  '  // ---- 工作流分组 + 三个模板',
  '  const group = await step("建工作流分组", () => db.saveWorkflowGroup({ name: "2.0 收口", parent_id: null }))',
  '  for (const wf of S.workflows) {',
  '    const nodes = wf.steps.map((s, i) => {',
  '      const n = { title: s.title, detail: s.detail || "", order_index: i, action_kind: s.kind }',
  '      if (s.kind === "script") { n.action_value = s.value; n.action_expect = s.expect || "0"; n.action_runtime = s.runtime || "node" }',
  '      if (s.kind === "condition") n.action_value = JSON.stringify(s.value)',
  '      return n',
  '    })',
  '    const saved = await step("建模板 " + wf.name, () => db.saveWorkflowTemplate({ name: wf.name, description: wf.description, start_policy: wf.start_policy, nodes: nodes }))',
  '    if (!saved || !saved.ok) { if (saved && saved.problems) R.errors.push("模板 " + wf.name + " 校验未过：" + saved.problems.join("；")); continue }',
  '    const tid = saved.templateId',
  '    R.workflows[wf.name] = tid',
  '    const full = await step("读回模板 " + wf.name, () => db.workflowTemplate(tid))',
  '    if (!full) continue',
  '    const byKey = {}',
  '    for (let i = 0; i < wf.steps.length; i++) byKey[wf.steps[i].key] = full.nodes[i] && full.nodes[i].id',
  '    for (const s of wf.steps) {',
  '      if (s.kind !== "condition") continue',
  '      if (s.yes) await step("条件成立分支 " + wf.name, () => db.setWorkflowBranch(byKey[s.key], byKey[s.yes], "true"))',
  '      if (s.no) await step("条件不成立分支 " + wf.name, () => db.setWorkflowBranch(byKey[s.key], byKey[s.no], "false"))',
  '    }',
  '    if (group && group.id) await step("归入分组", () => db.moveWorkflowTemplate(tid, group.id))',
  '  }',
  '  // 实例化前两个模板 —— 让「流程可实际运行」这件事在库里就有证据',
  '  for (const name of ["每周复盘", "发布前置检查"]) {',
  '    const tid = R.workflows[name]',
  '    if (tid) await step("实例化 " + name, () => db.instantiateWorkflow(tid, name + " · 本周", null, "first"))',
  '  }',
  '',
  '  // ---- 智能清单（把常用视角固化下来）',
  '  const QUERIES = [',
  '    { name: "我这周要清的", kind: "task", expr: "!done priority>=3" },',
  '    { name: "等别人回话的", kind: "task", expr: "status:waiting" },',
  '    { name: "深度工作", kind: "task", expr: "!done tag:深度工作" }',
  '  ]',
  '  for (const q of QUERIES) await step("智能清单 " + q.name, () => db.saveSavedQuery(q))',
  '',
  '  // ---- 番茄钟记录：挂在两条真实任务上',
  '  const FOCUS = [["清点全部多步写点", 50, true, null], ["抽出纯决策函数", 25, false, "被电话打断"], ["用事务包裹跨表写入", 50, true, null]]',
  '  for (const f of FOCUS) {',
  '    const tid = R.ids[f[0]]',
  '    if (tid) await step("番茄钟 " + f[0], () => db.recordPomodoro(tid, f[1], f[2], f[3]))',
  '  }',
  '',
  '  R.counts.taskIds = Object.keys(R.ids).length',
  '  R.counts.noteIds = Object.keys(R.notes).length',
  '  R.counts.folders = Object.keys(R.folders).length',
  '  R.counts.flashes = flashIds.length',
  '  R.counts.templates = Object.keys(R.workflows).length',
  '  return R',
  '})()'
].join('\n')

// 注入的这段代码一旦有语法错，CDP 只回一句 Invalid or unexpected token；
// 落一份到磁盘就能直接用 node --check 定位。
writeFileSync(join(process.cwd(), '.screenshots', 'seed-browser.js'), BROWSER, 'utf8')
const report = await app.evaluate(BROWSER, true)
await app.close()

console.log('')
console.log('=== 播种报告 ===')
console.log('写入目标：' + home)
console.log('任务 id 数：' + (report.counts.taskIds || 0))
console.log('笔记 id 数：' + (report.counts.noteIds || 0))
console.log('笔记文件夹：' + (report.counts.folders || 0))
console.log('闪记：' + (report.counts.flashes || 0))
console.log('工作流模板：' + (report.counts.templates || 0))
console.log('报错：' + report.errors.length + ' 条')
for (const e of report.errors) console.log('  ✗ ' + e)

const manifestPath = join(process.cwd(), '.screenshots', 'seed-manifest.json')
writeFileSync(manifestPath, JSON.stringify({ target: home, applied: apply, seed: report }, null, 2), 'utf8')
console.log('清单文件：' + manifestPath)
process.exit(report.errors.length ? 1 : 0)
