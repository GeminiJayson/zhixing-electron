# 04 · 与 Python 实现的差异点（Electron 侧记录）

## 0. 阅读约定（先读这一节）

### 0.1 基线位置

**Python 对照基线位于 `zhixing_python` 仓库**。本文中出现的 `zhixing/...`、`qfluent_core/...`、以及仓库根的 `zhixing.spec` / `build_windows.bat` 路径，**均为该仓库内的相对路径**；Electron 侧路径相对 **Electron 项目根**（当前工作区内为 `electron/`，拆分后即 `zhixing-electron` 仓库根）。两个仓库各自独立，本文只做差异记录。

### 0.2 事实基准与旧文档定位

| 文档 | 定位 | 是否可作为事实源 |
| --- | --- | --- |
| `.aoci/.draft/audit/electron-diff.md`（490 行） | **权威复核报告**：把 `parity-audit.md` 的 152 条逐条重判（只依据当前代码取证），给出判决统计、按域权威差异清单、Electron 独有能力、脚本盘点与完成度 | ✅ **本文的唯一事实基准** |
| `docs/parity-audit.md`（516 行） | 最初审计的总览 + 批次 0–4 与后续 7 轮修复记录 | ⚠️ 第 20–516 行的批次记录可用；总览数字与结论是**审计当时快照** |
| `docs/audit/`（6 份：task / notes / graph-search-review / inbox-workflow / settings-platform / data-maintenance） | 分域明细表 | ❌ **明细表未回填**，仍是审计当时结论；本次复核发现其中 69 条描述已与代码不符 |
| `docs/optimization-proposals.md`（O1–O11） | 工程债提案 | ✅ 已全部标为完成，本轮核对与代码一致，**不再是差异** |
| `README.md`（56 行） | 项目说明 | ❌ 严重过时（见 §6.2） |

因此：**凡旧文档与本文件冲突，以本文件为准**；本文件与代码冲突，以代码为准。

### 0.3 差异类型

`未实现` / `部分实现` / `行为不同` / `有意简化`（实现方主动取舍）/ `已具备`（Electron 已有等价或更完整能力）。

---

## 1. 复核方法与判决统计

### 1.1 方法

1. 只依据**当前代码**逐条取证，不采信任何文档结论；每条断言附两侧 `文件:行号`。
2. 重判 `parity-audit.md` 的 152 条（构成：任务 17 + 笔记 22 + 图谱/搜索/回顾 15 + 收件箱/工作流/捕获 39 + 设置/平台/窗口 31 + 数据/统计/维护 28 = 152，数目自洽）。
3. 对「仍成立」项更新漂移的行号（约 30 条原引用行号发生漂移，结论不变）。
4. 原 152 条未覆盖的 **打包与发布**、**渲染与交互** 另立新增域（各 7 条）。

### 1.2 判决统计（复核后）

| 判决 | 条数 | 占比 | 含义 |
| --- | ---: | ---: | --- |
| 仍成立 | 83 | 54.6% | 缺口当前仍然存在（个别行号有漂移） |
| 部分修复 | 27 | 17.8% | 主要缺口已补，仍有可复现残留（多为后端已实现、渲染层未接线） |
| 已修复 | 42 | 27.6% | 当前代码已具备等价能力，文档结论失效 |
| 合计 | **152** | 100% | — |

**「描述已过时」共 69 条 = 已修复 42 + 部分修复 27**。

| 域 | 仍成立 | 部分修复 | 已修复 | 小计 |
| --- | ---: | ---: | ---: | ---: |
| 任务 | 9 | 2 | 6 | 17 |
| 笔记 | 16 | 3 | 3 | 22 |
| 图谱 / 搜索 / 回顾 | 12 | 2 | 1 | 15 |
| 收件箱 / 工作流 / 捕获 | 22 | 6 | 11 | 39 |
| 设置 / 平台 / 窗口 | 10 | 10 | 11 | 31 |
| 数据 / 统计 / 维护 | 14 | 4 | 10 | 28 |
| **合计** | **83** | **27** | **42** | **152** |

### 1.3 权威差异清单的规模

未对齐项共 **110 条**（仍成立 83 + 部分修复 27），加两个新增域的 14 条，**合计 124 条**。编号沿用原 audit 文件编号（T=任务 / N=笔记 / G=图谱搜索回顾 / I=收件箱工作流捕获 / S=设置平台窗口 / D=数据维护；P=打包发布、R=渲染交互为本次新增）。

> **忠实性说明（本轮实测）**：`electron-diff.md` §2 的 8 张分域表实际列出 **113 行**，与其声明的 124 条存在 **11 条差额**，全部集中在笔记域（§1.3 判定笔记域未对齐 19 条，§2.2 仅列 8 条）。为不擅自增删，本文 §2.1–§2.8 逐行转写该 113 行，另在 §2.9 按 §1.3 的判决**补录**这 11 条，使总量与 §1.2 的判决统计自洽（113 + 11 = 124）。

> 下表内容为 `electron-diff.md` §2 的**压缩转写**（保留编号、类型、语义与两侧证据），行号以该报告为准；其准确性与当前代码的抽样核对已在 `01`/`02`/`03` 三份文档中复核。

---

## 2. 按域权威差异清单

### 2.1 任务域

| 编号 | 类型 | 差异（Python → Electron） | 证据（Python / Electron） |
| --- | --- | --- | --- |
| T1 | 部分实现 | 全套清单体系（含 move_to_list） → 清单 CRUD + 筛选已具备，但缺「把任务移动到清单」UI，`moveTaskToList` 零调用 | `zhixing/model/application/task_service.py:677/684/696/708/717/373/250` / `src/main/db/lists.ts:15-107`、`src/renderer/src/pages/TasksPage.tsx:517-544`、`src/preload/index.ts:91` |
| T3 | 未实现 | attach_block / detach_block / linked_contexts / contexts_for_note / note_context_map，完成任务回写段落 → `task_note_context` 仅建表与清删，无业务读写；无「完成→追加结论」闭环 | `zhixing/model/application/task_service.py:594-640`、`zhixing/model/application/note_service.py:695`、`zhixing/controller/app_controller.py:678-697` / `src/main/db/schema.ts:152`、`src/main/db/migrate.ts:48`、`src/main/db/trash.ts:55/69` |
| T4 | 部分实现 | `pause(resume_at)`/`resume` 可写、编辑器有「恢复于」、`resume_due_today` 生效 → 字段与到期恢复逻辑在，但**无任何写入路径/UI**，恢复永不触发 | `zhixing/model/application/task_service.py:643-664`、`undefined:158-173/411-434`、`zhixing/controller/app_controller.py:1260/1365` / `src/main/db/tasks.ts:310-320`、`src/main/db/tasks.ts:270/351` 仅清零；`src/renderer/src/components/TaskEditor.tsx:22-160` 无字段 |
| T5 | 行为不同 | 编辑面板改状态不写 `completed_at`；只有 set_status/toggle_complete 写 → `updateTask` 只要含 `status` 就写 | `zhixing/model/application/task_service.py:119/138`、`undefined:407-421` / `src/main/db/tasks.ts:341-344` |
| T6 | 行为不同 | add_subtask 继承父 `list_id`；`list_tree(None)` 只取顶层根并闭包保留子树 → `createTask` 不继承 `list_id`，收件箱按 `list_id IS NULL` 平铺，子任务同时出现在收件箱 | `zhixing/model/application/task_service.py:81-89/373-403` / `src/main/db/tasks.ts:293-307`、`src/main/db/inbox.ts:16-21`、`src/renderer/src/pages/TasksPage.tsx:405` |
| T7 | 行为不同 | quick_create 未命中回退 `default_list_id` 且不新建；任务页捕获传当前清单 → `ensureListId` 未命中即新建 `list_folder`；`quickAdd` 无 default list 参数 | `zhixing/model/application/task_service.py:57-66`、`zhixing/controller/app_controller.py:126-127` / `src/main/db/task-ops.ts:171-185/191-216` |
| T11 | 行为不同 | `group_tasks_by_date` 逐日展开 start+due、无日期归今日、按 `(-priority,sort_key,id)` 排序；`calendar_show_done` 默认 False 生效 → 只用 `due_date`、无 start 展开、无日期丢弃、不排序、恒排除完成；`calendar_show_done` 只写不读 | `zhixing/view/pages/task_page.py:1425-1457/1831-1834`、`zhixing/core/constants.py:28` / `src/renderer/src/components/CalendarBoard.tsx:49-58`、`src/renderer/src/pages/SettingsPage.tsx:336-337` |
| T12 | 行为不同（有意） | reparent 保留原 `sort_key` 且无环校验；reorder 只改 `sort_key` → `reparentTask` 防成环并重置 `sort_key` 到新父末位；`reorderTask` 顺带改 `parent_id` | `zhixing/model/application/task_service.py:246-248/278-298` / `src/main/db/task-ops.ts:42-58/83-97` |
| T13 | 行为不同 | 撤销记录 `prev_status`；删除任务可撤销整棵子树 → 删除已可撤销（`action=restore`），但完成撤销仍盲目 `toggleTask`，无 `prev_status` | `zhixing/controller/app_controller.py:549-579/699-736` / `src/renderer/src/App.tsx:249-261`、`src/renderer/src/pages/TasksPage.tsx:244-249/295-299`、`src/main/db/tasks.ts:163-176` |
| T15 | 行为不同 | `list_all` 无上限，各视图全量装载 → `listTasks` 默认 `LIMIT 500`，渲染层不传参 | `zhixing/model/infrastructure/repositories.py:137-141` / `src/main/db/tasks.ts:20`、`src/renderer/src/pages/TasksPage.tsx:90` |
| T17 | 未实现 | `task_candidates(q,limit)` 供捕获目标选择器与笔记侧归属 → 全仓无实现（无 IPC/preload/渲染入口） | `zhixing/model/application/task_service.py:497-517`、`zhixing/view/components/target_selector.py:107-108`、`zhixing/view/pages/note_page.py:1118` / grep `task_candidates` / `TargetSelector` 0 |

### 2.2 笔记域

| 编号 | 类型 | 差异（Python → Electron） | 证据（Python / Electron） |
| --- | --- | --- | --- |
| N1 | 部分实现 | 切走前 `_commit_current_editor` 立即落盘 → 切换已 `flushPending`（8 处入口）；仍无关窗/刷新前 flush（`beforeunload` 缺失） | `zhixing/view/pages/note_page.py:330-334`、`zhixing/view/components/markdown_editor.py:270-274` / `src/renderer/src/pages/NotesPage.tsx:147-163/306/477/541/555/636/654` |
| N3 | 部分实现 | 五种格式可创建；创建对话框可选类型与目标路径/URL → 五种格式可创建、非法回退；但 `saveNote` 类型不含 `format`，无改格式入口；Word/Excel 不自动生成空白文件 | `zhixing/model/application/note_service.py:17-26`、`zhixing/view/components/note_create_dialog.py:48-52`、`zhixing/controller/app_controller.py:799-834`、`zhixing/model/infrastructure/repositories.py:477` / `src/main/db/notes.ts:126-153`、`src/preload/index.ts:200-203`、`src/renderer/src/pages/NotesPage.tsx:236/390-424` |
| N16 | 行为不同 | `by_title` 取 `.first()`（无排序） → `resolveNoteTitle` 按 `pinned DESC, updated_at DESC LIMIT 1` | `zhixing/model/infrastructure/repositories.py:402-404` / `src/main/db/notes.ts:28-34` |
| N17 | 行为不同 | `NoteRepository.all()` 无 LIMIT → `listNotes` 默认 300，两处无参调用 | `zhixing/model/infrastructure/repositories.py:406-418` / `src/main/db/tasks.ts:126`、`src/renderer/src/pages/NotesPage.tsx:55`、`src/preload/index.ts:31` |
| N18 | 未实现 | 版本历史 `difflib.unified_diff`；回滚二次确认 → 只 `pre` 展示该版正文；回滚无确认 | `zhixing/view/components/note_tools.py:108-136/146-153` / `src/renderer/src/components/NoteHistory.tsx:57-58/70-77` |
| N19 | 部分实现 | 查找下一个（循环）/ 替换下一处 / 全部替换 / 全部命中高亮 → 只有 findNext + replaceAll，无单处替换与高亮 | `zhixing/view/components/note_tools.py:243-302` / `src/renderer/src/pages/NotesPage.tsx:201-230` |
| N20 | 未实现 | `import_markdown_folder`：rglob `*.md` 批量建笔记 → 无导入实现，只有 markdown 导出 | `zhixing/model/infrastructure/exporter.py:221-239`、`zhixing/view/pages/settings_page.py:566-571` / `src/main/db/export.ts:82-142`、`src/renderer/src/pages/SettingsPage.tsx:377-410` |
| N21 | 行为不同 | 文件夹镜像对同名追加 `-{i}` → `safeName` 无去重，同名笔记互相覆盖 | `zhixing/model/infrastructure/exporter.py:94-107` / `src/main/db/export.ts:83-96/136-140` |

### 2.3 图谱 / 搜索 / 回顾

| 编号 | 类型 | 差异（Python → Electron） | 证据（Python / Electron） |
| --- | --- | --- | --- |
| G2 | 部分实现 | `_acyclic_ownership_edges` 丢弃归属回边并写 `cycle_edges`；图页提示 → `wouldCreateCycle` 已实现但全仓无调用；`buildGraph` 无破环；`GraphPayload` 无 `cycleEdges` | `zhixing/model/application/graph_service.py:57-83/269-284`、`zhixing/view/pages/graph_page.py:1197-1206` / `src/main/db/graph.ts:261-273`（零调用）、`src/main/db/graph.ts:44-201`、`src/shared/types.ts:132-137` |
| G3 | 部分实现 | 查 `ref_pairs` 并以 reference 类覆盖同对归属边 → `task_note_ref` 已有增删，但 `buildGraph` 不读，引用语义不进图 | `zhixing/model/application/graph_service.py:302-303/332-337` / `src/main/db/graph.ts:183-190` |
| G4 | 未实现 | 用 `task_note_context` 造 anchor 节点 + note→anchor / task→anchor 引用边 → `GraphKind` 无 anchor；`task_note_context` 无业务读取 | `zhixing/model/application/graph_service.py:287/344-368` / `src/shared/types.ts:119`、`src/main/db/schema.ts:152`、`src/main/db/trash.ts:55/69` |
| G5 | 未实现 | diff + 5 个 `apply_*` + subscribe；消费端按节点/边定点增删并保留布局与 pinned → 无 delta 通道；写操作整表重查，仅 `POS_CACHE` 复用坐标 | `zhixing/model/application/graph_service.py:469-555`、`zhixing/view/pages/graph_page.py:1075-1166` / `src/renderer/src/pages/GraphPage.tsx:81/110-229` |
| G6 | 未实现 | 订阅 `flash_changed` 并重算 → 只订阅 `['note','task']` | `zhixing/model/application/graph_service.py:530/544` / `src/renderer/src/pages/GraphPage.tsx:119`、`src/shared/events.ts:9` |
| G7 | 未实现 | 文件夹/标签下拉 + 图内搜索 + Ctrl+F 聚焦 + 默认 `include_tasks=True` → 只有 scope 与任务开关（默认 false）；无文件夹/标签过滤、无图内搜索 | `zhixing/view/pages/graph_page.py:882-896/1015-1028/1318-1342`、`zhixing/view/shell/main_window.py:229-230` / `src/renderer/src/pages/GraphPage.tsx:70-86/259-269`、`src/main/db/index.ts:384` |
| G8 | 行为不同 | neighborhood 仅沿 `note_link` 做 1~2 度 BFS 再补悬空节点 → 前端对已加载 payload 的**全类型边**做 BFS，结果随 `includeTasks`/文件夹节点变化 | `zhixing/model/application/graph_service.py:711-745` / `src/renderer/src/pages/GraphPage.tsx:122-152` |
| G9 | 未实现 | `preview_text` 按类型输出摘要/状态/优先级/截止/父任务/关联笔记/来源 → 侧栏只有 kind/degree/format | `zhixing/model/application/graph_service.py:748-785` / `src/renderer/src/pages/GraphPage.tsx:692-707` |
| G10 | 部分实现 | 双击按 note/flash/task/folder/anchor/dangling 六类分派跳转；侧栏 `_open_selected` → 只有 note→打开、dangling→新建，其余仅提示 | `zhixing/view/pages/graph_page.py:265-280/1696-1713` / `src/renderer/src/pages/GraphPage.tsx:443-449/737-749` |
| G11 | 行为不同（有意） | create 只重算新笔记自身出链，不按标题回填他处悬空 → 新建后显式 `bindDanglingByTitle` 全量转正 | `zhixing/model/application/note_service.py:81-97/718-730` / `src/renderer/src/App.tsx:228-234`、`src/main/db/notes.ts:215-223` |
| G12 | 行为不同 | `_flash_label` 取正文首行、截 40 字 → 折叠全部空白后截 16 字加省略号 | `zhixing/model/application/graph_service.py:913-916` / `src/main/db/graph.ts:147-150` |
| G13 | 部分实现 | `global_search` 前缀/过滤/FTS 分档 + 命令注入 + MRU → 前缀/过滤/FTS 分档已实现并接入命令面板；缺 MRU 与命令注入 | `zhixing/model/application/search_service.py:71-232`、`zhixing/controller/app_controller.py:77-85/770-776` / `src/main/db/search.ts:64-227`、`src/renderer/src/components/CommandPalette.tsx:71/81-104`、`src/preload/index.ts:99` |
| G14 | 行为不同（有意） | `today_counts` 的 flash = 全部未删除闪念（含 archived） → 只数 `status='inbox'` | `zhixing/model/application/review_service.py:35`、`zhixing/model/infrastructure/repositories.py:585-589` / `src/main/db/review.ts:43-47` |
| G15 | 行为不同（有意） | `completed_between` 无 `deleted_at`/status 过滤，周趋势/热力/连续天数直接使用 → 限定 `deleted_at IS NULL` 且要求 effective done | `zhixing/model/infrastructure/repositories.py:199-202`、`zhixing/model/application/review_service.py:41-120` / `src/main/db/review.ts:28/36-38/69-74/99-127` |

### 2.4 收件箱 / 工作流 / 捕获

| 编号 | 类型 | 差异（Python → Electron） | 证据（Python / Electron） |
| --- | --- | --- | --- |
| I1 | 部分实现 | `add(content,remark,source_app,source_url)`，content[:2000]/remark[:200] → 后端已支持 source_url 与截断；渲染层两处 `addFlash` 只传 3 参，`source_url` 恒空 | `zhixing/model/application/flash_service.py:18-24` / `src/main/db/inbox.ts:41-59`、`src/renderer/src/pages/InboxPage.tsx:74`、`src/renderer/src/components/CapturePanel.tsx:68` |
| I2 | 未实现 | `_extract_source_url` 从剪贴板 HTML 提取来源 URL → 不解析剪贴板 HTML | `zhixing/controller/app_controller.py:432-467/383-384` / `src/renderer/src/components/CapturePanel.tsx:29-38` |
| I6 | 部分实现 | `to_subtask` 挂到指定父任务 → 后端+IPC+preload 齐备，渲染层零调用 | `zhixing/model/application/flash_service.py:203-211` / `src/main/db/inbox.ts:168-190`、`src/preload/index.ts:48`、`src/main/db/index.ts:340` |
| I7 | 部分实现 | `to_note(folder_id)` 可指定笔记目录 → `flashToNote` 全链路支持 `folderId`；`InboxPage` 不传 | `zhixing/model/application/flash_service.py:185/190` / `src/main/db/inbox.ts:193-201`、`src/preload/index.ts:54`、`src/renderer/src/pages/InboxPage.tsx:86` |
| I8 | 未实现 | delete-flash 走撤销链路 → 仅 `confirm` + `deleteFlash`，无撤销 | `zhixing/controller/app_controller.py:666-670` / `src/renderer/src/pages/InboxPage.tsx:136-140` |
| I12 | 未实现 | `instances_of_task` + 任务页启动/查看流程 → 无 IPC；`instantiateWorkflow` 恒传 `null` originTaskId | `zhixing/model/application/workflow_service.py:240-249`、`zhixing/view/pages/task_page.py:960-1030` / `src/main/db/workflow.ts:236-262`、`src/renderer/src/pages/WorkflowPage.tsx:322` |
| I14 | 未实现 | `duplicate_template` 复制模板 → 全仓无实现 | `zhixing/model/application/workflow_service.py:139-153`、`zhixing/view/pages/workflow_page.py:1254-1258` / grep `duplicate` 0 |
| I15 | 未实现 | 模板重命名 → 无入口（`saveWorkflowTemplate` 支持 name 但无调用） | `zhixing/view/pages/workflow_page.py:1243-1252` / `src/renderer/src/pages/WorkflowPage.tsx:211-242` |
| I16 | 未实现 | `start_policy` 可编辑（first/all） → 只透传既有值，新建写死 `'first'`，`'all'` 不可达 | `zhixing/view/pages/workflow_page.py:1276-1280/1366-1371` / `src/renderer/src/pages/WorkflowPage.tsx:217/250/278/361` |
| I17 | 未实现 | 删除步骤 / 上移下移 → 无入口 | `zhixing/view/pages/workflow_page.py:1322-1346` / `src/renderer/src/pages/WorkflowPage.tsx:388-399` |
| I18 | 部分实现 | 加一步支持「插到选中节点后」+ 设为分支 → 分支可单独编辑；加一步恒追加末尾 | `zhixing/view/pages/workflow_page.py:1282-1313` / `src/renderer/src/pages/WorkflowPage.tsx:244-270/718-739` |
| I19 | 未实现 | 步骤绑定 SOP 笔记（note_combo→note_id） → 编辑弹窗无 `note_id` 字段，`[[笔记]]` 写备注成死代码 | `zhixing/view/pages/workflow_page.py:762-769/831` / `src/renderer/src/pages/WorkflowPage.tsx:669-740`、`src/main/db/workflow.ts:212-218` |
| I20 | 未实现 | `_auto_layout` 一键对齐 → 无；仅在 pos 为空时纵向兜底 | `zhixing/view/pages/workflow_page.py:1197-1207` / `src/renderer/src/pages/WorkflowPage.tsx:30-42` |
| I21 | 行为不同 | 完成判定只认 `status=='done'` → `'abandoned'` 也算 done | `zhixing/model/application/workflow_service.py:437-448` / `src/main/db/workflow.ts:290` |
| I22 | 行为不同 | 实例步骤集合仅含已生成绑定 → LEFT JOIN 全部模板节点（`task_id` 可 null），进度分母不同、出现空步骤行 | `zhixing/model/application/workflow_service.py:215-222` / `src/main/db/workflow.ts:273-285` |
| I23 | 行为不同 | `list_instances` 按 id desc → 按 `created_at` desc | `zhixing/model/application/workflow_service.py:227-234` / `src/main/db/workflow.ts:299-300` |
| I24 | 行为不同 | `describe_action` 输出笔记标题/命令前缀/「无动作」 → 恒「打开关联笔记」/裸值/空串 | `zhixing/model/application/workflow_service.py:307-318` / `src/main/db/workflow.ts:376-381` |
| I26 | 行为不同 | `shlex.split`：反斜杠转义、未闭合引号抛错 → 自实现切分，无转义、未闭合引号静默吞掉 | `zhixing/model/application/workflow_service.py:334-347` / `src/main/db/workflow.ts:352-373` |
| I27 | 部分实现 | `save_template` 返回 None → 主进程模板不存在时 throw；页面处理 `ok:false` 但未 try/catch rejection | `zhixing/model/application/workflow_service.py:72-73` / `src/main/db/workflow.ts:131`、`src/renderer/src/pages/WorkflowPage.tsx:220-223/293-296` |
| I28 | 行为不同 | `list_templates` 按 `updated_at desc nullslast, id desc` → 仅 `updated_at DESC` | `zhixing/model/application/workflow_service.py:35-37` / `src/main/db/workflow.ts:80` |
| I29 | 部分实现 | 划词卡五去向（闪念/笔记/任务/列表/子任务） → 三去向（闪念/笔记/任务） | `zhixing/view/capture/capture_card.py:79-80/96-102` / `src/renderer/src/components/CapturePanel.tsx:124-140` |
| I30 | 未实现 | TargetSelector：分组树 + 最近 3 条 + 模糊搜索 → 无对应实现 | `zhixing/view/components/target_selector.py:19-131`、`zhixing/view/capture/capture_card.py:116-145` / grep `TargetSelector` 0 |
| I31 | 部分实现 | 模拟复制读选区 + 剪贴板备份恢复 + 来源应用/URL → 只读剪贴板预填并 `slice(0,500)` | `zhixing/model/infrastructure/selection.py:28-48/113-123`、`zhixing/controller/app_controller.py:375-408` / `src/renderer/src/components/CapturePanel.tsx:31-32` |
| I32 | 部分实现 | select-quick 热键 + 选区读取 + 原文入备注 → 设置项/热键/动作已接，动作仍读剪贴板 | `zhixing/controller/app_controller.py:334-337/388-419` / `src/shared/settings.ts:38/97`、`src/main/index.ts:244`、`src/renderer/src/App.tsx:217-221` |
| I35 | 行为不同 | 捕获「任务」不解析语法糖，notes=「捕获内容：…」 → 走 `quickAdd` 解析 `!`/`@`/`#`/日期 | `zhixing/controller/app_controller.py:480-482` / `src/renderer/src/components/CapturePanel.tsx:52-63` |
| I36 | 行为不同 | `title[:30]`、body=引文+content+remark → `title[:40]`、body 仅 content、remark 只进标题 | `zhixing/controller/app_controller.py:495-499` / `src/renderer/src/components/CapturePanel.tsx:74-83` |
| I38 | 行为不同（有意） | `parse_natural_date` 的「下周X」实现为「下一个 X」 → 按字面语义取下一周 | `zhixing/model/domain/task_rules.py:265-269` / `src/shared/capture.ts:69-80` |
| I39 | 行为不同 | `@列表` 未命中回退 `default_list_id`，不新建 → `ensureListId` 未命中即新建 `list_folder` | `zhixing/model/application/task_service.py:60-64` / `src/main/db/task-ops.ts:171-185` |
### 2.5 设置 / 平台 / 窗口

证据列：`P` = `zhixing_python` 仓库内相对路径；`E` = Electron 项目根相对路径。

| 编号 | 类型 | 差异（Python → Electron） | 证据（P / E） |
| --- | --- | --- | --- |
| S3 | 部分实现 | `mica_enabled` 设置项 + 改动即调材质 → 能力已实现且默认 true；渲染层无开关 | P `zhixing/core/constants.py:11`、`zhixing/view/pages/settings_page.py:154-157`、`zhixing/controller/app_controller.py:1100-1104`、`zhixing/view/shell/main_window.py:327-332` / E `src/shared/settings.ts:42`、`:99`、`src/main/index.ts:349-356`、renderer grep 0 |
| S5 | 未实现 | `control_height` 默认 32、范围 24–48，驱动控件高度 → 只在类型层（默认已对齐 32/24–48），无消费点、无 UI | P `zhixing/core/constants.py:37-38`、`zhixing/view/pages/settings_page.py:166-171`、`zhixing/controller/app_controller.py:984`、`:1079-1083` / E `src/shared/settings.ts:19`、`:83` |
| S6 | 行为不同 | `font_size` 默认 14、范围 9–20、按像素直接应用 → 默认/钳位已对齐；滑杆 10–18，应用时 `+1.5px` | P `zhixing/controller/app_controller.py:986`、`zhixing/view/pages/settings_page.py:173-178`、`zhixing/core/constants.py:35-36` / E `src/shared/settings.ts:80`、`src/renderer/src/pages/SettingsPage.tsx:230-231`、`src/renderer/src/theme.ts:84` |
| S7 | 行为不同 | `task_row_height` 默认 38、范围 24–72 → 默认/钳位已对齐；滑杆 22–56，应用时 `+10px` | P `zhixing/view/widget/desktop_widget.py:135`、`zhixing/view/pages/settings_page.py:199-203` / E `src/shared/settings.ts:81`、`src/renderer/src/pages/SettingsPage.tsx:239-244`、`src/renderer/src/theme.ts:85` |
| S8 | 部分实现 | `pomodoro_auto_break` 默认 False 且有开关 → 默认已对齐 false；无开关 UI | P `zhixing/view/pages/settings_page.py:257-260` / E `src/shared/settings.ts:87`、`src/renderer/src/pages/SettingsPage.tsx:266-339` |
| S10 | 行为不同 | `motion_level` 仅 full/reduced，另探测系统减动效并冻结图谱物理 → full/essential/none，仅 `none` 置 dataset；无 OS 探测/图谱降级 | P `zhixing/view/pages/settings_page.py:159-164`、`zhixing/controller/app_controller.py:1035-1063` / E `src/shared/settings.ts:56`、`:68`、`:84`、`src/renderer/src/theme.ts:86` |
| S13 | 部分实现 | select_quick 热键 + 选区速记 → 设置项/热键/动作已在，动作为剪贴板降级 | P `zhixing/core/settings_keys.py:20`、`zhixing/controller/app_controller.py:334-337`、`:388-419` / E `src/shared/settings.ts:38`、`:97`、`src/main/index.ts:244`、`src/renderer/src/App.tsx:217-221` |
| S16 | 未实现 | 启动只显主窗并 hide 浮窗；主窗显隐联动浮窗 → `widget_enabled` 时启动即创建并显示浮窗；无主↔浮窗联动 | P `zhixing/controller/app_controller.py:1382`、`:896-907`、`:179-188` / E `src/main/index.ts:443-444` |
| S17 | 部分实现 | 贴边半隐/悬停滑出/双击展开/右键菜单/**边缘缩放** → 贴边+悬停+双击+右键已实现；边缘缩放未实现 | P `zhixing/view/widget/desktop_widget.py:466-514`、`:445-448`、`:450-464`、`:387-437`、`:321-330` / E `src/main/index.ts:149-182`、`:471-480`、`src/renderer/src/WidgetApp.tsx:32-47` |
| S18 | 行为不同 | 浮窗可改优先级/标签/子任务/定位编辑/删除（含撤销）/hover 段落 → 仅勾选/改标题/加子任务/删除；优先级与标签引导主窗，无撤销与 snippet | P `zhixing/view/widget/desktop_widget.py:210-262`、`:171-180`、`zhixing/controller/app_controller.py:180-185` / E `src/renderer/src/WidgetApp.tsx:88-133` |
| S19 | 行为不同 | 拖拽/缩放释放或贴边时写一次几何 → `moved`/`resized` 每次事件写库（贴边态除外） | P `zhixing/view/widget/desktop_widget.py:368-384`、`:307-309` / E `src/main/index.ts:117-128`、`src/main/db/maintenance.ts:135-155` |
| S20 | 部分实现 | 改键流程 + `hotkey_status`（已注册/冲突降级） → 仅 `select_quick` 可改；失败仅 `console.error`，无状态反馈 | P `zhixing/view/pages/settings_page.py:264-328`、`zhixing/controller/app_controller.py:295-329` / E `src/renderer/src/pages/SettingsPage.tsx:298-306`、`src/main/index.ts:246-258` |
| S21 | 部分实现 | 划词捕获（选区/来源/URL/五去向） → 读剪贴板预填，无选区/来源/URL，去向 3 个 | P `zhixing/model/infrastructure/selection.py:28-123`、`zhixing/controller/app_controller.py:375-513` / E `src/renderer/src/components/CapturePanel.tsx:19-39`、`:124-133`、`src/preload/index.ts:35-36` |
| S22 | 部分实现 | 深链精确定位任务/笔记 + block/闪念/文件夹 → 只按 kind 切页，不消费 id 与 block | P `zhixing/controller/app_controller.py:1445-1459`、`zhixing/core/deep_link.py:22-50` / E `src/shared/deep-link.ts:26-34`、`src/renderer/src/App.tsx:189-200` |
| S23 | 部分实现 | 托盘 tooltip 显示今日待办 N，**图标随主题重建** → tooltip 已动态；图标仍静态 | P `zhixing/controller/app_controller.py:1149-1153`、`:1118`、`zhixing/view/shell/main_window.py:281-284`、`:334-335` / E `src/main/index.ts:271-304` |
| S25 | 部分实现 | 托盘/热键 6 类动作 → 托盘 5 项，动作集仍非全集 | P `zhixing/controller/app_controller.py:275-293` / E `src/main/index.ts:288-302` |
| S26 | 部分实现 | 命令 7 条 + 任务/笔记/闪念/标签命中 + MRU → 命中已齐；命令仅导航页 + 新建任务，无 MRU | P `zhixing/controller/app_controller.py:77-85`、`:210`、`:770-797` / E `src/renderer/src/components/CommandPalette.tsx:71`、`:81-104` |
| S27 | 未实现 | FloatingDock 右下快捷新建入口 → 全仓无 | P `zhixing/view/widget/floating_dock.py:32-186`、`zhixing/view/shell/main_window.py:76-89`、`:158-211` / E grep 无 dock 组件 |
| S29 | 未实现 | splash 完成初始化后再显主窗 → 直接建主窗 + `ready-to-show` | P `zhixing/__main__.py:106-135`、`zhixing/view/shell/splash.py` / E `src/main/index.ts:321-357` |
| S30 | 行为不同 | 1280×820，min **1024×700** → 1280×820，minWidth 1040 / minHeight 640 | P `zhixing/view/shell/main_window.py:41-44` / E `src/main/index.ts:322-326` |

### 2.6 数据 / 统计 / 维护

| 编号 | 类型 | 差异（Python → Electron） | 证据（P / E） |
| --- | --- | --- | --- |
| D2 | 部分实现 | 库打不开进**只读模式** + 横幅 + 恢复备份入口 → `db:info` 已真实反映 `ready`，失败给中文原因；但 `app:info` 恒 `dbReady:true`，无只读分支/横幅；恢复入口已在设置页 | P `zhixing/controller/app_controller.py:1313-1319`、`:1350-1351`、`zhixing/view/shell/main_window.py:375` / E `src/main/db/index.ts:171`、`src/main/index.ts:446-453`、`src/main/db/connection.ts:155-169`、`src/renderer/src/pages/SettingsPage.tsx:412-424` |
| D4 | 行为不同 | 导入前备份走 BackupService，纳入 10 份 prune → 写入 `backups/before-import/` 后不 prune | P `zhixing/view/pages/settings_page.py:421`、`zhixing/model/infrastructure/backup.py:19-42` / E `src/main/db/export.ts:166-176`、`src/main/db/backup.ts:28-47` |
| D6 | 部分实现 | `id_map` 重映射外键、目标缺失即跳过；CASCADE 清理 → 新增孤儿清理；但 `EXPORT_TABLES` 不含 `task_note_context` / `task_note_ref` / `workflow_*`，导入后残留旧 id | P `zhixing/model/infrastructure/exporter.py:170-204`、`zhixing/model/infrastructure/models.py:127` / E `src/main/db/export.ts:11-27`、`:33-42`、`:216-219` |
| D9 | 行为不同 | 跨天 **600s** 轮询 + startup → **60s** 轮询 + 挂载时调用（依赖渲染进程） | P `zhixing/controller/app_controller.py:1211`、`:1364-1365` / E `src/renderer/src/App.tsx:143-175` |
| D12 | 行为不同 | 用 `datetime` 比较 `deleted_at < now - days` → 取 `deleted_at` 前 10 位与 `(today-days)` 做 `<` 比较，恰 N 天前多留一天 | P `zhixing/model/application/task_service.py:236-243`、`zhixing/model/application/note_service.py:195-201`、`zhixing/model/application/flash_service.py:176-182` / E `src/main/db/trash.ts:91-100` |
| D13 | 行为不同 | `trash()` 复用 `list_all` 的 `(sort_key,id)` 排序 → `ORDER BY deleted_at DESC` | P `zhixing/model/application/task_service.py` 的 trash 区域（**行号未取证**，审计未给行号） / E `src/main/db/trash.ts:18`、`:25`、`:31` |
| D14 | 未实现 | 导入/恢复发 `backup_restored` 全量刷新 → `restoreTrash` / `purgeTrash` / `emptyTrash` / `purgeTrashOlderThan` / `import*` 全映射 `'task'`，note/flash/settings 视图不刷新 | P `zhixing/view/pages/settings_page.py:423` / E `src/main/db/index.ts:105-120`、`src/renderer/src/pages/NotesPage.tsx:119-124` |
| D17 | 部分实现 | 每条到期任务各弹一窗，正文含 `reminder_at` 时刻 → 正文已显示提醒时刻；仍只渲染 `due[0]`，其余仅计数 | P `zhixing/controller/app_controller.py:1223-1227` / E `src/renderer/src/components/ReminderPopup.tsx:31-56` |
| D18 | 未实现 | 手动结束专注弹原因选择并写 `reason` → `reason` 列与后端参数齐备，但 preload/PomodoroBar 只传 3 参，永不写入 | P `zhixing/controller/pomodoro.py:144-162`、`zhixing/model/infrastructure/repositories.py:686-689` / E `src/main/db/maintenance.ts:70-84`、`src/preload/index.ts:221-222`、`src/renderer/src/components/PomodoroBar.tsx:59`、`:108-112` |
| D20 | 未实现 | 休息结束同样记账；新 `start()` 先 `stop()` 记完上一轮 → 只 focus 阶段记账；`start` 直接覆盖 session，丢失上一轮 | P `zhixing/controller/pomodoro.py:103-105`、`:118-131` / E `src/renderer/src/components/PomodoroBar.tsx:31-37`、`:58-70` |
| D21 | 未实现 | 命令面板「开始番茄钟（25 分钟）」→ 可无任务启动 → 仅任务行「开始专注」，无全局入口 | P `zhixing/controller/app_controller.py:84`、`:876-877` / E `src/renderer/src/components/TaskRow.tsx:172-179`、`src/renderer/src/components/CommandPalette.tsx:81-104` |
| D22 | 部分实现 | 默认 False 且有「专注结束自动休息」开关 → 默认已对齐 False；无该开关 | P `zhixing/controller/pomodoro.py:140`、`zhixing/view/pages/settings_page.py:257-260` / E `src/shared/settings.ts:87`、`src/renderer/src/pages/SettingsPage.tsx:266-339` |
| D23 | 行为不同 | 专注 5–90、休息 1–30 → 设置页专注 1–120 / 休息 1–60，钳位 5–90 / 1–30，**允许域不同** | P `zhixing/view/pages/settings_page.py:245`、`:252` / E `src/renderer/src/pages/SettingsPage.tsx:271-286`、`src/shared/settings.ts:85-86` |
| D24 | 未实现 | `seed_if_empty`：工作/生活分组 + 我的清单 + 2 欢迎任务 + 1 欢迎笔记 → 无任何 seed（`ensure_defaults` 已补） | P `zhixing/core/context.py:71-100`、`zhixing/model/application/settings.py:77-95` / E grep `seed`/`welcome` 0；`src/main/index.ts:412-416` |
| D25 | 未实现 | `import_markdown_folder` → 只有 markdown 导出 | P `zhixing/model/infrastructure/exporter.py:221-239`、`zhixing/view/pages/settings_page.py:566-571` / E `src/main/db/export.ts:82-142` |
| D26 | 行为不同 | 导出 ZIP；同名去重 → 选目录直写，同名覆盖 | P `zhixing/view/pages/settings_page.py:541-547`、`zhixing/model/infrastructure/exporter.py:50-60`、`:94-103` / E `src/main/db/export.ts:129-142` |
| D27 | 行为不同 | `csv.writer` 默认 `\r\n`、末行也有换行 → 以 `'\n'` join、无结尾换行 | P `zhixing/model/infrastructure/exporter.py:110-124` / E `src/main/db/export.ts:58-79` |
| D28 | 行为不同 | 导入提示「任务 N · 笔记 M」 → 提示「已导入 N 条记录」 | P `zhixing/model/infrastructure/exporter.py:219`、`zhixing/view/pages/settings_page.py:424` / E `src/main/db/export.ts:222` |

### 2.7 打包与发布（原 152 条未覆盖，新增域）

| 编号 | 类型 | 差异（Python → Electron） | 证据（P / E） |
| --- | --- | --- | --- |
| P1 | 行为不同 | PyInstaller COLLECT 出 `ZhiXing/` 目录，整目录分发 → electron-builder 出 NSIS 安装包 + portable 单文件 | P `build_windows.bat:14-20`、`zhixing.spec:72-80` / E `electron-builder.yml:29-53`、`package.json:13-14` |
| P2 | 行为不同 | Qt/Python 依赖由 PyInstaller 收集，无 ABI 重建步骤 → `better-sqlite3` 需 electron-rebuild，dist 后必须 `postdist` 还原本机 ABI | P 无对应步骤 / E `package.json:12`、`:15-16`、`electron-builder.yml:24-27` |
| P3 | 行为不同 | jieba 字典由 PyInstaller `collect_data_files` 收 → `@node-rs/jieba` 各平台 binding 需 `ensure-jieba-win-binding` 补齐，否则 Windows 启动崩 | P `zhixing.spec:24-25` / E `scripts/ensure-jieba-win-binding.mjs`、`docs/windows-build.md:50-74` |
| P4 | 已具备 | Python 侧无版本上传脚本 → `upload-release.mjs` 上传 Gitee Release（默认预演，支持 `GITEE_TOKEN`） | P — / E `scripts/upload-release.mjs:1-119`、`docs/windows-build.md:99-112` |
| P5 | 同为缺口（已具备说明） | 未配置代码签名 → 未配置代码签名（SmartScreen 提示未知发布者） | P `zhixing.spec:67` / E `docs/windows-build.md:94-98` |
| P6 | 同为缺口（已具备说明） | 无自动更新 → 未接入 `electron-updater` | P — / E `docs/windows-build.md:98` |
| P7 | 有意简化 | `zhixing.spec` 声明跨平台通用 → 仅配置 Windows 目标（macOS 需 `.icns` + 公证） | P `zhixing.spec:2` / E `electron-builder.yml:29-44`、`docs/windows-build.md:97` |

### 2.8 渲染与交互（原 152 条未覆盖，新增域）

| 编号 | 类型 | 差异（Python → Electron） | 证据（P / E） |
| --- | --- | --- | --- |
| R1 | 行为不同 | 图谱页内联 `wheelEvent` 缩放（`_zoom` 0.15–4.0），工作流页无缩放 → 两页共用 `lib/panzoom.ts` + `usePanZoom.ts`（以光标为中心缩放，7 项单测），两页都有重置视图 | P `zhixing/view/pages/graph_page.py:497`、`:665-670` / E `src/renderer/src/lib/panzoom.ts`、`src/renderer/src/lib/usePanZoom.ts`、`src/renderer/src/pages/GraphPage.tsx:441`、`:480`、`src/renderer/src/pages/WorkflowPage.tsx:203-208`、`:391` |
| R2 | 行为不同 | 连线为直连（QGraphicsItem 体系内联实现） → 三次贝塞尔（弧高 12% 封顶 18px）+ marker 箭头 + `trimEnd` 端点收边，纯函数 + 8 项单测 | P 无 edge-path 等价模块（`zhixing/view/pages/graph_page.py`） / E `src/renderer/src/lib/edge-path.ts`、`src/renderer/src/lib/edge-path.test.ts`、`src/renderer/src/pages/GraphPage.tsx:499-547` |
| R3 | 已具备 | QTreeView 原生虚拟化 → 自研 `VirtualList` 做 DOM 窗口化；`vlistcheck` 断言 400 条任务下 DOM 行数远小于数据行数 | P `zhixing/view/pages/task_page.py:49`、`:200` / E `src/renderer/src/components/VirtualList.tsx`、`src/renderer/src/pages/TasksPage.tsx:624-633`、`scripts/vlistcheck.mjs` |
| R4 | 已具备 | `theme.py` 运行时对比度校正（fg2 ≥ 4.5、fg3 ≥ 4.0） → `color.ts ensureTextContrast`（4.5/4.0，保留色相）+ `accent-text` 派生；168 组守门数据 | P `qfluent_core/theme.py`、`docs/ui_polish_v014_audit.md` / E `src/shared/color.ts`、`src/renderer/src/theme.ts:49-68`、`src/shared/color.test.ts` |
| R5 | 有意简化 | qfluentwidgets + QSS 组件库 → 纯 CSS 语义 token（11 文件）+ 无 UI 框架，禁止组件内写死色值 | P `qfluent_core/*`、`zhixing/view/pages/settings_page.py:305-313` / E `src/renderer/src/styles/tokens.css` 等 11 文件 |
| R6 | 行为不同 | z-index 由 Qt 栈序管理；无统一按压/禁用态 → 单一 `--z-*` 尺度 + 全局 `:active` 位移反馈 + `:disabled`/`aria-disabled` 统一 | P — / E `src/renderer/src/styles/tokens.css`（`--z-*`）、`src/renderer/src/styles/global.css:33-45` |
| R7 | 行为不同 | 无内嵌 Office 渲染时以系统应用打开 → `mammoth`/`xlsx` 内嵌只读预览 + 主进程正则白名单清洗 HTML | P `zhixing/view/components/note_previews.py:609-716` / E `src/main/db/preview.ts:26-76`、`src/renderer/src/pages/NotesPage.tsx:425-471` |

---

### 2.9 按 §1 判决补录：未进入 §2 分域表的 11 条（笔记域）

编号采用 `N-§1.3#<原 audit 笔记域条目号>`，判决列取自同一报告的复核结论。

| 编号 | 类型 | 差异（Python → Electron） | 证据（P / E） |
| --- | --- | --- | --- |
| N-§1.3#4 | 仍成立 | 富文本正文有独立编辑器、工具栏/插图/附件 → `richtext` 与 `markdown` 一起落到 `MarkdownEditor` 分支；该组件无富文本工具栏/插图/附件 | P `zhixing/view/components/markdown_editor.py` / E `src/renderer/src/pages/NotesPage.tsx:425`、`:482`、`src/renderer/src/components/MarkdownEditor.tsx` |
| N-§1.3#5 | 仍成立 | Word/Excel 预览之外可编辑写回 → 只读预览 + `openNoteFile`，不可编辑写回 | P `zhixing/view/components/note_previews.py:609-716` / E `src/renderer/src/pages/NotesPage.tsx:425-471`、`src/main/db/preview.ts:35-76`、`src/main/db/export.ts:249-260` |
| N-§1.3#7 | 仍成立 | 有「添加引用链接」能力 → 无 `db:addReferenceLink`，`notes.ts` 中无 `addReferenceLink`（grep 0） | P `zhixing/model/application/note_service.py`（引用链接相关方法） / E grep `addReferenceLink` 0 |
| N-§1.3#8 | 部分修复 | 笔记页可把笔记归属到任务 → 任务侧链路齐备（挂载/解除/查询 + 图谱调用），残留：**笔记页无「归属任务」入口** | P `zhixing/view/pages/note_page.py:1118` / E `src/main/db/tasks.ts:86-97`、`src/main/db/index.ts:226-231`、`src/renderer/src/pages/GraphPage.tsx:274` |
| N-§1.3#9 | 仍成立 | 笔记可在文件夹间移动 → `saveNote` 支持 `folder_id`，但渲染层只有图谱连线会传；笔记树无移动操作 | P `zhixing/view/pages/note_page.py`（移动入口） / E `src/main/db/notes.ts:93-96`、`src/renderer/src/pages/GraphPage.tsx:278` |
| N-§1.3#10 | 仍成立 | 编辑器右键菜单 + 选文转任务（段落锚） → `MarkdownEditor` 无自定义右键菜单；`App.tsx` 不消费深链 `link.block`；`graph.ts` 保留 anchor 判定但**从不生成 anchor 节点** | P `zhixing/view/components/markdown_editor.py`、`zhixing/controller/app_controller.py:678-697` / E `src/renderer/src/components/MarkdownEditor.tsx`、`src/renderer/src/App.tsx:189-200`、`src/main/db/graph.ts:25-31` |
| N-§1.3#11 | 仍成立 | `appendNote`（追加结论）与「复盘：X」入口 → 均无 | P `zhixing/model/application/note_service.py:695` / E grep `appendNote` 0 |
| N-§1.3#12 | 仍成立 | 笔记文件夹可删除/移动，且有操作菜单 → 只有 `createNoteFolder`/`renameNoteFolder`；`notes.ts` 无 delete/move；`NoteTree` 无文件夹操作菜单，且 `renameNoteFolder` 渲染层零调用 | P `zhixing/model/application/note_service.py`（文件夹增删改） / E `src/main/db/index.ts:403-406`、`src/renderer/src/components/NoteTree.tsx` |
| N-§1.3#13 | 仍成立 | `ensure_default_folder` 保证有默认目录 → 无该逻辑；`NoteTree` 只渲染已有 folders | P `zhixing/model/application/note_service.py`（默认文件夹） / E `src/renderer/src/components/NoteTree.tsx:132`、`:172-173` |
| N-§1.3#14 | 仍成立 | 失效链接含「有目标但目标被删」等更多形态 → `brokenLinks` 只筛 `dst_note_id IS NULL` | P `zhixing/model/application/note_service.py`（失效链接查询） / E `src/main/db/notes.ts:334-343` |
| N-§1.3#15 | 仍成立（有意） | 自链接的处理方式 → `resolved === noteId ? null : resolved`（自链接解析为空） | P `zhixing/model/application/note_service.py` / E `src/main/db/notes.ts:59-60` |
## 3. Electron 独有能力（Python 侧没有，或形态不同）

| # | 能力 | 说明 | Python 侧对应 | 证据 |
| --- | --- | --- | --- | --- |
| E1 | CSP + sandbox 安全模型 | `renderer/index.html` 声明 meta CSP（`default-src 'self'`；`connect-src` 含 `ws:`/`localhost` 供 HMR）；两个窗口都 `sandbox:true` + `contextIsolation` + `nodeIntegration:false` | 无对应层（在 Python 侧 grep CSP/Content-Security/sandbox 均 0 命中） | `src/renderer/index.html:6-9`、`src/main/index.ts:332-337`、`:104-109` |
| E2 | 导航/弹窗/webview 三道出口收口 | `will-navigate` 只放行应用自身入口、`setWindowOpenHandler` 一律 deny、`will-attach-webview` 直接 `preventDefault`；`openExternalSafely` 只放行 `http/https/mailto`，其余写日志拦下 | 无（Qt 无明显同等威胁面，也无此校验） | `src/main/security.ts:17-64` |
| E3 | CDP 驱动的真实 Electron 端到端验证体系 | 27 个 `.mjs` 脚本用 `--remote-debugging-port` + WebSocket 驱动真实窗口，多数在副本库上跑；Electron 侧独有测试资产 | 无同类脚本 | `scripts/*.mjs`（见 §4） |
| E4 | 原生 binding 跨平台补齐 + 缺失降级 | `ensure-jieba-win-binding.mjs` 按 `@node-rs/jieba` 自声明版本补 win32-x64 binding；`fts-query.ts` 用 `require` + try/catch 使缺 binding 时降级逐字分词而不崩；`check-jieba-fallback.mjs` 断言「构建产物顶层不得出现该 require」 | PyInstaller `collect_data_files('jieba')` 一次性打包纯 Python 依赖，无 ABI/平台 binding 问题 | `scripts/ensure-jieba-win-binding.mjs`、`scripts/check-jieba-fallback.mjs`、`src/main/db/fts-query.ts:21-28` |
| E5 | 从 Python 反向导出权威 DDL | 生成器用 SQLAlchemy 从 Python 模型导出建表 DDL + FTS DDL，生成为 `src/main/db/schema.ts`，保证两版 schema 逐字一致 | 无（Python 侧是权威源，不需要反向工具） | `scripts/export-schema.py:1-87`、`src/main/db/schema.ts:1-10` |
| E6 | 跨实现中文分词一致性守卫 | `fts-query.test.ts` 固化 `cut_for_search` 与 Python 逐字一致的基准；`fts.ts` 写入时即分词，避免两套索引互相漏检 | 无（Python 侧无对端可比） | `src/main/db/fts-query.test.ts`、`src/main/db/fts.ts:33-47` |
| E7 | 自研 DOM 虚拟滚动 | `VirtualList` 按 `count × rowHeight` 绝对定位，任务页 400 条下只渲染可视行 | 用 QTreeView 原生虚拟化（同为虚拟，实现层不同） | `src/renderer/src/components/VirtualList.tsx`、`TasksPage.tsx:624-633`、`scripts/vlistcheck.mjs` |
| E8 | 共享画布 pan/zoom + 连线几何纯函数 | `lib/panzoom.ts`（`fitView`/`zoomAt`/`panBy`/`wheelFactor`）+ `usePanZoom.ts` 被图谱与工作流共用；`lib/edge-path.ts`（贝塞尔/`edgeMidpoint`/`trimEnd`）配 8 项单测 | 在 `graph_page.py` 内联 `wheelEvent` 缩放，工作流页无缩放，无独立几何模块与单测 | `src/renderer/src/lib/panzoom.ts`、`usePanZoom.ts`、`edge-path.ts`、`GraphPage.tsx:441`、`WorkflowPage.tsx:203-208` |
| E9 | 覆盖式导入安全链 | `importFromJsonFile`：校验 app 外壳 → `VACUUM INTO backups/before-import` → 单事务整库替换 → settings 逐键 upsert 跳过 `schema_version` → 孤儿清理；渲染层二次确认 | Python importer 也覆盖式导入，但备份走 BackupService 且无 before-import 子目录/孤儿清理 | `src/main/db/export.ts:151-229`、`src/renderer/src/pages/SettingsPage.tsx:427-443` |
| E10 | electron-builder 安装包分发 | NSIS（可选安装目录 + 桌面/开始菜单快捷方式）+ portable 单文件；`asarUnpack` 原生模块；`postdist` 自动还原本机 ABI | PyInstaller COLLECT 目录分发，无安装器 | `electron-builder.yml:1-56`、`package.json:12-16` |
| E11 | Gitee Release 上传脚本 | `upload-release.mjs` 默认预演，`--upload` 才动远端，token 三级回退 | 无 | `scripts/upload-release.mjs:1-119` |
| E12 | Electron 平台层加固 | 单实例锁 + 二次启动/open-url 深链、禁用视觉缩放并启动归零、菜单不挂 View（避免误触缩放） | Qt 侧无此 profile 级缩放状态问题 | `src/main/index.ts:306-319`、`:363-365`、`:388-404` |
| E13 | i18n 骨架 | `i18n/index.ts` + `i18n/zh.ts` + `i18n.test.ts`，8 个页面标题/副标题走 i18n | Python 硬编码中文 | `src/renderer/src/i18n/index.ts`、`src/renderer/src/i18n/zh.ts`、`src/renderer/src/App.tsx:355`、`src/renderer/src/pages/TasksPage.tsx:494-495` |
| E14 | 文件日志 hook console | `main/log.ts` 覆盖 `console.error/warn` 写 `logs/zhixing.log`（1MB × 3 滚动），无需逐点替换 | 用 loguru（能力等价，实现不同） | `src/main/log.ts:38-63` |
| E15 | 对比度实测工具 | `contrast-audit.mjs` 用 WCAG 2.1 相对亮度对 14 主题包 × 双模式逐组实测并列出未达标项 | Python 无独立实测脚本（`theme.py` 有运行时校正） | `scripts/contrast-audit.mjs` |

---

## 4. 验证资产差异

| 项目 | Python 侧 | Electron 侧 |
| --- | --- | --- |
| 单元测试 | 未见等价 vitest/pytest 资产记录（**未取证**） | 14 个 vitest 文件 / 86 个用例，只覆盖纯函数（`vitest.config.ts:11-19`） |
| 端到端检查 | 无同类脚本（**未取证**） | `scripts/` 顶层 28 个文件：27 个 `.mjs` + `export-schema.py`（另有 `fixtures/gen-office-fixtures.py`） |
| 方法论 | — | 拷贝备份库到临时 `ZHIXING_HOME` → 启动真实 Electron + CDP → 经 IPC 操作 → `sqlite3` CLI 校验落库 |
| 分发 | `build_windows.bat` + `zhixing.spec`（PyInstaller COLLECT 目录） | `electron-builder` NSIS + portable + Gitee 上传脚本 |

> **盘点表勘误（本轮实测）**：`electron-diff.md` §4 的「28 个文件」盘点表收录 26 个 `.mjs` + 2 个 `.py`，**漏列 `upload-release.mjs`**；该脚本在 §3/E11、P4 中有记录。断言点数字按 `check`/`ok` 调用点正则统计，本文沿用该口径。

---

## 5. 完成度评估

口径：以「Python 侧该域的功能面」为 100%，按**主链是否可用 / 写路径是否接通 / UI 是否有入口 / 护栏是否存在**四项加权；不是简单按条数比例。

| 域 | 完成度 | 扣分要点 |
| --- | ---: | --- |
| 任务 | ~78% | 清单「移动到清单」无 UI（T1）、段落上下文整块缺失（T3）、`resume_at` 不可写（T4）、子任务 list 继承与收件箱口径（T6）、日历口径与 `calendar_show_done` 失效（T11）、500 上限（T15）、捕获目标选择器（T17） |
| 笔记 | ~65% | 富文本无编辑器（N4）、Word/Excel 只读（N5）、附件与改格式（N3）、笔记↔任务/文件夹关联无 UI（N8/N9）、段落锚与选文转任务（N10）、复盘回写（N11）、文件夹删/移（N12）、默认文件夹（N13）、MD 导入与导出重名（N20/N21） |
| 图谱 / 搜索 / 回顾 | ~58% | 回顾 ~85%；图谱破环未接线、引用边/anchor 不入图、无 delta、未订阅 flash、无过滤/搜索/预览（G2–G10）；全局搜索缺 MRU 与命令注入（G13） |
| 收件箱 / 工作流 / 捕获 | ~65% | `source_url` 无 UI（I1/I2）、转子任务/指定目录无 UI（I6/I7）、删闪念无撤销（I8）、任务侧工作流入口（I12）、模板复制/重命名/删步/排序/SOP 绑定/策略切换（I14–I20）、命令拆分与完成口径（I21–I28）、捕获五去向与 TargetSelector（I29/I30）、划词降级（I31/I32） |
| 设置 / 平台 / 窗口 | ~68% | mica/浮窗等开关无 UI（S3/S5/S8）、字号行高偏移与滑杆区间（S6/S7）、motion 取值集合（S10）、select_quick 降级（S13）、浮窗启动可见性（S16）、边缘缩放（S17）、托盘图标/动作集（S23/S25）、热键状态（S20）、深链粒度（S22）、FloatingDock/splash（S27/S29）、最小窗口尺寸（S30） |
| 数据 / 统计 / 维护 | ~78% | 只读模式/横幅（D2）、before-import 未 prune（D4）、导入非导出表残留（D6）、域广播不完整（D14）、提醒多条并发（D17）、番茄 reason/休息记账/全局入口（D18/D20/D21）、种子数据（D24）、MD 导入（D25）、导出重名与 CSV 换行（D26/D27）、清理边界（D12） |
| 打包与发布 | ~70% | 无代码签名、无自动更新、仅 Windows 目标（与 Python 侧同等或更完整） |
| 渲染与交互 | ~80% | 虚拟滚动、共享 pan/zoom、贝塞尔连线与箭头、对比度运行时校正、z-index/控件状态收敛、i18n 骨架均已具备并有脚本/单测守护；工作流页节点详情浮卡与分支连线编辑为额外增强 |
| **综合（按域功能面加权）** | **~70%** | 主要缺口集中在三处结构性断链（见下） |

### 5.1 三处结构性断链

1. **任务↔笔记的段落级上下文（T3 / N10 / N11）**——表在、任务侧入口在，但读写与 UI 全缺。
2. **笔记格式体系（N4 / N5 / N3）**——`richtext` 无编辑器、Office 只读、附件缺失。
3. **图谱语义完整性（G2 / G3 / G4）**——破环函数写了没接线，`task_note_ref` 与 anchor 不进图。

### 5.2 结构性模式（沿用原审计的分类）

**A** 表建了业务代码零行（`task_note_context`、`attachment` 等） / **B** 功能整体缺失 / **C** 后端有实现但渲染层零调用 / **D** 语义口径不同 / **E** 护栏缺失。

---

## 6. 文档漂移与更正

### 6.1 `parity-audit.md` 与 `audit/` 的正确用法

- `docs/parity-audit.md` 的**批次 0–4 记录**（第 20–516 行）仍是有效的修复历史；其**总览表与分域完成度**是审计当时快照，已被本轮复核取代。
- `docs/audit/` 六份明细表**未回填**：其中 69 条（已修复 42 + 部分修复 27）描述的 Electron 侧结论已与代码不符，另有约 30 条行号漂移但结论不变。**任何引用旧明细表的行为都应先对照 `electron-diff.md` 第 1 节判决列。**
- 建议的修法（低成本）：直接以 `electron-diff.md` 第 1 节的判决替换六份明细表的「结论列」，并在表头注明复核日期。

### 6.2 `README.md` 三处过时（差异审计 §0 前置发现）

| 位置 | README 声称 | 代码事实 |
| --- | --- | --- |
| `README.md:24` | 「当前以只读方式打开（`readonly: true`）」 | `src/main/db/connection.ts:137-152` 是**读写**打开（`new Database(p)` 无 `readonly`） |
| `README.md:52-53` | 任务页/笔记页/图谱/收件箱/工作流/回顾/设置列为「待迁移」 | 8 页均已实现（`src/renderer/src/App.tsx:369-400`） |
| `README.md:13` | 「schema v12 零迁移」 | 与 `connection.ts:83-111` + `src/main/db/migrate.ts`（v1–v12 迁移链）矛盾 |

### 6.3 `optimization-proposals.md` 已闭合

O1–O11 全部标为「已完成」，本轮核对与代码一致（O1 `shared/settings.ts`、O2 `main/db` 拆分、O3 `shared/events.ts`、O4 `VirtualList`、O5 `POS_CACHE`、O6 `electron-builder.yml`、O7 vitest、O8 `theme-packs.ts`、O9 CodeMirror、O10 i18n、O11 mammoth/xlsx）。**该文档不再承载差异**。

### 6.4 本文与原 152 条的关系

原 152 条中的 **42 条已修复**不再逐条列出（其内容已并入 §2 的「已具备」或不再需要行动）；§2 收录的是仍需行动的 **110 条 + 新增域 14 条 = 124 条**。

---

## 7. 后续行动清单

### 7.1 接线即可闭合（后端均已在，只差 UI / preload 参数）

| # | 项 | 需要做的 | 证据 |
| --- | --- | --- | --- |
| 1 | T1 移动到清单 | 在任务弹窗/右键菜单加「移动到清单」并调用 `moveTaskToList` | `src/preload/index.ts:91`（零调用） |
| 2 | I6 闪念转「子任务」 | 收件箱加「转子任务」入口（可选父任务） | `src/preload/index.ts:48`（零调用） |
| 3 | I7 转笔记指定目录 | 收件箱传递 `folderId` | `src/renderer/src/pages/InboxPage.tsx:86` |
| 4 | N3 改笔记格式 | preload `saveNote` 类型加 `format` + 界面入口 | `src/preload/index.ts:200-203` |
| 5 | D18 番茄中断原因 | `recordPomodoro` 补第 4 参 `reason` + 结束原因选择 | `src/preload/index.ts:221-222`、`src/renderer/src/components/PomodoroBar.tsx:108-112` |
| 6 | G2 破环接线 | 把 `wouldCreateCycle` 接进 `buildGraph` 并输出 `cycleEdges` | `src/main/db/graph.ts:261-273`（零调用） |
| 7 | I1/I2 `source_url` | 两处 `addFlash` 传 `source_url`（能取到就传） | `InboxPage.tsx:74`、`CapturePanel.tsx:68` |

### 7.2 描述性修复（无需改逻辑）

1. 修 `README.md` 的只读/待迁移/零迁移三处过时描述（§6.2）。
2. 回填 `docs/audit/` 六份明细表的结论列（§6.1）。
3. 在 `electron-diff.md` §4 盘点表补上 `upload-release.mjs`（§4 勘误）。

### 7.3 需要产品决策（不宜由实现侧单方面改）

| 项 | 决策点 |
| --- | --- |
| T11 日历口径 | 是否改为「逐日展开 start+due、无日期归今日、排序、`calendar_show_done` 生效」 |
| T6 子任务 list 继承 | 子任务是否继承父任务清单、收件箱是否排除子任务 |
| G14 / G15 完成统计过滤 | 闪念计数是否含 archived；完成统计是否放宽过滤 |
| T12 改挂排序语义 | reparent 是否保留原 `sort_key` 且放弃环校验 |
| S22 深链粒度 | 是否按 id/block 精确定位（需要新窗口级路由） |
| S6 / S7 主题/字号映射 | 是否取消 `+1.5px` / `+10px` 偏移并对齐滑杆区间 |
| D2 只读模式 | 是否补只读分支 + 横幅（当前只给中文报错与恢复入口） |
| D24 种子数据 | 全新库是否要欢迎内容 |

---

## 8. 一页速查

| 问题 | 答案 |
| --- | --- |
| 现在还有多少差异？ | 110 条未对齐（仍成立 83 + 部分修复 27），加新增域 14 条，共 124 条 |
| 有多少旧结论已失效？ | 69 条（已修复 42 + 部分修复 27） |
| 完成度多少？ | 综合 ~70%（任务 78 / 笔记 65 / 图谱搜索回顾 58 / 收件箱工作流捕获 65 / 设置平台窗口 68 / 数据维护 78 / 打包 70 / 渲染 80） |
| 最该先做什么？ | §7.1 的 7 项「接线即闭合」，其次是 §7.2 的文档回填 |
| 事实源以谁为准？ | 代码 > `.aoci/.draft/audit/electron-diff.md` > 本文；`docs/parity-audit.md` 总览与 `docs/audit/*` 明细表不作为事实源 |

