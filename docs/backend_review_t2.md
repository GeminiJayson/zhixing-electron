# 后端审查报告（t2）— model/ 与 controller/ 实现状态

审查范围：zhixing/model/{domain,application,infrastructure} + zhixing/controller/ + zhixing/core/（接线层）。
方法：以 docs/req_acceptance_baseline_t1.md 为基线，逐项 grep 服务层方法存在性 + view/controller 调用点（判断「服务已就绪但 UI 未接线」）。

## 一、完全未实现（无对应代码路径）

| 需求ID | 结论 | 证据（文件:行） |
|---|---|---|
| F5-3 snooze「稍后提醒」 | 未实现 | controller/app_controller.py:743-753 _check_reminders 到期即 dismiss_reminder() 清 reminder_at，无 snooze；全库 grep 无 snooze/稍后 |
| F1-8 自定义 RRULE 循环 | 未实现（子集缺失） | domain/entities.py:23-27 RepeatPeriod 仅 none/daily/weekly/monthly；daily/weekly/monthly 已由 task_rules.next_due 实现，无 RRULE 自定义 |
| F4-3 任务内 [[链接]] | 未实现 | domain/link_parser.extract_links 仅用于 note.content_md（note_service.py:366）；任务 notes_md 无 wiki 解析/跳转路径 |
| F7-4 编辑器查找/替换 | 未实现 | view/components/markdown_editor.py、richtext_editor.py grep 无 find/replace 对话框（rfind 仅为 [[ 补全） |
| F11-4 归档可查 | 未实现 | domain/entities.py:37 FlashStatus.ARCHIVED 枚举存在，但全库无任何置 archived 的写路径（仅 inbox→converted）；无归档入口/过滤 |
| F1-10 四象限拖拽换象限 | 未实现 | view/pages/task_page.py:140-142 QuadrantView 仅 openTaskRequested/toggleRequested；无拖拽换象限信号，后端亦无「换象限」服务（=改 priority+due，无专用方法/UI 拖拽） |
| F1-12 日历拖拽改期 | 未实现 | view/pages/task_page.py:146-149 CalendarTaskView 仅 daySelected/taskActivated，无拖拽改期；service.tasks_on_day 就绪但无改期拖拽接线 |

## 二、弱实现（方法存在但逻辑不完整 / 无 UI 接线 / 性能不达标）

| 需求ID | 结论 | 证据 |
|---|---|---|
| F1-13 拖拽排序/移动归属 | 弱实现 | Service reorder(task_service.py:208)、move_to_list(:180)、move_relative(:184) 均存在；但 grep 全库仅 move_relative 被 task_page.py:342 调用（Ctrl+↑/↓ 已实现），reorder/move_to_list 无任何 view 调用 → 鼠标拖拽排序/跨列表移动归属未接线 |
| F8-2/F8-3 全量 JSON 导出导入 | 弱实现 | export_json(exporter.py:23-42) 缺 flash_tag、note_revision、attachment、pomodoro_session 四表；import_json(:77-133) 不恢复它们；note 导入列(:91-92) 缺 format/created_at/updated_at → 富文本笔记导入后退化 markdown、时间戳丢失。「导出→清库→导入一致」验收不满足。UI 入口已接（settings_page.py:322,339-353） |
| F3-4 力导向主线程 O(n²)（非功能-性能） | 弱实现/风险未修 | view/pages/graph_page.py:445-451 _tick 由 QTimer 驱动（主线程），斥力 O(n²)，>500 节点 items[::2] 降采样；未移 QThreadPool，「2000 节点可交互」不可行 |
| F5-2 番茄钟中断选原因 | 弱实现 | controller/pomodoro.py:84 注释「中断需选原因：先简单记录」，stop(abandoned)(:102-111) 仅 completed/abandoned bool，无原因选择 |
| F2-8 代码高亮（pygments） | 弱实现 | view/components/markdown_editor.py:18-48 _MdHighlighter 仅正则高亮 md 语法/行内代码/[[链接]]；无 fenced 代码块按语言着色、无 pygments |
| F4-2 笔记转任务 | 弱实现（服务有、UI 无） | note_service.create_task_from_selection(:332-345) 存在，但 note_page/markdown_editor/richtext_editor grep 无「转为任务」上下文菜单接线 |
| F4-4 完成沉淀提示 | 弱实现 | app_controller.py:306-313 「写篇笔记记一下」jump 仅在任务有关联笔记(linked)时显示，无关联笔记的任务完成不提示；与「完成任务时提示」不完全一致 |
| F11-2 捕获卡成功 Toast「去查看」 | 弱实现 | app_controller.py _after_capture 仅 flash(:248)/task(:252) 传 jump；note/group/subtask(:262-282) 无「去查看」 |
| F1-15/F6-1 今日「已完成」卡定位 | 弱实现/风险 | app_controller.py:593 _jump 映射 {today:0, overdue:1, done:1, flash:2}，done 与 overdue 同跳 index=1，无独立已完成清单 |
| F1-10 四象限点击=勾选 | 风险（未修） | task_page.py:142 quadrant.toggleRequested 连接 → 点击任务触发完成勾选而非打开编辑页 |
| F9-1 theme_changed 总线接线 | 弱实现 | event_bus.py:22 定义、app_controller.py:660 emit；但 :148 仅 connect(lambda: None) 无真实订阅者，动态行刷新靠 :656 inbox_page.reload() 旁路 |
| F9-6 reduce-motion | 弱实现/风险 | view/kit/motion.py:22-28 set_motion_enabled 由设置项 K_MOTION 手动驱动，非 OS 级探测；图谱物理/图表不受控 |
| F1-8 循环克隆不完整 | 弱实现 | task_service.toggle_complete(:116-121) 克隆仅复制 title/list/priority/due/repeat/notes，不复制 start_date/reminder/标签/子任务 |
| 非功能-可维护 MVC 分层 | 弱实现 | app_controller.py:505-512 _open_hit 直连 ctx.db.session + 直接 import TagRow；note_service(:289-296)、graph_service(:50-67)、flash_service(:109-113) 均直 s.query() ORM，绕开 repositories（违背 repositories.py:2「SQL 唯一入口」约定） |
| F11-3 merge 细节 | 弱实现（低） | flash_service.merge(:87) fi.deleted_at = merged.created_at（恒 None）为死赋值，随后被 soft_delete 覆盖；不合并 tags/source_url |

## 三、已实现（近期新增/需实现项，交叉验证确认已闭环）

- F2-6 笔记模板：note_service NOTE_TEMPLATES+create_from_template(:222-228)，note_page 接线(:92-94,348-354)
- F2-9 版本历史：NoteRevisionRow+SCHEMA_VERSION=4/migrate_v4(db.py:66-77,161)，note_service revisions/restore_revision/_snapshot(:231-282)，note_tools.NoteRevisionDialog+note_page 接线
- F3-7 任务入图：graph_service._attach_task_nodes+include_tasks(:119-150)，graph_page build(include_tasks=True)(:385)
- F3-8 孤儿笔记：note_service.orphans(:285-302)，note_page orphans_btn+note_tools 接线
- F6-4 成就：review_service.achievements(:122-141)，review_page 接线(:140-153)
- F11-3 闪念多选合并：flash_service.merge(:74-94)，inbox_page merge_btn+_merge_selected(:226-231)
- F11-7 剪贴板监听：app_controller._init_clipboard_monitor/_on_clipboard_changed(:776-795)，K_CLIPBOARD_MONITOR 默认关
- F9-5 开机自启：autostart.py 跨平台(:42-114)，app_controller:683-685 接线
- F10-6 点击穿透：K_WIDGET_CLICK_THROUGH，app_controller:676-677→widget.set_click_through（desktop_widget.py 视图层）
- F1-11 看板：view/pages/kanban.py KanbanView，task_page 接线(:151-155,242-243)
- F1-4 开始时间联动截止下限：task_editor._on_start_date_changed(:237-251)
- F5-1 行内「▶ 专注」：task_delegate:39,409 focusRequested → today_page/task_page 上抛 → _start_pomodoro
- F7-1 无结果新建笔记/主题直达：command_palette createNoteRequested/themeRequested(:23-24,92,109)，app_controller:153-154 接线
- F3-6 图谱文件夹/标签过滤+节点色按文件夹：graph_page:377-385 build(folder_id/tag_id)，:253 folder_color
- F9-1 Mica 即时生效：app_controller:678-682；F10-4 透明度即时：app_controller:674-675；F9-2 热键改键：_rebind_hotkeys(:182-197)
- F9-3 回收站：三 service trash/purge/purge_older_than + RecycleBinDialog(settings_page:360-361) + _purge_recycle 30天清理(app_controller:764-774)

## 四、优先级整改建议（后端侧）
1. F3-4 力导向移 QThreadPool（唯一硬性性能红线，非功能验收不达标）
2. F8-2/F8-3 补全 JSON 归档表（flash_tag/note_revision/attachment/pomodoro）+ note 的 format/时间戳，否则「全量一致」验收失败
3. F1-13 为 reorder/move_to_list 补 UI 拖拽接线（服务层已就绪）
4. F5-3 snooze、F4-3 任务内 [[链接]]、F7-4 查找替换、F1-10/F1-12 拖拽换象限/改期 → 后端需新增或补接线
5. F4-2 create_task_from_selection 补 note 编辑器右键菜单
6. MVC 收口：controller 直连 ORM（app_controller:505-512）与 service 内联 s.query() 应下沉仓储层
7. 低优先：merge 死代码清理、循环克隆字段补全、F1-8 自定义 RRULE

注：SCHEMA_VERSION 现为 4（基线标注 3），迁移链 1→4 完整无缺号。版本标记（README v0.8 / docs v0.3 / __init__ 0.1.0）仍不一致。