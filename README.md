# 知行 ZhiXing — 个人待办与知识图谱

> 工作名「知行」：**知**（知识图谱）与**行**（待办行动）一体。名字可随时替换。

一个**本地优先**的个人效率桌面应用：用待办管理「要做的事」，用 Markdown 笔记与双向链接图谱沉淀「所学所想」，并让两者互相引用、互相成就。

- 技术栈：**Python 3.11+ / PySide6 / PySide6-Fluent-Widgets / SQLite** · 架构：**MVC**（Controller 编排 / View 纯展示 / Model 含 Qt Model/View 桥）
- 平台：macOS / Windows / Linux
- 特性：**工作流（流程模板 → 一键拆解为待办 → 与任务双向绑定）**；完全离线、数据本地存储、无账号无云依赖；**桌面浮窗常驻待办、划词捕获（可入闪念/任务分组/子待办）、循环打卡子任务、多主题包 + 自定义强调色、SVG 矢量图标系统、精巧动效、任务↔笔记段落级关联（双向定位高亮）、`zhixing://` OS 深链唤起**

> **当前基线：v0.17.4**（2026-09）· 全量测试通过 · 最新一批：v0.17.4 交互打磨批——图谱/工作流画布左键拖动画布、图谱连线编辑端点手柄、笔记树缩进对齐、笔记编辑器链接区与按钮尺寸优化、工作流节点双击编辑/曲线连线/布局稳定与一键对齐/箭头随方向、分支逻辑与选中节点新增步骤修正。需求 / 架构 / UI / 手册四文档随版本同步维护。

## 目录

**① 了解项目**：§1 项目概览 → §2 快速开始 → §4 里程碑总览
**② 查阅文档**：§3 文档导航（主文档 01–04 + 审计/对比/打包辅助资料）
**③ 当前状态**：§5 当前基线（v0.17.4）验收速览
**④ 历史沿革**：§6 版本历史（v0.5 → v0.17.4，每批含功能点与「桌面验收对照」）

---

## 1. 项目概览

知行把**待办（行）**与**知识图谱（知）**放进同一个数据域：

- 一条任务可以直接关联一篇笔记，甚至**某一段落**（任务侧一键跳回定位高亮）；
- 一篇笔记可以随时「长出」任务（选中文字 → 转为任务并关联段落）；
- 图谱把任务、笔记、文件夹、闪念的关系可视化，形成个人的认知地图。

**核心特性速览**：

| 维度 | 能力 |
| --- | --- |
| 待办 | 任务树（父任务=大任务组）/ 四象限 / 日历胶囊 / 看板 / 循环打卡 / 等待中恢复 / 自然语言时刻（「明天3点」）/ 8 级优先级 P1–P8（旗子+色阶）/ 任务编辑三 Tab（基本/时间/详情）/ 四象限·看板·日历父任务可展开子任务 |
| 知识与捕获 | 笔记五格式（Markdown/富文本/Word/Excel/链接）/ 文件夹树 / 反链三组（引用·反链·归属）＋主动添加 / 划词捕获五去向 / 划选速记（Ctrl+Shift+U）/ 快速捕获语法糖 / 闪念收件箱 |
| 联动 | 任务↔笔记段落级双向跳转 / 图谱锚点 / 完成任务沉淀提示 |
| 图谱 | 五类节点 + 段落锚点、两类边（归属实线/引用虚线）、增量刷新、拖拽建链改挂 |
| 体验 | 桌面浮窗 / ⌘K 命令搜索胶囊 / FloatingDock 快捷新建 / 番茄钟 / 回顾统计 / 14 款主题包 × 8 色强调色 / 深链唤起 |
| 数据 | SQLite WAL 本地存储 / schema v8 迁移链 / 自动备份 / JSON 导入导出 / 回收站 30 天 |

完整功能清单与验收标准见 [01-需求规格说明书](docs/01-需求规格说明书.md)。

## 2. 快速开始

```bash
pip install -r requirements.txt
python -m zhixing
```

- 数据目录按平台自动选择（可用环境变量 `ZHIXING_HOME` 覆盖）：macOS `~/Library/Application Support/ZhiXing/` · Windows `%APPDATA%\ZhiXing\` · Linux `~/.zhixing/`（含 `zhixing.db`、`backups/`、`logs/`）。
- 应用为**单实例**运行：重复启动会唤醒既有实例；命令行带 `zhixing://` 深链参数时自动转发主实例定位（深链格式见 04 手册 §14）。
- 首次运行的逐项操作说明见 [04-用户使用手册](docs/04-用户使用手册.md)。

## 3. 文档导航

**主文档（需求 → 设计 → 手册，随版本同步）**：

| 文档 | 内容 |
| --- | --- |
| [01-需求规格说明书](docs/01-需求规格说明书.md) | 产品定位、用户场景、功能需求（F1–F11，含优先级与验收标准）、非功能需求、主题/设计系统需求；文末附录 A 收录 v0.2–v0.16 历次需求变更 |
| [02-技术架构设计](docs/02-技术架构设计.md) | 技术选型、分层架构（MVC）、目录结构、线程规约、数据模型（schema v7）、图谱引擎、链接管线、浮窗/捕获/主题/图标/动效架构、关键技术决策（ADR-1~21）；文末附录 A 收录历次架构变更 |
| [03-UI-UX交互设计](docs/03-UI-UX交互设计.md) | 设计原则、视觉语言（色彩 token/形状/图标/动效）、信息架构、各页面布局与交互流、主题系统、快捷键、状态设计、逐功能操作流程；文末附录 A 收录历次 UI 变更 |
| [04-用户使用手册](docs/04-用户使用手册.md) | 面向最终用户的操作手册（v0.16 基线）：安装启动、逐页操作、语法糖、深链、快捷键总表、数据安全、FAQ |

**辅助资料（审计 / 设计对照 / 打包 / 架构图）**：

| 文档 | 内容 |
| --- | --- |
| [v0.14 视觉精修审计报告](docs/ui_polish_v014_audit.md) | 对比度实测矩阵、Top 10 整改实施状态（§0.5 全完成） |
| [对照「Electron 双核」差距分析](docs/feature_compare_vs_dualcore_electron.md) | P0/P1/P2 扩展提案与 v0.15 实施状态（§5） |
| [对照「Neo-Dark Glass」UI 分析](docs/ui_design_compare_vs_neodark_glass.md) | 设计系统对照 + v0.16 UI 增强批实施状态（§6） |
| [控件/布局/动效全量对照矩阵](docs/ui_controls_matrix_vs_neodark.md) | 控件 × 布局 × 动效矩阵与 v0.16 落地（§8） |
| [v0.10 全局 UI 审计报告](docs/ui_audit_final_report.md) | 33 项合规整改闭环 |
| [图谱重构契约](docs/graph_redesign_contract_t1.md) · [打包说明](docs/打包说明.md) | 图谱 v0.11 契约 · Windows PyInstaller 打包 |
| [架构图 v0.12](docs/diagrams/zhixing-architecture-v012.html) | archify 可交互架构图（内联 SVG，明暗主题） |

## 4. 里程碑总览

| 里程碑 | 目标 | 交付 |
| --- | --- | --- |
| **M1 可用的待办** | 项目骨架 + 数据层 + 主窗口导航 + 任务分组树 + 多级/循环子任务 + 任务 CRUD + 今日页 | 一个能日常记任务的 Fluent 风格应用 |
| **M2 知识与捕获** | Markdown 编辑器 + 标签 + 全文搜索 + 反向链接 + 闪念收件箱 + 划词捕获 | 能写、能搜、能互链、随手能存的笔记库 |
| **M3 知识图谱** | `[[链接]]` 解析 + 力导向图谱可视化 + 图谱交互 | 直观的知识网络视图 |
| **M4 体验完善** | 桌面浮窗、主题系统（主题包/强调色）、SVG 图标系统、动效打磨、命令面板、番茄钟、四象限/日历、统计回顾、备份导入导出 | 功能完备 v1.0 |

## 5. 当前基线（v0.17.4）验收速览

v0.17.4 为最新打磨批（交互与视觉，详见 [版本历史 → v0.17.4](#v0174--交互打磨批)）；以下为可直接运行的快速验收清单（v0.17.1–v0.17.3 各项仍适用）：

- **旗子色阶固定绿→黄→橙→红**：任务页/浮窗/编辑页 P1–P8 旗子与色阶为固定高辨识色阶（P1 绿 → P3 草绿 → P4 橄榄黄绿 → P5 深琥珀 → P6 橙 → P8 深红；黄系偏深，浅/深主题下各档对比达标——白底 ≥2.86 / 深底 ≥2.47），不再从 accent/warm token 混合、不随强调色漂移。
- **任务行悬浮按钮命中**：任务行悬浮浮出的编辑等按钮可稳定点中（命中改由「事件位置 + press 记录」判定，release 缺 MouseOver 不再致按钮失效）；双击行内编辑链验证通过。
- **选中保持与行点击高亮**：勾选/编辑任务后保留并恢复 current 选中，焦点不错行；笔记页点击 文件夹/笔记/全部 行均高亮（含文件夹行）。
- **笔记/文件夹行视觉对齐任务行**：笔记行标题前显示类型小图标、悬浮操作按钮图标化；非悬浮点行右侧空白不误触发（hovered 门控）。
- **命令面板与速记窗 UDialog 化**：⌘K 命令面板与快速捕获窗为 UDialog 子类（工具窗置顶、自带标题栏、16px 圆角实色、失焦自动关闭、主题自愈）。
- **任务↔笔记可「引用」（v0.17.2）**：图谱工具栏「引用连线」模式下从**任务拖到笔记**即建立引用（虚线，允许成环）；「归属连线」模式则建归属（实线）。两者可并存，图谱对同一对只画一条边且呈引用。
- **图谱连线可编辑（v0.17.2）**：单击连线即选中（加粗高亮 + 顶部提示）→ `Delete` 删除；拖动连线**两端圆点**可改挂到另一节点；`Esc` 取消。画布平移改用**中键/右键拖拽**（左键让位给点选）。
- **链接笔记多链接（v0.17.2）**：链接型笔记可保存**多条链接**，每条含标题 + 目标，右侧各有独立「打开」；旧单链接笔记自动兼容。
- **编辑器工具栏整合（v0.17.2）**：保存 / 版本历史 / 查找替换与格式按钮（B/I/H1…）**同款同尺寸**并排在工具栏右端；「引用 / 归属」移到链接卡片**标题栏右侧**。
- **笔记项胶囊按钮（v0.17.2）**：笔记/文件夹行悬浮操作按钮为**纯图标胶囊**（软底全圆角、随行高自适应），并按**设备像素比**渲染（Retina 下不发虚）。
- **命令面板贴合触发点（v0.17.2）**：`Ctrl+K` 面板贴在标题栏 ⌘K 胶囊**正下方居中**展开。
- **快速添加浮层可主动关闭（v0.17.2）**：右下「+」展开后，点浮层外任意位置或按 `Esc` 均可收起。
- **快速捕获框动态定高（v0.17.2）**：窗口高度随语法糖 chip 行数伸缩（约 120–190px），并启用紧凑标题栏。
- **工作流模块（v0.17.3）**：导航新增「工作流」页 —— 左模板列表 / 中**矩形节点图**（拖动、缩放、中右键平移）/ 右实例面板；可「＋ 步骤」编排、设「条件分支」（虚线）、绑定 SOP 文档、配置步骤动作（打开文档/网址/运行命令，命令类**双重风险确认**）；「启动实例」按策略下发待办。
- **任务 ↔ 流程双向绑定（v0.17.3）**：任务页「速览」新增**工作流卡片**，可「启动工作流…」；流程步骤是**真实任务**（挂为来源任务的子任务、备注带 `[[SOP文档]]`），**勾选完成即自动推进**流程，末步完成则实例自动标记已完成。
- **图谱/工作流画布拖动画布（v0.17.4）**：两个画布在**空白处按住左键拖动**即可平移（标准图编辑器行为）；连线模式下点空白同样可平移；中/右键拖动仍保留。
- **图谱连线编辑端点手柄（v0.17.4）**：选中连线后，两端出现**醒目的圆形手柄**（强调色 + 白描边），拖动即可改挂到另一节点，命中半径加大、拖点更高效。
- **笔记树缩进对齐（v0.17.4）**：笔记行与文件夹行统一留出 16px chevron 占位，同一层级文字起点一致，多层展开缩进严谨。
- **笔记编辑器链接区优化（v0.17.4）**：链接卡片标题降为 12px 小字；「引用 / 归属」按钮改用与编辑器工具栏同款的紧凑 QToolButton，标题区不再过高。
- **笔记项操作按钮缩小（v0.17.4）**：悬浮操作胶囊对齐任务行（20px），不再比任务行大一圈；图标按设备像素比渲染保持清晰。
- **工作流节点与连线（v0.17.4）**：节点**双击打开编辑**；节点信息「序号 + 标题（两行换行省略）+ 角标（文档/动作/条件/分支）」分行不堆叠；连线改为**贝塞尔曲线**且**箭头沿终点切线方向**随节点相对位置变化；节点位置**持久化**（SCHEMA_VERSION=11 增 pos_x/pos_y），新增/编辑/上移下移后**布局不变化**，另增「**一键对齐**」重置网格排布。
- **工作流分支与步骤操作（v0.17.4）**：新增步骤支持**选中某节点后插入其后**，并可勾选「作为其条件分支」；修复节点「编辑 / 上移 / 下移」因未设可选中标志而不起效的问题；顺序边与分支边指向同一节点时自动去重。

> 各版本验收对照（v0.6 / v0.8 / v0.9 / v0.14 / v0.15 / v0.16）已内嵌至 §6 对应版本小节，运行 `python -m zhixing` 后可逐条实测。

## 6. 版本历史（v0.5 → v0.17.4）

> 从旧到新记录每批功能。除另有说明外，「桌面验收对照」均指运行 `python -m zhixing` 后逐条核对（各批内的开发合规流程见对应版本说明）。

### v0.5 · 版本状态：M1–M4 核心实现 + 第一轮架构优化

**v0.4↔v0.5 优化回路（本批）**：数据库迁移链补全并在升级前强制备份(B)；过期测试套件重写转绿、`reminder_at` 到点一次性提醒落地(C)；备份与导出改后台线程、提供可复用执行器(D)；配置键名真源下沉 `core/constants`、去除 core→model 反向 import(A)。待办：View 直读 domain 枚举与页面直调 Service 的信号化收口（需带 GUI 冒烟），及架构图精修至 showcase。

### v0.6 · 统一组件层（A 路线）

新增 `zhixing/view/ui/` 自有 token 化组件库——`UButton`(tone: default/accent/danger/success/warn × kind: solid/ghost)、`UCard`、`UStatusPill`、`UTitle`(hero/title/sub/muted)。控件颜色一律读 `ThemeEngine` 语义 token，订阅 `engine.changed` 自动自愈（模式/主题包/强调色即时生效）。首批页面接入：今日 hero 标题、任务「新分组/列表」、笔记「新笔记」、收件行与闪念四动作(删除=danger)、`general.EmptyState` CTA——均改由 `UButton`（按语义 tone），移除对应点的裸 qfluentwidgets/`QPushButton`/`QToolButton` 实例化。settings 的富层控件按 A 路线保留“少量基础元件”。待真机验收后续收编 `TagChip/StatCard.SectionHeader` → `UChip/` 等，及把 delegates/editor 自绘样式统一 token。

#### 桌面验收对照（v0.6）
- 今日页大标题（hero）、任务页「+ 新分组/列表」、笔记页「+ 新笔记」、收件箱行/闪念操作按钮外观统一。
- 浅/深主题与 8 色强调色间切换：以上按钮/标题应即时自愈不闪。
- 若观感需调（如 chip 圆角/卡片层次/胶囊字重），反馈方向后继续 v0.7 微调与 general 收编。

### v0.7 · 沉浸卡片全域铺（今日页概览起）
- 视觉组件库已铺主工作面：今日页概览（StatCard 并入沉浸 UCard 同族）、任务三轨、笔记三栏、收件双 Tab、图谱工具栏与选中信息面板、回顾图表与完成热力，均以 UCard 圆角悬浮（无边框+抬升羽影+顶部受光）分区；画布/图表本体（图谱 GraphView、QtChart）不拆，保持整页沉浸。
- 真机验收：to-dos —— 逐页切换浅/深/强调，核对各卡浮层光影，确认无卡错位/文字叠压。

### v0.8 · 马卡龙主题包 & 全局视觉统一
- **新增 10 款马卡龙主题包**（每款含亮/暗两套，字段同规范）：樱花粉、蜜桃橘、柠檬黄、薄荷绿、海盐蓝、薰衣草紫、香芋紫、奶咖棕、冰川蓝、莓果粉。保留「墨黑」原样；主题包由 `zhixing/resources/themes/*.json` 自动加载（现共 14 款：青竹/暮色/暖沙/墨黑 + 10 马卡龙）。
- **主题/高亮修复**：全局 `QPalette`（Active/Inactive/Disabled）随主题 + `QAbstractItemView/QComboBox` 的 `selection-background-color/selection-color` + 具体视图 `QTreeView::item:selected`(active/inactive) → 列表/树/下拉选中均随主题，不再黑底；去除 macOS 原生高亮黑（启用 `app.setStyle("Fusion")`）。
- **关键根因修复**：`accent_soft` 改为优先取主题 json 显式值（避免 `_mix` 产出近黑 `#010101`）；TaskDelegate `QMouseEvent` 修正为从 `PySide6.QtGui` 导入（消除点击列表时的 ImportError）。
- **交互控件**：下拉箭头恢复；日期/日历弹层随主题；收件箱 Tab 关 `documentMode` 使 QSS 生效（Tab 条随主题）；图谱按钮/关系图区暗色随主题。
- **回顾图表**：QtCharts 背景/轴/图例随主题 canvas，且切主题/主题包时实时重刷（`_style_chart` + `_restyle` 挂 `engine.changed`）。
- **合规流程**（开发自律）：每次改动完成 → `commit` → `push` Gitee → `pkill` 旧实例 → 启新实例。

#### 桌面验收对照（v0.8）
- 设置→外观→主题包 出现 14 款（10 马卡龙亮暗各验一版），切包后全 UI/回顾图表背景实时跟随 `canvas`。
- 亮/暗 + 各主题包下：列表/树/下拉选中为 `accent_soft`+主题字（非黑）；收件箱 Tab、图谱按钮、日期弹层与全局一致。
- 若某马卡龙包亮/暗对比或边界需调，指出包名+模式即可微调（改→提交→推送→杀旧→启新）。

### v0.9 · 未完成需求清仓 + P2 功能补齐

**需求清仓（文档标〔需实现〕项）**：
- 删除→回收站→撤销闭环：回收站对话框（任务/笔记/闪念三 Tab 还原/彻底删除/清空）、删除撤销（任务/笔记/闪念 `Ctrl+Z` 还原，含子树）、回收站 30 天自动清理（`schema_version=4` 迁移 `note_revision`）。
- 拖拽排序：`Ctrl+↑/↓` 同级移动排序（`TaskService.move_relative`）+ 看板拖拽改状态；四象限/日历拖拽改期保留待真机验收。
- 图谱：`Ctrl+F` 节点搜索镜头飞入、文件夹/标签过滤、节点色=所属文件夹、任务节点入图（F3-7）；力导向仍在主线程（>500 降采样）。
- 命令面板：无结果「新建笔记」动作、「主题：XX」命令直达。
- 捕获卡：G 模式「键入即模糊搜索」+ 分组树形呈现、`source_url` 取值、成功 Toast「去查看」跳转、权限降级内嵌引导条。
- 桌面浮窗：贴边 200ms 滑出动画、透明度滑杆即时生效、鼠标穿透开关、右键菜单。
- 设置即时生效：Mica 开关、热键改键 UI、macOS 权限文字引导、导入全量 JSON 备份入口、回收站保留天数。
- 笔记：标题栏「已保存 HH:MM」指示、编辑器查找/替换（F7-4）、版本历史回滚（F2-9）。
- 主题：动态行（概览卡/最近笔记/闪念卡）随主题即时自愈（`bus.theme_changed` 接线）。

**P2 延后功能**：看板视图(F1-11)、笔记模板(F2-6)、笔记版本历史(F2-9)、任务入图(F3-7)、孤儿笔记清单(F3-8)、完成任务沉淀提示(F4-4)、成就/连续打卡(F6-4)、开机自启(F9-5)、浮窗点击穿透(F10-6)、剪贴板监听(F11-7)、闪念多选合并(F11-3)。

**待真机验收 / 遗留**：任务完成划线/勾选弹簧/子任务 stagger 等动效增强；View 直读 domain 枚举与页面直调 Service 的信号化收口（MVC 硬规约）；四象限/日历拖拽；架构图精修至 showcase。

#### 桌面验收对照（v0.9）
- 任务页视图切换出现「看板」，四列拖拽改状态；任务树选中行 `Ctrl+↑/↓` 移动排序。
- 设置→数据 出现「导入 JSON 备份…」「回收站…」；回收站可还原/彻底删除/清空；删除任务/笔记/闪念后 `Ctrl+Z` 可撤销。
- 图谱工具栏出现文件夹/标签过滤下拉 + 搜索框，`Ctrl+F` 聚焦，输入即镜头飞入高亮；任务节点（绿色）入图双击打开。
- 笔记页「＋ 从模板新建…」「孤儿笔记」「版本历史」「查找替换」按钮可用；停止输入 1s 后标题栏出现「已保存 HH:MM」。
- 回顾页底部出现「成就」卡；完成任务（有关联笔记时）弹「写篇笔记记一下」。
- 命令面板输入「主题」列出主题包直达；无结果时回车新建笔记。

### v0.10 · 全局 UI 审计整改清仓（docs/ui_audit_final_report.md §5）

> 按审计报告 §5 完整实施 P0 红线 + P1 功能缺口 + P2 打磨。全量测试 **178 项转绿**（167 原有 + 11 新增），交叉验证结论已回写报告 §5（逐项标注 已完成/失败）。

**已完成（25 项）**：
- **P0**：MVC 分层收口（View 无 db.session()/infrastructure 模型/task_rules 直读，下沉只读 facade）；力导向移 QThreadPool 后台线程；任务树鼠标拖拽排序；删除撤销 Toast 一致性；主题硬编码色改 token；F1-6 标签管理；F4-2 笔记转任务右键菜单 + F4-1 关联笔记搜索。
- **P1**：F5-3 snooze 稍后提醒；F1-10 四象限拖拽换象限+独立勾选；F1-12 日历胶囊拖拽改期；骨架屏/BusySpinner（#11）；迁移失败只读横幅+恢复备份（#12）；F8-2/F8-3 JSON 全量导出导入四表补全；F7-4 查找替换逐条高亮；F2-8 pygments 代码高亮；F5-2 番茄钟中断选原因；F1-15/F6-1 已完成卡独立定位；F9-6 reduce-motion OS 探测+图谱/图表降级；F11-2 捕获卡五去向「去查看」；F11-3 merge 合并 tags/source_url；动效 9c stagger/9d 图表生长/9e 循环重置抖动。
- **P2**：F1-11 看板卡片元数据/列计数/空态；F6-4 成就卡视觉；F2-9 版本历史 diff+回滚确认。

**v0.10.1 补充（8 项遗留已由 captain 直接补完，§5 共 33 项全部完成）**：
1. 13b desktop_widget.open_btn 补 `setAccessibleName`；2. 9f Toast 全部改 `InfoBarPosition.BOTTOM`；3. W22 capture_card/quick_capture 去 emoji 改 `IconWidget("nav.flash")`；4. F1-8 RRULE 编辑器加「自定义」+ `repeat_rule` 输入；5. F4-3 任务备注复用 `WikiSuggestPopup` 实现 [[ 补全；6. F1-14 任务树多选 + 「批量」菜单（完成/改期/打标签/删除）；7. F11-4 收件箱加「已归档」toggle + 归档/还原按钮；8. 10b 图谱页空状态（graph_stack 切换）。

### v0.10.2 · 9 项 UI 优化整改（启动/交互/主题/布局）

> 本批针对 9 项 UI 问题逐项整改并交叉验证，全量测试 **178 项转绿**（`.venv/bin/python -m unittest discover -s tests -q` → OK）。逐项结论如下（均为「已完成」）。

1. **① 启动后仍有几秒卡顿** — 回顾页 QtCharts 渲染与图谱力导向改为惰性构建：`app_controller.py:839-871`（`_refresh_everything` 轻量立即 / `_arm_lazy_heavy_pages` + `eventFilter` + `_load_review_lazy` 回顾页首次显示才 reload）、`graph_page.py:359/701`（首屏未构建时不随 `theme.changed` 触发图谱构建）。
2. **② 速记窗失去焦点不消失** — `quick_capture.py:3/81-89`：`event()` 捕获 `QEvent.WindowDeactivate/ApplicationDeactivate`，失焦后经 `QTimer.singleShot` 校验 `isActiveWindow` 再 `close()`。
3. **③ 任务行内编辑后输入框残留** — `task_delegate.py:79-82`：`destroyEditor` 显式 `editor.hide()` + `editor.deleteLater()`。
4. **④ 任务修改（非时间字段）后四象限/日历/看板不刷新** — `app_controller.py:807-815`（`_on_task_changed` 调 `reload_alt_views`）+ `task_page.py:336-352`（`reload_alt_views` 强制刷新 quadrant/calendar/kanban，`_reload_calendar` 保持选中日仅重算）。
5. **⑤ 字号设置下限改为 9** — `constants.py:34-35` 新增 `FONT_SIZE_MIN=9/FONT_SIZE_MAX=20` 真源；`settings_page.py:149/157` SpinBox range 改用常量；`app_controller.py:687` `_apply_theme` 字号钳制改用 `FONT_SIZE_MIN`。
6. **⑥ 回顾页图表溢出 card** — `review_page.py:58-60`（图表 `setMinimumHeight(200)` + `QSizePolicy(Expanding,Expanding)`）、`:268-271`（`_style_chart` 关闭图表/绘图区背景 + `setMargins(6,6,6,6)`，透明底由 UCard 承载，内收 6px 不再溢出圆角卡）。
7. **⑦ SwitchButton 高度与其他控件不统一** — `theme.py:313-320`：解除内部 `setFixedHeight(22)`，容器高对齐全局 `control_h`，滑轨 Indicator 固定 22px 并在增高容器内垂直居中。
8. **⑧ SpinBox 上下按钮未垂直居中** — `theme.py:283-286/309-312`：新增 `spinbtn_h=control_h-12` 并显式 min/max-height，不再继承全局 QToolButton 的 `cb_h`（高 2px 导致靠下）。
9. **⑨ card 内控件布局溢出、card 宽度超出页面** — `widgets.py:184`（UCard `setSizePolicy(Expanding,Preferred)` 横向撑满可用宽度不外溢）；`settings_page.py:349-356`（「数据」卡 8 个备份/导入导出按钮由单行 QHBoxLayout 改 4 列 QGridLayout 换行）。

### v0.11 · 知识图谱重构 + 启动页 + 标题栏/侧边栏 + Windows 打包

> 本批为「图谱四类节点/两类边 + 观察者增量刷新」重构、笔记文件夹管理、快速捕获方案 A、启动欢迎页、自定义标题栏（签名 + 翻页时钟）与 Windows PyInstaller 打包。全量测试 **191 项转绿**（`.venv/bin/python -m unittest discover -s tests -q` → OK）。

#### 图谱重构（`graph_service.py` / `graph_page.py`，见 `docs/graph_redesign_contract_t1.md`）
- **节点五类**：note（展开书本）/ flash（闪电，负空间）/ dangling（待建链接虚线）/ **folder（文件夹矩形，负空间 -2,000,000）** / **task（五角星，高位正空间 +5,000,000）**。
- **边两类**：`ownership` 归属（实线 DAG，无环约束：folder→folder、folder→note、task→note、task→task）与 `reference` 引用（虚线，仅 note↔note / note→dangling，允许成环）。`ALLOWED_CONNECTIONS` 连接矩阵约束拖拽建链。
- **任务全量入图**：所有未删除任务（不再只显示「已关联笔记」的任务），含 task→note 归属 + task→task 父子层级。
- **归属 DAG 破环**：三色 DFS 去回边，成环边记入 `cycle_edges` 供提示。
- **观察者增量刷新**：`GraphService.subscribe()` 订阅 EventBus → 领域事件 → `GraphDelta` → `bus.graph_delta` → `GraphPage.apply_delta()` 定点增删（保留布局/pinned），替代全图 `reload()`。
- **拖拽改挂**：`attach_task_note()` / `reparent_task()` 在图谱拖拽时直接改写归属，`would_create_cycle()` 祖先链回溯防环。
- **单线贝塞尔边 + 双向箭头**：引用边画双箭头，归属/引用以实线/虚线 + 颜色区分。

#### 笔记文件夹（`note_service.py` / `note_tree.py` / `note_page.py`）
- 「全部笔记」不再聚合所有笔记，仅收纳未归属（folder_id=None）笔记；文件夹为空自动建默认「我的笔记」。
- 文件夹操作悬浮胶囊按钮：`＋笔记` / `＋文件夹` / `重命名` / `删除`（删除时笔记回落「全部笔记」、子文件夹上移一级）；`move_folder` 带祖先链环路校验。
- reload 后恢复选中节点，避免焦点自动跳到「全部笔记」；图谱双击文件夹节点可跳转定位。

#### 快速捕获方案 A（GTD 收集箱语义，`task_page.py` / `inbox_page.py` / `app_controller.py`）
- 新建/快速任务只有明确选中「列表」时落该列表，其余（智能清单/分组/标签/收件箱/今日/浮窗）一律落收件箱（`list_id=None`）。
- 收件箱任务行右键「移动到列表」菜单，含分组树形呈现。

#### 启动欢迎页（`splash.py`）
- SVG 图标 + 标题 + 进度条 + 淡出；`startup(show=False)` 在欢迎页阶段完成全部初始化（含回顾/图谱重页），`processEvents` 冲刷布局/渲染，主窗口打开即可操作（取代原先的回顾/图谱懒加载）。

#### 自定义标题栏 / 侧边栏（`main_window.py` / `flip_clock.py`）
- `CustomTitleBar`：签名（默认「知行合一」，设置项「标题栏签名」）+ 中间翻页时钟 `FlipClock`（HH:MM:SS，仅变更位动画）+ 系统红绿灯；清空系统标题避免重叠。
- 侧边栏 `setExpandWidth(200)`、隐藏返回按钮、保留折叠按钮；顶部品牌文字随折叠/展开。

#### 其他打磨
- **番茄钟 SVG 图标**（`pomodoro.py`）：呼吸圆点/咖啡/暂停/播放图标随主题 accent，去 `●`/emoji。
- **成就卡片块**（`review_page.py`）：`AchievementTile` + `FlowLayout` 流式排列 + 6 枚 `achieve.*` SVG 图标；热力图铺满卡片、柱状图显式 Y 轴、图表底部留边距。
- **圆形复选框**（`theme.py` / `control_style.py`）：全局 `QCheckBox::indicator` 圆形、大小随控件高度缩放；`restyle_switch_button` / `restyle_spinbox` 解除 qfluentwidgets 固定高度。
- **热键修复**（`hotkey.py` / `settings_page.py`）：macOS EventTap 共享 tap + runloop source 清理 + autorepeat 过滤 + `CGEventMaskBit` 修正；改键弹窗 `HotkeyCaptureDialog` 直接捕获组合键（改键期间先注销旧热键）。
- **捕获卡**（`capture_card.py`）：`Qt.Tool` 接收键盘焦点，失焦自动关闭，`requestActivate()` 温和激活不拉起主窗口。
- **跨平台数据目录**（`db.py`）：macOS `~/Library/Application Support/ZhiXing` / Windows `%APPDATA%\ZhiXing` / Linux `~/.zhixing`。

#### Windows 打包（`zhixing.spec` / `run.py` / `build_windows.bat` / `assets/zhixing.ico`，见 `docs/打包说明.md`）
- PyInstaller onedir：collect qfluentwidgets/jieba/pygments 数据与子模块，图标 `assets/zhixing.ico`（多尺寸），`console=False`；产物 `dist\ZhiXing\ZhiXing.exe`。PyInstaller 不可交叉编译，需在 Windows 机上运行 `build_windows.bat`。

### v0.12 · 图谱连线/边视觉 + 主题化无边框弹窗 + 笔记类型扩展 + 打包重定向

> 本批为 v0.12 功能批（8 项）：①任务↔笔记图谱连线修复 ②归属/引用边显色与虚线间隔 ③Windows 打包 stderr 重定向 + spec 上传 Gitee ④新建笔记弹窗输入名称（不以内容简记）⑤弹窗主题/主题色统一 ⑥弹窗无边框（图标+标题栏+按钮组按类型）⑦笔记类型 Markdown/Word/Excel/链接 ⑧图谱节点可换行标题 + 点击预览。全量测试 **212 项转绿**（`.venv/bin/python -m unittest discover -s tests -q` → OK）。

#### 图谱（`graph_page.py` / `graph_service.py`）
- **连线修复 + 边视觉（①②）**：task→note 归属边此前为 30% 透明度淡灰（视觉上近乎「无连线」），改为读 ThemeEngine 语义 token——归属=fg2 中性实线、引用=accent 强调虚线（自定义 `DashPattern[6,4]` 加大间隔），订阅 `engine.changed` 自愈；`_begin_link` 橡皮筋同步取色。
- **节点可换行标题 + 点击预览（⑧）**：节点形状下绘制可换行标题（`TextWordWrap`，宽度 96 上限自动换行、高度随文本增长、矢量缩放清晰）；选中节点侧栏显示 `GraphService.preview_text` 四类预览（笔记=文件夹/摘要/字数/置顶、任务=状态/优先级/截止/父任务/关联笔记、文件夹=上级/子文件夹数/笔记数、闪念=正文/备注/来源/链接）。

#### 主题化无边框弹窗框架（⑤⑥，`view/ui/dialog.py`）
- `DialogType.INPUT`（仅关闭）/ `RESIZABLE`（最小化+最大化+关闭）；`UDialog`（Qt 原生无边框 + 自绘标题栏 + 内容区）+ `DialogTitleBar`（拖拽移动 + 双击最大化）+ `UInputDialog.get_text()`（替换 `QInputDialog.getText`）。
- 颜色全读 ThemeEngine 语义 token、订阅 `changed` 自愈；边缘缩放仅 RESIZABLE。不引入 qframelesswindow（macOS offscreen 下 SIGSEGV，实测），改 Qt 原生无边框 + 自绘。

#### 新建笔记以用户输入为准（④）
- 新建/重命名经 `UInputDialog.get_text` 弹名称输入框；空输入回退 `DEFAULT_NOTE_TITLE='未命名笔记'`；`_auto_save` 不再以内容首行回填标题。

#### 笔记类型扩展（⑦，`note_service.py` / `note_create_dialog.py` / `note_previews.py`）
- `note.format` 五类：markdown/richtext/word/excel/link；`NoteCreateDialog`（名称 + 类型 + 目标 + 浏览）新建；`select_note` 按 format 切换五个视图。
- Word/Excel 经 python-docx/openpyxl 解析为只读 HTML（QTextBrowser 渲染、主题自愈）；链接一键 `QDesktopServices` 打开，本地文本文件内嵌预览。`SCHEMA_VERSION=6` + `migrate_v6`（历史空 format 归一 markdown）；requirements.txt 新增 python-docx/openpyxl，`zhixing.spec` 收集 docx/openpyxl hiddenimports。

#### Windows 打包 stderr 重定向（③，`core/logging_util.py` / `__main__.py`）
- windowed 冻结（sys.stderr/stdout 为 None）时 `ensure_std_streams` 按需把标准流重定向到 `<logs>/stdout.log、stderr.log`（行缓冲、幂等）；`setup_logging` 仅当 sys.stderr 非 None 才 add 控制台 sink；`__main__` 在 QApplication 前先行调用，早期 print/traceback 有真实 sink。

#### 其他
- `Ctrl+Shift+N` 新建笔记统一走 `NoteCreateDialog`（不再绕过名称/类型）；弹窗 `exec` 后 `deleteLater` 防泄漏；`NoteRow.title` 默认值改「未命名笔记」与 `DEFAULT_NOTE_TITLE` 一致。
- 架构图更新：`docs/diagrams/zhixing-architecture-v012.html`（archify 可交互，内联 SVG，明暗主题）。

### v0.13 · 交互打磨 + 图谱多色图标 + 笔记编辑增强

> 本批为 v0.13 功能批：①桌面浮窗缩放 ②弹窗主题自愈/圆角 ③任务编辑页 UDialog ④今日页笔记跳转 ⑤收件箱闪念优化 ⑥设置页 QTabWidget 重构 ⑦页面大标题+副标题+入场动效 ⑧回顾页布局 ⑨任务页视图即时刷新 ⑩快速捕获入笔记新建 ⑪图谱节点 9 类多色 SVG 图标 ⑫Word/Excel 可编辑 ⑬Markdown 三态预览 ⑭富文本字号/颜色/图片缩略图/文件附件 ⑮自动/主动保存。全量测试 **215 项转绿**（`.venv/bin/python -m unittest discover -s tests -q` → OK）。

#### 图谱节点多色 SVG 图标（`view/kit/graph_icons.py`）
- 9 类节点图标（文件夹/Markdown/Word/Excel/PDF/多媒体/链接/任务/闪记），多色元素组合（主体色 + 辅助色 + 装饰），`QSvgRenderer` 矢量渲染（无锯齿、任意缩放清晰）；`GraphNode` 增 `format`，`NodeItem` 按 `note.format` 选图标。

#### 笔记编辑增强（`note_previews.py` / `richtext_editor.py` / `markdown_editor.py`）
- Word/Excel 可编辑：python-docx/openpyxl 读写（保留格式）、编辑工具栏、可新建空白文件；Markdown 三态预览（编辑/双栏/只预览）；富文本字号/颜色、图片缩略图单击预览、文件附件双击打开；所有笔记 1s 防抖自动保存 + Ctrl+S 主动保存。

#### UI 打磨
- 设置页 QTabWidget 5 Tab + QFormLayout 右对齐 + 快捷键双列键盘封装；页面大标题 + 12px 副标题 + 入场动效（fade+slide up，切页/Tab 触发）；弹窗统一 UDialog 圆角 + 主题自愈。

### v0.14 · 视觉精修批（Top 10 审计整改，对照 `docs/ui_polish_v014_audit.md`）

> 无 P0；P1「对比度不达标 + 双色并存不一致」、P2 面较广均低风险局部整改。全量测试 **215 项转绿**；离屏渲染 + 像素 diff 复核通过（见审计 §0.5）。核心：**对比度合规机制进 ThemeEngine**。

- **accent 明暗派生 + on-accent 双模式**：实底/幽灵按钮前景与 `accent_solid` 底自动选白/近黑（亮暗均 ≥4.5:1），修复 `_mix` RGB 0..1 通道 bug；新增语义 token `accent_solid/accent_on/accent_solid_hover/accent_solid_pressed`（`view/kit/theme.py`）。
- **fg2/fg3 校正 + 字级提升**：14 主题包×双模式一次覆盖（fg2 ≥4.5 / fg3 ≈4.0），11px 辅助文字 13 处全部提至 12px。
- **图标净化**：⚠/✕/✓ emoji → info 行 SVG、📄 附件 → data-URI PNG、← → `action.back`；导航 idle 图标 `#888` → fg2 token 自愈（`icons.py` 新增 `data_uri()`）。
- **焦点可见性（T6）**：UButton 全 tone/kind 补 `:focus` 环（实底 2px ring / ghost 1px accent+soft 底，零尺寸跳动）。
- **radius 收敛（T7）**：新增 `radius-ctl` 6px 对齐全局控件；大弹层统一 12px `radius-lg`；docs/03 §2.2 同步。
- **命中区 ≥32px（T8）**：task delegate / note tree 行内按钮垂直扩展、浮窗入口 28→32、图谱节点标题 9→10pt。
- **截断稳定（T9）**：日历长标题省略+tooltip、看板 tag +N、任务行 hover 不挤压文本（布局恒定）。
- **动效/空态一致（T10）**：UDialog 族 fade_in 进场统一、回收站三 Tab 空态（QStackedWidget+EmptyState）。

#### 桌面验收对照（v0.14）
- 亮/暗 × 各主题包 × 强调色：实色按钮文字清晰无糊底；Tab 键可见焦点环；辅助文字 ≥12px；日历/看板截断正常不挤行。

### v0.15 · 功能批（对照「Electron 双核效能系统」，实现 P0 全部 + P1 全部 + P2 定向，见 `docs/feature_compare_vs_dualcore_electron.md` §5）

> 坚持本地独立知识库、不与外部软件做内容交互（P2-6 Markdown 外部同步按用户要求剔除）。全量测试 **232 项转绿**（基线 215 + 新增 17）。

- **时刻 NLP（P0-2）**：「明天3点」→ due 明天 + 提醒 15:00；支持 `14:30`/`3点半`/`下午5点`/`凌晨`/`中午`；语法糖/速记窗 chip 回显时刻（`task_rules.parse_clock/parse_natural_datetime`、`capture_grammar.due_clock`）。
- **段落级双向跳转（P0-1）**：Markdown 选中段落右键「转为任务并关联段落」→ 任务侧「§」按钮 → 切笔记页滚动高亮段落（1.4s）；关联落新表 `task_note_context`（block_key=段落首行指纹 + snippet 引文快照，正文零污染）。
- **上下文速读（P1-5）**：任务行 hover 显示「笔记标题 > 段落首 60 字」。
- **图谱段落锚点（P1-3）**：段落上下文入图为 anchor 子节点（accent 小圆点，负空间 −3e6），note→anchor / task→anchor 引用虚线，双击/侧栏「定位段落」跳转。
- **OS 深链（P1-4）**：`zhixing://task|note|flash|folder/<id>[?block=]`；纯函数解析 + 单实例 QLocalSocket IPC 转发主实例派发（新 `core/deep_link.py`）。
- **状态「等待中」WAITING（P2-8）**：全链路五态——5 处文案 + 看板列 + 行暂停符号（非删除线）+ 编辑页「恢复于」`resume_at`（waiting 专属、离开自动清除）+ 启动/跨天自动恢复 + waiting 不弹到点提醒（`SCHEMA_VERSION=7`，`migrate_v7` 加 `task.resume_at` + 建 `task_note_context`）。
- **速记窗细节（P2-7）**：唤出定位鼠标所在屏；捕获卡钳制于鼠标屏（副屏不错位）。

#### 桌面验收对照（v0.15）
- 快速捕获输入「明天3点 交周报」→ chip 显示截止「明天」+ 提醒「15:00」。
- 笔记段落 → 右键「转为任务并关联段落」→ 任务编辑页点「§」回跳高亮；任务行 hover 显示段落摘要。
- 终端执行 `zhixing://task/1` 唤醒实例并定位任务 1。
- 任务设「等待中」+ 恢复日 → 行显暂停符号、看板入「等待中」列、不弹提醒；过恢复日后自动回待办。

### v0.16 · UI 增强批（对照「Neo-Dark Glass」P0/P1/P2 全做，增量不换肤，见 `docs/ui_design_compare_vs_neodark_glass.md` §6 + `docs/ui_controls_matrix_vs_neodark.md` §8）

> 全量测试 **232 项保持绿**；真机截图（今日/任务/笔记页）视觉复核通过。弹窗视觉链按用户反馈迭代至「大圆角 16px 实色无阴影」终态。

- **⌘K 入口可见化（P0-1）**：标题栏居中「搜索任务、笔记、命令… ⌘K」胶囊 → 命令面板（CustomTitleBar `commandRequested`）。
- **聚焦发光（P0-2）**：输入框/下拉/数字框/强调主按钮 focus 时 accent 柔光（blur12 α90），失焦清除（大滚动编辑器排除防性能）。
- **FloatingDock 底部快捷新建（P0-3）**：今日/任务页右下「+」展开「新建任务/笔记/闪念」，OutExpo 280ms 面板展开（新 `view/widget/floating_dock.py`）。
- **动效 token（P1-a）**：EASING 增 `panel=OutExpo/page=InOutQuad`，DURATION 增 `page=200/panel=280`。
- **弹窗大圆角实色无阴影（P1-b 终态）**：UDialog/命令面板 16px 四角全圆 + 不透明 `layer` 底（标题栏顶角 + body 底角），移除外阴影与双重边框观感（`_DIALOG_RADIUS=16px`；`attach_dialog_shadow` 保留未用）。
- **任务「速览」右栏（P1-c）**：任务页工具栏「速览」→ 260px Context Inspector（默认折叠）：状态/优先级/截止/等待至/关联段落（点击定位）/标签。
- **UButton solid hover 渐变（P2-a）**：150ms 底色渐变（CSS 模板 + QVariantAnimation；ghost 保持即时态）。
- **笔记树 chevron 旋转（P2-b）**：文件夹展开/折叠 120ms（delegate 角度插值）。
- **Tab 切页淡入 + 标题入场统一（P2-c）**：QTabWidget 150ms 淡入（`attach_tab_fade`）；PageHeader 统一 page token 200ms InOutQuad 8px。
- **语义绿渐变进度条（P2-d）**：`component_qss` 全局 QProgressBar 圆角渐变 chunk（读 `success` token）。

#### 桌面验收对照（v0.16）
- 标题栏中点 ⌘K 胶囊唤起命令面板；今日/任务页右下「+」展开三项快捷新建。
- 点任务页「速览」→ 右侧面板随选中刷新；关联段落项可点击跳笔记定位。
- 弹窗（任务编辑/新建笔记/命令面板）四角大圆角、实色背景、无外阴影；Tab 键遍历可见聚焦发光。
- 笔记树展开/收起箭头 120ms 旋转；设置页切 Tab 150ms 淡入。

### v0.17 · 优先级 8 级 + 任务编辑 Tab + 反链主动链接 + 划选速记/三视图展开

> v0.17 以任务组织与捕获提速为主线：优先级 4 级 → 8 级全链路、任务编辑页 Tab 化、弹窗/快速窗圆角统一与设置页行高、QToolTip 气泡主题化、新增「划选速记」全局热键、反链面板三组与主动添加、速览三卡与四象限/看板/日历子树展开、布局横向滚动收口。全量测试通过。

- **优先级 8 级体系**（commit `7f4804c` / `b5f8961` · `model/domain/entities.py` / `view/kit/priority.py` / `capture_grammar.py`）：Priority 由 4 级扩为 `NONE(0)+P1..P8`（数字即档位，P8 最高），兼容别名 `LOW=P2` / `MID=P5` / `HIGH=P8`；`migrate_v8` 把旧值 1/2/3（低/中/高）→ 2/5/8，`SCHEMA_VERSION=8`；语法糖 `!1=最高(P8)`、`!2=中(P5)`、`!3=低(P2)`，速记 `!!!→P8` / `!!→P5` / `!→P2`（保留旧肌肉记忆）。共享 helper（`view/kit/priority.py`）提供 `priority_label` / `priority_color`（主题 token 8 档色阶：P4≈accent / P5≈warm / P8≈danger）/ `priority_choices` / `is_important`；`domain.entities` 另增纯函数 `priority_label` / `priority_is_important`。任务页/浮窗/app_controller/编辑页下拉均 8 档；quick_capture 占位提示与 chip 显示同步升级。
- **任务编辑页 Tab 化**（commit `69157f5` · `view/components/task_editor.py`）：TaskEditorPanel 改 QTabWidget（`documentMode=False` + `attach_tab_fade`）三 Tab——基本（标题/状态/恢复于/优先级）、时间（开始/截止/循环 RRULE）、详情（标签/备注/关联笔记/子任务）；每 Tab 独立 QScrollArea 滚动；load/clear 重置回 Tab 0；对外接口全兼容。
- **弹窗窗口按钮圆角与快速窗统一**（commit `ea09b5b` · `view/ui/dialog.py` / `view/capture/quick_capture.py`、`capture_card.py`）：`_WindowButton` 背景改 QPainterPath 圆角路径填充——普通按钮 hover/pressed 四角 8px、关闭钮（danger）右上角 16px 贴合窗口大圆角；quick_capture / capture_card 壳统一 16px 圆角 + 去外边框（交互行为不变）。
- **设置页行高与气泡主题化**（commit `b117a2a` · `view/kit/theme.py` / `pages/settings_page.py`）：`component_qss` 按 qfluentwidgets metaobject LineEdit 增加 min/max-height = control_h-2 规则（修复其自带 QSS 覆盖导致恒矮 10px 的根因）；热键行输入框 clear_fixed_height；热键状态 QLabel 空文本即隐藏（去掉悬空「—」），改键后即时刷新；QToolTip 主题化（layer 底 / fg 字 / border2 细边 / radius-ctl 6px / 5px 10px padding / 字号随全局）。
- **划选速记「读取选中并速记」**（commit `ac6f8cc` · `controller/app_controller.py` / `view/capture/quick_capture.py` / `core/settings_keys.py`）：新增全局热键默认 `Ctrl+Shift+U`（可改键，设置快捷键表已补该行）；app 内任意选中文字 → 预填快速捕获窗（首行 ≤60 字为标题、余文随回车入备注）；复用 SelectionGrabber 选区管线，未授权时降级剪贴板；主窗隐藏时走托盘气泡提示；应用内 QShortcut 兜底。
- **反链面板升级 + 主动添加**（commit `7db9ffe` · 笔记反链面板 / note_link 链路）：反链面板改「引用(N)·反链(M)·归属(K)」三分组 Tab；「+ 引用」弹选择器建 note_link（可建待建悬空，正向列表含悬空项、可 materialize 创建转正）；「+ 归属」——任务 → task_note_link 多对多，文件夹 → 移动 note.folder_id。
- **任务速览 UCard 化 + 三视图子树展开**（commit `ed789ee` · `pages/task_page.py` / quadrant / kanban / calendar）：任务右栏「速览」改 UCard 三卡分组（任务/关联段落/标签，空卡隐藏）；四象限/看板/日历支持父任务展开子任务——页面级 `_expanded_ids` 共享集合 +「▸/▾ N 子」chip，子任务 18px/级缩进，切视图保持展开；看板子树以缩进卡片插父卡下；日历当日清单行可交互 + 展开。
- **布局滚动收口**（commit `cafa531` 等 · 收件箱/设置滚动容器）：收件箱/设置滚动容器关水平滚动（ScrollBarAlwaysOff），子内容限制在视口内；settings 快捷键表补 Ctrl+Shift+U 行。
- **任务行行内重构**（commit `a08bad5` · `delegates/task_delegate.py`）：优先级文字 pill → `task.flag` SVG 旗子（`priority_color` 8 档色阶、无文字，点击旗子改优先级）；悬浮动作按钮（专注/＋/编辑/删除）**不占位**——非悬浮时标题与胶囊占满行宽，仅悬浮让位浮出且图标化（`pomo.play`/`action.add`/`action.edit`/`data.trash`）；右侧信息 chips（笔记/循环/streak/日期）+ 标签 chip 放不下时折叠为行尾「**+N 省略胶囊**」（hover 展开 QToolTip 逐行列出被折叠项）；标题区最小宽 100。

### v0.17.1 · 修复批

> v0.17.1 为修复批：旗子色阶绿→红、任务/笔记选中与悬浮按钮命中修复、笔记视觉对齐、命令面板与快速捕获窗 UDialog 化。全量测试通过。

- **优先级旗子色阶固定化**（commit `3b4c892` · `view/kit/priority.py`）：8 档色阶改为固定高辨识「绿→黄→橙→红」——P1 `#2E9E5B` 绿 → P3 `#5BA83A` 草绿 → P4 `#8F9E1D` 橄榄黄绿 → P5 `#C08A00` 深琥珀 → P6 `#E67E00` 橙 → P8 `#C81E1E` 深红（黄系偏深保证浅色 UI 对比，白底全档 ≥2.86 / 深底 ≥2.47）；不再从 accent/warm token 混合。
- **任务/笔记选中与悬浮按钮命中修复**（commit `2c4d9d1`）：delegate `editorEvent` 悬浮按钮命中改由「事件位置 + press 记录」判定（release 常缺 MouseOver 曾致按钮永点不中——修复任务行编辑按钮失效）；`task_page.reload_tasks` 保留并恢复 current 选中（修复勾选/编辑后焦点错行）；note_page 点击 folder/note/全部 行均 `setCurrentIndex`（修复文件夹行点击无高亮）；双击行内编辑链验证通过。
- **笔记/文件夹行视觉对齐任务行**（commit `13444ec` · `view/note_tree.py`）：笔记行标题前加类型小图标；悬浮操作按钮图标化（action.edit / win.pin / data.trash / folder.plus / nav.notes）；`editorEvent` hovered 门控（非悬浮点右侧不误触发）；NoteTreeModel 增 `NoteRoleFormat`。
- **命令面板与快速捕获窗改用 UDialog 框架**（commit `eaef60a`）：UDialog 扩展工具窗模式（tool/sticky 置顶、`show_title_bar` 可省、`auto_close_on_deactivate` 失焦自动关）；CommandPalette 与 QuickCaptureWindow 改为 UDialog 子类（自带标题栏、16px 圆角实色、主题自愈）。

### v0.17.4 · 交互打磨批

> v0.17.4 为交互与视觉打磨批：图谱/工作流画布拖动画布、连线端点手柄、笔记树缩进对齐、笔记编辑器链接区与按钮尺寸优化、工作流节点/连线/分支/操作修正。SCHEMA_VERSION=11（workflow_node 增 pos_x/pos_y）。全量测试通过。

- **画布拖动画布**（`view/pages/graph_page.py` / `workflow_page.py`）：两个画布在**空白处左键拖动**即平移（连线模式下点空白同样平移），中/右键拖动保留；左键点节点仍是选中/拖动节点、点连线仍是选中连线。
- **图谱连线端点手柄**（`graph_page.py`）：`EdgeItem` 新增 `endpoints()` 提取实际连接点，选中态 `paint` 绘制**圆形手柄**（强调色实心 + 白描边）；`_endpoint_at` 改为按端点命中（半径 14px，随缩放自适应）。
- **笔记树缩进对齐**（`view/note_tree.py`）：笔记行标题统一从 `x+16` 起（与文件夹 chevron 占位一致），同层级文字起点对齐。
- **笔记编辑器链接区优化**（`view/pages/note_page.py`）：「引用 / 归属」改用与编辑器工具栏同款的紧凑 QToolButton（高 28），链接卡片标题降为 12px。
- **笔记项操作按钮缩小**（`note_tree.py`）：悬浮胶囊 `cap_h = round(20*s)`、图标 `cap_h-8`（对齐任务行），不再比任务行大一圈。
- **工作流节点与连线**（`workflow_page.py`）：`_StepNodeItem` 加 `ItemIsSelectable`（修复编辑/上移/下移不起效的根因）+ 双击编辑 + 信息分行（序号/标题两行省略/角标）+ 坐标回写；`_FlowEdgeItem` 改三次贝塞尔曲线 + 箭头沿切线；`_render_template` 用持久化坐标；新增 `_auto_layout` 一键对齐、`persist_positions` 防抖静默保存。
- **工作流分支与步骤**：`_StepEditDialog` 加「作为其条件分支」checkbox；`_add_step` 支持选中节点插入其后并设分支；顺序/分支边去重；`save_template` 加 `silent` 参数。
- **数据层（SCHEMA_VERSION=11）**：`workflow_node` 增 `pos_x`/`pos_y`（`migrate_v11` 幂等加列）。
### v0.17.3 · 工作流模块

> v0.17.3 新增**工作流（Workflow）模块**：把重复事务沉淀为可复用流程模板，一键启动自动拆解为待办，并与知识库（笔记）和任务体系**双向绑定**。SCHEMA_VERSION=10（仅建表、不改旧数据）。全量测试通过（新增 21 项工作流回归）。

- **数据层（SCHEMA_VERSION=10）**（`model/infrastructure/{models,db}.py`）：新增四表 `workflow_template`（name/description/start_policy）、`workflow_node`（order_index / **note_id** 绑 SOP 文档 / **action_kind·action_value** 动作 / **condition·branch_node_id** 分支）、`workflow_instance`（status / current_node_id / **origin_task_id**）、`workflow_step_task`（`UNIQUE(instance_id,node_id)`）；`migrate_v10` 用四个 `CREATE TABLE IF NOT EXISTS`，仅建表、不动既有数据。
- **领域层**（`model/domain/entities.py`）：`WorkflowStatus` / `StepAction` / `StartPolicy` 三个枚举 + `WorkflowNode`/`WorkflowTemplate`/`WorkflowStep`/`WorkflowInstance` 四个 dataclass；纯函数拓扑：`ordered_nodes` / `first_node` / `next_node`（优先分支、否则顺序）/ **`validate`**（空模板、空标题、分支自环、分支悬空、**分支成环**）。
- **服务层**（`model/application/workflow_service.py`）：模板 CRUD（校验失败拒存、节点整体替换 + **分支 id 重映射**、有运行中实例拒绝删除、复制模板）；实例（`instantiate` 按策略下发 / `get_instance` 含步骤完成态 / `instances_of_task` / `abort_instance`）；**双向绑定核心** `_spawn_step_task`（步骤→真实任务：标题带流程前缀、挂 origin_task 为父、SOP 以 `[[标题]]` 入备注）与 `complete_step_task`（任务完成→推进实例，末步则完成）。
- **步骤动作**：`describe_action` / `is_risky_action` / `run_step_action` —— 命令**独立进程、不经 shell**（`shlex.split` + `Popen(argv)`），空命令与二进制缺失返回可读错误；保存与执行**双重风险确认**。
- **视图层**（`view/pages/workflow_page.py`）：三栏 `QSplitter`；`_StepNodeItem` 为**矩形**节点（圆角矩形 + 序号徽标 + 标题省略 + 「文档/动作/条件」角标），`_FlowEdgeItem` 直线+箭头（顺序实线/**分支虚线**）；`_FlowView` 复用图谱交互范式（拖动、滚轮缩放、中/右键平移、连线建分支）。
- **融合与接入**：`EventBus` 增 `workflow_template_changed`/`workflow_instance_changed`；`AppContext` 装配并注入 `task_service`；`MainWindow` 新增「工作流」导航（`nav.workflow` 图标）；`TaskPage`「速览」新增**工作流卡片**（实例状态/进度/步骤 + 「启动工作流…」）；`AppController._on_task_changed` 在 `reason=="completed"` 时**自动推进流程**。
### v0.17.2 · 交互整改批

> v0.17.2 为交互整改批：任务↔笔记新增「引用」关系（与归属并存，SCHEMA_VERSION=9）、图谱连线可选中/删除/拖端点改挂、链接笔记支持多链接、编辑器工具栏整合、命令面板贴合触发点、快速添加浮层可主动关闭。全量测试通过。

- **任务↔笔记「引用」关系**（`model/infrastructure/{models,db}.py` / `model/application/graph_service.py`）：新增表 `task_note_ref`（`UNIQUE(task_id,note_id)`、双外键 CASCADE），与既有 `task_note_link`（归属）**并存**；`SCHEMA_VERSION=9` + `migrate_v9`（`CREATE TABLE IF NOT EXISTS`，仅建表、不改旧数据）。连接矩阵新增 `EDGE_EITHER` 标记——`task↔note` 是唯一「两种关系皆可」的组合，由新增的 `resolve_edge_kind(src,dst,mode)` 结合拖拽入口模式定夺（未给模式时默认归属，保持旧语义）。服务层新增 `link_task_note_ref`（幂等）/`unlink_task_note_ref`/`detach_task_note`。
- **图谱边构建与分类修正**（`graph_service._attach_task_nodes` / `_finalize_edges`）：引用边写入 `edge_kinds=EDGE_REFERENCE`；`_finalize_edges` 改为「已显式标注则跳过」，修复 `classify_edge` 按节点类型推断时**覆盖引用标注**导致虚线退化实线的问题；同一对既有归属又有引用时只保留一条边并呈引用（避免视觉重叠，数据层两种关系均保留）。
- **图谱连线可编辑**（`view/pages/graph_page.py`）：`EdgeItem` 增 `ItemIsSelectable` + `shape()` 加宽命中区（`QPainterPathStroker` 12px，1.3px 细线可点选）+ 选中态加粗；`GraphView` 增 `select_edge` / `delete_selected_edge` / `_endpoint_at` / `_begin_rewire` / `_finish_rewire` / `keyPressEvent(Delete·Esc)`。**`dragMode` 默认改 `NoDrag`**——`ScrollHandDrag` 会把左键全部用于平移画布，导致连线无法点选/拖端点；仅连线模式切 `ScrollHandDrag`，并以中/右键拖动平移补偿。`GraphPage.remove_edge` 按边类分派删除（引用/归属/父子/笔记引用/文件夹归属），`rewire_edge` 先建新关系再删旧边。
- **链接型笔记多链接**（`view/components/note_previews.py` / `pages/note_page.py`）：`LinkPreviewView` 重构为多链接列表，`content_md` 存 JSON 数组 `[{title,target}]`；`parse_links` 对**非 JSON 内容按旧单条/多行纯文本兼容解析**，`dump_links` 在「单条且无标题」时退回纯文本保持可读；新增 `linksChanged` 信号即时落盘；每条链接独立「打开」。
- **编辑器工具栏整合 + 卡片标题动作槽**（`view/components/markdown_editor.py` / `view/ui/widgets.py` / `pages/note_page.py`）：`MarkdownEditor.make_toolbar_button()` 静态工厂让宿主注入的「保存/版本历史/查找替换」与格式按钮**同款同尺寸**；`UCard.header_row(title)` 提供标题行动作槽，「引用/归属」移入链接卡片标题右侧。
- **笔记项胶囊按钮 + 高 DPI 图标**（`view/note_tree.py` / `view/kit/icons.py`）：悬浮操作按钮改**纯图标胶囊**（软底全圆角、随行高自适应）；`paint` 读取 `option.widget.devicePixelRatioF()` 并逐层传入，图标按物理像素渲染（与任务项 delegate 一致）——此前漏传 dpr，Retina 下 1x 位图被放大而发虚。
- **弹窗几何与定位**（`view/ui/dialog.py` / `view/capture/quick_capture.py` / `view/components/command_palette.py`）：`UDialog` 增 `compact_title` + `COMPACT_TITLE_BAR_H=34`；快速捕获框 `_fit_height()` 按语法糖 chip 行数动态定高（自算 `_MIN_H` 突破通用 180px 下限）；`CommandPalette._place_under(anchor)` 对齐标题栏胶囊正下方居中展开。
- **浮层主动关闭**（`view/widget/floating_dock.py` / `view/shell/main_window.py`）：`FloatingDock.collapse()` 返回 bool，`MainWindow.eventFilter` 统一处理「点击浮层外 / `Esc`」收起（修复展开后无法关闭）。
- **可读性修复**：新建笔记弹窗目标输入框行内控件统一 `AlignVCenter`（清除按钮垂直居中）；标题栏命令胶囊高度固定（不再被全局 QSS 压成横向长方形）。

---

*README 与四份文档同步维护；版本历史自 v0.5 起记录（更早见各文档附录 A）。*
