# 任务域 差异清单
> 基准：Python zhixing/ ｜ 目标：electron/src/ ｜ 证据均为 file:line

| # | 差异 | Python 行为（证据） | Electron 现状（证据） | 影响 |
|---|---|---|---|---|
| 1 | 列表/分组（清单）体系整体缺失 | `folder_tree` task_service.py:677、`create_folder`:684、`rename_folder`:696、`delete_folder`:708、`default_list_id`:717-727、`list_tree(list_id)`:373-403、`move_to_list`:250-252；种子分组/清单 core/context.py:82-84；消费方 inbox_page.py:176、target_selector.py:76 | 未找到对应实现（无 IPC/preload/渲染入口，任务页无清单侧栏）；`list_folder` 仅被 quickAdd 隐式写入 task-ops.ts:170-184，表定义 schema.ts:43 | 任务无法分组/按清单浏览与移动；两版列表数据模型实际不可互操作 |
| 2 | 任务↔笔记「归属」关系无写入路径 | `update(notes_md)`→`_sync_wiki_links` task_service.py:169-176（create/update 均调用，:45-46/:106-107）、`link_wiki_notes`:178-193、`attach_note`/`detach_note`:575-591、`linked_notes`:568-573；仓储 repositories.py:214-227 | 未找到对应实现：`task_note_link` 只被读（tasks.ts:63-68 计数、graph.ts:181 取边）和删除（trash.ts:50），全仓无 INSERT；`task_note_ref` 同样无写入（schema.ts:174） | 编辑器承诺的 `[[笔记标题]]`（TaskEditor.tsx:140）永不落链，行内 ⇄N（TaskRow.tsx:169）恒为 0，图谱缺任务-笔记边 |
| 3 | 任务↔笔记「段落级上下文」整块缺失 | `attach_block`/`detach_block`/`linked_contexts`/`contexts_for_note`/`note_context_map` task_service.py:594-640；反向沉淀 note_service.py:695、完成任务回写 app_controller.py:678-697 | 未找到对应实现；`task_note_context` 仅在建表 schema.ts:152 与删除 trash.ts:51,64 出现 | 「完成任务 → 在关联笔记段落追加结论」闭环完全不存在 |
| 4 | `resume_at` 不可写，「等待中到期恢复」是死代码 | `pause(task,resume_at)`/`resume` task_service.py:643-649；编辑器「恢复于」task_editor.py:158-173 与提交 411-434；`resume_due_today` :651-664 由 controller 调用 app_controller.py:1260,1365 | `setStatus` 只能置 waiting（tasks.ts:209-225）；`EDITABLE_FIELDS` 无 `resume_at`（tasks.ts:260-270）；唯一写处是清零 maintenance.ts:59-65；App.tsx:119-131 调用该恢复；TasksPage.tsx:592-596 只显示 | 任务一旦「等待中」只能手动改回，自动恢复永不触发；恢复时长恒为空 |
| 5 | 编辑面板置「已完成」时 `completed_at` 语义不同 | `_commit_status` 走 `update(status=…)`（task_editor.py:407-421），只有 `set_status`/`toggle_complete` 写 `completed_at`（task_service.py:119,138） | `updateTask` 只要含 status 就写 `completed_at = now`（tasks.ts:291-294） | 回顾页「今日完成/热力图/连续天数」在「编辑面板改状态」路径下两版口径不一致 |
| 6 | 子任务不继承父 list_id，收件箱口径不同 | `add_subtask` 继承父 list_id task_service.py:81-89；`list_tree(None)` 只取顶层 list_id=NULL 的根并闭包保留整棵子树 :373-403 | `createTask(title,parentId,listId)` 只写调用方传入值 tasks.ts:245-257，UI 新建子任务不传 listId（TasksPage.tsx:372-381）；`listInboxTasks` 按 `list_id IS NULL` 平铺筛 inbox.ts:14-21 | `@清单` 任务下新增的子任务会同时出现在收件箱 |
| 7 | 快速捕获 `@列表` 语义不同 | `quick_create` 只按名查找，未命中回退 `default_list_id`，不新建列表 task_service.py:57-66；任务页捕获传入当前清单 id app_controller.py:126-127 | `ensureListId` 未命中即新建 list_folder（task-ops.ts:170-184）；`quickAdd` 无 default list（:190-196），未写 @ 时 list_id=NULL | 清单名拼错会静默新建垃圾清单；捕获任务不再落入当前清单 |
| 8 | 捕获时刻解析：裸 1-6 点不按下午、无 24h 校验 | `_resolve_hour` 无修饰 1-6 点→+12（task_rules.py:188-200）；`parse_clock` 校验 h<24、m<60（:203-225） | `parseNaturalDate` 只对「下午/傍晚/晚上/夜里/夜晚/中午」加 12，无范围校验（capture.ts:43-56） | 实测：`明天3点` → Python 15:00 / Electron 03:00；`明天25:99` → Python 无时刻 / Electron (25,99) 并落库非法 reminder_at |
| 9 | 捕获标题缺少残留清理与 strip 字符集 | 剔除日期词后清「前/之前/以前/之内/内」并 `strip(" -，,")`（capture_grammar.py:85-92） | 仅做 `trim()` 与空白折叠（capture.ts:110-144），无修饰词/标点清理 | 实测：`周五前 交付方案` → Python「交付方案」/ Electron「前 交付方案」；`- 买菜` → Python「买菜」/ Electron「- 买菜」 |
| 10 | 非法日期静默归一化 | `parse_natural_date` 用 `date(y,m,d)` 抛错即返回 None（task_rules.py:270-289） | `Date.UTC` 自动进位（capture.ts:77-89） | 实测：`2月30日 事` → Python due=None / Electron 2026-03-02；`2/29`(非闰年) → Python None / Electron 2026-03-01 |
| 11 | 日历归类规则与「显示已完成」开关 | `group_tasks_by_date`：开始+截止逐日展开、仅开始落开始日、无日期归今日、按 (-priority,sort_key,id) 排序（task_page.py:1425-1457）；已完成受 `calendar_show_done`（默认 False）控制（:1831-1834，constants.py:28） | CalendarBoard 只用 due_date，无 start_date 展开、无日期任务直接丢弃、不排序，且恒排除已完成（CalendarBoard.tsx:49-58）；设置项只写不读（SettingsPage.tsx:279-280） | 时间区间任务、无日期任务在日历消失；calendar_show_done 设置无效 |
| 12 | 改挂/排序语义不同 | `reparent` 只改 parent_id 保留 sort_key 且无成环校验（task_service.py:246-248）；`reorder` 只改 sort_key 不换父级（:278-298） | `reparentTask` 防成环并把 sort_key 重置为新父末位（task-ops.ts:82-96）；`reorderTask` 顺带把 parent_id 改为 anchor 的父级（:41-57） | 拖拽后位次不同（Electron 追加到末尾），跨父级拖拽在 Electron 是隐式 reparent |
| 13 | 撤销语义不同 | 记录 `prev_status`，删除任务记录整棵子树并可 restore；Ctrl+Z（app_controller.py:549-552,570-579,699-736） | 撤销固定 `toggleTask`（App.tsx:210-217）；删除任务不派发 undoable（TasksPage.tsx:266-275） | 撤销「完成」会反向打开任务、原 abandoned 会变 done；删除只能去回收站，无 Ctrl+Z 撤销 |
| 14 | 任务全文索引未维护 | create/update/soft_delete/restore 均调 `fts.index_task/remove`（repositories.py:78,95,107,117） | `task_fts` 只有建表 DDL（schema.ts:151），全仓无写入/查询 | 任务无法被 FTS 检索（Electron 目前也无检索入口，属预留断链） |
| 15 | 任务列表硬上限 500 | `list_all` 无上限（repositories.py:137-141），各视图全量装载 | `listTasks` 默认 `LIMIT 500`（tasks.ts:17-22），渲染层不传参（TasksPage.tsx:84） | 超过 500 条时任务页/四象限/日历/看板静默缺数据 |
| 16 | 提醒弹出时机与开关 | 弹出前立即 `dismiss_reminder` 防 30s 重复并受 `reminder_enabled` 控制（app_controller.py:1218-1227；constants.py:16） | `reminder_at` 保留到用户点「知道了/稍后/查看」（ReminderPopup.tsx:17-44）；`reminder_enabled` 只写不读（SettingsPage.tsx:271-272） | 忽略弹窗后重启会再弹；关闭「到点提醒」开关无效 |
| 17 | 捕获候选（任务目标选择器）缺失 | `task_candidates(q,limit)` task_service.py:497-517；消费方 target_selector.py:107-108、note_page.py:1118 | 未找到对应实现（无 IPC/preload/渲染入口） | 捕获卡无法把内容建成指定父任务的子任务；笔记侧无法选择「归属任务」 |

**该域整体完成度**：任务主链（CRUD／状态机／循环克隆与 COUNT·UNTIL 递推／打卡 streak·last_reset_date／排序中间值算法／批量完成与改期／软删回收站／到点提醒与 snooze／今日与逾期 roll-up）已在 Electron 逐条对齐，但**列表分组体系、任务↔笔记关联、等待中恢复**三块结构性缺失，快速捕获语法另有 3 处可复现偏差。

**风险最高的 3 条**：
1. #4 `resume_at` 不可写：`resumeDueToday` 成为永不触发的死路径，等待中任务会永久沉底（用户只能手动改状态）。
2. #1+#7 列表/分组缺失且 `@列表` 未命中即建表：信息组织能力缺失，同时拼错清单名会静默产生脏 `list_folder` 数据。
3. #2+#3 任务↔笔记关联（归属 + 段落上下文）无写路径：编辑器承诺的 `[[笔记标题]]`、行内笔记计数、图谱边、完成任务回写段落全部断链。
