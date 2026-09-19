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

---

## 今日页交互调整（2026-09-19，第八轮）

用户报了 3 项，都在今日页：

| # | 需求 | 处理 |
| --- | --- | --- |
| 1 | 滚动只出现在「今日待办」「最近笔记」两块上 | 原实现是整页 body 滚动。给今日页加 `.today-page` 作用域：`.page__body { overflow: hidden }`，两块 `<section>` 改 `section--grow`（`flex: 1 1 0; min-height: 0`）各自分出剩余高度，滚动交给新增的内层 `.section__scroll`（`overflow-y: auto`）。标题行、快速添加、四张概览卡因此**始终可见**，两块内容各滚各的 |
| 2 | 任务项的编辑按钮与胶囊样式一致；悬浮时胶囊移到按钮组左侧 | 按钮组从**绝对定位浮层**改回**行内 flex 项**（推翻第六轮 #5 的结论，见下）：`.trow__actions` 未悬浮时 `max-width: 0` + 透明 + `pointer-events: none`，悬浮/选中时展开为内容宽度；`.trow__chips` 作为普通兄弟项自然排到它左侧。按钮对齐胶囊规格：20px 高、`0 6px` 内边距、`--radius-sm`、`--fg-secondary` |
| 3 | 今日页任务项也能直接编辑 | 复用任务页同一个 `components/TaskEditor.tsx`：`editingId` 命中 `today.subtree` 即弹出，保存走 `updateTask` + `refresh()`，删除前 `confirm`。原先的 `onEdit` 只是弹提示「在任务页双击 #id 可编辑」，已删 |

**推翻第六轮 #5 的原因**：#5 当时的诉求是「未悬浮时按钮组不占位」，绝对定位能满足这一点，但代价是**按钮组浮在内容之上**：悬浮时只能给标题补 `padding-right: 78px` 让位，胶囊仍会被压住（标签越多越明显）。现在改成「0 宽 ↔ 内容宽」的展开式行内项，**既满足不占位，又天然把胶囊推到左边**，还省掉了那 78px 的魔法数。

### 验证（CDP 强制伪类，不依赖真人鼠标位置）

鼠标真实位置会随窗口启动时的系统光标而变，直接 `Input.dispatchMouseEvent` 复现不出稳定的 `:hover`，所以改用 `CSS.forcePseudoState` 强制 `:hover` 后实测几何：

```
base      : chips.right=1221  acts.x=1229 w=0   opacity=0  max-width=0px
hovered   : chips.right=1111  acts.x=1119 w=110 opacity=1  max-width=220px   row.matches(':hover')=true
推入宽度 = 按钮组宽度 = 110   胶囊右缘 <= 按钮组左缘 OK   按钮组右缘 <= 行右缘(1229) OK   按钮高 20 = 胶囊高 20 OK
取消强制后复位 OK   注入 6 个胶囊（377px）后按钮组仍完整 110px、不重叠、不溢出 OK
```

同时验证：`.page__body` 计算样式 `overflow-y: hidden`；今日页恰有 **2 个** `.section__scroll`（`overflow-y: auto`，今日待办 `scrollHeight 407 > clientHeight 221` 可滚、最近笔记内容不足不滚）；点击行内「编辑」→ `.modal` 弹出、标题输入框**预填该行标题**、10 个字段与「删除 / 写复盘笔记 / 取消 / 保存」按钮齐全。

**回归**：`typecheck` 0 error、`vitest` 86/86（14 个文件）。产物重新出包：`dist/Zhixing-0.1.7-x64-setup.exe`（86.89 MB）、`dist/Zhixing-0.1.7-x64-portable.exe`（86.67 MB），`postdist:win` 已自动恢复本机 ABI。

---

## 控件高度全局审计（2026-09-19，第九轮）

用户报：**输入类控件（下拉框、输入框等）与按钮高度不一致**，要求全局审计、全部受设置页「控件高度」控制，并**划清任务项高度与控件高度的边界**。

### 根因：两个同值不同源的 32px

| 令牌 | 谁在用 | 问题 |
| --- | --- | --- |
| `--hit-min: 32px` | `.icon-btn`（固定 `width/height`）、`.text-btn`（`min-height`） | **不跟设置** —— 它只是「无障碍最小热区」，却被当成了按钮高度 |
| `--control-h: 32px` | `.field`（输入框 / 下拉 / 日期） | 跟设置 |

两者默认值都是 32px，所以**平时看不出差别**；设置页一改就分叉。实测用户当时的设置是**控件高度 24px / 行高 29px**，于是输入框 24px、按钮 32px、分段控件 26px 同排——正是报障的样子。另有 6 处裸值：`.seg button` 26、`.ntree__search` 28、`.popmenu__item` 30、`.kcol__add` 28、`.palette__item` 34、`.editor__title`（靠 padding 猜高）；`.rt-editor__bar input[type=color]` 24 与同排 32px 的按钮凹一块。

### 处理

| # | 动作 | 落点 |
| --- | --- | --- |
| 1 | **令牌分层**：删 `--hit-min`，新增派生档 `--control-h-sm: calc(var(--control-h) - 8px)`；两个可调尺度（控件 / 行）与一个派生档在 `tokens.css` 注释里写明边界 | `tokens.css:72-88` |
| 2 | **全局兜底**：`input / select / textarea` 在 `global.css` 统一 `min-height: var(--control-h)`（排除勾选 / 单选 / 色板 / 滑块）——新页面不会再冒出一个写死高度 | `global.css:33-42` |
| 3 | **按钮接入**：`.icon-btn`（正方形边长 = 控件高度）、`.text-btn`、`.seg`（整体取控件高度、按钮 `height:100%`）、`.kcol__add`、`.popmenu__item`、`.palette__item` | `app.css`、`tasks.css` |
| 4 | **输入控件接入**：`.ntree__search`（内层 input 去壳、高度交给容器）、`.editor__title`、`.field--mini`（改用 `--control-h-sm`）、`.palette__input`（内边距 12→8，高度交给搜索框） | `notes.css`、`workflow.css`、`app.css` |
| 5 | **边界豁免**：`.trow__input` 显式 `min-height: 0`，否则全局兜底的 `min-height` 会盖过它的 `height`，把 24px 的行撑破 | `tasks.css` |
| 6 | **防止回归**：新增 `scripts/ctlheightcheck.mjs` + `npm run check:ctlheight`，静态扫描「控件选择器里的写死 px 高度」 | `package.json` |

**边界**（写进 `docs/03` §2.7）：`--control-h` 管**独立控件**；`--row-h` 管**列表行**；三类刻意不跟设置——行内元素（勾选框 18 / 胶囊 20 / 行内动作按钮 20 / 行内重命名框 26）、色板圆点（WCAG 24×24 固定）、浮动主操作 FAB（38px，独立尺度，已在 `FloatingDock.tsx` 注明）。列表行一律用 `min-height`，控件调大时被内容撑高而不溢出。

### 实测（CDP，8 个页面 × 两档设置）

用 `CSS.forcePseudoState` 之外的思路：把 `--control-h` 在 **24px / 44px** 之间切换，逐元素比对高度差（Δ20 即接线成功），并读取两档下的设置值。**不依赖真人鼠标位置与备份库**。

```
令牌：--control-h 44px / --row-h 29px（用户当前设置）/ --control-h-sm calc(44px - 8px)
受控且跟随：37 个元素（Δ=20）
行内保持原尺寸：trow__caret 16 / check 18 / flag 18 / 行内 icon-btn 20  → 24px 与 44px 两档完全一致
同父容器高度不一致：0 处（图谱节点 26/27 是 SVG 图形，非控件）
```

截图 8 张（设置页 24/32/48、任务页 24/48、笔记页 32、工作流 32、收件箱 32）人工复核：任务页工具栏整排（下拉 / 按钮 / 输入框 / 分段）在 24px 与 48px 下均**严格等高、无溢出**；设置页在 48px 下表单行不挤不破。

**回归**：`typecheck` 0 error、`vitest` 86/86、`layoutcheck` 8/8（布局伸缩未被破坏）、`check:ctlheight` 通过（该脚本首次运行时确实抓到了误判项，规则收紧为「只拦写死 px 数值」后通过——说明它有效）。

> **环境说明**：`themecheck` / `interactioncheck` / `todaycheck` / `notecheck` 等 13+ 个脚本依赖备份库
> `D:\Development\backups\electron-migration\zhixing-before-electron-write.db`，该文件在本机不存在（且无 `sqlite3` CLI），
> 拆分仓库时未被带上，**与本轮改动无关**。本轮改用不依赖它的 `layoutcheck` + 自制 CDP 审计完成验证。

---

## 工具栏统一（2026-09-19，第十轮）

接第九轮：用户看过原型（`prototype/toolbars` 分支的三变体）后定案 —— **按 B 骨架，空间不够按 C 折叠，全部工具栏都这样设计**。

### 落地

| # | 动作 |
| --- | --- |
| 1 | 新增生产组件 `components/Toolbar.tsx` + `styles/toolbar.css`：两层骨架 + 逐级折叠（`page` / `panel` 两种形态） |
| 2 | 六个页面级工具区改用 `<Toolbar>`：今日 / 任务 / 收件箱 / 工作流 / 图谱 / 设置；各页原有的 `page__head` 删除（标题进第一层） |
| 3 | 两个面板级工具区改用 `<Toolbar variant="panel">`：笔记树 `.ntree__tools`、富文本格式条 `.rt-editor__bar` |
| 4 | 收件箱的闪念区合并：`.flash-new` + `.flash-toolbar` 的内容成为同一条工具栏的 `search` / `primary` / `secondary`，**一页三条工具条 → 一条** |
| 5 | 删除旧样式：`.tasks-toolbar`、`.flash-new`、`.flash-toolbar`、`.ntree__tools`、`.ntree__search`、`.rt-editor__bar`、`.quick-add`（共 14 个规则块） |
| 6 | 删除原型目录、切换栏与 `prototype:toolbars` 脚本（原型留在 `prototype/toolbars` 分支） |

### 折叠判据踩的坑（值得记）

第一版用 `el.scrollWidth > el.clientWidth` 检测溢出 —— **永远返回 0**。原因：`scrollWidth` 对 `overflow: visible` 的元素等于 padding box 宽，根本不含溢出内容；Chromium 只在滚动容器上才给出内容宽度。改成**累加子项 `getBoundingClientRect().width` + gap** 后正常（子项都是 `flex: 0 0 auto`，宽度即真实需求）。

### 实测（CDP，三种视口宽度）

```
1280px  tasks   → 不折叠（need 565 = avail 565）
1280px  workflow→ ⋯ 10      （次要操作整组收起）
1280px  graph   → ⋯ 3
820px   tasks   → ⋯ 4       （第二层只剩搜索框 + ⋯）
820px   workflow→ ⋯ 11      （筛选也一并收起）
notes（240px 树宽）→ ⋯ 1   （格式下拉常驻浮层）
浮层展开：分组「筛选 / 操作」正常
```

各页 `.tb` 高度 69px（页面级两层）、24px（面板级一行）；`typecheck` 0 error、`check:ctlheight` 通过（新按钮类 `tb-btn` 已纳入检查正则）。

### 补充（同日）：标题分区不放任何操作

第一版落地把主操作放在标题行右端（原型 B 的做法）。用户定：**标题栏不放置任何操作，标题分区与工具栏分区要分隔开**。已改为：标题分区只有标题与副标题（右上角留空），主操作移到工具栏分区最右端（两种形态一致）；两分区之间由 `.tb__sub` 的上边框分隔，标题分区加 `padding-bottom` 让分隔更清楚；`.tb__headtail` 容器删除。实测各页 `.tb` 高度 69 → 81px（标题分区多一行留白），折叠行为不变。

### 补充：工具栏底色与常驻范围修正（用户反馈「与整体割裂」）

症状：工具栏区域是一块**灰色通栏色块**，贴着白色圆角卡片，边界明显；面板形态的工具区（笔记树、编辑器格式条）也被一起常驻了。

根因两条：底色调错 —— sticky 需要不透明底，我用了 `--bg-canvas`（页面底色），而所在卡片是 `--bg-layer`（浅色 90% / 深色 85% 半透明）；作用域也错 —— sticky 与底色写在 `.tb` 基类上，panel 形态跟着一起生效。

修正：

| 项 | 修正 |
| --- | --- |
| 形态拆分 | `.tb--page` 才 `position: sticky` + 铺底色；`.tb--panel` 恢复 `static` / 透明 |
| 底色 | 改用 `--bg-layer-solid`（与卡片同源）——实测浅色下工具栏与卡片都是 `rgb(255,255,255)`，深色下都是 `rgb(30,30,30)`，边界消失 |
| padding | `padding-top` 8px → 4px（原来让标题比别的元素多缩进 8px） |
| 面板形态 | 补回宿主原有的内边距与分隔：`.ntree .tb--panel` 上下内边距、`.rt-editor .tb--panel` 的下边框（否则格式条与正文粘在一起） |

验证：设置页滚动后 `tbTop` 恒为 body 顶（69），内容被完整遮挡；`layoutcheck` 11/11、`typecheck` 0 error。

---

## 笔记树新建入口下沉 + 工作流工具栏置顶（2026-09-19，第十一轮）

| # | 需求 | 落地 |
| --- | --- | --- |
| 1 | 笔记树：新建笔记 / 新建文件夹移到笔记项与文件夹项上，删掉类型下拉，类型在新建时选 | 见下 |
| 2 | 工作流页的标题与工具栏应在整个页面顶部 | 工具栏从 `wf-main` 里提到 `page__body` 直接子（`wf-wrap` 之前） |

**笔记树**：

- 工具区只剩搜索框；`onCreateNote(folderId, format)` / `onCreateFolder(parentId)` 都带上父级
- 笔记行 hover 出「在此新建笔记」（同级 = 该笔记所在文件夹）；文件夹行 hover 出「在此新建笔记 / 新建子文件夹」——复用既有的 `.ntree__actions` hover 模式
- 类型改成点击时选：行内按钮弹出 `PopMenu`（Markdown / 富文本 / Word / Excel / 链接），选中后才创建；`createFormat` 这个「先选类型再新建」的全局状态随之删除
- 空树兜底：没有行可以 hover，`.ntree__empty` 里留「新建第一篇笔记 / 新建文件夹」
- 文件夹右键菜单同步：「在此新建笔记…」改为弹类型菜单，并补「在此新建子文件夹」
- 顺手修掉 `PopMenu` 未选中项前面那个**空方块**（勾选位只占位不画框，选中态才画；占位保留所以同菜单文字仍对齐）

实测：工具区 `ctl: ["field"]`（只剩搜索）· 文件夹行 hover 出两个按钮 · 点击弹出 5 项类型菜单。

**工作流**：`tb.top=69 / w=986`（全宽）· `wrap.top=158`（在工具栏之下）· `tbBeforeWrap=true`。

**回归**：`typecheck` 0 error · `layoutcheck` 11/11 · 出包通过。

---

## 笔记页细节修正（2026-09-19，第十二轮）

| # | 需求 | 落地 |
| --- | --- | --- |
| 1 | 笔记树搜索框占满父布局 | `.tb--panel .tb__subright { flex: 1 1 auto }` + 其中的 `input` 同伸缩（面板形态的工具行就是全部内容，搜索框该吃掉剩余宽度） |
| 2 | 文件夹 / 笔记行的操作按钮不悬浮时**不占位** | `.ntree__actions` 改成 0 宽 + 透明 + 不收指针事件，悬浮展开 76px —— 与任务行 `.trow__actions` 同一套做法；这也修掉了「笔记数被挤到中间」 |
| 3 | 笔记数用主题强调色 | 新增 `.ntree__count`：`color: var(--accent-text)`（按对比度校正过的强调色变体，不是品牌原值）+ `tabular-nums` |
| 4 | 编辑区工具栏按之前的实现做 | `.editor__bar` 换成统一 `Toolbar`（page 形态 + `sticky={false}`）：标题分区 = 可编辑标题输入框 + 保存状态，工具栏分区 = 格式下拉 + 预览/链接/引用/归属/模板/孤儿/失效链接 |

为第 4 条给 `Toolbar` 加了两个 prop：`titleNode`（标题本身是输入框这类自定义节点）与 `sticky`（默认 page 开、panel 关 —— 编辑区嵌在卡片里要显式关掉，常驻只对页面级有意义）。编辑区标题输入框由 `.editor .tb__lead` 的伸缩规则接管，占满标题分区。

实测：搜索框 189 / 可用 210（余下是图标与间距）；未悬浮 `.ntree__actions` width=0、maxWidth=0px；计数 `rgb(10, 111, 102)`、右边缘 484 vs 行右 492（8px 内边距）；编辑区 `.tb` = `tb tb--page`、`position: static`、标题输入框 690px、工具 8 个、分区分隔线 1px。

顺带删掉 `孤儿 {''}` 里那个无意义的空串占位。

---

## 工具栏修正与白屏修复（2026-09-19，第十三轮）

| # | 需求 | 落地 |
| --- | --- | --- |
| 1 | 今日页快速添加输入框占满工具栏剩余空间 | 页面级右侧组与其中 `input` 一起 `flex: 1 1 auto`（原来只有面板形态这样处理） |
| 2 | 折叠阈值改为 3 | `Toolbar` 新增 `collapseFrom = 3`：第二层最多平铺 3 个「非搜索」控件，超出的进「更多」；仍溢出则逐个再收 |
| 3 | 笔记树搜索按钮放进输入框内部 | `search` 改为 `.ntree__search-wrap`（图标绝对定位在框内），输入框加 `padding-left` 让位 |
| 4 | **切笔记 / 改格式白屏** | 见下 —— 本轮唯一的 bug，且是上一轮改动引入的 |
| 5 | 文件夹展开图标看不清 | 笔记树里覆盖为 22×22，图标 `size` 13→16（任务行的行内箭头尺寸不动） |

### 白屏根因（React error #185）

排查方式：CDP 监听 `Runtime.exceptionThrown` 后走「选第 1 篇 → 选第 2 篇 → 改格式」，
第 2 篇时 `#root` 子节点归零、控制台报 #185（无限更新）。

根因是上一轮加的折叠判据：写成「溢出就升一级、有 48px 富余就降一级」，而笔记编辑区那条工具栏
恰好落在「升级后不溢出、降级后又溢出」的临界点上 —— `setState` 无限循环，React 抛 #185 后卸载整棵树。

修法：**收起只升不降**，只在容器宽度变化时重置；收敛由「溢出时递增到放得下为止」保证。
两个 `useLayoutEffect` 分工：一个监听宽度变化重置，一个在溢出时递增。
验证：切第 2 篇、切富文本、切回 markdown 全部正常，抓到 **0** 条异常（修复前 2 条）。

顺带修掉 `shownSecondary` 的笔误：`slice(Math.max(0, cap - filters.length))` 少了结束索引，
导致次要操作全部平铺、阈值形同虚设（实测工作流平铺 12 个 → 修复后平铺 3 个、`⋯ 8`）。

### 并行处理的两条（同轮，子代理）

| # | 需求 | 落地 |
| --- | --- | --- |
| 6 | 回顾页：图表过高、且不要顶部的任务统计 | 删掉顶部 `stat-grid`（5 张统计卡 + 连续完成天数卡），`reviewStats()` 查询保留给下方图表；**图表过高的根因是坐标系设计宽度** —— 旧 viewBox 只有 342 宽，铺满 1130px 卡片被放大约 3.3 倍，高度随之失控，光加 `max-height` 治不了。柱状图 viewBox 改为 1132×186（铺满时缩放≈1），热力图按「格子约 22px 才看得清」倒推宽度上限 336px、高度随之约 199px |
| 7 | 设置页增加更多材质选择 | `mica_enabled`(bool) → `material` 枚举（mica / acrylic / tabbed / none；vibrancy 是 macOS 专属，刻意不入列）；主进程按平台 + Windows build（22000 / tabbed 22621）+ DWM 合成分档降级，失败回退 none 且不抛错；渲染层复选框换成 `.field` 下拉，写库时同步回写旧键 `mica_enabled` 避免与 Python 版偏好分叉 |

实测：回顾页 `statGrid=false`、柱状图 160px（原 500+）、热力图 199px、`viewBox="0 0 1132 186"`；
材质迁移用真实 `parseSettings` 跑了 8 个兼容用例（空表→mica、旧键 '0'→none、非法值钳 mica…）全过，`vitest` 86/86。

### 补充：热力图铺满父栏（同日）

用户指出热力图应当占满父布局、格子随之拉伸，但**不能发虚**。

- 视图坐标按「并排时那一栏的常见宽度」重设：`12 × 44 + 边距 ≈ 532` 宽、`7 × 24 + 边距 = 172` 高 ——
  铺满时缩放≈1，格子边界落在整数像素上（此前限制 336px 宽，格子只有 13×13）
- 格子尺寸 40×20（随宽度拉伸成扁块）；**去掉 0.5 单位的描边** —— 半像素描边缩放后会落到像素之间，
  正是「看起来糊」的主要来源；改用 4 单位的间隙做分隔
- 该栏改为 `flex: 1 1 var(--review-heat-min)`，随布局伸缩，不再卡死宽度

实测：热力图 156px 高，页面正好放下（`bodyScroll 674/674`；此前 693/674 有轻微溢出）。

---

## 细节修正（2026-09-19，第十四轮）

| # | 需求 | 落地 | 实测 |
| --- | --- | --- | --- |
| 1 | 回顾页统计项分区不明显 | `.page--review .section` 套卡片（背景 + 边框 + 圆角 + 内边距），与设置页 `.set-card` 同一套语言；并排的两块只在行内留间距 | 4 个分区均有卡片样式（radius 12 / padding 16 / border 1） |
| 2 | 浮窗外层的直角矩形边框 | 根因是卡片 `padding: 4px` 留出的窗口区域露出了平台补的直角底 —— 改为卡片铺满窗口（`padding: 0`），并去掉会被窗口边界硬裁成矩形边的 `box-shadow` | 卡片盒 `[0,0,292,380]` == 窗口 `292×380`、`box-shadow: none` |
| 3 | 材质切换不生效 | 有**两处遮挡**：窗口自带的实色 `backgroundColor`、渲染层 `body` 的实色底，都会整块盖住 DWM 画的材质。改为材质生效时窗口底色透明、退回 none 时给回不透明；`applyAppearance` 把材质写进 `data-material`，CSS 据此让出 body 底色 | `data-material=acrylic` 且 `body` 背景透明 |
| 4 | 工作流启动策略下拉高度不统一 | 该下拉用的是 `.field--mini`（紧凑档，比控件基准矮 8px）→ 改 `.field--compact` | 同排控件全部 24px |

> 第 2、3 两条都不是「样式没写」，而是**窗口层与内容层各挡了一半**：浮窗的矩形 = 平台补底 + 卡片留白；材质 = 窗口 backgroundColor + body 底色。
> CDP 截图截不到窗口装饰，所以第 2 条是用「卡片盒尺寸 == 窗口尺寸」来验证的，第 3 条验证的是「底色是否让位」。

---

## 工具栏折叠策略与笔记页细节（2026-09-19，第十五轮）

| # | 需求 | 落地 | 实测 |
| --- | --- | --- | --- |
| 1a | 编辑区标题框不要边框，只在编辑时在框下显示状态 | 标题去掉 border/背景/聚焦变色；状态提示从标题右侧移到下方，且只在 `dirty` 时渲染 | `titleBorder=0px`、未编辑时无状态节点 |
| 1b | 笔记树搜索框左右留白不一致 | 给输入框补右内边距，与左侧图标留白对称 | 左 30px（图标位）/ 右 12px |
| 1c | 编辑区标题与工具栏用 card 包裹、中间不要分割线 | `.editor .tb` 加卡片样式，`.editor .tb__sub` 去掉 `border-top` | `tbBg` 实色、`divider=0px` |
| 1d | 各类型笔记的工具栏与内容区不要分割线 | 富文本格式条与 Office 头部都改为 `border: none`（显式覆盖，避免别处的 border-* 漏过来） | — |
| 2 | **折叠策略**：按可用宽度自行计算，不要阈值 | 去掉 `collapseFrom` 硬约束，改回「默认全平铺，溢出才逐个收」（`cap = flatTotal - extra`） | 工作流 1280px 平铺 8 / 收 5；900px 平铺 4 / 收 9 |
| 3 | 标签分布卡与热力图高度不一致 | `.review-pair` 的 `align-items` 由 `start` 改 `stretch` | — |
| 4 | 材质切换全局看不到效果 | 系统侧确认支持（build 26220、本地会话、dwm 在跑），问题在**内容层遮挡**：`--bg-layer` 是 90%/85% 不透明，只剩一成材质透出。材质开启时内容层降到 62% | `content: color(srgb 1 1 1 / 0.62)`、`body` 透明 |

> 第 2 条是**回退我上一轮的方案**：固定阈值会让「明明放得下」的控件也被收进浮层。正确判据只有一条 —— 放不下才收，放得下就都摆出来。
> 第 4 条的悬浮窗**做不到**系统材质：Electron 的 `backgroundMaterial` 要求不透明窗口，而浮窗必须是 `transparent: true`（否则圆角卡片外会露出矩形底，正是上一轮修掉的问题）。

---

## 浮窗悬浮球（接入 Emotion Ball 表情引擎）（2026-09-19，第十六轮）

| # | 需求 | 落地 | 实测 |
| --- | --- | --- | --- |
| 1 | 贴靠收缩后显示为一个悬浮球 | 贴边形态从「10px 把手」换成 112px 见方的球（球本体 96px，四周 8px 留给 hover 放大与投影）；竖直对齐原窗口中心后钳进工作区 | 预置几何 `x=0` → 启动即球：`win 112×112`、`.wball--ready`、`.widget__card` 不存在 |
| 2 | 悬浮球为 grokbot 表情 | 接入上游 Emotion Ball 引擎（`src/renderer/src/vendor/emotion-ball/`，四个脚本**逐字拷贝**、零依赖零构建）；96px 属小尺寸实例，取 `eyeScale 1.7` + `lite: true` | `window.EmotionBall.create` 可用、`.wball__host svg` 已渲染、容器 96×96 |
| 3 | 随机做表情 | 组件调度：12 个表情的随机池（避开睡眠 / 出错 / 拒绝 / 停止等**状态性**表情），2.6~5.8s 一拍、停留 1.4~2.6s 后回待机；附鼠标注视、150s 无交互打盹（`00`）、互动播 `01` 唤醒 | 40s 采样序列：`33 → 02 → 14 → 02 → 10 → 02 → 16 → 02 → 03 → 02 → 14 → 02 → 30 → 02` |
| 4 | 点击后恢复浮窗 | `.wball` 的 `onClick` → 先切 `10 开心`，180ms 后 `widget:undock` 展开；同时**移除**「鼠标进入即滑出」—— 球就贴在屏幕边缘，鼠标每次掠过都展开太吵 | 真实点击时间线：`click@ball` → 191ms 后 `mode:full` → `resize 530×382` |
| 5 | 形态切换的 IPC | 新增 `widget:mode` 查询 + 同名推送（贴边 / 展开时）；渲染层据此在球与卡片之间切换，球形态下暂停 5s 轮询 | `Page.reload` 后仍恢复为球（`getMode` 生效） |
| 6 | 展开后不被立刻收回 | 展开位置距屏幕边缘留 12px（**大于** 8px 贴边阈值）：`setBounds` 同样会触发 `moved`，留白不够会「刚展开又收回去」 | 展开后 `ui_state` 写回 `x = wa.x + 12` |
| 7 | 右键菜单 | 「取消贴边」拆成两态：球形态给「展开浮窗」、卡片形态给「贴边停靠」（主动收进最近一侧，对齐 Python） | — |
| 8 | 许可合规 | 上游为「非商业免费 + 可购商业授权」双许可，且**球形角色视觉形象仅限个人学习研究、禁止任何商业用途**；许可原文与来源版本锁在 vendor 目录内，仓库根 `THIRD-PARTY.md` 登记 | `vendor/emotion-ball/{LICENSE,NOTICE.md,UPSTREAM.md}` |

> 第 1、6 条是同一个坑的两面：**Electron 的 `setBounds` 会触发 `moved`**（Python 的 `move()` 不会重入它自己的贴边判定），
> 所以程序化改几何必须防重入 —— 这里用「展开位置留出大于阈值的间隙」解决，比加标志位 / 定时器更稳定。
> 第 3 条的证据来自探针页面记录的引擎 `change` 事件，其调度参数由脚本**从 `WidgetBall.tsx` 源码解析后注入**，
> 避免出现「文档参数与代码不一致」。
> 引擎是纯全局脚本，按需动态 import 后成为**独立 chunk**（rings 46.8kB / engine 25.8kB / ball 20.3kB / emotions 19.2kB），
> 主 bundle 不含它们；这条也顺带验证了 `file://` 生产环境下动态 import 分片可用。

---

## 悬浮球可拖动 / 可缩放 / 反方向展开 / 隐藏即收球（2026-09-19，第十七轮）

| # | 需求 | 落地 | 实测 |
| --- | --- | --- | --- |
| 1 | **球要能拖动** | 渲染层只上报「正在拖」，位移由主进程按屏幕光标重算（与边缘缩放同款）。**不用 `-webkit-app-region: drag`** —— 那会把球上的 click 一并吞掉，而点球展开才是主交互；拖动与点击用「是否移动过」区分，拖动收尾的 click 被忽略 | 窗口位移 == 光标位移：`150,-100` vs `150,-100`；拖动后 `ball=true, card=false` |
| 2 | **球要能改大小，且保证清晰** | 滚轮步进 8px + 右键菜单三档（小 88 / 中 112 / 大 144），主进程钳在 88~160；球体只占「窗口减 16px」，窗口一变球就跟着变；眼睛倍率按球径**量化分档**（球越小眼睛越大，96px→1.75、88px→1.8、144px→1.25），避免滚轮每格都重建引擎实例 | `setBallSize(160)` → 176×176 且**球心不动**；滚轮向下 176→168。88px 下限来自实测：56/72px 时表情糊成一团 |
| 3 | **展开方向 = 贴边反方向** | 按球心在屏幕左半/右半决定：球在左 → 浮窗向右展开；球在右 → 向左展开。这样球始终落在浮窗**外侧**，不会被盖住 | 球贴左 → 浮窗 `x=12`；球贴右 → 浮窗右缘 `1548 = 工作区宽 - 12` |
| 4 | **点「隐藏」后球重新出现** | `widget:close` 从「隐藏窗口」改语义为「收起成球」，球落到浮窗最近的一侧（竖直对齐浮窗中心）；真正的彻底隐藏保留在右键「隐藏浮窗」 | 点隐藏后 `ball=true, card=false`，球 `x=0`（浮窗在左半） |
| 5 | 形态与位置解耦 | 球的位置 / 边长 / 上次展开尺寸独立存 `ui_state.widget_ball`（`active` 标记上次退出时是不是球形态）；球形态下**不写** `widget_geometry`，展开时要靠它还原 | 重启后按保存的球位置恢复；收球不再污染展开几何 |
| 6 | Windows 几何陷阱（踩坑记录） | 只用 `setBounds`：**可见**时平台会因尺寸变化按「保持左上角」异步重排，把位置参数盖掉（`setBounds(276,276,176,176)` 落成 `(300,300,176,176)`）；只用 `setPosition`：**隐藏**时（`ready-to-show` 里恢复球形态）落不下去。最终「先 `setBounds` 落地、再 `setPosition` 纠偏，且第二次只改位置不改尺寸」 | 两条路径同时正确：启动恢复 `300,300`、改大小球心不动 |

> 第 1 条的替代方案（app-region 拖动）看起来更省事，但会让球彻底点不动 —— 这个「简单方案」被实测否掉了。
> 第 6 条是本轮最费时间的一处：它没有任何报错，只是「尺寸对了、位置没动」，且**隐藏/可见两种阶段结论相反**，
> 所以验证必须在真实窗口生命周期的两个阶段各测一遍（启动恢复 vs 运行时缩放）。

---

## 图标系统换成 morphicons（2026-09-19，第十八轮）

| # | 需求 | 落地 | 实测 |
| --- | --- | --- | --- |
| 1 | 引进 morphicons 图标系统 | `morphicons@1.7.1`：MIT、零运行时依赖、约 8KB gzip、stroke-based 通用形变 + 弹簧物理；它的 react/vue/svelte/react-native peer **全部 optional** | 安装后核对 `node_modules`：未拖入 react-native / vue / svelte |
| 2 | 替换原先的应用内图标 | 原 `lucide-react` 全面退役：63 个图标改由 `lib/icons.tsx` 里的 MorphIcon 渲染，**25 个文件只换 import 源**、用法一行没改；随后卸载 `lucide-react` | typecheck / vitest 86-86 / 构建全绿 |
| 3 | 形状数据从哪来 | 装 lucide **数据包**（与 lucide-react 同版本 0.468 对齐）而不是组件包 —— morphicons 只吃数据 | — |
| 4 | 接口不匹配（踩坑） | lucide 主入口导出 `[svg, attrs, children]`，而 morphicons 的输入契约是 `[tag, attrs][]` 且只认 path/line/circle/…；入口必须解包，否则报 `morphicons: unsupported tag <svg>` | 直接传/解包后各测一次：前者抛错、后者 `canonicalD` 正常 |
| 5 | 真正用上形变能力 | 5 处「同一位置换图标」：侧栏折叠/展开、标题栏日/夜、番茄钟播放/暂停、笔记预览/编辑、任务行子树 caret | 三处采样：每处 10~11 个中间帧，且**飞行中是 M/L 折线、静止才回落到曲线**（形变确实在飞，不是瞬间切换） |
| 6 | 动效策略与 §2.9 一致 | 应用关动效（`html[data-motion='none']`）→ `reducedMotion='always'`；否则 `'user'`（跟随系统）。**不用** morphicons 默认的 `never`（那会无视系统设置） | `icons.tsx` 的 `motionPolicy()` |
| 7 | caret 的 CSS 旋转退役 | 删掉 `.trow__caret--open`（rotate 90°）与 svg 的 `transition: transform`：`ChevronRight ↔ ChevronDown` 的形变本身就是旋转 | 死 CSS 已清 |
| 8 | 可维护性 | 入口文件由 `scripts/gen-icons.mjs`（`npm run gen:icons`）生成：扫描源码里用到的图标名（含形变用的 `IconData.X`），新增图标后重跑即可 | 生成器同时处理 `Tag as TagIcon` 这类别名 |

> 第 4 条是这次唯一的接口坑，而且**文档与实测相反**：README 说 `import { Menu } from "lucide"` 直接可用，
> 实测主入口给的是带 svg 包装的三元组。所以不能图省事在业务代码里直接 import lucide —— 统一入口的解包
> 不是形式主义，是必需的。
> 第 5 条的判据取自 morphicons 自己的不变式（飞行中是 M/L 折线），因此「有没有真的形变」这件事可以
> 编程验证，不必靠眼睛看动画。

---

## 悬浮球的「矩形边框」（2026-09-19，第十九轮）

| # | 现象 | 排查 | 结论与落地 |
| --- | --- | --- | --- |
| 1 | 悬浮球看起来有个矩形边框 | 先量 DOM：html / body / #root / `.wball` / `.wball__host` 全是 `rgba(0,0,0,0)`、`border: 0 none`、`shadow: none` → 页面内容干净（CDP 截图确认只有白球） | 矩形不来自页面内容层 |
| 2 | 是窗口层的残留吗 | **像素差异法**：同一区域截「球显示」与「球隐藏」两张，阈值降到 **1**（任何 1/255 的变化都算）逐像素比对 | 差异包围盒 `(26,26)-(181,181)` = 155 物理 = **77.5 DIP = 球体圆的直径**；四角与四边中点 delta **全为 0**，球窗口外的深色桌面 (27,27,28) 原样透出 → **静止态窗口层也没有矩形** |
| 3 | 那矩形从哪来 | 逐条审 CSS：唯一能画出**方框**的规则是球的焦点环 —— `outline: 2px solid …` | **`outline` 不跟随 `border-radius`**，它沿元素边框盒画成**方框**（`border-radius: 50%` 只影响背景）。焦点环改用 `box-shadow`（跟随圆角），并给 `.wball__host` 显式声明 `border-radius: 50%` |
| 4 | 顺手试过的错误方案 | 用 `resizable: false` 摘掉 Windows 的 `WS_THICKFRAME`（透明窗口矩形轮廓的经典来源） | **不可行**：Windows 上非 resizable 窗口的 `setSize` / `setBounds` **尺寸部分会被忽略** —— `setBallSize` 完全失效、收球/展开窗口不改变尺寸（实测窗口停在 128 不动）。已回退，窗口必须保持 resizable |

> 第 2 条的教训：**「看不到」不等于「不存在」**，也不等于「不存在」——阈值设成 10 时会被很淡的痕迹骗过去，
> 设成 1 才是可证伪的判据（本轮就是先被阈值 10 误导，以为完全干净）。
> 第 3 条是这类问题的通病：**`outline` 是唯一不跟随圆角的标准边框属性**，凡是「圆形元素 + 焦点环」
> 都可能踩到，值得全仓扫一遍。
> 第 4 条记下来是因为它很反直觉：关闭 resizable 这种「看起来只影响用户交互」的开关，会连带
> 关掉程序化改尺寸的能力。

---

## 工作流画布：dagre 分层布局（2026-09-19，第二十轮）

参考 AntV F6 的「Dagre 流程图」示例：把流程交给 dagre 做**分层** —— 按依赖关系分层、
层内排序减少交叉、节点尺寸参与计算（所以不重叠），方向由 rankdir 决定。

| # | 问题 | 落地 | 实测 |
| --- | --- | --- | --- |
| 1 | 布局是手工的：没拖过的节点按 `60 + i*190` 横向铺开、上下交替 —— 步骤一多就横竖重叠 | 新增 `lib/workflow-layout.ts`（纯函数）：把工作流的**隐式**结构投影成 dagre 有向图 —— 顺序边（order_index 相邻）+ 分支边（node → branch_node_id）；自环与悬空分支丢弃 | 17 条单测：分层、方向、不重叠、回环不崩、左上角换算 |
| 2 | 「一键对齐」只做纵向网格（`pos_x=0, pos_y=i*间距`），分支与主线挤在同一列 | 改为「自动布局」：按依赖关系分层，分支会落到与主线**不同的层** | 带分支的 5 步流：纵向分 5 层且 0 重叠 |
| 3 | 只有一种排布方向 | 工具栏「纵向 / 横向」一键切换并**立即重排**，选择记在 localStorage | 横向 5 列、0 重叠；切回纵向也正确 |
| 4 | 画布基准尺寸写死 900×520 | 基准随布局伸缩（`layoutBounds`），并由 effect 在基准变化后统一适配视图 | 横向铺开 5 列后视图正确居中（此前会缩在右上角） |
| 5 | 连线端点写死「从底部到顶部」 | 锚点按两节点相对位置选边（`edgeAnchors`）：纵向走上下边、横向走左右边、斜向取主方向 | 4 条单测（含反向锚点），横向布局下连线不再从侧面穿出 |
| 6 | 条件分支只有虚线，没有文案 | 把 `condition` 画在分支起点旁 | 2 个标签正常渲染 |
| 7 | 标签被节点盖住（踩坑） | 标签原先跟连线同层，而节点在其后渲染 —— **SVG 后画的在上**，于是被节点盒盖掉（「资料不全」只露出一个字）。改为单独一层画在所有节点之上 | — |
| 8 | 标签压到别的节点上（踩坑） | 用边中点定位时，中段可能正好穿过另一个节点（纵向布局里很常见）。改成贴分支起点 30px 放 —— 起点附近一定是空的 | `edgePointFrom` + 2 条单测 |

> 第 7、8 条是同一处功能的两个坑，且都是**只有看图才发现**的：断言全绿（标签确实渲染了、
> 数量也对），但视觉上一个被盖住、一个压住别的节点。
> 第 4 条的时序坑也值得记：`setCanvasSize` 是异步的，紧随其后的 `pan.reset()` 用的仍是旧基准，
> 所以适配必须交给「监听基准变化」的 effect，而不是写在动作函数里。

---

## 工作流：条件节点 + 折线 + 预览框修复（2026-09-19，第二十一轮）

| # | 需求 / 问题 | 落地 | 实测 |
| --- | --- | --- | --- |
| 1 | **增加条件节点**，注入条件可为提示确认 / 任务状态 / 脚本返回状态 | 复用 `action_kind='condition'` + `action_value` 存 JSON（`src/shared/workflow-condition.ts`，两端共用）—— 不动 schema，也就不影响与 Python 版共用的库；画布上画成**橙色菱形**，编辑弹窗里给三种来源各自的参数表单（任务状态是下拉选真实任务，不让用户敲 id） | 端到端：条件成立走分支、不成立走顺序，两条路径都验证 |
| 2 | 条件求值 | `evaluateCondition`：确认走主进程模态 `dialog`（阻塞直到用户选择）；任务状态查 task 表；脚本以独立进程运行并**比较退出码**（不经 shell、15s 超时兜底） | exit 0 → true；exit 1 / 7 → false（实测三种） |
| 3 | 条件节点不建任务 | 新增 `resolveNextRunnable`：实例化与推进都从这里找「下一个可运行节点」，条件节点在这一步被自动消费掉；`instantiateWorkflow` / `completeWorkflowStep` 随之改 async | 条件节点不出现在步骤列表里 |
| 4 | **连线改直线 / 折线** | 新增 `elbowPath`（H-V-H / V-H-V 正交折线），工作流用它替换流体贝塞尔；知识图谱仍保留弧线（那边要的是「网络感」） | 画布实测：曲线 0 条、折线 2 条 |
| 5 | **预览框有两层边框** | 真因不是样式：浮卡被放到了节点**上面**。画布基准按节点包围盒算，小布局下比「节点 + 浮卡」还小，于是浮卡「右边放不下就左翻」误判，被塞到左上角压住节点 —— 节点金色边框与浮卡边框叠在一起，看起来就像两层。修法是给基准预留浮卡空间（+ 顺手去掉那圈会被看成第二层边框的阴影） | 浮卡 x 从 `0`（压在节点上）变成 `节点 x + NODE_W + 10` |
| 6 | **拖动节点时预览框有绘制残留** | 浮卡画在 `foreignObject` 里，节点移动时它的坐标更新了但不会重绘，会在原地留下拖影。改为拖动期间不渲染浮卡 | 拖动中浮卡数 = 0（实测） |
| 7 | 踩坑：条件分支「不成立」也走分支 | `nextWorkflowNode` **自身就会优先返回 `branch_node_id`**，而 `resolveNextRunnable` 已经处理过分支，再调它就是又走一次。分支路径看不出来（恰好也对），**只有顺序路径会错** | 改为自己按 `orderedNodes` 算「下一个」 |

> 第 5 条是这一轮最有意思的一处：现象（「边框有两层」）指向样式，真因却是**布局计算把浮卡塞到了节点上面**。
> 如果直接去改 CSS，问题会一直留着。
> 第 7 条同理：「复用现成函数」看起来最省事，但那个函数的语义（分支优先）与这里的需要（纯顺序）不重合，
> 而它**只在一条路径上出错** —— 所以两条推进路径都必须测。

---

## 图谱：从节点手柄拖出连线（2026-09-19，第二十二轮）

| # | 现象 | 排查 | 落地 |
| --- | --- | --- | --- |
| 1 | 用户报告「无法从一个节点拉出连线到另一个节点」 | 图谱原本只有**两次点击**式建链：选中节点 → 点侧栏「从此节点连线」→ 点目标节点（或侧栏「连到这里」）。**在节点上按住拖动是「移动节点」**，所以想「拉」的人必然失败 | 给节点加**连接手柄**：hover 或选中时出现在节点右侧，从它按住拖出去即可建链 |
| 2 | 手柄不能和「拖节点」打架 | 手柄是节点 `<g>` 的**子元素**，`pointerdown` 里 `stopPropagation` 挡在节点拖拽之前；并 `setPointerCapture` 由手柄自己接管后续 move/up | 两种手势各走各的，互不干扰 |
| 3 | 落点判定与反馈 | 复用改挂端点那套 `elementFromPoint(...).closest('[data-node-id]')`（拖拽期间指针被捕获，hover 不触发）；落在空白或自己身上给出**明确回执**而不是静默 | 实测：`25 → 26` 条边、toast「已建立笔记引用」、虚线无残留 |

> 这一轮的教训在**验证方法**上：我先用 `dispatchEvent(new PointerEvent(...))` 去模拟拖拽，
> 结果始终失败 —— 因为**合成事件无法体现 `setPointerCapture` 的语义**，`pointerup` 不会回到手柄。
> 换成真实的合成输入（`Input.dispatchMouseEvent`）后一次通过。
> 顺带发现：图谱侧栏是 `<aside>` 且**盖在画布右侧之上**，所以拿 `getBoundingClientRect` 选节点时
> 必须先用 `elementFromPoint` 预检「这个点真的能点到节点吗」，否则会在视口外/被遮挡处空点。

---

## 图谱节点图标改为多色分层（2026-09-19，第二十三轮）

| # | 需求 | 落地 | 实测 |
| --- | --- | --- | --- |
| 1 | 不能是单色的实体绘制 | 原来每类节点都是**一个 fill**（星/闪电/便签各一块纯色）。现在每类由 2~3 个图层组成：基底主色 + 内层（向底色混合）+ 细节（向文字色混合），描边再向画布底色混合一档 | 逐节点统计唯一颜色数：**笔记 4 色、文件夹 3 色、任务 4 色**，全部 ≥2 |
| 2 | 要两色或以上 | 三档颜色全部由 `--gnode-c`（节点主色）经 CSS `color-mix` 派生 —— 于是**换主题包/强调色时不用改图标代码**，且每个节点随自己的主色自动得到配套的浅色与深色 | `graph.css` 的 `.gnode__icon` 规则；图标组件只管形状与色槽 |
| 3 | 突出节点特性 | 笔记＝便签 + 折角三角 + 文本线；任务＝星里嵌圆与中心点（「一个待办项」）；闪念＝叠一层内闪电；段落引用＝双菱形 + 内核；待建链接＝虚线环 + 加号；文件夹＝深浅两片（选项卡 + 主体） | 截图确认层次清晰可辨 |
| 4 | 代码位置 | 形状与色槽迁到 `components/GraphNodeIcon.tsx`（GraphPage 已近千行，不再往里塞形状函数）；GraphPage 只传 kind / 半径 / 主色 | typecheck / build 通过 |

> 第 2 条是这个设计的关键取舍：如果把浅色/深色写死在图标组件里，那么「笔记用文件夹调色板、任务用固定色」
> 这套既有配色就得多处同步；交给 `color-mix` 之后，任何主色都能自己派生出配套的三档。

---

## 工作流工具栏：新增「加条件」入口（2026-09-19，第二十四轮）

| # | 需求 | 落地 | 实测 |
| --- | --- | --- | --- |
| 1 | 工具栏添加新增条件节点的按钮 | 「加一步」与「加条件」复用同一个弹窗入口 `openNewNodeDialog(kind)`：条件那支预置 `action_kind='condition'`、标题「条件判断」、以及一份「提示确认」草稿 —— 于是点进去就能直接填条件，不用先选动作类型 | 点击后条件编辑区立即出现，动作已为 condition |
| 2 | 图标语义一致 | 用 **Diamond**（菱形），与画布上条件节点的形状对应 | `npm run gen:icons` 自动补进图标入口（62 → 63 个） |
| 3 | 验证 | 临时库造模板 → 点「加条件」→ 读弹窗 → 保存 → 读画布 | 6/6：按钮存在、条件编辑区出现、动作/标题预置正确、节点 1→2、菱形 0→1 |

> 这轮是个纯增量的小改动：条件节点上一轮已经能建（进弹窗后把动作改成「条件判断」），
> 缺的只是一个**直达入口**。顺带把「加一步」的实现参数化，两个按钮共用一条路径，避免复制一份几乎相同的
> 初始化代码。

---

## 工作流：步骤与条件的编辑弹窗彻底拆开（2026-09-19，第二十五轮）

| # | 需求 | 落地 | 实测 |
| --- | --- | --- | --- |
| 1 | 步骤与条件的编辑**应该是两个独立弹窗** | 新建 `components/WorkflowStepDialog.tsx` 与 `components/WorkflowConditionDialog.tsx`：各自包含遮罩、表单、底部按钮，自己管表单状态（草稿 / 是否设为分支），通过 props 收候选与回调 | `WorkflowPage` 里已无任何 modal JSX，只剩两处组件引用 |
| 2 | 两类弹窗的字段不再交叉 | 步骤：标题 / 详情 / SOP 文档 / 动作 + 动作值 / 进入条件 / 条件分支到 /（新增时）作为条件分支；条件：条件名称 / 详情 / 注入条件 / 条件成立时跳到 | 回归 9/9：步骤表单不含条件编辑区、动作下拉不含「条件判断」；条件表单不含动作与 SOP |
| 3 | 页面只按类型分发 | `editingIsCondition` 决定渲染哪一个；`asBranch` 从页面状态移进步骤弹窗内部，`handleSaveNode(node, asBranch)` 改为显式传参 | typecheck / build / check:ctlheight 通过 |

> 上一轮我做的是「同一个弹窗里两套 body」，功能上分开了、**组件层面没有**。这一轮把状态与表单一起搬进各自组件：
> `asBranch` 这类字段原本挂在页面上、只有某个弹窗用得到，现在跟着它所属的表单走。
>
> 迁移时踩到一个定位坑：我用「括号配平」从 `{editing && (` 往后找段落终点，结果被段内的
> `setEditing(null)` 提前骗到 depth 归零 —— 替换后残留了一个 `}`，报的是 `Unexpected token`。
> **字符串/JSX 混在一起时不该用字符级的括号配平**，按行定位（找那个精确缩进的 `))}`）才可靠。
