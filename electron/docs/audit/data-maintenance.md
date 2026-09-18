# 数据/统计/维护 差异清单

> 基准：Python zhixing/ ｜ 目标：electron/src/ ｜ 证据均为 file:line

| # | 差异 | Python 行为（证据） | Electron 现状（证据） | 影响 |
|---|---|---|---|---|
| 1 | schema 迁移链 | `db.py:240-321` 逐号迁移 v1..v12、`settings.schema_version` 驱动、迁移前强制备份(307-311)、缺链报错(301-305)、失败进只读(`context.py:35`) | **完全缺失**：`connection.ts:47-55` 仅对空库 initSchema；全仓无 schema_version 读取/迁移逻辑（`schema.ts:10` 常量只在 connection.ts:50 写入） | 打开旧版本库直接跑 v12 查询 → "no such column"；无迁移前备份保护 |
| 2 | 只读模式/恢复入口 | `app_controller.py:1313-1319,1350-1351`；`main_window.py:375` 横幅+恢复备份入口 | **完全缺失**：`main/index.ts:294-301` 硬编码 `dbReady: true`，未调用 open()，无只读分支 | 库打不开/被 Python 占用时抛错，无横幅、无恢复备份入口 |
| 3 | 启动自动备份 / 保留 10 份 / 恢复备份 | `app_controller.py:1369-1372` startup 后台 backup("auto")；`backup.py:19-42` MAX_KEEP=10；`backup.py:47-60`+`settings_page.py:512-526` 恢复 | **完全缺失**：仅手动 `settings.ts:43-53`+`SettingsPage.tsx:83-91`；无启动备份、无 prune、无 restore（preload/index.ts 无对应方法） | 无历史快照，误操作/损坏不可回滚；手动备份目录无限增长 |
| 4 | 导入前备份目录与保留 | 走 BackupService（`settings_page.py:421`），同一 backups 目录并纳入 10 份 prune | `export.ts:151-160` VACUUM INTO backups/before-import/，无 prune | 备份碎片无上限堆积 |
| 5 | JSON 导入对 settings 的处理 | `exporter.py:205-212` 逐键 upsert 且跳过 schema_version，不清空 settings | `export.ts:167` 反向 DELETE 全部 15 表（含 settings）后原样插入文件里的 settings | 导入旧文件把 schema_version 回退为旧值并抹掉文件外设置键 → 随后 Python 启动重复迁移/失败 |
| 6 | JSON 导入外键与孤儿行 | `exporter.py:170-204` id_map 重映射外键、目标缺失即跳过；task_note_context 由 FK CASCADE 清理（`models.py:127`） | `export.ts:164` pragma foreign_keys=OFF + 原 id 原样插入；EXPORT_TABLES(`export.ts:10-26`) 不含 task_note_context/task_note_ref/workflow_*，既不清空也不重建 | 导入后 task_note_context/workflow_step_task 残留旧 id，错配成脏关联 |
| 7 | FTS 索引维护 | 每次写/删/恢复都同步：`repositories.py:78/95/107/117`、`384/396/424/430`、`570/579/595/601` | **完全缺失**：仅 `schema.ts:35/77/151` 建虚表，全仓无任何 FTS 写入 | 两版共用一库时 Python 搜索漏检 Electron 新增、命中已删数据 |
| 8 | 跨天维护：回收站自动清理 | `app_controller.py:1264` 跨天末尾调用 `_purge_recycle()`（1266-1276，读 recycle_retention_days） | `App.tsx:118-143` 跨天只调 rollRecurringToday/resumeDueToday；purgeTrashOlderThan 仅 `RecycleBin.tsx:118` 手动按钮 | 保留期设置形同虚设，回收站无限增长 |
| 9 | 跨天维护触发间隔 | `app_controller.py:1211` 600s 轮询 + startup(1364-1365) | `App.tsx:135-140` 60s 轮询 + 挂载时调用(133) | 幂等，仅检测粒度不同（Electron 依赖渲染进程挂载） |
| 10 | 回收站「清空」范围 | `recycle_bin.py:165-173` 清空 = 任务/笔记/闪念三类全部 | `trash.ts:77-81`+`RecycleBin.tsx:130-140` 只清空当前 Tab 的 kind | 点「清空」后其他分类仍保留，语义与基准不同 |
| 11 | 回收站保留期取值 | `settings_page.py:395-399` 写入设置；`app_controller.py:1268` 读取 | `RecycleBin.tsx:22` 硬编码 `useState(30)`；`recycle_retention_days` 仅 `SettingsPage.tsx:305` 可改、无处消费 | 设置页改了保留天数，清理仍按 30 天 |
| 12 | 过期清理边界 | `task_service.py:236-243` / `note_service.py:195-201` / `flash_service.py:176-182` 用 datetime 比较 deleted_at < now-days | `trash.ts:84-93` 取 deleted_at 前 10 位与 (today-days) 做 `<` 比较 | 恰好 N 天前删除的记录要多留一天才清 |
| 13 | 回收站列表排序 | `task_service.trash()` 复用 list_all 的 (sort_key,id) 排序 | `trash.ts:17/24/30` ORDER BY deleted_at DESC | 列表顺序不同（属排序规则） |
| 14 | 回收站/导入后的域广播 | `_import_json` 发 backup_restored 总线全量刷新（`settings_page.py:423`） | `db/index.ts:82-96` 把 restoreTrash/purgeTrash/emptyTrash/purgeTrashOlderThan/importData 全映射为 'task' | 导入或回收站操作后 NotesPage（订阅 'note'，`NotesPage.tsx:118`）/闪念/设置视图不刷新，显示陈旧数据 |
| 15 | 提醒总开关 | `app_controller.py:1218-1220` reminder_enabled=False 直接 return | `ReminderPopup.tsx:17-29` 无开关判断；reminder_enabled 仅 `SettingsPage.tsx:271` 写入 | 关掉「到点提醒」仍会弹窗 |
| 16 | 提醒「一次性」语义 | `app_controller.py:1222-1227` 弹窗前先 dismiss_reminder 清空 reminder_at | `ReminderPopup.tsx:34-44` 仅用户点「知道了/查看/稍后」才写库（`maintenance.ts:103-106`） | 未处理即退出/重启会重复打扰，跨会话不收敛 |
| 17 | 到点提醒并发与正文 | `app_controller.py:1223-1227` 每条到期任务各弹一窗，正文含 reminder_at 时刻 | `ReminderPopup.tsx:31-32` 只渲染 due[0]，其余仅在 50 行显示「还有 N 条」；正文(53)显示 due_date | 多任务同时到期时信息与处理方式不同 |
| 18 | 番茄钟中断原因 | `pomodoro.py:144-162` 手动结束专注弹原因选择；`repositories.py:686-689` 写入 reason | **完全缺失**：`maintenance.ts:70-75` recordPomodoro 无 reason 参数；`PomodoroBar.tsx:101-115` 直接调用，reason 列永不写入 | 中断原因统计/导出字段永远为空 |
| 19 | 番茄钟记录条件 | `pomodoro.py:121-130` minutes=round((total-remain)/60)，minutes<1 不落库 | `PomodoroBar.tsx:105-113` 任何手动结束都写一条；`maintenance.ts:73` `Math.max(0,...)` 允许 0 分钟 | 0 分钟记录污染统计与导出 |
| 20 | 休息阶段/连开新番茄是否记账 | `pomodoro.py:118-131` 休息结束同样记账(completed=True,task_id=None)；`pomodoro.py:103-105` 新 start() 先 stop() 记完上一轮 | `PomodoroBar.tsx:105-115` 仅 focus 阶段记账；`PomodoroBar.tsx:31-37` start 直接覆盖 session | 休息时长不计入番茄分钟（Python 计入）；连开新番茄丢失上一轮记录 |
| 21 | 无任务/全局番茄钟入口 | `app_controller.py:84` 命令面板「开始番茄钟（25 分钟）」→ `876-877` `_start_pomodoro(None)` | 只有 `TaskRow.tsx:175` 任务行「开始专注」事件；CommandPalette 无番茄钟命令 | 无法启动不关联任务的番茄钟 |
| 22 | 自动休息默认值与配置入口 | `pomodoro.py:140` 默认 False（键不在 ensure_defaults）；`settings_page.py:257-260` 有「专注结束自动休息」开关 | `shared/settings.ts:71` 默认 true；`SettingsPage.tsx:240-292` 无该开关（仅 `App.tsx:81` 读取） | 未配置用户默认行为与基准相反，且 Electron 内无法更改 |
| 23 | 番茄钟时长取值边界 | `settings_page.py:245,252` 专注 5-90、休息 1-30 | `SettingsPage.tsx:248-249` 专注 1-120、`:260-261` 休息 1-60；`settings.ts:69-70` 钳 1-180/1-60 | 允许取值域不同（同一库切换客户端会读到越界值） |
| 24 | 首次启动种子数据与默认设置落库 | `context.py:71-100` seed_if_empty：工作/生活分组+「我的清单」+2 条欢迎任务+1 篇欢迎笔记；`settings.py:77-95` ensure_defaults 写默认键 | **完全缺失**（全仓无 seed/欢迎相关实现） | 新装 Electron 拿到空库、无默认分组/示例；默认设置键从不落库 |
| 25 | 导入 Markdown 文件夹 | `exporter.py:221-239` import_markdown_folder + `settings_page.py:566-571` | **完全缺失**：只有 `export.ts:83-126` 的 markdown 导出，无导入实现 | 无法从 MD 文件夹批量导入笔记 |
| 26 | 笔记 Markdown 导出产物与重名 | `settings_page.py:541-547` 导出 ZIP；`exporter.py:50-60` 目录名 folder-<id>/root（去重逻辑 `exporter.py:94-103` 仅在未接线的 export_notes_folder 中） | `export.ts:113-125` 选目录直接写文件，同名笔记 `join(dir,name)` 互相覆盖，无去重 | 同一文件夹内同名笔记导出后只剩一篇，静默丢内容 |
| 27 | 任务 CSV 换行/结尾 | `exporter.py:116-124` csv.writer 默认 `\r\n`、末行也有换行 | `export.ts:53-62` 以 `'\n'` join，无结尾换行 | 字节级格式不同（表头与字段一致） |
| 28 | 导入完成提示口径 | `exporter.py:219` 返回 {tasks,notes}，提示「任务 N · 笔记 M」（`settings_page.py:424`） | `export.ts:185` 返回总行数，提示「已导入 N 条记录」 | 仅提示口径不同 |

**该域整体完成度评估**：数据层是「能读能写但缺护栏」——日常 CRUD、标签增删改合并、跨天打卡重置/等待中恢复、旧版回收站与手动备份基本对齐，但迁移、自动备份/恢复、FTS 维护、回收站自动清理与保留期生效、提醒开关与一次性语义、番茄钟中断原因与休息记账这些长期运行才暴露的机制大面积缺失或改了语义。

**风险最高的 3 条**：
1. **#3 无启动自动备份、无恢复备份入口** —— Python 每次启动自动备份、保留 10 份且可一键恢复，Electron 完全没有，一次误操作/库损坏即不可回滚。
2. **#1+#5 无迁移能力、导入还会回退 schema_version** —— 打开旧库不迁移直接按 v12 查询会报错；JSON 导入写回文件里的旧 schema_version，会让随后启动的 Python 版重复迁移，属可破坏共享库的问题。
3. **#6 JSON 导入关闭外键且不清空非导出表** —— task_note_context / task_note_ref / workflow_* 残留旧 id 且不触发 CASCADE，导入后产生指向错误对象的脏关联（叠加 #7 的 FTS 陈旧）。
