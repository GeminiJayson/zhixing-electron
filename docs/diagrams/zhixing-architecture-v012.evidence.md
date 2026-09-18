# 知行 ZhiXing v0.12 架构图 — 代码证据映射

> 本文件为 `zhixing-architecture-v012.html` 的「文件/符号级依据」清单。
> 架构图 JSON 未使用 archify 的 `sources` 字段，因为该字段要求 `meta.repository.url`
> 必须为 GitHub 地址（本仓库为 Gitee），二者无法兼容；因此证据以本清单 + 图中「代码证据」卡片呈现。

## 节点 → 源码符号

| 节点 id | 组件 | 源码文件:行 | 符号 |
|---|---|---|---|
| entry | 入口装配 | zhixing/__main__.py:7 | main() |
| entry | 入口装配 | zhixing/core/logging_util.py:27 | ensure_std_streams |
| entry | 入口装配 | zhixing/core/logging_util.py:46 | setup_logging |
| os | 系统平台 | zhixing/model/infrastructure/hotkey.py:17 | HotkeyManager |
| os | 系统平台 | zhixing/model/infrastructure/selection.py:16 | SelectionGrabber |
| ctrl | AppController | zhixing/controller/app_controller.py:39 | AppController |
| bus | EventBus | zhixing/core/event_bus.py:6 / :38 | EventBus / graph_delta |
| view | MainWindow | zhixing/view/shell/main_window.py:77 | MainWindow（7 页） |
| udialog | 无边框弹窗框架 | zhixing/view/ui/dialog.py:34 / :195 / :361 | DialogType / UDialog / UInputDialog |
| noteviews | 笔记类型视图 | zhixing/view/components/note_create_dialog.py:25 | NoteCreateDialog |
| noteviews | 笔记类型视图 | zhixing/view/components/note_previews.py:50 / :77 | parse_docx_to_html / parse_xlsx_to_html |
| noteviews | 笔记类型视图 | zhixing/view/pages/note_page.py:217 | select_note（按 format 切视图） |
| graphview | GraphPage | zhixing/view/pages/graph_page.py:143 | NodeItem（TextWordWrap 可换行标题） |
| graphview | GraphPage | zhixing/view/pages/graph_page.py:1239 | select_node（四类预览） |
| kit | 主题引擎 | zhixing/view/kit/theme.py:59 | ThemeEngine |
| svc | 应用服务 | zhixing/model/application/task_service.py:22 | TaskService |
| svc | 应用服务 | zhixing/model/application/note_service.py:74 | NoteService |
| svc | 应用服务 | zhixing/model/application/flash_service.py:12 | FlashService |
| svc | 应用服务 | zhixing/model/application/graph_service.py:118 | GraphService |
| svc | 应用服务 | zhixing/model/application/review_service.py:12 | ReviewService |
| svc | 应用服务 | zhixing/model/application/search_service.py:51 | SearchService |
| dom | 领域规则 | zhixing/model/domain/entities.py:56 / :99 / :137 | Task / Note(format) / NoteLink·TaskNoteLink |
| qtbridge | Qt Model 桥 | zhixing/model/qt/models.py:44 / :237 / :273 / :307 | TaskTreeModel / NoteListModel / FlashListModel / GroupTreeModel |
| repo | 基础设施 | zhixing/model/infrastructure/repositories.py:55 / :268 / :350 | TaskRepository / NoteRepository / NoteLinkRepository |
| repo | 基础设施 | zhixing/model/infrastructure/fts.py:65 | FTSService |
| db | SQLite | zhixing/model/infrastructure/db.py:111 | Database |
| db | SQLite | zhixing/model/infrastructure/models.py:163 | SCHEMA_VERSION = 6（migrate v1–v6，db.py:108） |
| pylibs | 第三方库 | requirements.txt:6 / :7 | python-docx / openpyxl |

## v0.12 新增组件证据

- 弹窗框架（需求⑤⑥）：zhixing/view/ui/dialog.py（UDialog 195 / DialogType 34 / UInputDialog 361 / DialogTitleBar 101）。
- 笔记类型（需求④⑦）：note_service.py NOTE_FORMAT_* (12–26)、DEFAULT_NOTE_TITLE (29)、Note.format (entities.py:103)、NoteRow.format (models.py:63)、migrate_v6 (db.py:96)。
- Word/Excel 只读预览：note_previews.py parse_docx_to_html(50) / parse_xlsx_to_html(77)；requirements.txt 引入 python-docx/openpyxl。
- 图谱节点可换行标题 + 预览（需求⑧）：graph_page.py NodeItem(143，Qt.TextWordWrap) / select_node(1239)；graph_service.py preview_text(602) / _note_preview(619) / _task_preview(640) / _folder_preview(686) / _flash_preview(711)。
- Windows 打包 stderr 重定向（需求③）：logging_util.py ensure_std_streams(27) / setup_logging(46)；__main__.py:13 入口先行调用。
