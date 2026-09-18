# 笔记域 差异清单
> 基准：Python zhixing/ ｜ 目标：electron/src/ ｜ 证据均为 file:line

> **复核状态（本表已于 2026-09-19 按 electron-diff.md §1 回填）**：本表原结论为审计当时快照；「结论」列已按当前代码重新判决。仍以代码为准。
> **本表 22 条**：仍成立 15 · 部分修复 4 · 已修复 3；行号与 electron-diff.md §1.3（笔记域）逐条对应。
> **计数口径提示**：electron-diff.md §1.1 汇总表对本域记「仍成立 16 / 部分修复 3 / 已修复 3」，与 §1.3 逐条判决（15 / 4 / 3）不一致；本表以逐条判决为准。
> **差额校验**：本表 22 条与 §1.3 的 22 条逐条对应，**无行数差额**（旧说法「笔记域差 11 条」在当前版 electron-diff.md 中不复现；当前 §2 全表实为 124 行，与声明一致）。

| # | 差异 | Python 行为（证据） | Electron 现状（证据） | 影响 | 结论 |
|---|---|---|---|---|---|
| 1 | 切换笔记时未落盘的编辑被丢弃 | 切走前显式落盘：note_page.py:330-334 `_commit_current_editor` → markdown_editor.py:270-274 `commit()`（停防抖定时器并立即 `_emit_save`） | NotesPage.tsx:158-170 自动保存 effect 依赖含 content/current，切笔记后 load 完成触发的 cleanup 会 `clearTimeout` 掉已排队的保存；onSelect 直接 `setSelectedId`（NotesPage.tsx:255），无 commit/flush、无 beforeunload | 高：切走或关窗前 <800ms 输入静默丢失（数据丢失） | 部分修复 |
| 2 | note_fts 全文检索完全未接线 | fts.py:43-63 jieba 分词与查询式；index_note 由 repositories.py:384/396/424/430/439 触发；search_service.py:194-198 用 FTS 检索笔记正文 | schema.ts:77 只建了表，全仓无 `note_fts` 读写（grep 仅命中 schema）；检索只有 CommandPalette.tsx:63-73 对已加载笔记做 `title.includes` | 高：无正文检索、无中文分词、无索引同步触发点 | 已修复 |
| 3 | 新建笔记无「格式 + 目标」选择 | note_service.py:17-26 五种格式；note_create_dialog.py:48-52 选类型 + 目标路径/URL；app_controller.py:799-834 按格式填 content，Word/Excel 无目标时自动生成空白文件 | notes.ts:112-124 `createNote` 硬编码 `format='markdown'`，saveNote 字段白名单无 format（notes.ts:65-67）；NotesPage.tsx:204-209 直接建「未命名笔记」 | 高：Word/Excel/链接/富文本笔记无法创建，格式不可变（仅靠导入 JSON） | 部分修复 |
| 4 | 富文本(richtext)无编辑器与附件 | note_page.py:293-295 切 RichTextEditor；richtext_editor.py:160-201 格式工具栏、63-87 插入图片(data URI)/文件附件 | NotesPage.tsx:335 richtext 落入 Markdown 编辑器分支；MarkdownEditor.tsx 无富文本工具栏/插图/附件代码 | 高：richtext 笔记只能看到原始 HTML，插图与附件能力缺失 | 仍成立 |
| 5 | Word/Excel 笔记只读 | note_page.py:296-301 用 WordEditView/ExcelEditView，可编辑并写回文件（note_previews.py:609-627 html_to_docx、670-716 xlsx 落盘） | NotesPage.tsx:335-357 仅 mammoth/xlsx 只读预览 + export.ts:212-224 交系统应用打开 | 中：文档笔记不能在本应用内编辑 | 仍成立 |
| 6 | 链接(link)笔记多链接视图缺失 | note_previews.py:209-215 content_md 存 JSON 数组 [{title,target}]，可增删改多条链接（note_page.py:302-304） | NotesPage.tsx:359-381 原样打印 content_md；export.ts:216-222 对 JSON 文本非 URL 且不存在 → 报「关联文件已不存在」 | 中：Python 建的 link 笔记在 Electron 内不可用 | 已修复 |
| 7 | 主动「+引用」缺失 | note_service.py:524-572 add_reference_link：按 id/标题建引用，返回 added/dangling/bound/duplicate/invalid/self，悬空行遇真实目标转正 | 未找到对应实现（无 `db:addReferenceLink`，notes.ts 无函数） | 中：不能在不改正文的前提下建引用/转正悬空引用 | 仍成立 |
| 8 | 「+归属→任务」缺失 | note_service.py:608-631 attach_note_to_task（幂等，invalid/duplicate/attached）；661-667 attached_tasks；669-675 task_candidates | 未找到对应实现：task_note_link 在 Electron 只被读（tasks.ts:64、graph.ts:180-187）与删（trash.ts:50,63），无任何 INSERT | 中：笔记↔任务关联无法建立，相关计数与图谱边恒为空 | 部分修复 |
| 9 | 「+归属→文件夹」缺失 | note_service.py:633-659 attach_note_to_folder：改 note.folder_id，返回 attached/unchanged/invalid | notes.ts:86-88 saveNote 支持 folder_id，但 renderer 无一处传 folder_id（NoteTree.tsx:35 只读） | 中：笔记建好后无法移动文件夹 | 仍成立 |
| 10 | 选文转任务 + 段落锚定位链缺失 | note_service.py:677-701 create_task_from_selection（block_key/snippet → task_note_context）；note_page.py:585-599 右键二级动作、601-615 locate_in_note → markdown_editor.py:535-541 指纹、588-607 locate_block；deep link `?block=` | 未找到对应实现：MarkdownEditor 无自定义右键菜单；task_note_context 只被 trash.ts:51,64 删除；deep-link.ts:10-34 解析出 block 但 App.tsx:157-168 只按 kind 跳页；graph.ts:24-28 保留 anchor 判定却从不生成 anchor 节点 | 中：任务→笔记段落双向定位闭环缺失 | 仍成立 |
| 11 | 完成任务后回写复盘笔记缺失 | note_service.py:703-716 append；app_controller.py:553-556、672-697 完成后「写篇笔记记一下」→ 有关联段落则 append，否则建「复盘：X」 | 未找到对应实现（无 `appendNote`、无复盘笔记入口） | 中：完成任务的知识沉淀闭环缺失 | 仍成立 |
| 12 | 文件夹删除/移动缺失、重命名无 UI | note_service.py:446-477 move_folder（祖先链环路校验，成环不改库）；479-499 delete_folder（笔记回落根、子文件夹上移） | 未找到对应实现（db/index.ts:241-260 无 delete/move handler，notes.ts 无函数）；renameNoteFolder 有 IPC（index.ts:260、notes.ts:207-214）但 renderer 无调用 | 中：文件夹只能新建与浏览 | 仍成立 |
| 13 | 空库无默认文件夹 | note_service.py:307-319 ensure_default_folder + note_page.py:272-275 为空时自动建「我的笔记」 | 未找到对应实现（NoteTree.tsx 仅渲染已有 folders） | 低 | 仍成立 |
| 14 | 失效链接检测会误报 | repositories.py:543-557 broken_links 过滤掉「标题仍能解析到现存笔记」的 NULL 行 | notes.ts:302-311 只筛 `dst_note_id IS NULL`，不比对现有标题；bindDanglingByTitle 只由图谱页调用（App.tsx:190-196） | 中：先写 [[X]] 后建笔记 X 会误报为失效且无修复入口 | 仍成立 |
| 15 | 自链接绑定语义不同 | note_service.py:722-725 `_pipeline` 用 resolve 解析，命中自身即写 dst_note_id=自身 id（repositories.py:477） | notes.ts:59 `resolved === noteId ? null : resolved`，注释明确「自链接不绑定」 | 低中：同一 self-loop 在 Python 是实链接，Electron 变成「待建」 | 仍成立 |
| 16 | 同名笔记解析规则不同 | repositories.py:402-404 by_title `.first()`（无排序） | notes.ts:27-34 resolveNoteTitle `ORDER BY pinned DESC, updated_at DESC LIMIT 1` | 低：标题重复时 [[标题]] 绑定目标不同 | 仍成立 |
| 17 | 笔记列表被截断到 300 条 | repositories.py:406-418 `all()` 无 LIMIT | tasks.ts:80-86 `listNotes(limit=300)`；NotesPage.tsx:53、CommandPalette.tsx:34 均无参调用 | 中：超过 300 篇时笔记树与命令面板静默丢笔记 | 仍成立 |
| 18 | 版本历史无 diff、回滚无确认 | note_tools.py:108-136 difflib.unified_diff（选中版本 vs 当前内容）；146-153 回滚二次确认 | NoteHistory.tsx:57-59 仅 `<pre>` 展示该版正文；70-77 直接 restoreNoteRevision 无确认 | 低 | 仍成立 |
| 19 | 查找替换缺分支 | note_tools.py:243-275 查找下一个(循环)/查找下一处并替换/全部替换；277-302 全部命中高亮 | NotesPage.tsx:172-202 只有 findNext 与 replaceAll，无单处替换、无高亮 | 低 | 部分修复 |
| 20 | Markdown 文件夹导入缺失 | settings_page.py:566-571 import_markdown_folder（exporter.py:221-238 rglob *.md → 建笔记） | 未找到对应实现：SettingsPage.tsx:326-366 只有 JSON/CSV/Markdown 导出与 JSON 导入，主进程无 rglob | 中 | 仍成立 |
| 21 | 笔记导出无重名去重 | exporter.py:94-107 文件夹镜像对同名追加 `-{i}`（UI 走的 ZIP 路径 50-60 按 folder-<id>/<title>.md） | export.ts:66-81 safeName 无去重，直接写目录 folder-<id>/<title>.md | 中低：同文件夹下同名笔记互相覆盖 | 仍成立 |
| 22 | 回收站列表语义与自动清理不同 | note_service.py:177-183 `trash()` 传 include_deleted=True → 实际返回全部笔记；app_controller.py:1264-1276 日切换按 recycle_retention_days 自动清理 | trash.ts:21-27 只返回 deleted_at IS NOT NULL（更正确）；RecycleBin.tsx:22 天数硬编码 30、108-120 仅手动清理，maintenance.ts 无清理调用 | 中低：Electron 无自动过期清理，回收站不会自动清空 | 已修复 |

该域整体完成度评估：笔记域完成度约 60%——核心 CRUD、文件夹树（只读）、模板、版本历史、孤儿笔记、正/反向链接展示、悬空引用转正、回收站与导出已具备，但格式体系（Word/Excel/链接/富文本）、附件、全文检索、笔记↔任务关联、段落锚定位、文件夹变更操作整条链路缺失，并存在一处数据丢失缺陷。

风险最高的 3 条：
1. #1 切换笔记静默丢弃未落盘编辑——唯一的数据丢失级缺陷，且无任何补偿机制（无插桩、无关闭前 flush）。
2. #2 note_fts 与中文分词完全未接线——笔记正文不可检索，且 create/save/软删/恢复/回滚五个索引同步触发点全缺，数据层无法自愈。
3. #3+#4+#5+#6 格式体系整体塌陷——format 字段事实上被锁死为 markdown：非 markdown 笔记无法创建、富文本无编辑器、Word/Excel 只读、link 笔记的 JSON 内容在 Electron 内会报「关联文件已不存在」。
