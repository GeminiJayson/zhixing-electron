/**
 * 清空数据库的端到端检查（跑在**隔离实例**上：launchApp 默认用临时 home 的夹具库）。
 *
 * 这个操作不可逆，所以在真库上没法验；而它又有三处容易做错：
 *   · 忘了跳过 FTS 影子表 → 全文索引坏掉，之后搜索要么报错要么悄悄查不到；
 *   · 把 settings 一起清了 → 用户的主题/热键/AI 配置被顺带重置；
 *   · 没重建默认文件夹 → 新库是空的，界面上一个文件夹都没有。
 * 这个脚本把这三点都钉住。
 *
 * 用法：npm run build && node scripts/check-wipe.mjs（跑的是 out/ 里的构建产物）
 */
import { join } from 'node:path'
import { ROOT, launchApp, createChecker } from './lib/cdp.mjs'

const PORT = 9252
const tmpHome = join(ROOT, '.screenshots', 'wipe-home')
const app = await launchApp({ port: PORT, home: tmpHome, killStale: false })
const { check, finish } = createChecker()

// 造点数据 + 一个要保留的设置键
const before = JSON.parse(
  await app.evaluate(`(async () => {
    const db = window.zhixing.db
    await db.createTask('待清空任务', null, null)
    await db.createNote('待清空笔记', null)
    await db.setSetting('测试_保留键', 'kept')
    return JSON.stringify({ tasks: (await db.tasks()).length, notes: (await db.notes()).length })
  })()`)
)
console.log('清空前：任务 ' + before.tasks + ' / 笔记 ' + before.notes)

const res = JSON.parse(await app.evaluate('window.zhixing.db.wipeDatabase().then((r) => JSON.stringify(r))'))
console.log('清空返回：' + JSON.stringify(res))

const after = JSON.parse(
  await app.evaluate(`(async () => {
    const db = window.zhixing.db
    return JSON.stringify({
      tasks: (await db.tasks()).length,
      notes: (await db.notes()).length,
      folders: (await db.noteFolders()).map((f) => f.name),
      kept: (await db.settings())['测试_保留键'] ?? null,
    })
  })()`)
)
check('清空后任务为空', after.tasks === 0, String(after.tasks))
check('清空后笔记为空', after.notes === 0, String(after.notes))
check('设置被保留（不是顺带重置）', after.kept === 'kept', String(after.kept))
check('默认文件夹重建了', after.folders.length > 0, after.folders.join(' / '))
check('返回了删掉的表数与行数', res.tables > 0 && res.rows > 0, JSON.stringify(res))

// 关键：FTS 没被搞坏 —— 清空之后还能正常写入与读取
const fts = JSON.parse(
  await app.evaluate(`(async () => {
    const db = window.zhixing.db
    const n = await db.createNote('清空后新建的笔记', null)
    const rows = await db.notes()
    const t = await db.createTask('清空后新建的任务', null, null)
    return JSON.stringify({ noteCreated: !!n, noteCount: rows.length, taskCreated: !!t })
  })()`)
)
check('清空后仍能新建笔记（FTS 未被破坏）', fts.noteCreated === true, JSON.stringify(fts))
check('清空后仍能新建任务', fts.taskCreated === true)
check('新写入的内容读得回来', fts.noteCount === 1, String(fts.noteCount))

await app.close()
process.exit(finish())