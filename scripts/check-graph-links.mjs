/**
 * 图谱连线规则：矩阵 ↔ 实现的端到端一致性检查。
 *
 * 查的是**两边有没有分叉**：ALLOWED_CONNECTIONS 说某个组合可以连，但 connectGraphNodes 里
 * 没有对应分支时，用户拖完什么都不发生、也不报错 —— 静态读代码还容易看漏（两边各自都「看起来对」）。
 * 踩过两次：folder|folder 静默失败；环路校验的参数顺序反了（上移一级被误判成环）。
 *
 * 手法：在**夹具库**（launchApp 默认，不碰真实库）上造几个文件夹/笔记/任务，对每条允许的组合
 * 走一遍「连 → 断言真的连上了 → 断 → 断言回到原状」，外加环路的两条回归：
 *   · 上移一级（挂到自己的祖父下）必须允许；
 *   · 把祖先挂到自己的后代下（真环）必须拒绝。
 *
 * 用法：node scripts/check-graph-links.mjs
 */
import { join } from 'node:path'
import { ROOT, launchApp, createChecker, J } from './lib/cdp.mjs'

const PORT = 9250
const tmpHome = join(ROOT, '.screenshots', 'graphlinks-home')
const KINDS = ['note', 'folder', 'task', 'flash', 'anchor', 'dangling']

// killStale: false —— 那条清理按「命令行里有 --remote-debugging-port」判据杀实例，
// 而**开发环境（dev-app.cmd）也带这个参数**，于是跑一次检查就把用户正在用的 dev 杀掉。
// 本脚本用独立端口（9250），不需要清理别人的实例。
const app = await launchApp({ port: PORT, home: tmpHome, killStale: false })
const { check, finish } = createChecker()

// 1) 允许矩阵（实测，权威）
const matrixExpr =
  '(async () => {' +
  '  const kinds = ' + J(KINDS) + ';' +
  '  const out = {};' +
  '  for (const a of kinds) for (const b of kinds) out[a + "." + b] = await window.zhixing.db.graphConnectionAllowed(a, b);' +
  '  return JSON.stringify(out);' +
  '})()'
const matrix = JSON.parse(await app.evaluate(matrixExpr))
const allowed = Object.keys(matrix).filter((k) => matrix[k] !== null)
console.log('允许的组合：' + allowed.map((k) => k.replace('.', ' → ') + '(' + matrix[k] + ')').join('、'))
check('矩阵里恰好 6 条允许的组合', allowed.length === 6, String(allowed.length))
check('note → dangling 已从矩阵移除（不再是「允许但做不到」）', matrix['note.dangling'] === null)
check('flash / anchor 不作为端点', KINDS.filter((k) => ['flash', 'anchor', 'dangling'].includes(k)).every((k) => KINDS.every((j) => matrix[k + '.' + j] === null && matrix[j + '.' + k] === null)))

// 2) 造数据：三层文件夹 + 两篇笔记 + 两个任务
const ids = JSON.parse(
  await app.evaluate(
    '(async () => {' +
    '  const db = window.zhixing.db;' +
    '  const A = await db.createNoteFolder("验证连线-A", null);' +
    '  const B = await db.createNoteFolder("验证连线-B", A.id);' +
    '  const C = await db.createNoteFolder("验证连线-C", B.id);' +
    '  const N1 = await db.createNote("验证连线-N1", null);' +
    '  const N2 = await db.createNote("验证连线-N2", null);' +
    '  const T1 = await db.createTask("验证连线-T1", null, null);' +
    '  const T2 = await db.createTask("验证连线-T2", null, null);' +
    '  return JSON.stringify({ A: A.id, B: B.id, C: C.id, N1: N1.id, N2: N2.id, T1: T1.id, T2: T2.id });' +
    '})()'
  )
)

const connect = (sk, sr, dk, dr, kind) =>
  app.evaluate('window.zhixing.db.connectGraphNodes(' + J(sk) + ',' + sr + ',' + J(dk) + ',' + dr + ',' + J(kind) + ')')
const removeEdge = (sk, sr, dk, dr, kind) =>
  app.evaluate('window.zhixing.db.removeGraphEdge(' + J(sk) + ',' + sr + ',' + J(dk) + ',' + dr + ',' + J(kind) + ')')
const folderParent = async (id) =>
  (await app.evaluate('window.zhixing.db.noteFolders()')).find((f) => f.id === id).parent_id
const noteFolder = async (id) => (await app.evaluate('window.zhixing.db.notes()')).find((n) => n.id === id).folder_id
const taskParent = async (id) => (await app.evaluate('window.zhixing.db.tasks()')).find((t) => t.id === id).parent_id

// 3) folder → folder（改挂 / 断开回顶层）
check('folder → folder 允许（落库有分支）', await connect('folder', ids.B, 'folder', ids.C, 'ownership') === true)
check('  ↳ 子文件夹真的挂过去了', (await folderParent(ids.C)) === ids.B)
check('  断开 → 回到顶层', (await removeEdge('folder', ids.B, 'folder', ids.C, 'ownership')) === true && (await folderParent(ids.C)) === null)
check('  ↳ 复位', await connect('folder', ids.B, 'folder', ids.C, 'ownership') === true)

// 4) 环路两条回归（曾经都错）
check('上移一级（挂到祖父下）允许 —— 曾经被误判成环', await connect('folder', ids.A, 'folder', ids.C, 'ownership') === true)
check('  ↳ 确实挂到了祖父下', (await folderParent(ids.C)) === ids.A)
check('  ↳ 复位', await connect('folder', ids.B, 'folder', ids.C, 'ownership') === true)
check('真环（把祖先挂到自己的后代下）仍被拒绝', await connect('folder', ids.C, 'folder', ids.A, 'ownership') === false)

// 5) folder → note（改笔记归属 / 断开归「全部笔记」）
check('folder → note 允许', await connect('folder', ids.A, 'note', ids.N1, 'ownership') === true)
check('  ↳ 笔记真的移进去了', (await noteFolder(ids.N1)) === ids.A)
check('  断开 → 归全部笔记', (await removeEdge('folder', ids.A, 'note', ids.N1, 'ownership')) === true && (await noteFolder(ids.N1)) === null)

// 6) note → note（引用）
check('note → note 允许', await connect('note', ids.N1, 'note', ids.N2, 'reference') === true)
check('  断开', (await removeEdge('note', ids.N1, 'note', ids.N2, 'reference')) === true)

// 7) task ↔ note（归属 / 引用两种边类）
check('task → note（归属）允许', await connect('task', ids.T1, 'note', ids.N1, 'ownership') === true)
check('  断开', (await removeEdge('task', ids.T1, 'note', ids.N1, 'ownership')) === true)
check('task → note（引用）允许', await connect('task', ids.T1, 'note', ids.N2, 'reference') === true)
check('  断开', (await removeEdge('task', ids.T1, 'note', ids.N2, 'reference')) === true)
check('note → task 方向归一（等价于 task → note）', await connect('note', ids.N2, 'task', ids.T1, 'reference') === true)
check('  断开', (await removeEdge('task', ids.T1, 'note', ids.N2, 'reference')) === true)

// 8) task → task（改挂子任务）
check('task → task 允许', await connect('task', ids.T1, 'task', ids.T2, 'ownership') === true)
check('  ↳ 子任务真的挂过去了', (await taskParent(ids.T2)) === ids.T1)
check('  断开 → 回到顶层', (await removeEdge('task', ids.T1, 'task', ids.T2, 'ownership')) === true && (await taskParent(ids.T2)) === null)

// 9) 不允许的组合必须被落库拒绝（矩阵说不行，实现也别偷偷放行）
check('anchor 端点被拒', await connect('note', ids.N1, 'anchor', 1, 'reference') === false)
check('flash 端点被拒', await connect('flash', 1, 'note', ids.N1, 'reference') === false)
check('dangling 端点被拒', await connect('note', ids.N1, 'dangling', 1, 'reference') === false)

await app.close()
process.exit(finish())