# 图谱/搜索/回顾 差异清单
> 基准：Python zhixing/ ｜ 目标：electron/src/ ｜ 证据均为 file:line

> **复核状态（本表已于 2026-09-19 按 electron-diff.md §1 回填）**：本表原结论为审计当时快照；「结论」列已按当前代码重新判决。仍以代码为准。
> **本表 15 条**：仍成立 11 · 部分修复 3 · 已修复 1；行号与 electron-diff.md §1.4（图谱/搜索/回顾）逐条对应。
> **计数口径提示**：electron-diff.md §1.1 汇总表对本域记「仍成立 12 / 部分修复 2 / 已修复 1」，与 §1.4 逐条判决（11 / 3 / 1）不一致；本表以逐条判决为准。

| # | 差异 | Python 行为（证据） | Electron 现状（证据） | 影响 | 结论 |
|---|---|---|---|---|---|
| 1 | 图谱拖拽建链 / 删边 / 改挂全链路缺失 | `commit_connection` 按矩阵裁决+环路校验+写底层：graph_page.py:1430-1479；服务层 `connection_allowed` graph_service.py:386、`resolve_edge_kind` :400、`would_create_cycle` :451、`link_notes` :558、`attach_task_note` :605、`link_task_note_ref` :621、`unlink_task_note_ref` :639、`detach_task_note` :659、`reparent_task` :679；删边/改挂 graph_page.py:1514-1590 | 全仓仅 `classifyEdge`（graph.ts:22）用于上色；grep `connectionAllowed/resolveEdgeKind/wouldCreateCycle/linkNote/attachTaskNote/linkTaskNoteRef` 无命中；preload/index.ts:22-213 无对应方法；GraphPage.tsx 无任何连线交互 | 图谱退化为只读视图，手动建链/断开/改挂不可用 | 已修复 |
| 2 | 归属 DAG 破环缺失 | `_acyclic_ownership_edges` graph_service.py:57-83，`_finalize_edges` 丢弃回边并写 `cycle_edges` :269-284；提示 graph_page.py:1197-1206 | graph.ts:190-195 只对边分类，无环检测与丢弃；`GraphPayload`（types.ts:132）无 cycleEdges 字段 | folder/task 脏环数据在 Electron 会画成环且无提示 | 部分修复 |
| 3 | 任务→笔记「引用」边（task_note_ref）未入图 | 查 ref_pairs 并以 reference 类覆盖同对归属边：graph_service.py:302-303、:332-337 | 仅查 `task_note_link`：graph.ts:180-187；grep `task_note_ref` 仅命中 schema.ts:174/180 与 trash.ts 删行，主进程无读取 | 丢失“引用”语义，任务↔笔记只剩实线归属 | 仍成立 |
| 4 | 段落锚（anchor）节点全缺 | `_attach_task_nodes` 用 task_note_context 造 anchor 节点 + note→anchor/task→anchor 引用边：graph_service.py:33-34、:344-368 | `GraphKind` 仅 5 类无 anchor（types.ts:119）；grep `task_note_context` 无业务读取（schema.ts:152 建表、trash.ts 删行） | 任务引用笔记段落在图谱不可见/不可跳转 | 仍成立 |
| 5 | 增量刷新（GraphDelta）缺失 | `diff`+5 个 `apply_*`+`_sync`+`subscribe`：graph_service.py:469-555；消费端 `apply_delta` 保留布局/pinned、按节点与边定点增删：graph_page.py:1075-1166；装配 app_controller.py:203-205、1168-1174 | 无 delta 通道；GraphPage.tsx:80-89 每次写操作整表重查重建（仅 POS_CACHE 复用坐标） | 大图每次笔记/任务写入全量重建，性能与位置稳定性下降 | 仍成立 |
| 6 | 图谱未订阅 flash（闪念）域 | 总线订阅含 `flash_changed`：graph_service.py:530、`_on_flash_changed` :544；注释 app_controller.py:1166 | GraphPage.tsx:89 仅 `subscribeDomain(['note','task'])`；写操作已广播 `'db:addFlash': 'flash'`（db/index.ts:69-73） | 增删闪念后图谱节点不更新，直到下次笔记/任务变更 | 仍成立 |
| 7 | 图谱过滤、节点搜索、默认任务节点 | 文件夹/标签下拉 + 搜索框：graph_page.py:882-896；build 传 folder_id/tag_id :1015-1027；默认恒 `include_tasks=True` :1026-1028；Ctrl+F→`_focus_node_search` :1318-1342，快捷键 main_window.py:229-230 | 仅 scope + 任务开关（默认 false）：GraphPage.tsx:70-71、:259-269；IPC `db:graph` 只接 includeTasks（db/index.ts:240）；无 Ctrl+F（App.tsx:219-233 只绑 Ctrl+K） | 不能按文件夹/标签聚焦，图内搜索缺失，默认看不到任务节点 | 仍成立 |
| 8 | 邻域子图语义不同 | `neighborhood` 仅沿 note_link 做 1~2 度 BFS（不含 folder/flash/task），再补挂悬空节点：graph_service.py:711-745 | GraphPage.tsx:92-122 在前端对已加载 payload 的**全类型边**做 BFS，结果随 includeTasks/文件夹节点变化 | “1/2 度邻域”与基准不可比 | 仍成立 |
| 9 | 节点预览（选中面板）缺失 | `preview_text` 按类型输出摘要/状态/优先级/截止/父任务/关联笔记/来源：graph_service.py:748-785、:787/:808/:854/:879 | GraphPage.tsx:350-380 仅 kind/degree/format | 侧栏信息量大幅缩水 | 仍成立 |
| 10 | 双击跳转覆盖不全 | note/flash/task/folder/anchor/dangling 六类分派：graph_page.py:265-280；侧栏按钮 `_open_selected` :1696-1713 | 仅 note→打开、dangling→新建，其余弹提示：GraphPage.tsx:245-251、:366-378 | 双击闪念/任务/文件夹无导航 | 部分修复 |
| 11 | 悬空新建的绑定时机不同 | `note_service.create` → `_pipeline` 只重算**新笔记自身**出链（note_service.py:81-97、:718-730），未按标题回填他处悬空 dst_note_id | App.tsx:190-196 新建后显式 `bindDanglingByTitle`（notes.ts:184-192：`UPDATE note_link SET dst_note_id=? WHERE dst_title=? AND dst_note_id IS NULL`） | 语义不一致（Electron 更完整）：Python 需源笔记重存悬空才转正 | 仍成立 |
| 12 | 闪念节点标签截断规则不同 | `_flash_label` 取正文首行、截 40 字：graph_service.py:913-916 | graph.ts:144-147 折叠全部空白后截 16 字加省略号 | 节点标题文本不一致（多行闪念差异明显） | 仍成立 |
| 13 | 全局搜索 SearchService 整体缺失（语法/数据源/MRU/命令） | `global_search` search_service.py:71-211：前缀 task:/note:/flash:/tag: :101-114；过滤 due:/status:/priority:/folder:（正则 :16-23、判定 :147-168）；FTS 上限 task20/note8/flash6 + 标签全量 :188-207；命令注入 app_controller.py:77-85、主题前缀 command_palette.py:131-139；空查询只返回命令 :136-145；MRU `touch`/`_apply_mru` :214-232，落点 app_controller.py:770-776 | 未找到对应实现：无 search IPC（preload/index.ts、db/index.ts 全文无）；CommandPalette.tsx:38-75 自实现——仅导航页 + 笔记**标题子串** + 快速建任务，单列表 20 条；空查询列导航页+前 13 篇笔记；schema.ts:35/77/151 建了 flash_fts/note_fts/task_fts 但主进程从不查询 | 搜索退化到最简子串匹配：任务/闪念/标签搜不到、过滤语法全无、无最近访问优先 | 部分修复 |
| 14 | 回顾“闪念”统计口径不同 | `today_counts()["flash"] = len(self.flashes.list(s))`，status=None → **全部未删除闪念（含 archived）**：review_service.py:35、repositories.py:585-589；卡片“闪念收件箱” today_page.py:90 | review.ts:43-47 只数 `status='inbox'`；ReviewPage.tsx:21 标签“待整理闪念” | 同一字段两版数值不同（有归档闪念时必现） | 仍成立 |
| 15 | 回顾完成数/热力图/连续天数的过滤与判定不同 | `completed_between` 无 deleted_at、无 status 过滤（repositories.py:199-202），week_stats/heatmap/streak 直接使用：review_service.py:41-51、:80-102、:104-120；只有 today_counts 用 roll-up :22-33 | 任务查询限定 `deleted_at IS NULL`（review.ts:28），周趋势/热力/连续天数额外要求 effective done（review.ts:36-38、:69-74、:99-101、:115-127） | 软删任务的完成记录 Python 计、Electron 不计，跨版本统计不可比 | 仍成立 |

**该域整体完成度评估**：三个子域差异极大——回顾统计约 85%（结构与算法基本对齐，仅过滤口径与闪念统计有偏差），图谱约 30%（只剩“读+画”，建链/删边/改挂、破环、过滤、增量刷新、预览、多数双击跳转全缺），全局搜索约 10%（无 SearchService、无任何搜索 IPC，仅命令面板的笔记标题子串）。

**风险最高的 3 条**：
1. 图谱写入链路整体缺失（#1/#2/#3/#4）：`connection_allowed`/`resolve_edge_kind`/`would_create_cycle`/`link_notes`/`attach_task_note`/`link_task_note_ref` 全无对应实现，图谱从“可编辑知识网络”退化为只读展示。
2. 全局搜索整体缺失（#13）：三张 FTS 表已建但不查询，任务/闪念/标签与 due:/status:/priority:/folder: 语法完全不可用。
3. 增量刷新与事件订阅缺口（#5/#6）：图谱未订阅 flash 域导致闪念变更后数据陈旧，同时所有写操作触发全量重建，大图性能与布局稳定性受损。
