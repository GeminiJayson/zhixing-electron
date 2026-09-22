# 竞品对比与差距补齐清单（个人 · 离线）

> **来源说明（v3 · 2026-09-19 联网逐条核对后修订）**：产品能力**已追到官方一手来源**并逐条核对正文。抓取方式有两种，都可复现：① 系统网络栈（Node `fetch`，脚本 `scripts/webfetch-digest.mjs`）；② 本机 `pwsh` + `Invoke-WebRequest`。内置 `web_fetch` 工具不可用，原因是本机代理使用 fake-IP（`198.18.x.x`），被工具判为「非公网地址」而拒绝 —— 这是工具侧限制，不是没有外网。
>
> **本版相对上一版**：把 §2 每条描述逐条对着官方页面核了一遍，改掉 3 处不准确（§3 第 5、6 项已实现的部分、Joplin 的存储细节），补上 §3 缺失的「现状 / 对标来源」两列与 §4 的理由，§6 换成实际抓到的 URL 并列出未核实项。改动清单见 §6.3。
>
> **评估前提**：单机个人使用、**离线优先**、Windows 桌面、数据只在本机一只 SQLite 文件；联网只用于两件可选的事（用户自配的大模型接口、用户自配的外部任务 JSON 接口）。需要服务器 / 账号 / 多人的能力**不算差距**（见 §4）。

## 1. 调研范围与方法

| 类别 | 产品 | 一手来源状态 |
| --- | --- | --- |
| 待办 / 任务 | Todoist、Things 3、TickTick、OmniFocus、Microsoft To Do、Apple 提醒事项、Super Productivity | Todoist / Things / TickTick / OmniFocus / Apple / Super Productivity 已核实正文；Microsoft To Do 支持站不稳定，仅 1 篇取到正文 |
| 知识库 / 笔记 | Obsidian、Logseq、Notion、Roam Research、Apple 备忘录、Bear、Joplin、Anytype、RemNote | Obsidian（经官方文档源仓库）、Logseq、Joplin、Anytype、Bear、Apple 备忘录、RemNote 已核实；Notion / Roam 仅部分核实 |
| 工作流 / 自动化 | Apple 快捷指令、Raycast、Alfred、Keyboard Maestro、n8n（自托管）、Zapier / Make（云端） | 快捷指令 / Raycast / Alfred / n8n 许可证 已核实；Keyboard Maestro 正文 403、Make 403 = 未核实 |
| 二合一（任务 + 知识库） | Obsidian Tasks 插件、Logseq、Anytype、Super Productivity | 均已核实（官方仓库 / 官方文档） |

**日期**：2026-09-19。**方法**：只用官方帮助中心 / 官方手册 / 官方功能页 / 官方仓库 README 与源码；`web_search` 仅用于定位官方 URL；二手评测不作依据。**证据分级**：A 级＝官方页面或仓库正文逐字核对；B 级＝官方页面 200 但正文 JS 渲染，只核对标题/元数据；C 级＝官方仓库 README/源码片段；未核实＝域名被阻断或官方无此说明（后者写「未找到官方说明」）。

**抓取结果（逐域名）**：todoist.com、help.ticktick.com、culturedcode.com、support.omnigroup.com、support.apple.com、doc.anytype.io、super-productivity.com、github.com 均 200 且正文可核对；help.obsidian.md 与 publish.obsidian.md 为 SPA（改用官方文档源仓库 `github.com/obsidianmd/obsidian-help` 与官方插件源码仓库核对）；docs.logseq.com 为 SPA（改用官方 `github.com/logseq/docs` 与 `logseq/logseq`）；joplinapp.org `/help/` 正文可读（首页 `/faq/` 是 JS 壳）；www.keyboardmaestro.com `/documentation/` 403（但官方 wiki `wiki.keyboardmaestro.com/Triggers` 与 `/manual/Macros` 均 200）；docs.n8n.io **首次连接被中断、重试后 200**（`/n8n-community-license`、`/hosting/` 可读）；www.notion.com 连接被关闭（notion.so/help 部分路径可用）；www.make.com 的 `/en/help` 403，但官方 `llms.txt` 与 `help.make.com/on-premise-agent` 均 200。

## 2. 功能矩阵（每格后附一手来源）

| 维度 | 对标怎么做的 | 知行现状 |
| --- | --- | --- |
| 自然语言捕获 | Todoist Quick Add 自然语言日期（`tomorrow at 4 PM`、`every Monday`）与邮件转任务（[quick add](https://www.todoist.com/help/todoist/features/use-task-quick-add-in-todoist-va4Lhpzz)、[邮件](https://www.todoist.com/help/todoist/features/forward-emails-to-todoist-JPJ1V339)）；TickTick Smart Recognition 含**日期/时间/重复/提前提醒**（[官方文章](https://help.ticktick.com/articles/7081924556310446080)）；Things Natural Language（`Sat`、`in four days`）（[features](https://culturedcode.com/things/features/)） | 已有语法糖 `周五前 交付方案 !2 @工作 #客户`（优先级/清单/标签/截止/时刻，`src/shared/capture.ts`）、三个全局热键与命令面板 —— 覆盖面接近；**缺重复规则解析**（该文件中 repeat 匹配为 0，而 `src/shared/recurrence.ts` 已有 RRULE 解析器） |
| **保存的查询 / 智能清单** | Todoist 官方 Filter 语法：`(today \| overdue) & #Work`、`p1 & %email`、`search: Meeting & today`（[官方帮助](https://www.todoist.com/help/todoist/features/introduction-to-filters-V98wIH)）；TickTick Advanced Filter（图形化 AND/OR）与「搜索条件保存为 Filter」（[Advanced Filter](https://help.ticktick.com/articles/7055782240994721792)、[搜索与保存](https://help.ticktick.com/articles/7473275590313771008)）；OmniFocus 自定义 Perspective（[手册](https://support.omnigroup.com/documentation/omnifocus/universal/4.3.3/en/custom-perspectives-pro/)）；Obsidian Bases 官方核心插件（[语法](https://help.obsidian.md/bases/syntax)）；Obsidian Tasks `tasks` 查询块（[官方仓库](https://github.com/obsidian-tasks-group/obsidian-tasks)）；Super Productivity saved views（[site](https://super-productivity.com/)） | **只有四个固定视图**（列表/四象限/日历/看板），筛选是临时的、无保存（全库 grep `savedFilter` / `smartList` = 0）——**最大差距** |
| 检索与命令 | Obsidian Search 核心插件有**字段操作符与否定**（`path:`、`file:`、`OR`、`-`、括号）（[官方帮助](https://help.obsidian.md/plugins/search)）；Things Quick Find + Type Travel；Alfred Workflows 的 list/script filter（[workflows](https://www.alfredapp.com/help/workflows/)） | FTS5 + jieba 中文分词 + 命令面板；但查询表达式只是「前缀 AND」（`src/main/db/fts-query.ts`），**没有字段操作符、否定与分组** —— 检索强，查询弱 |
| 组织与层级 | Things：Area → Project → Heading → To-do；TickTick：List → Folder，子任务**最多 5 级**（[官方文章](https://help.ticktick.com/articles/7055782219767349248)）；OmniFocus：Inbox/项目/文件夹/动作组/动作 + 可嵌套标签（[手册](https://support.omnigroup.com/documentation/omnifocus/universal/4.3.3/en/perspectives/)） | 清单 + 多层子任务 + 标签 + 优先级 0–8 + 文件夹树（两层以上）+ 四视图，**齐平或更强** |
| **结构化属性** | Obsidian Properties（YAML frontmatter，类型 text/list/number/checkbox/date/tags）（[官方帮助](https://help.obsidian.md/properties)）；Notion 数据库属性（text/select/status/relation/rollup…）（[官方帮助](https://www.notion.com/help/database-properties)）；Anytype 以 type + relation 组织（[官方文档](https://doc.anytype.io/)） | 笔记只有 标题/格式/标签/钉住/文件夹 —— **确为差距** |
| **模板 / 日记** | Obsidian Templates 与 Daily notes **均为官方核心插件**（[核心插件清单](https://help.obsidian.md/plugins)、[Templates](https://help.obsidian.md/plugins/templates)、[Daily notes](https://help.obsidian.md/plugins/daily-notes)）；Todoist Templates（[help](https://www.todoist.com/help)）；Things Templates（[support](https://culturedcode.com/things/support/)） | 工作流有模板分类树；**笔记没有模板与日记** |
| **提醒** | TickTick 多级提醒与 Constant/Repeat Reminder、重复任务（[提醒与重复](https://help.ticktick.com/articles/7055782206349770752)）；Microsoft To Do 截止日期与提醒（[官方支持](https://support.microsoft.com/en-us/office/add-due-dates-and-reminders-in-microsoft-to-do-064d9696-08d1-4433-bfdd-f661dc97491f)）；Things time-based reminders（[features](https://culturedcode.com/things/features/)） | 已有 `reminder_at` 到点提醒：**主窗口内**卡片弹窗、30 秒轮询、稍后 5/15/30 分钟（`src/renderer/src/components/ReminderPopup.tsx`）；**未使用系统通知 API**（`src` 全库 grep `Notification` = 0）。`due_date` 只有日期，时刻由 `reminder_at` 承担 |
| 提醒与日历集成（外部日历） | TickTick 支持 CalDAV 与日历双向（[CalDAV](https://help.ticktick.com/articles/7209388126463066112)、[日历集成](https://help.ticktick.com/articles/7055781593733922816)）；Todoist 日历集成（[官方帮助](https://www.todoist.com/help/todoist/integrations/use-the-calendar-integration-with-todoist-E4tMS9KM)） | 有内置日历视图；**无 ICS / CalDAV**（全库匹配 = 0）——「离线可做」的部分见 §3-8 |
| 回顾与统计 | OmniFocus Review 视角（逐项审查）（[手册](https://support.omnigroup.com/documentation/omnifocus/universal/4.3.3/en/perspectives/)）；TickTick Achievement 与完成趋势（[官方文章](https://help.ticktick.com/articles/7082302534169133056)）；Super Productivity 时间追踪 / worklog / reflections（[官方 Wiki](https://github.com/super-productivity/super-productivity/wiki)）；Todoist Karma / Insights（[Karma](https://www.todoist.com/help/todoist/features/introduction-to-karma-OgWkWy)） | **不缺统计面板**：回顾页已有今日计数、周趋势、热力图、连续天数、成就、标签分布（`ReviewStats`，`src/shared/types.ts`）+ 番茄钟落库；缺 OmniFocus 式逐项审查流程与「按任务的累计用时」 |
| 工作流 / 自动化触发 | Apple 快捷指令与 App Intents：动作在 **app 进程内本机执行**（[App Intents](https://developer.apple.com/documentation/appintents)、[WWDC22 逐字稿](https://developer.apple.com/videos/play/wwdc2022/10032/)、[手册](https://support.apple.com/guide/shortcuts/welcome/ios)）；Alfred Workflows 由热键/关键字/文件动作触发，属 **Powerpack 买断**（[workflows](https://www.alfredapp.com/help/workflows/)、[powerpack](https://www.alfredapp.com/help/powerpack/)）；Keyboard Maestro 触发器含 Hot Key / Cron / Time of Day / Folder / Clipboard Changed 等，买断制、无账号（[Triggers](https://wiki.keyboardmaestro.com/Triggers)、[Macros](https://wiki.keyboardmaestro.com/manual/Macros)）；n8n 节点编排（[官方仓库](https://github.com/n8n-io/n8n)） | 节点编排更细（条件 / 脚本 / 退出码 / 分支），但**只能手动或任务状态驱动启动**（全库无 cron/定时触发） |
| 扩展性 | Obsidian 社区插件与主题（Bases 是核心插件；**Dataview 与 Local REST API 都是社区插件**，非官方）（[社区插件](https://help.obsidian.md/community-plugins)、[Dataview](https://community.obsidian.md/plugins/dataview)、[Local REST API](https://community.obsidian.md/plugins/obsidian-local-rest-api)）；Raycast Extension API（[developers](https://developers.raycast.com/)）；Joplin 插件 + API（[插件](https://joplinapp.org/help/apps/plugins/)、[API](https://joplinapp.org/help/api/get_started/plugins/)）；Logseq 插件 API（[docs](https://plugins-doc.logseq.com/)）；Super Productivity 插件系统（[官方文档](https://github.com/super-productivity/super-productivity/blob/master/docs/plugin-development.md)）；Raycast 扩展开发**需要登录**（[getting started](https://developers.raycast.com/basics/getting-started)、[账号管理](https://manual.raycast.com/account-management)） | 主题包可换 + 工作流脚本动作 + `zhixing://` 深链（task/note/flash/folder，可带 `?block=`，`src/shared/deep-link.ts`）；**无插件 / 用户脚本目录** |
| 数据与离线 | Things：本地数据库，GDPR 导出即**标准 SQLite 文件**（[官方文章](https://culturedcode.com/things/support/articles/2982272/)）；Joplin 官方原文 "Joplin is offline first, which means you always have all your data on your phone or computer."（[官方帮助](https://joplinapp.org/help/)）；Super Productivity "Offline & Private by Default"（[site](https://super-productivity.com/)）；Anytype 官方原文「可完全离线 / 可自托管 / 端到端加密」（[文档](https://doc.anytype.io/anytype/data/sync-and-backup)）；Obsidian 纯 Markdown 本地 vault（[data-storage](https://help.obsidian.md/data-storage)） | SQLite 本地单文件 + JSON/CSV/Markdown/Markdown-ZIP 导出 + Markdown 文件夹导入 + 备份（`src/main/db/export.ts`）——**离线这一项强于全部云系竞品**；不是「文件即数据」是取舍（§3-11） |

> 「二合一（任务 + 知识库）」的成熟做法：Obsidian Tasks 把任务写在 Markdown 里、用查询块跨库汇总（[官方仓库](https://github.com/obsidian-tasks-group/obsidian-tasks)）；Logseq 用大纲块 + simple query / Datalog advanced query（[Queries](https://github.com/logseq/docs/blob/master/pages/Queries.md)、[Advanced Queries](https://github.com/logseq/docs/blob/master/pages/Advanced%20Queries.md)）；Anytype 用对象 + relation（[文档](https://doc.anytype.io/)）。知行用「任务表 + 笔记表 + 关联表 + 段落 block_key」实现同类效果，**形态不同但能力齐平**；缺块级引用（§3-7）。

## 3. 差距补齐清单（按个人离线价值排序）

| # | 差距 | 现状（知行） | 对标怎么做（官方来源） | 建议做法（离线可实现） | 成本 / 迁移 |
| --- | --- | --- | --- | --- | --- |
| 1 | **保存的查询（智能清单）** | 四个固定视图；筛选临时、不可保存 | Todoist Filter（[官方帮助](https://www.todoist.com/help/todoist/features/introduction-to-filters-V98wIH)）；TickTick Advanced Filter 与保存（[文章](https://help.ticktick.com/articles/7473275590313771008)）；Obsidian Bases / Tasks 查询块（[语法](https://help.obsidian.md/bases/syntax)、[仓库](https://github.com/obsidian-tasks-group/obsidian-tasks)） | 在现有字段与 FTS 上做本地查询 DSL（`tag:写作 & due<today & !done`），保存后进侧栏、可固定到今日页；纯本地求值 | 中 / 新增 `saved_query` 表 |
| 2 | **笔记结构化属性** | 只有 标题/格式/标签/钉住/文件夹 | Obsidian Properties（[官方帮助](https://help.obsidian.md/properties)）；Notion 数据库属性（[官方帮助](https://www.notion.com/help/database-properties)） | 笔记加键值属性（本地 JSON 列），在列表/看板作为列筛选与展示 | 中 / note 加列或新增 `note_property` 表 |
| 3 | **工作流触发器（定时 / 事件）** | 只能手动启动或任务状态驱动 | Apple 快捷指令自动化（[手册](https://support.apple.com/guide/shortcuts/welcome/ios)）；Alfred 触发器（[workflows](https://www.alfredapp.com/help/workflows/)） | 模板加触发器：每天定时、开机后、文件夹变化、剪贴板匹配（本地定时器 + `fs.watch`） | 中 / 新增触发器配置 |
| 4 | **笔记模板 + 日记** | 新建笔记为空白 | Obsidian Templates / Daily notes 官方核心插件（[清单](https://help.obsidian.md/plugins)） | 模板目录 + 日期变量 + 一键「今日笔记」并把当日任务写入 | 小 / 不需要新表 |
| 5 | **到点提醒的系统通知** | 提醒弹窗只在主窗口内渲染；未使用系统通知 API（grep `Notification` = 0） | TickTick Constant / Repeat Reminder（[文章](https://help.ticktick.com/articles/7055782206349770752)）；Microsoft To Do 提醒（[官方支持](https://support.microsoft.com/en-us/office/add-due-dates-and-reminders-in-microsoft-to-do-064d9696-08d1-4433-bfdd-f661dc97491f)） | 用 Electron `Notification`（Windows Toast）；窗口隐藏/托盘时也能提醒；补一条「错过的提醒」清单。**截止时刻本身已由 `reminder_at` 支持**，不必再加字段 | **小** / 不需要新表 |
| 6 | **按任务的累计用时** | 已有番茄钟落库并在回顾页按周汇总（`pomodoro_session`、`ReviewStats`） | Super Productivity 时间追踪 / worklog（[官方 Wiki](https://github.com/super-productivity/super-productivity/wiki)） | 在已有番茄钟数据上加「按任务 / 按标签累计用时」；习惯先用「重复任务 + 连续天数（`task.streak` 已存在）」近似 | 中 / 复用 `pomodoro_session` |
| 7 | **块级引用** | 已有「段落 ↔ 任务」关联（`task_note_context` + `block_key`），但笔记内不能引用另一段落 | Logseq blocks 与块引用（[官方 docs 仓库](https://github.com/logseq/docs)）；Obsidian 块链接（[Links 页](https://help.obsidian.md/links) 正文未逐字核对） | 复用同一套 `block_key`：笔记内支持 `((块引用))` 或 `^blockid` + 反链面板 | 中 / 扩展 `note_link` 或新增表 |
| 8 | **日历互操作（.ics 导出）** | 有内置日历视图；无 ICS / CalDAV | TickTick CalDAV 与日历双向（[文章](https://help.ticktick.com/articles/7209388126463066112)）；Todoist 日历集成（[官方帮助](https://www.todoist.com/help/todoist/integrations/use-the-calendar-integration-with-todoist-E4tMS9KM)） | 只做**单向导出**：把带 due/reminder 的任务导出 `.ics`，用户自行订阅进 Windows 日历 / Outlook / 手机；无服务器、无凭据 | 小 / 不需要新表 |
| 9 | **笔记的数据库视图** | 笔记页只有列表与文件夹树 | Obsidian Bases 视图（[官方帮助](https://help.obsidian.md/bases/syntax)）；Notion 数据库视图（[官方帮助](https://www.notion.com/help/database-properties)） | 依赖 1 + 2 完成后再做 | 中 / 依赖 1、2 |
| 10 | **用户脚本扩展点 + 外部调用入口** | 工作流可执行命令/脚本，但动作类型固定；已有 `zhixing://` 深链 | Raycast Extension API（[developers](https://developers.raycast.com/)）；Super Productivity 插件系统（[官方文档](https://github.com/super-productivity/super-productivity/blob/master/docs/plugin-development.md)）；Things URL Scheme 的 `add` 命令（[官方文章](https://culturedcode.com/things/support/articles/2803573/)）；Bear x-callback-url 与 CLI（[x-callback-url](https://bear.app/faq/x-callback-url-scheme-documentation/)、[CLI](https://bear.app/faq/command-line-interface/)）；Obsidian Tasks 是**本地运行的社区插件**，查询在本机执行、无账号（[安装文档](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/main/docs/Getting%20Started/Installation.md)） | ① `<数据目录>/scripts/` 的脚本作为命令面板/工作流动作；② 把深链扩成能**创建**对象（对标 Things `add`） | 小到中 / 不需要新表 |
| 11 | **自由画布** | 图谱为自动布局 | Obsidian Canvas 为**官方核心插件**（[清单](https://help.obsidian.md/plugins)）；Logseq Whiteboards（[docs](https://docs.logseq.com/)） | 价值中等：图谱已覆盖「看关系」，画布偏手工摆想法 | 大 / 新增表 |
| 12 | **数据即 Markdown 文件** | SQLite + 导出/备份 | Obsidian 纯 Markdown vault（[data-storage](https://help.obsidian.md/data-storage)）；Logseq Markdown/Org 文件（[官方仓库](https://github.com/logseq/logseq)） | **不建议改**：保持「导出 Markdown 文件夹 + JSON 备份」 | — / 不做 |
| 13 | **语音 / OCR 输入** | 无 | TickTick 有语音添加，但本次**未抓到可引用的官方文章 URL** → 未核实 | 依赖系统能力，收益有限 | — / 不做 |

## 4. 明确不做（与「个人 · 离线」冲突，逐条给理由）

| 方向 | 为什么不做 |
| --- | --- |
| 账号体系 / 云同步 / 多端实时 | 数据只在本机；云同步会引入账号、服务器与冲突合并的全部复杂度。竞品代价可见：Todoist 离线模式**也必须已登录**（[官方帮助](https://www.todoist.com/help/todoist/features/use-todoist-while-offline-4rbaZw)）；Apple 提醒事项的标签与智能列表**仅对 iCloud 账户列表可用**（[官方支持](https://support.apple.com/en-us/119953)）；Anytype 默认加入 Anytype Network 才有同步（[文档](https://doc.anytype.io/anytype/data/sync-and-backup)）；Notion / Roam / RemNote 为云端服务（[Notion 发布说明](https://www.notion.com/releases/2025-08-19)、[RemNote 定价](https://www.remnote.com/pricing)） |
| 协作、共享清单、评论 @ 人 | 单人使用，没有第二个参与者；Microsoft To Do 的共享任务以账号为前提（[官方支持](https://support.microsoft.com/en-us/todo)）；Roam 首页自述支持实时协作（[roamresearch.com](https://roamresearch.com/)） |
| 在线发布（Obsidian Publish 类） | 需要托管服务，与「数据不出本机」冲突；Obsidian 的 Sync 与 Publish 均为**付费官方云服务**（[定价](https://obsidian.md/pricing)、[Sync 帮助](https://help.obsidian.md/sync)） |
| 团队权限 / 多人泳道 | 权限模型只在有第二个人时才成立；同上 |
| 需要服务器或账号的自动化（Zapier / Make / 云端 n8n） | Zapier 官方产品说明称由它统一运行与治理，且 Free/Pro 为**单用户账号制**（[What is Zapier](https://help.zapier.com/hc/en-us/articles/37518970271245-What-is-Zapier)、[定价](https://zapier.com/pricing)、[条款](https://zapier.com/terms)）；n8n 虽可自托管且社区版免费，但**必须常驻一个服务进程**（官方 Docker 文档：暴露 5678 端口、默认用 SQLite 存凭据与执行历史），并受 Sustainable Use License 约束（[community license](https://docs.n8n.io/n8n-community-license)、[hosting](https://docs.n8n.io/hosting/)、[官方 LICENSE](https://github.com/n8n-io/n8n/blob/master/LICENSE.md)，含 "internal business purposes" 用途限制）；Make 是云端可视化编排平台、按 operations 计费，其 On-premise agent 也只用于让云端场景访问内网（[llms.txt](https://www.make.com/llms.txt)、[on-premise agent](https://help.make.com/on-premise-agent)） |
| 联网 AI 默认开启 | 已实现为**可选**（用户自配端点与提示词），保持这个边界 |
| 位置提醒 | Windows 桌面没有移动场景；对标的 Apple 提醒 / Things / TickTick 位置提醒依赖手机，属平台不适用 |

## 5. 如果只做三件事

1. **保存的查询** —— Todoist Filter / OmniFocus Perspective / Obsidian Bases 与 Tasks 查询块的共同内核，也是知行唯一「结构性缺失」。做完立刻改变日常用法（从「翻视图」变成「看几件定义好的事」），且纯本地求值。
2. **笔记属性（+ 属性视图）** —— 让笔记从「文档」变成可筛条目，是后续视图能力（§3-9）的地基。
3. **工作流触发器** —— 编排能力已经强于多数离线竞品，缺的只是「不用人按按钮就能开始」。

> **本次调研的补充意见（供决策，未改动上面的排序）**：若只看投入产出比，第 3 位建议换成 **§3-5「到点提醒的系统通知」** —— 它只需接上 Electron `Notification`（不需要新表），而现状是提醒只在主窗口内可见，窗口收进托盘时等于没有提醒；「工作流触发器」可顺延为第 4。

## 6. 来源与未核实项

### 6.1 已核对的官方来源

- **Todoist**：[Filter 语法](https://www.todoist.com/help/todoist/features/introduction-to-filters-V98wIH) ・ [Quick Add](https://www.todoist.com/help/todoist/features/use-task-quick-add-in-todoist-va4Lhpzz) ・ [自然语言重复日期](https://www.todoist.com/help/todoist/features/introduction-to-recurring-dates-YUYVJJAV) ・ [子任务](https://www.todoist.com/help/todoist/features/use-sub-tasks-in-todoist-kMamDo) ・ [离线须登录](https://www.todoist.com/help/todoist/features/use-todoist-while-offline-4rbaZw) ・ [邮件转任务](https://www.todoist.com/help/todoist/features/forward-emails-to-todoist-JPJ1V339) ・ [日历集成](https://www.todoist.com/help/todoist/integrations/use-the-calendar-integration-with-todoist-E4tMS9KM) ・ [Karma](https://www.todoist.com/help/todoist/features/introduction-to-karma-OgWkWy) ・ [Insights](https://www.todoist.com/help/todoist/features/introduction-to-insights-mK9DieWyP) ・ [API](https://developer.todoist.com/api/v1/) ・ [定价](https://www.todoist.com/pricing)
- **Things 3**：[features](https://culturedcode.com/things/features/) ・ [support](https://culturedcode.com/things/support/) ・ [URL Scheme](https://culturedcode.com/things/support/articles/2803573/) ・ [Shortcuts 动作](https://culturedcode.com/things/support/articles/9596775/) ・ [导出为标准 SQLite](https://culturedcode.com/things/support/articles/2982272/) ・ [Things Cloud](https://culturedcode.com/things/cloud/)
- **TickTick**：[Smart Recognition](https://help.ticktick.com/articles/7081924556310446080) ・ [层级与子任务](https://help.ticktick.com/articles/7055782219767349248) ・ [Advanced Filter](https://help.ticktick.com/articles/7055782240994721792) ・ [搜索保存为 Filter](https://help.ticktick.com/articles/7473275590313771008) ・ [成就与趋势](https://help.ticktick.com/articles/7082302534169133056) ・ [提醒与重复](https://help.ticktick.com/articles/7055782206349770752) ・ [日历集成](https://help.ticktick.com/articles/7055781593733922816) ・ [CalDAV](https://help.ticktick.com/articles/7209388126463066112) ・ [备份与导入](https://help.ticktick.com/articles/7055781405648748544) ・ [URL Scheme](https://help.ticktick.com/articles/7055781515422072832)
- **OmniFocus**：[Perspectives](https://support.omnigroup.com/documentation/omnifocus/universal/4.3.3/en/perspectives/) ・ [Custom Perspectives Pro](https://support.omnigroup.com/documentation/omnifocus/universal/4.3.3/en/custom-perspectives-pro/) ・ [Managing Your Data](https://support.omnigroup.com/documentation/omnifocus/universal/4.3.3/en/managing-your-data/) ・ [Omni Automation](https://www.omni-automation.com/omnifocus/)
- **Microsoft To Do / Apple 提醒事项**：[截止日期与提醒](https://support.microsoft.com/en-us/office/add-due-dates-and-reminders-in-microsoft-to-do-064d9696-08d1-4433-bfdd-f661dc97491f) ・ [Graph To Do API](https://learn.microsoft.com/en-us/graph/api/resources/todo-overview) ・ [Apple 提醒整理](https://support.apple.com/en-us/119953) ・ [快捷指令手册](https://support.apple.com/guide/shortcuts/welcome/ios) ・ [App Intents](https://developer.apple.com/documentation/appintents)
- **Super Productivity**：[官网](https://super-productivity.com/) ・ [官方仓库](https://github.com/super-productivity/super-productivity) ・ [Wiki](https://github.com/super-productivity/super-productivity/wiki) ・ [插件开发](https://github.com/super-productivity/super-productivity/blob/master/docs/plugin-development.md)
- **Obsidian**：[Bases 语法](https://help.obsidian.md/bases/syntax) ・ [Properties](https://help.obsidian.md/properties) ・ [核心插件清单](https://help.obsidian.md/plugins) ・ [Search 操作符](https://help.obsidian.md/plugins/search) ・ [Backlinks](https://help.obsidian.md/plugins/backlinks) ・ [data-storage](https://help.obsidian.md/data-storage) ・ [Sync](https://help.obsidian.md/sync) ・ [社区插件](https://help.obsidian.md/community-plugins) ・ [Web Clipper](https://obsidian.md/clipper) ・ [定价](https://obsidian.md/pricing)；文档源仓库 [obsidian-help](https://github.com/obsidianmd/obsidian-help)
- **Logseq**：[官方仓库](https://github.com/logseq/logseq) ・ [db-version](https://github.com/logseq/docs/blob/master/db-version.md) ・ [Queries](https://github.com/logseq/docs/blob/master/pages/Queries.md) ・ [Advanced Queries](https://github.com/logseq/docs/blob/master/pages/Advanced%20Queries.md) ・ [Export](https://github.com/logseq/docs/blob/master/pages/Export.md) ・ [插件 API](https://plugins-doc.logseq.com/) ・ [docs.logseq.com](https://docs.logseq.com/)
- **Joplin**：[offline first 与总览](https://joplinapp.org/help/) ・ [E2EE 规范](https://joplinapp.org/help/dev/spec/e2ee/) ・ [插件](https://joplinapp.org/help/apps/plugins/) ・ [插件 API](https://joplinapp.org/help/api/get_started/plugins/) ・ [导入导出](https://joplinapp.org/help/apps/import_export/) ・ [版本历史](https://joplinapp.org/help/apps/note_history/) ・ [同步后端](https://joplinapp.org/help/apps/sync/) ・ [官方仓库](https://github.com/laurent22/joplin)
- **Anytype**：[同步与备份（local-first 原文）](https://doc.anytype.io/anytype/data/sync-and-backup) ・ [导入导出](https://doc.anytype.io/anytype/data/import-and-export) ・ [Backlinks](https://doc.anytype.io/anytype/documentation_cn/ji-chu/relations/backlinks) ・ [开发者 API](https://developers.anytype.io/docs/reference/2025-03-17/export-object/)
- **Notion / Roam / Bear / RemNote / Apple 备忘录**：[Notion 离线模式发布说明](https://www.notion.com/releases/2025-08-19) ・ [Notion 数据库属性](https://www.notion.com/help/database-properties) ・ [Notion 导出](https://www.notion.com/help/back-up-your-data) ・ [Notion API](https://developers.notion.com/reference/intro) ・ [Roam](https://roamresearch.com/) ・ [Roam Depot](https://github.com/Roam-Research/roam-depot) ・ [Bear 导出](https://bear.app/faq/export-your-notes/) ・ [Bear x-callback-url](https://bear.app/faq/x-callback-url-scheme-documentation/) ・ [Bear CLI](https://bear.app/faq/command-line-interface/) ・ [RemNote 离线模式](https://www.remnote.com/feature/offline-mode) ・ [RemNote 导出](https://help.remnote.com/en/articles/7898019-exporting-notes) ・ [RemNote backlinks](https://help.remnote.com/en/articles/6030776-backlinks) ・ [RemNote 插件 API](https://plugins.remnote.com/advanced/rem_api) ・ [Apple 备忘录导出/导入](https://support.apple.com/guide/notes/not201900c07/mac)
- **自动化 / 工作流**：[Raycast Extension API](https://developers.raycast.com/) ・ [Raycast 扩展开发需登录](https://developers.raycast.com/basics/getting-started) ・ [Raycast 账号管理](https://manual.raycast.com/account-management) ・ [Alfred Workflows](https://www.alfredapp.com/help/workflows/) ・ [Alfred Powerpack](https://www.alfredapp.com/help/powerpack/) ・ [Keyboard Maestro Triggers](https://wiki.keyboardmaestro.com/Triggers) ・ [Keyboard Maestro Macros](https://wiki.keyboardmaestro.com/manual/Macros) ・ [Keyboard Maestro 官网](https://www.keyboardmaestro.com/main/) ・ [Apple App Intents](https://developer.apple.com/documentation/appintents) ・ [WWDC22 App Intents 逐字稿](https://developer.apple.com/videos/play/wwdc2022/10032/) ・ [n8n community license](https://docs.n8n.io/n8n-community-license) ・ [n8n hosting](https://docs.n8n.io/hosting/) ・ [n8n LICENSE](https://github.com/n8n-io/n8n/blob/master/LICENSE.md) ・ [n8n legal](https://n8n.io/legal/) ・ [Zapier What is Zapier](https://help.zapier.com/hc/en-us/articles/37518970271245-What-is-Zapier) ・ [Zapier 定价](https://zapier.com/pricing) ・ [Make llms.txt](https://www.make.com/llms.txt) ・ [Make on-premise agent](https://help.make.com/on-premise-agent)
- **Obsidian Tasks 插件**：[官方仓库 README](https://github.com/obsidian-tasks-group/obsidian-tasks) ・ [查询总览](https://publish.obsidian.md/tasks/Queries/About+Queries) ・ [官方查询示例](https://github.com/obsidian-tasks-group/obsidian-tasks/blob/main/docs/Queries/Examples.md) ・ [重复任务（🔁 every …）](https://publish.obsidian.md/tasks/Getting+Started/Recurring+Tasks)

### 6.2 未核实清单（逐条 + 原因）

| 事项 | 原因 |
| --- | --- |
| Obsidian 帮助单页正文（Bases/Properties/Canvas 等） | help.obsidian.md 是 SPA；本次改从官方文档源仓库 `obsidianmd/obsidian-help` 与官方核心插件清单核对，**未逐页复核正文** |
| Obsidian 块链接的具体语法 | `help.obsidian.md/links` 正文未逐字核对 |
| Keyboard Maestro **主站** `/documentation/` 页 | 该路径返回 403（站点反爬）；已改用官方 wiki（[Triggers](https://wiki.keyboardmaestro.com/Triggers)、[Macros](https://wiki.keyboardmaestro.com/manual/Macros)，均 200）核对触发器与宏结构 |
| Make 帮助中心页 | `www.make.com/en/help` 返回 403；已改用官方 [llms.txt](https://www.make.com/llms.txt) 与 [on-premise agent](https://help.make.com/on-premise-agent) 核对产品定位与计费 |
| n8n 的 **Windows 原生安装**方式 | docs.n8n.io 首次连接被中断、重试后 200（hosting 与 community license 已核对）；Windows 原生安装细节仍未逐条核对 |
| TickTick OpenAPI 端点与限额 | developer.ticktick.com 为 docsify 单页，无 JS 不渲染正文 |
| TickTick / Microsoft To Do 的离线能力 | 官方帮助与支持站未找到专门说明 → 属「未找到官方说明」 |
| Microsoft To Do 除「截止日期与提醒」外的支持文章 | support.microsoft.com 抓取多次连接被重置 |
| Joplin 的本地数据库是否为 SQLite | 已核对的官方页面中未出现该说法 → **不要当作官方事实** |
| Roam Research 的查询语法 / 导出 / 离线 / API | 官方帮助与开发者文档在应用内 graph，仅返回标题 |
| Notion 数据库帮助页 | www.notion.com 连接被关闭；notion.so/help 部分路径 200 但正文 JS 渲染 |
| Bear 的版本历史 | 官方 FAQ 未提供说明（社区帖为二手，不作依据） |
| TickTick 语音添加 | 未抓到可引用的官方文章 URL |
| Raycast 本体能否在未登录状态使用 | 官方只明文说明扩展开发命令需要登录（[getting started](https://developers.raycast.com/basics/getting-started)），未找到「未登录不可用」的声明 |
| OmniFocus 的离线措辞与 CalDAV/ICS | 手册未逐条复核；官方未见专文 |

### 6.3 本版相对上一版改了什么

| 位置 | 改动 |
| --- | --- |
| 来源说明 | 说明 `web_fetch` 失败的真实原因（代理 fake-IP `198.18.x.x` 被判非公网），并列出可复现的两种抓取方式 |
| §2 提醒行 | **纠正**：上一版写「到点提醒待核实」。实测：到点提醒**已存在**（主窗口内卡片、30 秒轮询、5/15/30 稍后），缺的是**系统级通知**；且时刻已由 `reminder_at` 承担，「只有日期」指的是 `due_date` |
| §2 统计行 | **纠正**：上一版把「时间统计」列为缺口。实测回顾页**已有**周趋势、热力图、连续天数、成就、标签分布与番茄汇总（`ReviewStats`），缺口收窄为「按任务的累计用时」 |
| §2 数据行 | **纠正**：上一版把 Joplin 描述为「端到端加密 + 同步」。已核实官方原文为 offline first，并注明 **Joplin 是否 SQLite 未找到官方说明** |
| §2 扩展性行 | **补充**：标注 Obsidian 的 **Dataview 与 Local REST API 都是社区插件**，不能算官方对标 |
| §2 捕获行 | **精确化**：语法糖覆盖面接近，具体缺口是**不解析重复规则**（而 RRULE 解析器已存在） |
| §3 | 恢复被上一版去掉的「现状」「对标来源」两列，并补上「是否需要迁移」；新增 #8 日历互操作（.ics 导出）、#13 语音（标注未核实） |
| §4 | 由一段文字改为逐条表格，每条给出理由与官方来源；新增「位置提醒（平台不适用）」 |
| §5 | 保留原排序，另加一条明确标注的「补充意见」：建议第 3 位换成系统级通知（成本小、每天遇到），工作流触发器顺延第 4 |
| §6 | 换成实际抓到的官方 URL（分组列出），新增「未核实清单」，并说明未核实项在正文中如何标注 |
| §2 扩展性 / 自动化行 | **纠正与补充**：上一版引的 Keyboard Maestro 触发器 URL（`wiki.../manual/Triggers`）实为 404，正确页是 `/Triggers`；补充 Raycast 扩展开发**需登录**、Alfred Workflows 属 Powerpack 买断、Apple App Intents 在 app 进程内本机执行 |
| §4 n8n / Zapier / Make 行 | **补强**：n8n 自托管需常驻服务进程（官方 Docker 文档：5678 端口、默认 SQLite）；Make 由「未核实」改为引用官方 llms.txt 与 on-premise agent 页；Zapier 补官方产品说明 |
| §6.2 | 上一版记为「未核实」的 Keyboard Maestro、Make、docs.n8n.io 三处，重试后均取得官方正文，已降级为「已核对」；清单只保留真正无法核对的部分 |

复现抓取：`node scripts/webfetch-digest.mjs`（上一版作者提供的脚本，内置目标与关键词）；本版另用 `pwsh` + `Invoke-WebRequest` 复核了其中一批 URL 的状态码与关键词。

