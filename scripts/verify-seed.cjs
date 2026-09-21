const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.argv[2])
const q = (s, ...a) => db.prepare(s).get(...a)
const all = (s, ...a) => db.prepare(s).all(...a)
const R = []
const chk = (name, ok, detail) => { R.push(ok); console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : '')) }
const MINE = ['每周复盘', '发布前置检查', '读书笔记整理']

console.log('=== 任务树（3 层 × 每层 5 条）===')
const listId = q("SELECT id FROM list_folder WHERE kind='list' AND name='知行 2.0 迭代'").id
const roots = all('SELECT id FROM task WHERE list_id=? AND parent_id IS NULL AND deleted_at IS NULL', listId)
const kids = (id) => all('SELECT id FROM task WHERE parent_id=? AND deleted_at IS NULL', id)
const l2 = roots.flatMap((r) => kids(r.id))
const l3 = l2.flatMap((c) => kids(c.id))
chk('第一层 5 条', roots.length === 5, String(roots.length))
chk('第二层 25 条', l2.length === 25, String(l2.length))
chk('第三层 125 条', l3.length === 125, String(l3.length))
chk('没有第四层', l3.every((x) => kids(x.id).length === 0))

console.log('\n=== 功能分支覆盖 ===')
const st = all('SELECT status, COUNT(*) c FROM task WHERE deleted_at IS NULL GROUP BY status')
chk('五种状态都出现', ['todo','doing','waiting','done','abandoned'].every((s) => st.some((x) => x.status === s)), st.map((x) => x.status + '=' + x.c).join(', '))
chk('优先级覆盖 1-4', [1,2,3,4].every((p) => q('SELECT COUNT(*) c FROM task WHERE priority=?', p).c > 0))
chk('截止日期', q('SELECT COUNT(*) c FROM task WHERE due_date IS NOT NULL').c > 0)
const rp = all("SELECT repeat_period, COUNT(*) c FROM task WHERE repeat_period IS NOT NULL AND repeat_period NOT IN ('', 'none') GROUP BY repeat_period")
chk('真·重复任务（排除空值/none）', rp.length > 0 && rp.reduce((s, x) => s + x.c, 0) < 20, rp.map((x) => x.repeat_period + '=' + x.c).join(', '))
chk('等待中(暂停+恢复日)', q('SELECT COUNT(*) c FROM task WHERE resume_at IS NOT NULL').c > 0, q('SELECT COUNT(*) c FROM task WHERE resume_at IS NOT NULL').c + ' 条')
chk('标签关联', q('SELECT COUNT(*) c FROM task_tag').c > 0, q('SELECT COUNT(*) c FROM task_tag').c + ' 条')

console.log('\n=== 笔记（5 种格式）===')
const fm = all("SELECT format, COUNT(*) c FROM note WHERE deleted_at IS NULL GROUP BY format ORDER BY format")
chk('每类 >= 5 篇', ['markdown','richtext','word','excel','link'].every((f) => (fm.find((x)=>x.format===f)||{c:0}).c >= 5), fm.map((x) => x.format + '=' + x.c).join(', '))
chk('置顶笔记', q('SELECT COUNT(*) c FROM note WHERE pinned=1').c > 0)
chk('结构化属性 props', q("SELECT COUNT(*) c FROM note WHERE props IS NOT NULL AND props<>''").c > 0)
const depth = (id) => { let d = 1, cur = id; while (true) { const r = q('SELECT parent_id FROM note_folder WHERE id=?', cur); if (!r || r.parent_id == null) break; d++; cur = r.parent_id } return d }
const fdepths = all('SELECT id FROM note_folder').map((f) => depth(f.id))
chk('文件夹嵌套 3 层', Math.max(...fdepths) >= 3, '最深 ' + Math.max(...fdepths) + ' 层，共 ' + fdepths.length + ' 个')

console.log('\n=== 关联关系 ===')
const bysrc = all("SELECT COALESCE(source,'(空)') s, COUNT(*) c FROM task_note_link GROUP BY s")
console.log('任务↔笔记关联: ' + bysrc.map((x) => x.s + '=' + x.c).join(', '))
chk('派生关联（正文 [[标题]]）', bysrc.some((x) => x.s === 'wiki' && x.c > 0))
chk('手动归属关联', bysrc.some((x) => x.s === 'manual' && x.c > 0))
chk('段落级关联', q('SELECT COUNT(*) c FROM task_note_context').c > 0, q('SELECT COUNT(*) c FROM task_note_context').c + ' 条')
chk('笔记↔笔记链接', q('SELECT COUNT(*) c FROM note_link').c > 0, q('SELECT COUNT(*) c FROM note_link').c + ' 条')

console.log('\n=== 闪记 / 收件箱 ===')
const fl = all('SELECT status, COUNT(*) c FROM flash WHERE deleted_at IS NULL GROUP BY status')
chk('收件箱里有闪记 >= 5', (fl.find((x)=>x.status==='inbox')||{c:0}).c >= 5, fl.map((x) => x.status + '=' + x.c).join(', '))
chk('闪记带标签', q('SELECT COUNT(*) c FROM flash_tag').c > 0)
chk('收件箱任务 >= 5', all('SELECT id FROM task WHERE list_id IS NULL AND parent_id IS NULL AND deleted_at IS NULL').length >= 5)

console.log('\n=== 工作流（3 个模板，可实际运行）===')
chk('新建 3 个模板', MINE.every((n) => q('SELECT COUNT(*) c FROM workflow_template WHERE name=?', n).c === 1), MINE.join(' / '))
const nd = MINE.map((n) => n + '=' + q('SELECT COUNT(*) c FROM workflow_node WHERE template_id=(SELECT id FROM workflow_template WHERE name=?)', n).c)
chk('每个模板都有 >= 4 个节点', MINE.every((n) => q('SELECT COUNT(*) c FROM workflow_node WHERE template_id=(SELECT id FROM workflow_template WHERE name=?)', n).c >= 4), nd.join(' '))
chk('条件节点配了分支', q("SELECT COUNT(*) c FROM workflow_node WHERE template_id IN (SELECT id FROM workflow_template WHERE name IN ('每周复盘','发布前置检查','读书笔记整理')) AND (branch_node_id IS NOT NULL OR branch_false_node_id IS NOT NULL)").c >= 3)
chk('有实例（真跑过实例化）', q('SELECT COUNT(*) c FROM workflow_instance').c >= 2, q('SELECT COUNT(*) c FROM workflow_instance').c + ' 个')
chk('实例派生出步骤任务', q('SELECT COUNT(*) c FROM workflow_step_task').c > 0, q('SELECT COUNT(*) c FROM workflow_step_task').c + ' 条')

console.log('\n=== 其它功能 ===')
chk('智能清单', q('SELECT COUNT(*) c FROM saved_query').c >= 3, q('SELECT COUNT(*) c FROM saved_query').c + ' 条')
chk('番茄钟记录', q('SELECT COUNT(*) c FROM pomodoro_session').c >= 3, q('SELECT COUNT(*) c FROM pomodoro_session').c + ' 条')
chk('工作流分组', q('SELECT COUNT(*) c FROM workflow_group').c > 0)

console.log('\n=== 全文检索索引一致性 ===')
const ot = q('SELECT COUNT(*) c FROM task_fts WHERE task_id NOT IN (SELECT id FROM task)').c
const on = q('SELECT COUNT(*) c FROM note_fts WHERE note_id NOT IN (SELECT id FROM note)').c
chk('task 无残留索引行', ot === 0, 'task_fts=' + q('SELECT COUNT(*) c FROM task_fts').c + ' task=' + q('SELECT COUNT(*) c FROM task').c)
chk('note 无残留索引行', on === 0, 'note_fts=' + q('SELECT COUNT(*) c FROM note_fts').c + ' note=' + q('SELECT COUNT(*) c FROM note').c)
chk('中文检索命中（成词）', q("SELECT COUNT(*) c FROM task_fts WHERE task_fts MATCH '事务'").c > 0, "搜「事务」命中 " + q("SELECT COUNT(*) c FROM task_fts WHERE task_fts MATCH '事务'").c + " 条")
console.log('ℹ 已知限制：搜「多步写」命中 ' + q("SELECT COUNT(*) c FROM task_fts WHERE task_fts MATCH '多步写'").c + ' 条 —— 索引里被切成「多 步 写」，跨分词边界的查询查不到（fts.ts 没有 LIKE 兜底）')

console.log('\n' + (R.filter((x) => !x).length ? '✗ ' + R.filter((x) => !x).length + ' 项未通过' : '✓ 全部通过（' + R.length + ' 项）'))
process.exit(R.filter((x) => !x).length ? 1 : 0)
