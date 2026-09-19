# 竞品对比与差距补齐清单（个人 · 离线）

> **来源说明（重要）**：本机环境**没有可用外网** —— `obsidian.md` / `culturedcode.com` / `docs.logseq.com` / `github.com` 全部被解析为非公网地址，`web_fetch` 一律失败，`web_search` 也只返回商店页与二手页面。因此本文的对标能力来自**模型固有知识**，**未逐条联网核实官方文档**；凡不确定处都标了「待核实」。若需要带官方链接的版本，请在**有外网的环境**重跑一次调研（`/research` 或直接抓各产品官方功能页）。
>
> **评估前提**：单机个人使用、离线优先、Windows 桌面。任何需要服务器 / 账号 / 多人的能力**不算差距**（见 §4）。

## 1. 调研范围

| 类别 | 对标产品 | 为什么看它 |
| --- | --- | --- |
| 待办 | Todoist、Things 3、TickTick、OmniFocus、Microsoft To Do、Super Productivity | 任务模型与「今天该做什么」的组织方式 |
| 知识库 | Obsidian、Logseq、Notion、Roam、Joplin、Anytype、Apple 备忘录 | 双链之外的结构化与检索能力 |
| 工作流 / 自动化 | Apple 快捷指令、Raycast、Alfred、Keyboard Maestro、n8n | 触发模型与扩展点 |
| 二合一 | Obsidian + Tasks 插件、Logseq、Anytype、Super Productivity | 「任务与笔记同一个库」的成熟做法 |

## 2. 功能矩阵（对标产品侧）

| 维度 | 代表做法 | 与本应用的关系 |
| --- | --- | --- |
| 捕获 | Things 快速输入 / Todoist 自然语言日期 / Raycast 全局命令 | 本应用已有三个全局热键 + 语法糖 + 命令面板，**基本齐平** |
| 组织与层级 | Things：Area → Project → Heading → To-do；Obsidian：文件夹 + 标签 + 链接 | 本应用有清单 + 多层子任务 + 标签 + 文件夹树 + 双链，**齐平**（缺 Area/Heading 的语义分层，但可用清单近似） |
| **保存的查询 / 智能清单** | Todoist **Filter**（`@work & 7 days`）、OmniFocus **Perspective**、Obsidian **Bases/Dataview**、TickTick 智能清单 | 本应用**只有固定视图**（列表/四象限/日历/看板）——**最大差距** |
| **结构化属性** | Obsidian **Properties/Frontmatter**、Notion database 字段、Anytype type+relation | 本应用笔记只有 标题/格式/标签/钉住/文件夹；任务有 优先级/截止/重复——**缺自定义字段** |
| 检索 | 全库 FTS + 查询语言 | 本应用已有 FTS5 + 中文分词，**强于多数离线竞品**；缺「查询语言」（只能搜索） |
| 回顾与统计 | Things/OF 的 Review、TickTick 习惯与统计、Super Productivity 时间追踪 | 本应用有回顾页；**缺**逐项审查流程、习惯打卡、时间追踪 |
| 提醒 | 到点系统通知、地点提醒、延期（Defer）与截止（Due）分离 | 本应用有截止日期与暂停/恢复（近似 Defer）；**待核实**是否有到点系统通知；缺「具体时刻」 |
| 自动化 | 快捷指令/Keyboard Maestro 的**触发（时间、应用切换、文件夹变化）**；n8n 的节点编排 | 本应用工作流节点编排**更细**（条件/脚本/退出码），但**只能手动或任务驱动启动**，缺定时/系统事件触发 |
| 数据所有权 | Obsidian/Joplin/Logseq：**纯 Markdown 文件即数据** | 本应用是 SQLite（可导出/备份）；**不是文件即数据**——这是取舍，不是缺陷 |
| 扩展性 | Obsidian 插件、Raycast 扩展、Alfred Workflow | 本应用有主题包 + 工作流脚本动作；**无插件/用户脚本目录** |
| 块级引用 | Roam/Logseq 的 block reference、Obsidian 的 block id | 本应用刚做了「段落 ↔ 任务关联」，**块引用是它的自然延伸** |
| 跨设备 / 协作 | 各家的 Sync / 共享 | **明确不做**（见 §4） |

## 3. 差距补齐清单（按个人离线价值排序）

| # | 差距 | 现状 | 对标怎么做 | 离线个人场景的建议 | 成本 |
| --- | --- | --- | --- | --- | --- |
| 1 | **保存的查询（智能清单）** | 只有四个固定视图；筛选项是临时的 | Todoist Filter / OmniFocus Perspective / Obsidian Bases | 在现有 FTS 与任务字段上做一层**查询 DSL + 保存**：`tag:写作 & due<today & !done`；保存后出现在侧栏，可固定到今日页。**不需要服务器**，纯本地求值 | 中（新增 `saved_query` 表） |
| 2 | **笔记结构化属性** | 只有标题/格式/标签/钉住/文件夹 | Obsidian Properties、Notion 字段 | 给笔记加**键值对属性**（本地 JSON 列），并在列表/看板里作为列展示 → 这是「数据库视图」的最小内核 | 中（少量迁移） |
| 3 | **工作流的定时 / 系统事件触发** | 手动「启动实例」或任务完成推进 | 快捷指令、Keyboard Maestro 的触发模型 | 给模板加**触发器**：每天定时、开机后、某文件夹变化、剪贴板匹配。离线可实现，且与本应用已有的步骤/条件模型天然契合 | 中 |
| 4 | **笔记模板 + 日记** | 新建笔记永远是空白 | Obsidian Templates / Daily Notes 是最高频用法 | 模板目录 + 变量（日期/标题/属性）；「今日笔记」一键创建并把当日任务写进去 | 小 |
| 5 | **截止「时刻」与到点提醒**（待核实当前是否有通知） | 截止只有日期；有暂停/恢复 | TickTick/Things 的提醒与 Defer | 截止支持可选时刻；到点弹**系统通知**（主进程 Notification），可设置提前量 | 小 |
| 6 | **块级引用** | 刚有「段落 ↔ 任务」关联 | Roam/Logseq block reference | 复用同一套 `block_key` 指纹：笔记内 `((block))` 引用 + 反链面板显示「被引用的段落」 | 中 |
| 7 | **习惯打卡 / 时间追踪** | 有番茄钟，无统计沉淀 | TickTick Habit、Super Productivity | 番茄钟落库已有的基础上加**按日/周聚合**；习惯可用「重复任务 + 连续天数」近似 | 中 |
| 8 | **查询/数据库视图用于笔记** | 笔记页只有列表 | Obsidian Bases、Notion gallery | 上面 #1 + #2 完成后，笔记也能按属性筛选成看板/表格 | 中（依赖 1、2） |
| 9 | **用户脚本扩展点** | 工作流能跑脚本，但没有「用户自定义动作」 | Raycast/Alfred 扩展 | 允许用户把脚本丢进 `<数据目录>/scripts/`，在命令面板/工作流里作为动作被调用 | 小到中 |
| 10 | **自由画布（Canvas）** | 图谱是自动布局 | Obsidian Canvas | 价值中等：图谱已覆盖「看关系」，画布更偏「手工摆想法」 | 大 |
| 11 | **数据即文件（Markdown 目录）** | SQLite + 导出 | Obsidian/Joplin | **不建议改**：会破坏与既有 Python 版共库的前提；保持「导出为 Markdown 文件夹」即可 | — |
| 12 | **语音 / OCR 输入** | 无 | TickTick 语音、Notion AI | 依赖系统能力，收益有限 | — |

## 4. 明确不做（与「个人 · 离线」冲突）

| 方向 | 理由 |
| --- | --- |
| 账号体系 / 云同步 / 多端实时 | 数据只在本机；同步会引入服务器、账号与冲突合并的全部复杂度 |
| 协作、共享清单、评论 @ 人 | 单人使用，没有第二个参与者 |
| 在线发布（Obsidian Publish 类） | 需要托管服务，且与「数据不出本机」冲突 |
| 任务看板的多人泳道、权限 | 同上 |
| 需要服务器的自动化（Zapier/Make/n8n 云端） | 离线优先；本地脚本 + 工作流已覆盖同类需求 |
| 联网 AI 的默认开启 | 已实现为**可选**（用户自配端点），保持这个边界 |

## 5. 如果只做三件事

1. **保存的查询（智能清单）** —— 它是 Todoist / OmniFocus / Obsidian 三家的共同内核，也是本应用目前唯一「结构性缺失」。做完立刻改变日常使用方式（从「翻视图」变成「看定义好的几件事」）。
2. **笔记属性 + 属性视图** —— 让笔记从「文档」升级为「可筛的结构化条目」，也是后续一切视图能力的地基。
3. **工作流触发器（定时/事件）** —— 本应用的编排能力其实强于多数离线竞品，缺的只是「不用人按按钮就能开始」。

## 6. 来源

**本次未能取得可引用的一手来源**（本机所有外部域名解析为非公网地址）。需要带官方链接的版本时，应抓取这些页面：

- Todoist：官方 Help Center 的 Filters / Natural language 页
- Things 3：Cultured Code 官方功能页与 Support
- TickTick：官方 Help（Habit / Smart List / Pomodoro）
- OmniFocus：Omni Group 官方文档（Perspectives / Defer dates）
- Obsidian：官方 Help（Properties、Bases、Canvas、Block references、Templates）
- Logseq：官方文档（Blocks、Queries、Whiteboards）
- Notion：官方 Help（Databases、Properties）
- Joplin / Anytype：官方站点与开源仓库 README
- Super Productivity：官方站点与 GitHub
- Raycast / Alfred / Keyboard Maestro：官方文档（Extensions / Workflows / Triggers）
- Apple 快捷指令：Apple 官方支持文档
