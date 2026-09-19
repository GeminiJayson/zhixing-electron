# 竞品对比与差距补齐清单（个人 · 离线）

> **来源说明**：本报告的产品能力**已尽量追到官方页面**。抓取方式是系统网络栈（Node `fetch`）而不是内置的 `web_fetch` 工具 —— 后者会把代理软件的 fake-IP（`198.18.x.x`）判为「非公网」而拒绝。抓取脚本：`scripts/webfetch-digest.mjs`。
> 已抓到官方页面的产品：Things 3、TickTick、Todoist（帮助中心目录）、Alfred、Logseq、Obsidian（帮助仓库）、Super Productivity、Raycast、Joplin。**未抓到细节的**：OmniFocus（官方支持页是索引页）、Notion（帮助页 404 或需登录）、Obsidian 的 Properties / Bases / Canvas 单页（站点是客户端渲染，只拿到标题）—— 这三处见 §6「未核实」。
>
> **评估前提**：单机个人使用、**离线优先**、Windows 桌面。需要服务器 / 账号 / 多人的能力**不算差距**（见 §4）。

## 1. 调研范围与方法

| 类别 | 产品 | 一手来源状态 |
| --- | --- | --- |
| 待办 | Things 3、TickTick、Todoist、OmniFocus、Super Productivity | Things/TickTick/Todoist/SP 已核实；OmniFocus 仅索引页 |
| 知识库 | Obsidian、Logseq、Joplin、Notion | 部分核实（见上） |
| 工作流 / 自动化 | Alfred、Raycast、Apple 快捷指令 | 已核实（Alfred Workflows / Raycast Extension API / 快捷指令指南） |

## 2. 功能矩阵（每格后附一手来源）

| 维度 | 对标怎么做的 | 知行现状 |
| --- | --- | --- |
| 自然语言捕获 | Things：Natural Language Recognition，输入 `Tom` / `Sat` / `in four days` 自动排期（[features](https://culturedcode.com/things/features/)）；TickTick：NLP 自动识别日期时间（[home](https://www.ticktick.com/home)）；Things：自然语言设日期/提醒/截止（[support](https://culturedcode.com/things/support/)） | 已有语法糖 `!2 @列表 #标签 明天`（快速添加）——**基本齐平**，但缺「以自然语言选日期」的完整覆盖面 |
| **保存的查询 / 智能清单** | TickTick：Filter「自定义筛选，例如『本周高优先级任务』」（[home](https://www.ticktick.com/home)）；Super Productivity：**「把符合你习惯的视图保存下来」（save the views that match your rituals）**（[site](https://super-productivity.com/)）；Todoist：帮助中心有独立 Filters 分类（[help](https://www.todoist.com/help)） | **只有四个固定视图**（列表/四象限/日历/看板）——**最大差距** |
| **习惯 / 重复与统计** | TickTick：**Habit Tracker**（习惯库、灵活打卡、统计）（[home](https://www.ticktick.com/home)、[help](https://help.ticktick.com/)）；Super Productivity：repeating tasks「为习惯与维护性工作设置精细重复」+ **一键时间追踪**（[site](https://super-productivity.com/)） | 有重复规则、有番茄钟；**缺习惯打卡与时间统计** |
| **提醒强度** | TickTick：**Constant Reminder**（通知持续响到完成为止）+ **Repeat Reminder**（[home](https://www.ticktick.com/home)）；Things：**time-based reminders**「绝不能错过的待办」（[features](https://culturedcode.com/things/features/)） | 有截止日期（**只有日期**）；到点提醒**待核实** |
| **模板** | Things：Templates「复用清单与项目」（[support](https://culturedcode.com/things/support/)）；Todoist：帮助中心 Templates 分类（[help](https://www.todoist.com/help)） | 工作流有模板；**笔记没有模板 / 日记** |
| 组织与层级 | Things：Area → Project → Heading → To-do；标签全局过滤（[features](https://culturedcode.com/things/features/)） | 清单 + 多层子任务 + 标签 + 文件夹树 + 双链，**齐平** |
| 检索与命令 | Things：Quick Find + Type Travel；Alfred：**Workflows 可用 list/script filter 与 JSON 自定义结果**（[workflows](https://www.alfredapp.com/workflows/)） | FTS5 + 中文分词 + 命令面板，**强于多数离线竞品** |
| 扩展性 | Raycast：官方 **Extension API**（[developers](https://developers.raycast.com/)）；Logseq：**插件与主题生态**（[README](https://raw.githubusercontent.com/logseq/logseq/master/README.md)）；Joplin：插件 + 自定义主题 + 网页剪藏（[joplinapp.org](https://joplinapp.org/)） | 主题包可换；**无插件/用户脚本目录** |
| 数据与离线 | Logseq：「privacy-first, open-source」（[README](https://raw.githubusercontent.com/logseq/logseq/master/README.md)）；Super Productivity：「offline, private, and yours to shape」（[site](https://super-productivity.com/)）；Joplin：端到端加密 + 同步 | SQLite 本地单文件 + 导出备份，**同档次**，但**不是「文件即数据」** |
| 工作流 / 自动化触发 | Alfred：Workflows 由热键/关键字/文件动作触发；Apple 快捷指令：多种触发；Keyboard Maestro：触发器体系（页面 404，未核实） | 节点编排更细（条件 / 脚本 / 退出码），但**只能手动或任务驱动启动** |
| 画布 / 白板 | Obsidian Canvas（只拿到标题，未核实正文） | 图谱是自动布局，**无自由画布** |

## 3. 差距补齐清单（按个人离线价值排序）

| # | 差距 | 建议做法（离线可实现） | 成本 |
| --- | --- | --- | --- |
| 1 | **保存的查询（智能清单）** | 在现有任务字段与 FTS 上做本地查询 DSL（`tag:写作 & due<today & !done`），保存后进侧栏；对齐 TickTick Filter 与 Super Productivity saved views 的用法 | 中（新增 `saved_query` 表） |
| 2 | **笔记结构化属性** | 笔记加键值属性（本地 JSON 列），作为列表/看板列展示 —— Obsidian Properties / Notion 字段的最小内核 | 中 |
| 3 | **工作流触发器（定时 / 事件）** | 模板加触发器：每天定时、开机后、文件夹变化、剪贴板匹配 —— 把已有的编排能力接上「自动开始」 | 中 |
| 4 | **笔记模板 + 日记** | 模板目录 + 日期变量 + 一键「今日笔记」；对标 Things Templates | 小 |
| 5 | **截止「时刻」+ 到点提醒（含持续提醒）** | 截止支持时刻；到点用系统 Notification；可选「未完成就重复提醒」（对标 TickTick Constant/Repeat Reminder） | 小 |
| 6 | **习惯打卡 + 时间统计** | 复用重复任务做习惯、番茄钟落库做统计；对标 TickTick Habit / SP Time tracking | 中 |
| 7 | **块级引用** | 复用现有 `block_key` 指纹，做笔记内 `((block))` 引用与反链 | 中 |
| 8 | **笔记的数据库视图** | 依赖 1 + 2 完成后再做 | 中 |
| 9 | **用户脚本扩展点** | `<数据目录>/scripts/` 里的脚本作为命令面板 / 工作流动作（离线版 Extension API） | 小到中 |
| 10 | **自由画布** | 对标 Obsidian Canvas；价值中等 | 大 |
| 11 | 数据即 Markdown 文件 | **不建议改**：会破坏与 Python 版共库前提 | — |
| 12 | 语音 / OCR 输入 | 依赖系统能力，收益有限 | — |

## 4. 明确不做（与「个人 · 离线」冲突）

账号体系 / 云同步 / 多端实时；协作与共享清单；在线发布；团队权限；需要服务器的自动化（云端 Zapier/Make）；联网 AI 默认开启（保持「用户自配」的边界）。

## 5. 如果只做三件事

1. **保存的查询** —— 三家共同的缺失点，做完立刻改变日常用法。
2. **笔记属性（+ 属性视图）** —— 让笔记从「文档」变成可筛条目，是后续视图能力的地基。
3. **工作流触发器** —— 编排能力已经强于多数离线竞品，缺的只是「不用人按按钮」。

## 6. 来源与未核实项

**已抓取的官方页面**
- Things 3：[features](https://culturedcode.com/things/features/)、[support](https://culturedcode.com/things/support/)
- TickTick：[home](https://www.ticktick.com/home)、[help](https://help.ticktick.com/)
- Todoist 帮助中心目录：[help](https://www.todoist.com/help)
- Alfred：[workflows](https://www.alfredapp.com/workflows/)
- Logseq：[README](https://raw.githubusercontent.com/logseq/logseq/master/README.md)、[docs](https://docs.logseq.com/)
- Obsidian：[帮助仓库 README](https://raw.githubusercontent.com/obsidianmd/obsidian-help/master/README.md)
- Super Productivity：[site](https://super-productivity.com/)
- Raycast：[developers](https://developers.raycast.com/)
- Joplin：[joplinapp.org](https://joplinapp.org/)
- Apple 快捷指令：[support.apple.com/guide/shortcuts](https://support.apple.com/guide/shortcuts/welcome/ios)

**未核实（页面是客户端渲染或 404，只拿到标题/索引）**
- Obsidian Properties / Bases / Canvas 单页 —— 站点为 SPA，正文需浏览器渲染
- OmniFocus —— 官方支持页是产品索引，未取得 Perspectives / Defer 的正文说明
- Notion databases 帮助页 —— 404 / 需登录
- Keyboard Maestro Triggers —— 该 URL 返回 404

复现抓取：`node scripts/webfetch-digest.mjs`（内置目标与关键词，输出去标签后的关键片段）。
