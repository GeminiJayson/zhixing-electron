# Python ↔ Electron 功能对齐跟踪

> 审计方法：6 组并行、**代码对代码**（不采信任何文档结论，`electron/README.md` 的
> 迁移表已确认与代码严重不符）。每条差异均带两侧 `file:line` 证据。
> 分域明细见 `audit/` 目录。

## 总览（6 域 152 条）

| 域 | 条数 | 完成度 | 明细 |
| --- | --- | --- | --- |
| 任务 | 17 | 主链已对齐；列表分组、任务↔笔记关联、等待中恢复结构性缺失 | `audit/task.md` |
| 笔记 | 22 | ~60%；格式体系、附件、全文检索、段落锚整链缺失 | `audit/notes.md` |
| 图谱 / 搜索 / 回顾 | 15 | 回顾 ~85%、图谱 ~30%、**全局搜索 ~10%** | `audit/graph-search-review.md` |
| 收件箱 / 工作流 / 捕获 | 39 | ~55%；编辑与运行闭环大面积缺失 | `audit/inbox-workflow.md` |
| 设置 / 平台 / 窗口 | 31 | 外观可用，设置域约六成 | `audit/settings-platform.md` |
| 数据 / 统计 / 维护 | 28 | 能读写缺护栏（迁移、备份、FTS、清理） | `audit/data-maintenance.md` |

五类结构性模式：**A** 表建了业务代码零行（`task_note_link`/`task_note_ref`/`task_note_context`/`flash_tag`/三张 FTS/`list_folder`）、**B** 功能整体缺失、**C** 后端有实现但渲染层零调用的断链、**D** 语义口径不同、**E** 护栏缺失。

## 批次划分与状态

### 批次 0 · P0 数据安全 / 崩溃 / 共享库破坏 — ✅ 已完成

| # | 问题 | 修复 | 验证 |
| --- | --- | --- | --- |
| 1 | 切换笔记丢弃防抖窗口内的编辑（数据丢失） | `NotesPage` 新增 `flushPending`/`selectNote`，全部 8 处切换入口先落盘 | 实测：输入后 120ms 切换，内容已落盘 |
| 2 | `run_command` 用 try/catch 捕异步 ENOENT，无 `'error'` 监听 | 等 `'spawn'`/`'error'` 判定；主进程加 `uncaughtException`/`unhandledRejection` 兜底 | 实测：不存在的命令返回 `ok:false` + ENOENT |
| 3 | 导入清空 `settings` 并回退 `schema_version` | 对齐 Python：settings 逐键 upsert、跳过 `schema_version` | 实测：`schema_version` 保持 12、`theme_pack` 更新、文件外键保留 |
| 4 | 无 schema 迁移链，旧库直接 `no such column` | 新增 `db/migrate.ts`（v1–v12 逐条对齐）+ `upgradeSchema`，迁移前强制备份 | 实测：v10 库升到 12，v11 列与 v12 索引均恢复 |
| 5 | 删工作流模板无运行中实例守卫 | 有运行实例时拒绝删除（返回 0），UI 给出提示 | 实测：有实例拒绝(0)、中断后成功(1) |
| 6 | 无 `close_to_widget`，主窗关闭后 `showMain()` 空转 | 新增设置项 + 关闭拦截为 hide；`showMain` 支持重建窗口 | 实测：关闭后窗口被 hide 未销毁 |
| 7 | 提醒总开关无效、无「一次性」语义 | `dueReminders` 读开关、弹窗前清 `reminder_at`；正文改为提醒时刻 | 实测：关闭开关后返回 0 条 |

### 批次 1 · 基础设施（A/E 类）— ✅ 已完成

| # | 问题 | 修复 | 验证 |
| --- | --- | --- | --- |
| 1 | 两端默认值不落库，同一库来回切换行为跳变 | `shared/settings.ts` 逐项对齐 Python 默认值与取值范围；新增 `DEFAULT_SETTINGS`，启动时 `ON CONFLICT DO NOTHING` 落库；补上 `theme_mode=system`（含系统明暗实时跟随）与「跟随系统」三态入口 | 单测断言对齐 Python 基准；56→59 项通过 |
| 2 | FTS 三表建了但从不写入 | 新增 `db/fts.ts`：12 个写路径（任务 5、笔记 4、闪念 2、回收站 3）同步索引，软删移除、恢复重建 | 实测：新建笔记/任务写入分词索引，中文 MATCH 命中，软删→0、恢复→1 |
| 3 | 中文分词不一致会导致跨客户端漏检 | 引入 `@node-rs/jieba`，与 Python 的 `cut_for_search`/`cut` 输出**逐字一致** | 实测两端输出相同；`fts-query.test.ts` 固化基准（3 项） |
| 4 | 无启动自动备份、无恢复入口 | 新增 `db/backup.ts`：启动 `autoBackup`、保留 10 份、`listBackups`/`restoreBackup`（恢复前自动 pre-restore 备份），设置页可点选恢复 | 实测：预置 12 份 → 启动后 10 份；恢复后新建的笔记被回滚，pre-restore 备份存在 |
| 5 | 导入会留下引用不存在目标的行 | 导入后按外键清理孤儿（等价 Python 的「目标缺失即跳过」） | typecheck + 导入流程回归 |

### 批次 2 · 结构性功能（B/C 类）— ✅ 已完成

| # | 问题 | 修复 | 验证 |
| --- | --- | --- | --- |
| 1 | 工作流实例推进断链：`completeWorkflowStep` 有实现与 IPC 却零调用 | 在 IPC 层接上（toggleTask / setStatus / updateTask / batchComplete 四条完成路径），并让工作流页订阅 `workflow` 域 | 实测：实例化 → 完成第 1 步 → 推进并生成第 2 步任务 → 完成第 2 步 → 实例 done |
| 2 | 全局搜索整链缺失（SearchService 不存在） | 新增 `db/search.ts`：前缀（task/note/flash/tag）+ 过滤（due/status/priority/folder）+ FTS 分档（20/8/6）+ 命令；命令面板改为调它 | 实测：关键词、四种前缀、四种过滤、空查询只回命令全部符合预期 |
| 3 | `task_note_link` 无写入路径（`[[标题]]` 永不落链） | 新增 `syncTaskNoteLinks`（解析 notes_md 的 `[[标题]]`）+ `attachTaskNote`/`detachTaskNote`/`listLinkedNotes` | 实测：写入含 `[[标题]]` 的备注自动落链、重复更新不重复、attach 幂等、detach 生效 |
| 4 | 列表/分组体系整体缺失（`list_folder` 只有隐式写入） | 新增 `db/lists.ts`：folder_tree/create/rename/delete/default_list/tasksByList/moveToList；任务页加清单筛选与新建 | 实测：父任务在清单、子任务经闭包可见、**收件箱不再重复列出子任务**、移动/重命名/删除回落均正确 |
| 5 | 闪念整理闭环缺失（标签/备注/合并/子任务/来源 URL 全无） | `addFlash` 加 source_url 与 2000/200 截断；新增 `updateFlashRemark`/`tagFlash`/`mergeFlashes`/`flashToSubtask`；收件箱加多选合并与备注/标签按钮 | 实测：source_url 落库、截断 2000、改备注、打标签、合并（原条软删）、转子任务 |
| 6 | 图谱只有「读+画」，建链/删边/改挂全缺 | `graph.ts` 加连接矩阵、`resolveEdgeKind`、`wouldCreateCycle`、`linkNotes`、`linkTaskNoteRef`/`unlinkTaskNoteRef`；图谱页加连线模式（可选归属/引用） | 实测：矩阵裁决（note→note=reference、task→note=either、task→flash=拒绝）、引用幂等、自环被拒、引用建立与解除 |
| 7 | 笔记格式被锁死为 markdown（Word/Excel/link/richtext 无法创建） | `createNote`/`saveNote` 支持 format 并做非法值回退；新建格式下拉；**链接笔记单独渲染**（此前落进 Office 分支会把 URL 当文件路径报错） | 实测：五种格式创建、非法格式回退、格式可改；link 笔记按 URL/JSON 数组渲染 |

### 批次 3 · 平台补齐 — 进行中（6/7）

| # | 问题 | 修复 | 验证 |
| --- | --- | --- | --- |
| 1 | 应用内快捷键只有 Ctrl+K / Ctrl+Z | App 统一监听并补齐 Ctrl+N（快速捕获）、Ctrl+Shift+N（新建笔记）、Ctrl+B（折叠侧栏）、Ctrl+E（预览）、Ctrl+F（查找）、Ctrl+,（设置）、Ctrl+Tab（最近两页）、Ctrl+1..6（切页）；页面经自定义事件响应 | 实测 Ctrl+2 切到任务页、Ctrl+, 切到设置页、Ctrl+B 折叠侧栏 |
| 2 | 托盘 tooltip 固定文案 | 改为「知行 ZhiXing · 今天待办 N」，并在任意写操作后刷新（通过注入的数据变更钩子，避免反向依赖） | typecheck + 写路径回归 |
| 3 | 无文件日志 | 新增 `main/log.ts`：`logs/zhixing.log`、1MB × 3 份滚动、hook console 覆盖全仓调用点 | 实测启动后日志文件已创建 |
| 4 | 6 个设置项缺失 | `autostart_enabled`（`app.setLoginItemSettings`）、`clipboard_monitor`（主进程轮询 + 提示）、`signature`（标题栏显示）、`select_quick_hotkey`、`widget_hotkey`（注册浮窗显隐热键）、`mica_enabled`（Windows 11 云母） | typecheck；设置页可选可存 |
| 5 | 划词速记降级 | Electron 无跨应用模拟复制能力，`select-quick` 读系统剪贴板预填（**降级实现**，与 Python 的选区读取不等价） | 已记录差异 |
| 6 | 浮窗贴边半隐 / 悬停滑出 / 右键菜单 | 主进程检测屏幕左右边缘（≤8px）缩为 10px 把手并放开最小宽度限制；鼠标进入/双击经 `widget:undock` 滑出；右键弹出「今日视图/取消贴边/隐藏浮窗」；恢复贴边几何时启动即进入把手态 | 实测：几何设在 x=0 时启动即为把手（innerWidth 10），undock 后恢复 290，两个 IPC 均在 |

> ⚠️ 环境备忘：`npm run dist:win` 会把 `better_sqlite3.node` 重建为 Windows 二进制，之后在 macOS 上运行 electron 会因原生模块 ABI 不符而打不开数据库（表现为设置全部回退默认值）。继续在本机调试前需先 `npm run rebuild`。

### 打包修复 · Windows 启动即崩（2026-09-17）

**现象**：Windows 上装完启动，弹报错框后直接退出，主进程根本没起来。

**根因**：`@node-rs/jieba` 的各平台 binding 放在它自己的 `optionalDependencies` 里，npm 只安装**当前平台**那一份。在 macOS 上打 Windows 包时，`jieba.win32-x64-msvc.node` 从头到尾就不在 `node_modules` 里，产物自然也没有；Windows 启动时 `require('@node-rs/jieba')` 抛 `Cannot find native binding`。

**两处修复**：

1. **补齐产物**：新增 `scripts/ensure-jieba-win-binding.mjs`，作为 `npm run dist:win` / `dist:dir` 的前置步骤；缺失时按 `@node-rs/jieba` 自己声明的版本 `npm pack` 出 win32-x64 binding 解到 `node_modules/@node-rs/`（不写死版本）。`package.json` 同步声明 `optionalDependencies`，`asarUnpack` 已覆盖 `**/node_modules/@node-rs/**`。
2. **不再一崩到底**：`db/fts-query.ts` 原先是静态 `import`，rollup 会把它提到 bundle 最前面，原生模块缺失时爆的是**模块顶层**异常，try/catch 兜不住。改为 `require` + try/catch：加载失败只 `console.warn` 并降级为逐字分词 —— 检索变糙，但应用照常启动、数据照常可用。

**验证**：

- `dist/win-unpacked/resources/app.asar.unpacked/node_modules/@node-rs/jieba-win32-x64-msvc/jieba.win32-x64-msvc.node` 存在，`file` 判定为 `PE32+ x86-64`；
- `npm run check:jieba`（本次新增）：① 构建产物顶层无 `@node-rs/jieba` 的 require；② 打桩模拟 binding 缺失 → 模块加载成功、`tokenize('知识管理')` 降级为 `知 识 管 理`；③ 对照 binding 正常 → `知识 管理`（与 Python 一致）；
- `npm test` 61/61、`npm run typecheck` 通过、`npm run rebuild` 已把本机 `better_sqlite3.node` 还原为 macOS 版本。

修复后重新出包为 **v0.1.1**（`Zhixing-0.1.1-x64-setup.exe` / `Zhixing-0.1.1-x64-portable.exe`）：用 7-Zip 解开两个 exe 的内层 `$PLUGINSDIR/app-64.7z`，两份内层包 sha256 相同，且都含 `resources/app.asar.unpacked/node_modules/@node-rs/jieba-win32-x64-msvc/jieba.win32-x64-msvc.node`（2645504 B）。

> ⚠️ 版本号必须跟着改：产物文件名带版本号，沿用旧版本号会让用户下到/装成上一版坏包；且 Gitee 同一个 tag 只能有一个 Release，复用 tag 会创建失败。

### 批次 4 · 语义口径对齐（D 类）— ✅ 已完成

| # | 问题 | 处理 | 验证 |
| --- | --- | --- | --- |
| 1 | 捕获时刻：裸 1-6 点不按下午、无 24h 校验 | 对齐 `_resolve_hour`：无修饰 1-6 点 +12；非法时刻（如 25:99）丢弃 | 单测：明天3点 → 15:00、明天25:99 → null |
| 2 | 非法日期被静默进位 | 对齐 `parse_natural_date`：回写后月份变化即判非法（2月30日 / 非闰年 2/29 → null） | 单测 3 项 |
| 3 | 捕获标题残留「前/之前/以内」与首尾标点 | 对齐 `capture_grammar` 的后处理与 `strip(" -，,")` | 单测：周五前 交付方案 → 交付方案；- 买菜 → 买菜 |
| 4 | 回收站保留期设置形同虚设 | 跨天维护末尾自动 `purgeTrashOlderThan(recycle_retention_days)`；回收站天数初值改读设置 | 回归 + typecheck |
| 5 | 「清空」只清当前 Tab | 对齐 rewrite：任务/笔记/闪念三类一起清 | typecheck |
| 6 | 删除不可撤销 | 撤销链路支持 `action='restore'`，删除后派发 undoable | typecheck |
| 7 | 番茄钟 0 分钟落库、休息不记账 | `minutes<1` 不落库；休息结束同样记一条；`recordPomodoro` 支持 `reason` | typecheck |

**有意保留的差异**（Electron 侧更正确或更直观，不为了「一致」而降级）：
- **回顾统计过滤**：Electron 的完成数/热力图/连续天数排除软删任务（Python 的 `completed_between` 未过滤）；闪念统计 Electron 只数 inbox，Python 含 archived。建议 Python 侧对齐而非反向。
- **改挂/排序**：Electron 的 `reparentTask` 重置 sort_key 到新父末位且防成环，Python 保留原 sort_key 且无环校验。
- **划词速记**：Electron 无跨应用模拟复制能力，读剪贴板属降级实现。
- **浮窗任务行**：Electron 的浮窗只支持勾选/改标题/加子任务，优先级与标签仍引导到主窗口。

---

## Electron 安全加固 · 按 `electron-development` skill 检查表核对（2026-09-17）

用 skill 的 Production Security Checklist 过了一遍主进程与 preload，逐项结论：

| 检查项 | 结论 |
| --- | --- |
| `contextIsolation: true` / `nodeIntegration: false` | 原本已满足（主窗口 + 浮窗两处） |
| preload 只用 contextBridge + 显式白名单，不透传 ipcRenderer | 原本已满足 |
| 无 `sendSync` / 无 `remote` 模块 | 原本已满足 |
| CSP | 原本已有（`renderer/index.html` 的 meta CSP） |
| 危险 HTML 清洗 | 原本已有：`MarkdownView` 用 DOMParser 白名单清洗、`preview.ts` 用正则清洗 |
| ASAR | 原本已启用 |
| **`sandbox: true`** | **原先两处窗口都是 `false` → 已改 `true`** |
| **`shell.openExternal` 的 URL 校验** | **原先 `setWindowOpenHandler` 拿到 URL 直接转交系统 → 已收敛到协议白名单** |
| **`will-navigate` 拦截** | **原先没有 → 已加** |
| **`<webview>` 拦截** | **原先没有 → 已加 `will-attach-webview`** |

新增 `src/main/security.ts`，把这三条出口收在一处（`hardenWindow`），三个 `shell.openExternal` 调用点全部改走 `openExternalSafely`：

- 协议白名单只有 `http:` / `https:` / `mailto:`；`file:`、`javascript:`、`ms-msdt:`、`smb:`、`data:` 一律拦下并写日志。
- 导航只放行应用自身入口（打包后 `file://…/out/renderer/index.html`，dev 下 vite server），其余拦下后交给系统浏览器。
- 顺带修掉一个**真实可达**的问题：原先没有 `will-navigate` 拦截，笔记正文里写一个 `file://` 链接，点下去会把整个主窗口导航到那个本地文件。

**评估后明确不做的项**（记下来免得下次重复评估）：

- **CSP 收紧**：`connect-src` 里的 `ws: http://localhost:*` 是 vite HMR 要的；生产虽同样放行，但应用自身不发起任何网络请求，没有可利用目标。要按环境拆开就得给 index.html 加构建期替换，复杂度不划算。
- **渲染包 1.6 MB**：`lucide-react` 已是按需导入（tree-shaking 生效），体积主要来自 codemirror / react / marked；桌面端从本地磁盘加载，不是瓶颈。
- **Playwright E2E**：`scripts/*.mjs` 已有 20 个跑真实 Electron + CDP 的端到端检查，再引一套 E2E 框架属于重复建设。
- **代码签名 / electron-updater**：都需要外部决定（证书、发布渠道），不属于代码层优化。

**验证**：`npm run check:security`（新增，5 项）、`npm run check:jieba`、`npm test` 64/64（新增 3 项白名单单测）、`typecheck`、`themecheck` 18/18、`notecheck` 28/28、`officecheck` 13/13。

> 顺带修了一个与本次改动无关的既有问题：`scripts/officecheck.mjs` 依赖 `/tmp/gen-office-fixtures.py`，临时目录一被清理这条验证就再也跑不起来（python 报 `can't open file`）。夹具生成脚本已纳入 `scripts/fixtures/gen-office-fixtures.py`。

---

## 前端样式优化 · 按 `modern-css` skill 核对（2026-09-17）

> `scss-best-practices` 这个 skill 没能定位到：搜过 sickn33/agentic-awesome-skills 的 2021 个 skill、moderncss org 全部仓库、wshobson/agents、jezweb/claude-skills，以及 GitHub 仓库搜索，都不存在。
> 另外**本项目没有用 SCSS** —— 11 个样式文件（2563 行）全是纯 CSS，所以 SCSS 那套约定（$变量 / @mixin / @use）本来也不直接适用。
> 以下按 `modern-css`（moderncss/skills 里唯一的 skill）逐条核对。

先给结论：样式底子很扎实 —— 语义 token 全部集中在 `tokens.css`、组件一律引用变量、已经在用 `color-mix()`、已有 `prefers-reduced-motion` 降级、无一处 `!important`、BEM 命名一致。真正该动的很少。

| 规则 | 结论 |
| --- | --- |
| `@layer` 组织层叠 | **不改**：11 个文件靠 import 顺序层叠、当前无冲突；全量包 layer 要动所有文件，且 layer 顺序必须与现状严格一致，收益只是"理论清晰度"。 |
| `@scope` 封装 | **不改**：BEM 命名已经提供隔离；`@scope` 的优先级加成反而会改变现有层叠。 |
| `oklch()` 色彩 | **不改**：色值要与 Python 版和主题包逐值一致，换色彩空间会改变实际渲染色，themecheck 的色值基线也会全部失效。 |
| `color-scheme` / `light-dark()` | **用了 `color-scheme`**：主题由 `data-theme` 属性驱动，`light-dark()` 用不上；但 `color-scheme: light/dark` 能让原生控件（输入框、下拉、日期选择器）跟随应用主题而不是系统偏好，这是真实修复。 |
| `clamp()` 流体字号 | **不改**：字号由设置项 `font_size`（9–20）控制，流体排版会和用户设置打架；窗口尺寸范围也固定（min 1040×640）。 |
| `text-wrap` | **用了**：`.page__title { text-wrap: balance }`。 |
| 逻辑属性 / 容器查询 / `cqi` / `subgrid` | **不改**：LTR-only 桌面应用、组件宽度由 flex 决定、没有跨行对齐需求。为这些改几十处选择器属于纯风格迁移，不产生功能收益。 |
| `prefers-reduced-motion: no-preference` | **不改**：动效是设计规范（docs/03 §2.4）的一部分，默认开拉动效是产品决策；skill 的 opt-in 模型面向营销页，本项目已有「设置关动效 + 系统偏好」双重降级。 |

**实际改的三处**（都有硬理由，不是为了用上新语法）：

1. **浮层阴影 token 化** —— 原先 5 种值散在 10 处（`0 8px 24px /18%` 与 `/22%` 同类不同值，明显是随手写的），
   而且**深色模式根本没适配**：同样的黑色透明度铺在 `#1f1f1f` 上几乎看不见。
   现在按浮层层级分四档 `--shadow-sm/md/lg/xl`（选中态微投影 / 弹出菜单 / 浮层 / 模态），深色模式各自加深（12→28%、20→44%、24→50%、28→56%）。
2. **`--overlay`** —— 模态遮罩 `rgb(0 0 0 / 32%)` 在深色模式下与弹窗对比不足，深色改 55%。
3. **`.prio` 的兜底色 `#8a9ba8`** —— `tokens.css` 之外唯一的硬编码色值，也违反项目自己「组件内禁止写死色值」的约定；改成 `var(--fg-tertiary)`（无优先级 = 中性灰，随主题）。

**验证**：`themecheck` 18/18、`layoutcheck` 11/11、`npm run build` 通过（本次改动不涉及 TS，`typecheck`/`vitest` 不受影响）。

---

## 前端可访问性 · 对比度实测与校正（2026-09-17）

用 `ui-ux-pro-max` 的 P1 规则（文字对比 ≥4.5:1）把 14 个主题包**实测**了一遍（不是估算），
工具是本次新增的 `scripts/contrast-audit.mjs`（WCAG 2.1 相对亮度）：

```
主题包 14 个 · 实测 168 组前景/背景
不达标 74 / 168 组：次要文字 25 · 辅助文字 49
最低 2.36:1（暖沙[light] 辅助文字 #B0A896 on #FFFFFF，需 4.0）
```

正文（`fg`）**全部达标**（0 处），问题集中在次要文字（`fg2`）与辅助文字（`fg3`）。

**根因不是「Electron 写得差」，而是两份数据不同步。** Python 版在
`docs/ui_polish_v014_audit.md` 的 T2 项做过同一件事（「fg2 校正 ≥4.5、fg3 温和 4.0，
14 主题包×双模式一次覆盖」），落点是 `qfluent_core/theme.py` 的运行时校正；
Electron 的主题包是独立生成的一份 `src/shared/theme-packs.ts`，没有对应的校正步骤。

**修复**（`src/shared/color.ts` + `src/renderer/src/theme.ts`）：不手改 168 个色值，而是在应用主题时
按同一套下限做运行时校正 —— 文字色只沿「亮底压暗 / 暗底提亮」一个方向调整（**保留色相**），
背景取 canvas 与 layer 中对比度最差的那个。正文/次要 4.5:1、辅助 4.0:1。
已达标的值原样返回，所以 `fg` 与全部主题包主色**零改动**。

**验证**：

- `src/shared/color.test.ts`（新增 6 项，`npm test` 70/70）：其中一条遍历**全部主题包 × 双模式 × canvas/layer**
  逐组断言达标，这是防回归的守门断言；
- `npm run check:contrast`（新增）：体检工具，报告未校正的原始数据，改主题包后能直接看出哪一档掉线；
- `themecheck` 18/18（主题包的 canvas / fg / warm 断言全部未受影响）、`layoutcheck` 11/11、`typecheck` 通过。

### 关于这批 skill 的适用范围（如实说明）

要求是按 `design-taste-frontend` / `hallmark` / `gsap-core` / `open-design-mode` / `ui-ux-pro-max`
对前端做重构升级。逐条核对后**只有一部分适用**，判断记在这里：

| skill | 是否适用 | 原因 |
| --- | --- | --- |
| `ui-ux-pro-max` | **适用** | 通用 UI/UX 规则（可访问性、交互、排版、色彩、表单、导航）；本次的对比度审计就出自它的 P1 规则 |
| `gsap-core` | 暂不引入 | 项目已有成体系的 CSS 动效 token（`--dur-*`/`--ease-*`）+ reduced-motion 降级；引入 GSAP 是新依赖，收益不明 |
| `hallmark` | 仅 component-scope 部分适用 | skill 自身定位是 landing / portfolio；它的 component-scope 流程（8 状态纪律）对本项目的按钮/输入有意义，页面级规则（hero / marquee / nav archetype）无从落地 |
| `design-taste-frontend` | **基本不适用** | 该 skill 第 13 节自己写明「NOT for: Dashboards / dense product UI / admin panels」，并要求遇到这类目标时 **say so explicitly**。本项目是任务/笔记/图谱类产品型 UI，hero / eyebrow / CTA / logo wall 等规则没有挂载点 |
| `open-design-mode` | 不适用 | 那是让 OpenDesign 服务生成新 artifact 的流程，不是对既有代码库做重构的 skill，且依赖 OpenDesign 云账号 |

**结论**：这个前端不是 landing page，硬套营销页规则只会产出不伦不类的东西。
真正有价值的入口是「与 Python 版对齐」+「可访问性实测」—— 上面那 74 组不达标就是这么找到的。

---

## 前端约束审计 · 层级 / 控件状态 / 强调色（2026-09-17，第二轮）

按 `ui-ux-pro-max` 的 `references/quick-reference.md`（stack-agnostic，desktop web 口径）核对了一遍
布局约束、控件约束与色彩。

### 口径修正（重要）

`references/pro-rules.md` 自己写明「everything below targets native/mobile app UI… these tables assume
touch targets, safe areas, and platform gesture conventions that **don't apply 1:1 to desktop web**」。
所以移动端的 44pt/48dp 触控目标**不适用于本应用**；桌面 web 的正确下限是 WCAG 2.2 的
`web-target-size`：**24×24 CSS px**。下面按这个口径判定。

### 改了三处

**1. 层级尺度（布局约束）** —— 原先 z-index 是 50 / 60 / 68 / 70 / 72 五个魔数，且层级关系是错的：
页面级浮条（`.pomo` 68、`.infobar` 70）反而压在**全屏模态**（`.modal-mask` 60）之上 —— 模态打开时
番茄钟条会亮在遮罩上面；`.toast` 干脆没有 z-index，会被任何弹层盖住。

现在收敛为唯一尺度 `--z-float / --z-menu / --z-modal / --z-reminder / --z-toast`，
浮条落到模态之下、toast 提到最高。`.palette` / `.capture` 复用 `.modal-mask`，层级本来就有保障。

**2. 控件状态（控件约束）** —— 全仓 `:hover` 有 31 处，但 `:active` 只有 4 处且**全是 `cursor: grabbing`**
（拖拽光标），没有一处是按压视觉反馈；`:disabled` 只有 1 处。现在在 `global.css` 统一：

- 按压用 `translate: 0 1px`（**独立 `translate` 属性，不覆盖组件自己的 `transform`**，比如 `.toast` 的
  `translateX(-50%)`），且按 pro-rules 的要求「不改布局边界」；
- 禁用态统一 `opacity: 0.45` + `cursor: not-allowed`，同时认 `disabled` 与 `aria-disabled`；
- `.swatch`（设置页配色圆点）从 22×22 提到 **24×24** —— 它可点击，22px 低于 WCAG 2.2 的指针目标下限。

**3. 强调色的文字变体（色彩）** —— `--accent` 是品牌色原值，**当文字用**时实测全线不达标：
默认青对墨黑包的 accent-soft 底只有 **2.94:1**、对 canvas 3.37–3.74；用户自选浅黄时只有 **1.51:1**。

修法与上一轮 fg2/fg3 同思路，但**不动品牌色**：新增 `--accent-text`，由 `applyTheme` 按当前实际背景
（canvas / layer / accent-soft）运行时校正并保留色相，**只用于 `color`**；填充、边框、`accent-color`
继续用 `--accent` 原值。13 处 `color: var(--accent)` 收敛到新变量。

### 核对后确认已经做到的（不改）

| 规则 | 现状 |
| --- | --- |
| `elevation-consistent` | 阴影已收敛为 4 档 token（本轮之前刚做） |
| 圆角一致性 | 87 处 `border-radius` **全部**走 `--radius-*` token，零硬编码 |
| `color-semantic` | 组件内无裸 hex，全部语义变量 |
| `number-tabular` | 计时器/计数已用 `font-variant-numeric: tabular-nums`（4 处） |
| `focus-states` | `--focus-w: 2px` + 全局 `:focus-visible` 环，在 2–4px 建议区间内 |
| `state-contrast parity` | 深色主题的边框、浮层遮罩已单独加深（`--overlay`、`--border-strong`） |

### 评估后不做（记下来免得重复评估）

- **`spacing-scale` 的 1px/2px/6px 微调值**：4px 节奏的主档已 token 化，这些是紧凑排版的肉眼微调，
  为每个值造 token 反而降低可读性；
- **`container-width` 桌面 max-width**：桌面应用由窗口尺寸本身约束（min 1040×640），不需要再加包裹层；
- **移动端那套**（safe-area、44pt 触控、横竖屏）：本项目是桌面应用，无对应场景。

**验证**：`vitest` 71/71（含新增「任意强调色 × 真实主题表面」的守门断言）、`typecheck`、
`themecheck` 18/18、`layoutcheck` 11/11、`securitycheck` 5/5、`npm run build` 通过。

---

## 用户实测报障修复（2026-09-17，第三轮）

用户反馈 5 项：4 项真实缺陷 + 1 项新需求。逐项根因与修复：

| 报障 | 根因 | 修复 |
| --- | --- | --- |
| **弹框输入框无法输入** | `Dialogs.tsx` 的 prompt 输入框只有 `value` 没有 `onChange` —— React 的只读受控输入，敲键盘不改变值。所有 `dialog.prompt`（新建清单 / 文件夹 / 标签、重命名）全部受影响 | 补 `onChange` |
| **任务页「新建任务」无反应** | 虚拟列表按 `count × rowHeight` 绝对定位，而 `flatRows` **只装真实任务节点**、从不包含添加行。`adding` 一置位就切到 VirtualList 分支，列表里却没有那一行 —— 顶层新建压根不渲染；子任务的添加行同样漏算，会把后续行挤错位 | 添加行以 `{node: null}` 计入 `flatRows`（顶层置顶、子任务紧跟父任务） |
| **笔记树「新增笔记/文件夹」溢出卡片** | 工具栏里的格式选择器沿用了通用 `.field--compact`（200px 固定宽），而树总宽只有 240px，加上搜索框与两个 32px 图标按钮必然顶破 | `.ntree__format` 收窄到 72px，`.ntree__search` 补 `min-width: 0` 让搜索框吃剩余空间 |
| **今日页副标题显示不全** | 副标题 `greeting` 放在 `.page__body`（滚动区）内部，还带一个 −8px 的负上边距 | 与下一项一并解决：移到标题行 |
| **全部页面加副标题（主标题右侧）** | 新需求 | 新增 `.page__head`（flex + baseline 对齐）与 `.page__subtitle`；8 个页面全部接入，文案走 i18n；今日页用已有的动态日期 `greeting` |

**验证**：新增 `npm run check:interaction`，用 CDP 走**真实输入通道**（`Input.insertText`）复现用户路径，8 项全绿：

```
✓ 任务页存在「新建任务」按钮并可点击
✓ 点击后出现添加行
✓ 添加行输入框能输入 — value="回归检查任务"
✓ 能唤起 dialog.prompt
✓ 弹框输入框已渲染
✓ 弹框输入框能输入 — value="回归检查清单"
✓ 笔记树工具栏不溢出卡片 — 溢出 0px
✓ 每个页面标题行都有副标题 — 8/8
```

这条检查在**修复前会失败**（添加行不存在、prompt 的 value 保持空），所以它确实能守住这两个 bug。

其余回归：themecheck 18/18、layoutcheck 11/11、notecheck 28/28、taskopscheck 14/14、vitest 71/71、typecheck 通过。

---

## 画布平移 / 缩放（2026-09-17，第四轮）

用户报「图谱和工作流画布不能拖动、缩放」。核实后是**功能确实没实现**：两块画布只有单个节点的拖拽，
画布本身既没有平移也没有缩放 —— 图谱是 `viewBox="0 0 ${width} ${height}"`、工作流是写死的
`viewBox="0 0 900 520"`，都没有视图状态。

新增**共享实现**（两块画布共用一套，不各写一遍）：

- `src/renderer/src/lib/panzoom.ts` —— 纯计算：`fitView` / `zoomAt` / `panBy` / `wheelFactor`。
  **以光标为中心的缩放**是这类交互最容易写错的地方（写错就会变成"往画布中心缩"），单独用单测钉住。
- `src/renderer/src/lib/usePanZoom.ts` —— React 绑定：拖背景平移、滚轮缩放、重置视图。

两个关键决策：

1. **只有点在画布背景上才平移**（`e.target === e.currentTarget`）。节点自己的拖拽因此不必逐个加
   `stopPropagation`，两套交互天然不打架。
2. **滚轮必须用 `addEventListener(..., { passive: false })` 绑定**。React 的 `onWheel` 挂在 root 上且是
   passive 的，在那里 `preventDefault()` 不生效，滚轮会连带把页面一起滚走。

**顺带修掉一个"加了缩放就必然暴露"的缺陷**：两个页面的节点拖拽原来把**屏幕像素**当坐标用
（`e.clientX - rect.left`）。画布一旦缩放，同样的像素位移对应的世界位移并不相同，节点会「跟不上鼠标」。
现在统一走 hook 的 `toWorld()` 换算 —— 这也是为什么缩放功能不能只加 viewBox 就完事。

两块画布还各加了「重置视图」按钮（缩飞了要能一键回来）。

**验证**：`check:interaction` 新增 8 项（两块画布各 4 项：已渲染 / 滚轮缩放 / 拖背景平移 / 重置视图），
合计 **16/16**；新增 `panzoom.test.ts` **7/7**；`graphcheck` 5/5、`workflowcheck` 17/17、
`themecheck` 18/18、`layoutcheck` 11/11、`vitest` 78/78、`typecheck` 通过。

> 注：`graphcheck` 首次与其它 electron 检查连跑时出现过一次 `shared=0` 的失败，单独重跑即 5/5。
> 症状是两次取样之间节点集合**完全无交集**（说明那一刻图谱还没加载完），判断为启动时序偶发，与本次改动无关。

---

## 连线编辑：删除 + 端点改挂（2026-09-17，第五轮）

用户要求「图谱和工作流的链接线可以编辑：删除，以及拖动端点改变链接节点」。

**先找基线**：Python 版 `zhixing/view/pages/graph_page.py` **已经实现过**这个功能 ——
`remove_edge` 按「边类 + 端点类型」分派到 5 种真数据操作、`rewire_edge` 是「先建新关系再删旧关系」、
`_endpoint_at` 做端点命中。所以这一轮是**把 Python 的分派逻辑移植过来**，不是自己发明一套。

### 后端：一个入口，两处复用

新增到 `main/db/graph.ts`：

- `unlinkNotes(src, dst)` —— 解除笔记↔笔记引用。**这里和 Python 版不一样**：Electron 的 `linkNotes`
  是**双向写**的（src→dst 与 dst→src 各一行），所以必须对称删两侧；照搬 Python 的单向删只会删掉一半，
  图谱上的边看似还在。
- `connectGraphNodes(...)` —— 按端点类型 + 边类建立连接（把渲染进程原来散在 `tryLink` 里的分支下沉下来）。
- `removeGraphEdge(...)` —— 按「边类 + 端点类型」分派删除，逐条对齐 Python `remove_edge`：
  task↔note 引用→`unlinkTaskNoteRef`；task↔note 归属→`detachTaskNote`；task↔task→`reparentTask(null)`；
  note↔note→`unlinkNotes`；folder↔note→移出文件夹。
- `rewireGraphEdge(...)` —— 改挂：**先建新关系、成功后再删旧关系**（反过来的话，新建一旦被约束拒绝就把边弄丢了）。

工作流侧新增 `setWorkflowBranch(nodeId, target|null)`：单独改分支目标，不用重写整个模板。

### 一个副产品：写操作支持多域广播

图谱编辑会**同时**动到笔记和任务两侧（比如删除 task↔note 归属，任务页也得刷新），
于是把 `WRITE_DOMAINS` 从单域放宽成 `DataDomain | DataDomain[]`。

### 前端交互

两边同一套：鼠标移到线上 → 亮出两个端点手柄 + 中点删除按钮；拖动端点 → 虚线跟随的重连预览，
松手落在目标节点上完成改挂。三个实现要点：

1. **1.2px 的线本身根本点不到**，所以每条可编辑边都铺了一条 `stroke-width: 14` 的**透明热区线**；
2. 手柄与删除按钮画在**节点层之上** —— 手柄就在端点上，放节点下面会被节点自身盖住；
3. 改挂落点用 `document.elementFromPoint(...).closest('[data-node-id]')` 反查：拖拽期间指针被画布捕获，
   节点的 hover 事件不会触发。

**可编辑范围**（按后端能不能真删来定，不硬凑）：

| 边 | 可否编辑 | 原因 |
| --- | --- | --- |
| task↔note 引用 / 归属、task↔task、note↔note、folder↔note | ✅ | 都有对应的真数据操作 |
| folder↔folder | ❌ | 主进程也不支持建立这种连线 |
| 悬空引用（负 id 的虚拟节点） | ❌ | 它是正文 `[[标题]]` 的投影，真要删得改正文，不在本次范围 |
| 工作流的顺序连线 | ❌ | 它是 `order_index` 的投影、没有独立实体；**分支连线**（`branch_node_id`）才可以编辑 |

**验证**：`check:interaction` 扩到 **25/25**，新增 7 项 —— 图谱存在可编辑连线 / 存在透明热区 /
悬停出两个端点手柄 / 悬停出删除按钮 / 点删除后连线 18→17；工作流分支线悬停出删除按钮 / 点删除 1→0。

回归：`graphcheck` 5/5、`workflowcheck` 17/17、`themecheck` 18/18、`layoutcheck` 11/11、
`notecheck` 28/28、`taskopscheck` 14/14、`vitest` 78/78、`typecheck` 通过。

> 排查记录：这两组检查一开始一直失败，`elementFromPoint` 显示那个点上盖着 `DIV[modal-mask]` —— 是
> **前面「弹框输入框能输入」那条检查打开了 prompt 却没关闭**，全屏遮罩一直留着。顺手补了一条
> 「弹框已关闭（不残留遮罩）」的检查，免得以后再踩同一个坑。

---

## 用户实测 UI 细节修复（2026-09-17，第六轮）

用户一次性报了 11 项，逐项处理：

| # | 问题 | 处理 |
| --- | --- | --- |
| 1 | 浮窗有两层边框 | 透明窗口没显式设 `backgroundColor`，平台会补一层白色**方底** → 卡片圆角边框之外多出一层直角。加 `backgroundColor: '#00000000'` |
| 2 | 子 card 内容长时父 card 跟着滚 | 卡片内的滚动容器加 `overscroll-behavior: contain`：滚到尽头不再把滚动传给父容器 |
| 3 | 今日页有两个副标题 | **上一轮我自己的疏漏** —— 把 greeting 移到标题行时没删掉原来那个 `<p class="today-greeting">`，删掉 |
| 4 | 输入框两层聚焦边框 | 全局 `:focus-visible` 焦点环 + `.field:focus` 边框变色叠在一起。输入框改为只用边框表达焦点（`.field:focus-visible { outline: none }`），并把 `--focus-ring` 从写死的青改成跟随 `var(--accent)` |
| 5 | 任务行按钮未悬浮时占位 | `.trow__actions` 改**绝对定位**（未悬浮完全不占位），悬浮时给标题留 78px 让位 |
| 6 | 工具栏被压缩撑高、新建按钮点不到 | 工具栏加 `flex-wrap`、按钮 `flex: 0 0 auto` —— 压扁会把按钮**挤出可视区**，表现就是「点了没反应」 |
| 7 | 链接栏位置 + 笔记树宽度固定 | 链接面板从右侧第三栏改到**编辑区下方**（两张卡横向并排、面板自己滚）；笔记树右边缘加拖拽手柄，宽度 180–460 可调 |
| 8 | 工作流节点详情单独成列 | 删掉画布下方的动作列表，改成点击节点时**跟随节点展开的浮卡**（`foreignObject`）；**展开方向按节点在视图里的位置自动翻转**（右边放不下就往左、下边放不下就上移），保证卡片不出画布 |
| 9 | 图谱节点图标 | 半径从 `5 + size * 4.5`（同一 kind 会因连接数差出一倍）改为统一 `NODE_R = 9`；笔记形状从方块改为带折角的文档形；**端点手柄抬到节点外缘** —— 原来压在节点中心，点下去命中的是节点、触发节点拖拽，端点根本拖不动 |
| 10 | 回顾页图表没铺满 | `.chart` / `.heatmap` 的 `max-width`（520 / 420px）限制了铺满，去掉 |
| 11 | 设置页卡片没铺满 | `.set-body` 的 `max-width: 720px` 去掉 |

**验证**：`themecheck` 18/18、`layoutcheck` 11/11、`check:interaction` 25/25、`vitest` 78/78、`typecheck` 通过。

> 两个**推断性**修复要说清楚：#1 的窗口白底属平台层行为、CSS 读不到，只能靠 `backgroundColor` 修；
> #6 的判断依据是「压扁会把按钮挤出可视区」，而不是按钮事件绑错了 —— interactioncheck 里
> 「点击后新增任务行出现」一直是通的，说明按钮逻辑本身没问题。

---

## Obsidian 风图谱视觉（2026-09-17，第七轮）

按用户给的规格复刻 Obsidian 原生 Graph View 的视觉语言，**知识图谱与工作流两处都改**。

### 连线：贝塞尔曲线

`<line>` 全部换成 `<path>`，路径由 `lib/edge-path.ts` 的纯函数生成（6 项单测钉住几何）：

- 三次贝塞尔，控制点在 `t = 0.25 / 0.75` 处**沿连线法线**偏移 → 中段微微鼓起、两端贴住节点，
  就是 Obsidian 那种「微弱自然弧度」的来源，而不是大弧线或死板直线；
- 弧高 = 长度的 12%，**封顶 18px** —— 短线几乎笔直，长线也不会甩出夸张的弯（用户要的「弧度区分」）；
- 零长度连线退化为直线且不产生 NaN。

删除按钮的位置也跟着改了：原来取两端中点，贝塞尔化后那个点**不在曲线上**，改用 `edgeMidpoint`
（三次贝塞尔 t=0.5 的取值 `(P0 + 3C1 + 3C2 + P3) / 8`）。

### 视觉与交互

| 规格 | 实现 |
| --- | --- |
| 极细（1–1.5px） | `stroke-width: 1.2` |
| 默认暗到隐没 | 新增 `--graph-edge` token（下详） |
| 无箭头 | 本来就没有，保持 |
| 悬浮节点 → 相连线高亮 | `.graph__edge--on / .wf-edge--on`：主题色 + `stroke-width: 2`，`transition` 用 `--dur-instant`（「瞬间渐变」） |
| 非相关元素淡化至 0.05 | 共用类 `.is-dimmed`（放 global.css）；实测 `dimmed=33, opacity=0.05` |
| 力导向的阻尼手感 | `alphaDecay 0.018`、`velocityDecay 0.55`、`link.strength 0.12`、`charge.distanceMax(420)` |

### 一处刻意偏离用户给的原值

用户给的是 `#3a3a3a / #444444`。这个值**只在深色底上成立** —— 本项目有 14 套主题包 + 明暗双模式，
纯 `#444` 落在浅色主题上会变成一条抢眼的黑线，正好与「隐没在背景中」的意图相反。所以：

```css
:root            { --graph-edge: color-mix(in srgb, var(--fg-primary) 26%, transparent); }
:root[data-theme='dark'] { --graph-edge: #444444; }   /* 深色沿用 Obsidian 原值 */
```

深色模式下与 Obsidian 完全一致；浅色模式取同等的低对比度。这是为了守住「克制、隐没」这个**意图**，
而不是照抄一个在浅底上会失效的色值。

### 验证

`check:interaction` 扩到 **33/33**，其中 5 项是新加的：

```
✓ 图谱连线是贝塞尔曲线（非直线） — M436.34509320298434,481.219145380483
✓ 图谱：悬浮节点后相连连线高亮 — lit=2
✓ 图谱：无关元素淡到 0.05 — dimmed=33 opacity=0.05
✓ 工作流连线是贝塞尔曲线（非直线）
✓ 工作流：悬浮步骤后相连连线高亮 — lit=1
```

新增 `lib/edge-path.test.ts` **6/6**。回归：`graphcheck` 5/5、`workflowcheck` 17/17、
`themecheck` 18/18、`layoutcheck` 11/11、`vitest` 84/84、`typecheck` 通过。

### 补：连线箭头 + 端点收边

原规格里「箭头设计：存在箭头（No arrows）」本身是矛盾的，我先按括号里的英文做成了无箭头；
用户实际要**有箭头**，已补上：

- 图谱与工作流各注册两个 `<marker>`（默认暗色 / 高亮主题色）—— **marker 是独立元素，不会跟着线的
  class 变色**，所以必须分开两个；id 也刻意分前缀（`edge-arrow* / wf-arrow*`），避免两页同时挂载时撞车。
- **端点收边**是关键：图谱的线是从**节点中心**连出去的，箭头会被节点图形压在下面，看起来就像
  「设了箭头却没有」。新增 `trimEnd()` 把两端沿连线方向收回 `半径 + 5`，箭头正好落在节点外缘。
  过短的边原样返回，避免收回后退化成零长或反向。
- 工作流的线本来就是**边缘到边缘**（下边→上边 / 右边→左边），不需要收边。

**验证**：`check:interaction` **36/36**，新增 2 项 ——
`图谱连线带箭头 — marker=url(#edge-arrow) defs=2`、`工作流连线带箭头 — marker=url(#wf-arrow) defs=2`；
`edge-path.test.ts` 8/8（新增 2 项覆盖 trimEnd）。

### 顺带修掉的两个坑

1. **打包后本机原生模块没恢复**：`npm run dist:win` 会把 `better_sqlite3.node` 重建为 **Windows 二进制**，
   之后在本机跑 electron 就是「数据库打开失败 … slice is not valid mach-o file」，表现为**所有页面都没有数据**。
   这一轮排查时我自己也踩了（检查全挂），根因藏在渲染进程异常里才看到。
   现在加了 `postdist:win` / `postdist:dir`，**打完包自动 `electron-rebuild` 恢复**，这个坑从此消失。
2. **回顾页加载态没有标题行**：`if (!stats) return <div>正在统计…</div>` 会导致进页面时标题闪一下、
   与其它页面骨架不一致。改成加载态也带 `.page__head`。

3. **`setPointerCapture` 抛错会挡住后续逻辑**：图谱节点与工作流节点的 `onPointerDown` 里，
   捕获失败（指针已失效 / 合成事件）会直接中断，**`setSelected` 不执行** —— 表现为节点点不中、
   连线模式进不去。已加 try/catch 并保证选中照常执行（与 panzoom 的处理一致）。
