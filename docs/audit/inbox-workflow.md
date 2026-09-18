# 收件箱/工作流/捕获 差异清单
> 基准：Python zhixing/ ｜ 目标：electron/src/ ｜ 证据均为 file:line

| # | 差异 | Python 行为（证据） | Electron 现状（证据） | 影响 |
|---|---|---|---|---|
| 1 | 闪念缺 source_url 与截断 | `add(content,remark,source_app,source_url)`，content[:2000]/remark[:200] `zhixing/model/application/flash_service.py:18-24` | `addFlash` 仅 3 参，source_url 写死 `''`，无截断 `electron/src/main/db/inbox.ts:40-50` | 来源丢失、超长无上限 |
| 2 | 来源 URL 提取缺失 | `_extract_source_url` `zhixing/controller/app_controller.py:432-467`，调用 383-384 | 未找到对应实现（CapturePanel 不解析剪贴板 HTML） | F11-3 网页来源无法记录 |
| 3 | update_remark 缺失 | `flash_service.py:87-97` | 未找到对应实现（flash IPC 白名单仅 7 条 `electron/src/main/db/index.ts:200-211`） | 备注建后不可改 |
| 4 | 闪念打标签缺失 | `flash_service.py:99-108`；`zhixing/view/pages/inbox_page.py:289-308` | 未找到对应实现；`flash_tag` 表存在但全仓无 INSERT `electron/src/main/db/schema.ts:36-41` | 标签整理不可用 |
| 5 | merge 缺失 | `flash_service.py:110-135`；`inbox_page.py:329-346`（勾选/全选） | 未找到对应实现 | 多条闪念不能合并 |
| 6 | to_subtask 缺失 | `flash_service.py:203-211` | 未找到对应实现（仅顶层 flashToTask `inbox.ts:69`） | 不能转为子任务 |
| 7 | to_note 无 folder_id | `flash_service.py:185,190` | `inbox.ts:86-94` `createNote(title,null,..)` 固定 null | 不能指定笔记目录 |
| 8 | 删闪念无撤销 | `app_controller.py:666-670`（delete-flash undo） | `electron/src/renderer/src/pages/InboxPage.tsx:94-98` 仅 confirm+deleteFlash | 误删不可恢复 |
| 9 | 闪念未入 FTS | `zhixing/model/infrastructure/repositories.py:570,579,601` index_flash | `schema.ts:35` 建表但无任何写入，未找到实现 | 闪念不可检索 |
| 10 | 回收站自动清理缺失 | `flash_service.py:176-182` + `app_controller.py:1264-1272` 启动清理 | 仅 `RecycleBin.tsx:118` 手动按钮；未找到启动期调用 | 回收站无限增长 |
| 11 | **任务完成→实例推进未接线** | `app_controller.py:1113-1115,1133-1147` → `workflow_service.py:252` | `completeWorkflowStep` `electron/src/main/db/workflow.ts:294` / IPC `index.ts:238` / preload:107，但全渲染层无调用（grep 确认无 .tsx 调用方） | 实例永远停第1步，闭环断裂 |
| 12 | instances_of_task 与任务侧入口缺失 | `workflow_service.py:240-249`；`zhixing/view/pages/task_page.py:960-1030` | 未找到对应实现（无 IPC）；`index.ts:230-233` 有 originTaskId 但无调用方传值 `WorkflowPage.tsx:233` | 不能从任务启动/查看流程；origin_task_id 恒 null，步骤任务不挂来源任务 |
| 13 | 删模板无「运行中实例」守卫 | `workflow_service.py:122-126`；`workflow_page.py:1237-1239` | `workflow.ts:174-181` 直接删 | 运行中模板被删→实例/步骤任务成孤儿 |
| 14 | duplicate_template 缺失 | `workflow_service.py:139-153`；`workflow_page.py:1254-1258` | 全仓无 duplicate，未找到实现 | 不能复制模板 |
| 15 | 模板重命名缺失 | `workflow_page.py:1243-1252` | WorkflowPage 无入口（saveWorkflowTemplate 支持 name 但无调用） | 模板名不可改 |
| 16 | start_policy 无入口 → all 不可达 | `workflow_page.py:1276-1280`(combo 保存)、`1366-1371`(带 policy) | `WorkflowPage.tsx:231-233` 恒传 null；无策略编辑项 | 「一次全下发」不可用 |
| 17 | 删除步骤 / 上移下移缺失 | `workflow_page.py:1322-1330`、`1332-1346` | `WorkflowPage.tsx:296-304` 仅 加一步/启动/删模板 | 步骤不可删、order_index 不可调 |
| 18 | 加一步插入位置/设为分支缺失 | `workflow_page.py:1282-1313`（插选中节点后 + branch_check） | `WorkflowPage.tsx:155-181` 恒追加末尾、无分支选项 | 编排能力受限 |
| 19 | 步骤无法绑定 SOP 笔记 | `workflow_page.py:762-769,831`(note_combo→note_id) | `WorkflowPage.tsx:423-499` 编辑弹窗无 note_id 字段 | `workflow.ts:197-203` 的 [[笔记]] 写备注成死代码 |
| 20 | _auto_layout 一键对齐缺失 | `workflow_page.py:1197-1207` | 未找到对应实现；`WorkflowPage.tsx:21-33` 仅在 pos 为空时兜底 | 拖乱后无法重置 |
| 21 | 完成判定口径不同 | `workflow_service.py:437-448` 只认 `=='done'` | `workflow.ts:275` `'abandoned'` 也算 done | 放弃的步骤显示已完成 |
| 22 | 实例步骤集合口径不同 | `workflow_service.py:215-222` 仅已生成绑定 | `workflow.ts:257-276` LEFT JOIN 全部模板节点(task_id 可 null) | 进度分母不同(0/5 vs 0/1)、空步骤行 |
| 23 | list_instances 排序不同 | `workflow_service.py:234` id desc | `workflow.ts:284-285` created_at desc | 顺序不一致（低） |
| 24 | describe_action 文案不同 | `workflow_service.py:307-318`（open_note 出笔记标题；run_command 前缀；未知「无动作」） | `workflow.ts:361-366`（恒「打开关联笔记」/裸值/空串） | 执行前确认信息不足（低） |
| 25 | run_command 错误路径失效 | `workflow_service.py:334-347` shlex.split + FileNotFoundError→「找不到命令」 | `workflow.ts:401-408` spawn 无 `'error'` 监听；实测 ENOENT 不同步抛→未捕获；main 无 uncaughtException 兜底 | 误报「已启动」，可能致主进程未捕获异常 |
| 26 | 命令拆分语义不同 | shlex.split：反斜杠转义、未闭合引号 ValueError（实测 `r'a\ b'`→`['a b']`） | `workflow.ts:337-358` 自实现无转义、未闭合引号静默吞掉 | 参数错位/该报错不报错 |
| 27 | save_template 错误路径 | `workflow_service.py:72-73` 返回 None | `workflow.ts:131` throw；`WorkflowPage.tsx:157-180` 未 catch | 渲染层未处理 rejection（低） |
| 28 | list_templates 排序 | `workflow_service.py:35-37` updated_at desc nullslast, id desc | `workflow.ts:80` 仅 updated_at DESC | 同分不稳定（低） |
| 29 | 划词卡五去向→三去向 | `capture_card.py:79-80,96-102`；`app_controller.py:501-513` | `CapturePanel.tsx:124-140` 仅 闪念/笔记/任务 | 不能直接归列表/挂子任务 |
| 30 | TargetSelector 缺失 | `target_selector.py:19-131`（分组树/最近3条/模糊搜索）+ `capture_card.py:116-145` | 未找到对应实现 | 无目标选择逻辑 |
| 31 | 划词捕获实为读剪贴板且截断 | `app_controller.py:375-385` SelectionGrabber（未授权降级提示） | `CapturePanel.tsx:29-38` navigator.clipboard + `slice(0,500)` | 未复制则空；>500字截断 |
| 32 | 划词速记 select-quick 缺失 | `app_controller.py:388-419`；热键 `337`（K_SELECT_HOTKEY 默认 ctrl+shift+u） | `settings.ts:31-32` 无 select_quick_hotkey；`electron/src/main/index.ts:159-162` 仅注册 2 个热键 | 划词速记+原文入备注缺失 |
| 33 | capture_hotkey 默认值不一致 | `zhixing/model/application/settings.py:81` `ctrl+shift+s` | `electron/src/shared/settings.ts:80` `shift+d` | 全新库默认热键不同且易冲突 |
| 34 | 应用内 Ctrl+N 快速捕获缺失 | `app_controller.py:215-216` | `App.tsx:219-233` 注释称支持 Ctrl+N，实际仅实现 `'k'` | 应用内快捷捕获不可用 |
| 35 | 捕获「任务」语义不同 | `app_controller.py:480-482` 不解析语法糖，notes=「捕获内容：…」 | `CapturePanel.tsx:52-63` 走 quickAdd 解析 !/@/#/日期 | 同一按钮结果不同（会建列表/设截止今天） |
| 36 | 捕获「笔记」标题/正文不同 | `app_controller.py:495-499` title[:30]、body=`"> content\nremark\n"` | `CapturePanel.tsx:74-83` title[:40]、body 仅 content，remark 只进标题 | 备注丢失、格式不一致 |
| 37 | 语法糖标题清理缺失 | `zhixing/model/domain/capture_grammar.py:85-92`（清 前/之前/以内 与首尾「 -，,」） | `electron/src/shared/capture.ts:108-144` 无清理 | 「周五前 X」→ 标题「前 X」 |
| 38 | 「下周X」语义不同 | `zhixing/model/domain/task_rules.py:265-269`（下周五=本周五） | `capture.ts:67-75` 取字面下周（注释自述有意修正） | 日期差一周 |
| 39 | @列表不存在时行为不同 | `zhixing/model/application/task_service.py:60-64` 回退 default_list_id，不新建 | `electron/src/main/db/task-ops.ts:170-183` ensureListId 直接新建列表 | 打错名会静默多出列表 |

**该域整体完成度评估**：闪念整理闭环与工作流运行期均明显缩水——收件箱侧「打标签/合并/改备注/来源URL/FTS/撤销+自动清理」全缺，工作流侧「完成推进、任务侧双向绑定、模板守卫、步骤增删排序、SOP 绑定、策略切换」全缺，捕获侧五分去变三分去且划词能力降级为读剪贴板，整体约为 Python 版的功能骨架（约 55%），仅读路径（列表/归档/转换/校验/坐标持久化）对齐较好。

**风险最高的 3 条**：
1. **#11 任务完成不推进实例**：`completeWorkflowStep` 有实现与 IPC 却无任何调用方，工作流核心闭环彻底断裂，实例永远停在第 1 步。
2. **#13 删模板无「运行中实例」守卫**：Electron 直接删除，产生悬空实例与孤儿步骤任务，属数据完整性风险。
3. **#25 run_command 无 `'error'` 监听**：命令不存在时误报「已启动」，且主进程无 uncaughtException 兜底，可能连带崩溃。
