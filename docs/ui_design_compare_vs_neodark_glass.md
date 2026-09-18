# 知行 ZhiXing UI 对照「Neo-Dark Glass 双核效能系统」— 差异分析与 UI 扩展优化设计

> 对照对象：外部需求文档「双核个人效能系统：UI/UX 设计规范与 PySide6 全量实现」（Neo-Dark Glass 深色微光视觉 + 三栏布局 + 全控件 QSS + Things3/Craft/Raycast/Linear 参考）
> 对照基准：知行 v0.14 视觉精修 + v0.15 功能批之后（14 主题包 × 亮暗 × 8 强调色、语义 token 体系、沉浸 UCard、全套动效/空态/可达性已落地，测试 232 绿）
> 日期：2026-09-09 · 方式：逐能力点核知行源码（非猜测）
> 结论：**对方文档的「工程实现」质量不达标（含语法错误、emoji 图标、纯黑背景、单一日深色主题），不宜照搬；但它的「三栏布局 × 质感强化 × ⌘K 可见入口 × 底部快捷浮条」4 个布局/交互理念确实值得知行吸收。知行在 token 架构、主题体系、图标纪律、可达性上全面领先，本提案只做加法、守住底盘。**

---

## 0. 一句话结论

**对方的价值是「场景化排版与质感启发」：居中 ⌘K 搜索胶囊、常驻右栏 Inspector、底部快捷 Dock、按钮发光聚焦——知行缺的是这几处「入口可见性/空间层次」，而不是视觉体系（知行 14 主题语义 token 明显更强）。本提案以 P0 小改（可见入口 + 聚焦质感）为主，不做整体换肤。**

---

## 1. 视觉设计系统对照

| 维度 | Neo-Dark Glass（对方） | 知行现状（实测） | 判定 |
| --- | --- | --- | --- |
| 主题架构 | **单一日深色**硬编码 `#0D0F12/#1A1D24...` | 语义 token（canvas/layer/fg/…）× **14 主题包 × 亮/暗 × 8 强调色**，`ThemeEngine` 动态 QSS + 组件自愈 | 知行架构领先（对方硬编码色违反 v0.14 已立「token 化」纪律） |
| 纯黑 vs 近黑 | `#0D0F12` 背景 | 墨黑包 `#1E1E1E` 起、各马卡龙包近黑有色彩倾向；v0.14 已禁用纯 `#000` | 知行优（对方背景属「纯黑 family」，拒绝） |
| 强调色 | 极光紫 `#6366F1` 固定 | 用户可选 8 色 + 主题包默认（青竹 #0D9488 等） | 知行优（个性化） |
| 状态色 | complete=翡翠 / P0=珊瑚 / P1=琥珀 / P2=湛蓝 | danger/warm/accent/success 语义 token + 优先级三色（danger/warm/accent） | 语义一致，色值不照搬 |
| 质感 | Glass：`rgba(26,29,36,0.72)` 玻璃层 + blur（设计愿景） | Mica + 沉浸 UCard（无边框+羽影+顶部受光）+ 半透明输入 | 知行已具同族质感；对方真 blur 在 Qt 需平台材质，均未落地验证 |
| 图标 | **emoji**（📁📅📥🔍⌘） | 全 SVG Lucide 风格族 + currentColor | 知行优（emoji 违反图标纪律，明确不采） |
| 圆角 | 6/10/16 | token radius-sm4/ctl6/md8/lg12（卡片与弹层 12） | 层级一致、知行 token 化 |

**对方可借鉴的质感点（非整套）**：① 按钮/输入聚焦时的「微发光」（不仅 1px ring）；② 弹层阴影更深（知行的 UCard 羽影偏收敛）；③ 「玻璃浮层」popover 层次。均见 §4 P0-2/P1 评估落地性。

---

## 2. 布局架构对照（这是真正的差距所在）

| 布局点 | Neo-Dark Glass | 知行现状 | 差距/机会 |
| --- | --- | --- | --- |
| 标题栏 | 居中 **⌘K 搜索胶囊** + 同步指示器 | 品牌 + 签名 + 翻页时钟 + 系统红绿灯 | **命令面板入口不可见**（仅 ⌘K 快捷键/按钮触发）→ 标题栏胶囊入口是最高感知改造（P0-1） |
| 导航 | 左树 PARA + 行动清单 | Fluent 左侧导航（今日/任务/收件箱/笔记/图谱/回顾/设置） | 知行导航更贴近产品；无树形 PARA 需求，不采 |
| 工作区 | 三栏 QSplitter（220 / 主 / 280 右 Inspector 可折叠） | 页内分栏：笔记=树|编辑器(+反链)；任务=列表/看板 + 按需编辑弹层；图谱=页内右栏 | 知行以「页内局部栏 + 按需弹层」换专注；可补「任务选中 → 常驻右栏上下文」实验（P1-1） |
| 底部 | **快捷新建 Dock 浮条**（hover 展开） | 无（桌面浮窗/全局热键承担快速入口） | **主窗内新建入口分散在各页按钮** → 统一底部快捷 Dock（P0-3，与既有「快速捕获」语义协同） |
| 弹窗 | Cmd+K 居中 + 深阴影 | CommandPalette `exec()` 模态（跟随父窗居中） | 定位已居中；可加深阴影与「淡入」完善（P0-2 顺带） |
| 视图转场 | 200ms InOutQuad 淡入淡出 + 4px | 切页 PageHeader.play_enter（300ms fade+slide）；弹层 fade_in | 已具同族转场；差距在「整页间交叉淡化」非必需 |

---

## 3. 控件与动效对照（已有 vs 提案 vs 拒绝）

### 3.1 知行已具备（对方文档描述为"新建"，知行实已实现——只列不重做）
- **AnimatedCheckbox（Things 勾选弹簧）**：task_delegate 勾选=OutBack 弹簧 + 完成划线 200ms（v0.10 动效 9a/9b 已落地）。
- **ModernSwitch**：qfluentwidgets SwitchButton（v0.10.2 ⑦ 已对齐全局控件高、滑轨 22px 居中）。
- **FlowLayout 标签云/胶囊**：view/kit/flow_layout.py（设置页主题包/强调色/成就卡在用）。
- **进度条**：BusySpinner（自转）、番茄钟专注进度环；如要绿色渐变条是简单加法（P2）。
- **chevron 树旋转**：任务/笔记树折叠已有基础指示（未做旋转动画——P2 可选）。
- **⌘K 命令面板**：CommandPalette 已有（命令/任务/笔记/标签/闪念/主题直达）。

### 3.2 对方有、知行缺且值得做的（见 §4）
| 提案 | 对方点 | 知行补法（低风险） |
| --- | --- | --- |
| P0-1 | 标题栏居中搜索胶囊 | CustomTitleBar 加居中胶囊 QPushButton（「搜索或执行命令… ⌘K」），点击即现有 CommandPalette.open_palette()；签名/时钟让位或胶囊化 |
| P0-2 | 输入/按钮聚焦发光 | QSS 层面 Qt 无 box-shadow：落地=输入框 `border 1px focus + rgba(accent,0.25) 2px 外扩`不可行 → 用 `QGraphicsDropShadowEffect`(accent, 8px, 0.35) 仅挂 focus 输入框/UButton(accent solid)，失焦移除；性能影响小（临时 effect）|
| P0-3 | 底部快捷 Dock | 新 `FloatingDock`（主窗底部居中胶囊条，hover 展开 新建任务/笔记/闪念/收件箱），触发现有 controller 动作（quick_create / 新建笔记 / capture）|
| P1-1 | 常驻右栏 Context Inspector | 任务页选中任务时右侧可折叠面板（复用 v0.15 linked_contexts：显示关联笔记段落 + 元数据 + 定位跳转）；默认折叠以保专注（与现有「编辑弹层」互斥取舍）|
| P1-2 | 按钮按下 0.97 缩放 | UButton 增 pressed 微缩放（motion.animate scale）——QSS 不能 scale，需在 UButton 上做按下视觉（效果有限，评估后定）|
| P1-3 | 弹层阴影加深 + 淡入 | 命令面板/对话框统一加深阴影（QGraphicsDropShadowEffect 或自绘），配合已有 fade_in |
| P2 | 各种微磨 | ① 树 chevron 旋转动效 ② 进度条绿色渐变样式 ③ 「同步/保存」状态指示器（标题栏小点，随保存状态闪烁——知行已有「已保存 HH:MM」提示可升级为标题栏指示）|

### 3.3 明确不采纳（对方实现缺陷 / 知行原则冲突）
1. **emoji 图标**（📁📅📥🔍⌘📤）→ 违反知行 SVG 图标纪律（v0.13 已全面去 emoji，v0.14 T4 再清一轮），坚决不采。
2. **单一日深色主题 / 纯黑 `#0D0F12`** → 知行 14 主题包体系是产品卖点；可提供「深色更深的预设」而非推翻。
3. **整体 Frameless + 自绘 QSS 覆盖 qfluentwidgets** → 工程代价大且与既有 Fluent 体系冲突；保留 FluentWindow。
4. **对方代码工程缺陷**：`def get_circleFactor((self)`（语法错）、QLCDNumber 倒计时（丑）、单一文件堆叠 → 仅取理念，不照搬实现。
5. **PARA 树形导航**：与知行「今日/任务/笔记/图谱」工作流不匹配，不做。
6. **右栏 280px 常驻**（对方默认展开）：占面积、扰专注；知行若做也默认折叠/可隐藏。

---

## 4. 知行 UI 扩展与优化提案（P0 先行 · 全部为增量不换肤）

### P0-1 ⌘K 入口可见化：标题栏居中「命令搜索胶囊」
- 位置：CustomTitleBar 中部（现有翻页时钟两侧 stretch 的中间位，与时钟/签名互斥取舍——建议**胶囊常驻、签名下移或仅折叠态显示**）。
- 交互：胶囊显示「搜索或执行命令… ⌘K」（Lucide 图标 search + 文字），点击/⌘K → 现有 `CommandPalette.open_palette()`；胶囊 hover 边框 accent（对齐 UButton focus 体系）。
- 收益：把深藏的命令面板变成「一眼可见的一等入口」——对齐 Raycast/Linear 的感知，改动集中在 main_window.py + command_palette（尺寸/阴影微调）。

### P0-2 聚焦「发光」质感（有限落地）
- 输入框获得焦点：border=accent(已有 1px→2px ring) + `QGraphicsDropShadowEffect`(accent, blur≈10, alpha≈0.30) 叠加；失焦移除。逐控件 effect 有性能成本，范围收敛在**当前聚焦控件**（全局 eventFilter 只给 active 输入框挂）——风险中，先做 QLineEdit/QComboBox/QTextEdit。
- 主操作 UButton(accent solid)：hover/focus 时给按钮挂同款弱发光（视觉层次对齐对方「霓虹光圈」但用 accent 派生色，不引入紫色）。
- 失败降级：若真机掉帧，只保留现有 2px ring + hover 亮度，发光作为「仅在 light 主题」的可选项（设置项可关）。

### P0-3 底部快捷新建 FloatingDock
- 新控件 `view/widget/floating_dock.py`：主窗口底部中央胶囊（「＋」icon），hover/点击展开 4 项：新建任务（quick_create 弹输入）、新建笔记（跳笔记页新笔记）、记闪念（捕获卡）、收件箱。全部复用 controller 既有动作/信号，不动业务层。
- 只在今日页/任务页显示（收件箱/笔记/图谱页已有各自新建入口，避免重复 CTA——符合「一件事一个主入口」设计原则 §1.1）。
- 主题：胶囊背景 layer + 阴影 + accent hover，随 ThemeEngine 自愈（沿用 UCard 视觉语言）。

### P1-1 「选中上下文」右栏（实验性，默认折叠）
- 任务列表选中任务 → 右侧可折叠面板（宽 ~280 可拖）显示：标题元数据（优先级/截止/重复/提醒）+ **关联笔记段落（v0.15 task_note_context，可点击定位）** + 相关标签。
- 与「任务编辑弹层」关系：弹层仍是「编辑」，右栏是「速览上下文」——互斥呈现（打开弹层时收起右栏），避免重复入口。
- 数据全走现有 service（linked_contexts/notes/tags），无新表。

### P1-2/P1-3/P2（批次二，视验收反馈）
- P1-2 按钮按下微缩放（UButton pressed 0.97，OutCubic 120ms）——评估 QSS/自绘代价后定，低优先。
- P1-3 命令面板/弹层阴影加深 + 淡入微调（panel 类动效 200ms InOutQuad 统一）。
- P2 微磨：树 chevron 旋转、绿色渐变进度条、标题栏「保存/同步」状态小点（复用笔记页「已保存 HH:MM」语义）、Deep Dark 预设包（可选）。

---

## 5. 落地节奏与验收

1. **P0 三件**（⌘K 胶囊 / 聚焦发光 / FloatingDock）单独成批：每件 = 改 UI 层 1-3 文件 + 离屏/真机截图前后对比 + 215+ 测试保持绿。
2. **P1/P2** 由用户对 P0 观感反馈后再实施（尤其发光性能与右栏是否值得）。
3. 验收沿用项目桌面流程：浅/深/8 强调色切一遍，核对发光不糊、Dock 不挡列表、胶囊不挤标题栏、reduce-motion 下 Dock/胶囊无动画异常。

---

*本提案只做「入口可见性与质感增强」的加法，不动主题体系/图标/信息架构；实施后逐项回写本文件标注。*

---

## 6. 实施完成状态（v0.16 UI 增强批 · 2026-09-09 回写）

> 全量测试 **232 项保持绿**；真机截图（今日/任务/笔记页）视觉复核通过（⌘K 胶囊、FloatingDock、速览按钮、chevron 均渲染正常，无叠压错位）。

| 项 | 交付 | 落点 |
| --- | --- | --- |
| P0-1 | 标题栏居中「搜索任务、笔记、命令… ⌘K」胶囊 → 唤起 CommandPalette（dispatch "command-palette"） | main_window CustomTitleBar / app_controller |
| P0-2 | 聚焦发光：QLineEdit/下拉/数字框/强调主按钮聚焦时 QGraphicsDropShadowEffect(accent,blur12,α90)，失焦清除（大滚动编辑器排除防性能） | app_controller.eventFilter 全局过滤 |
| P0-3 | FloatingDock 底部快捷「+」（新建任务/笔记/闪念），仅今日/任务页显示，panel(OutExpo) 展开 | 新 view/widget/floating_dock.py + main_window overlay |
| P1-a | motion EASING 增 panel=OutExpo / page=InOutQuad；DURATION 增 page=200 / panel=280 | motion.py |
| P1-b | 无边框弹窗外部柔影（WA_Translucent + QGraphicsDropShadowEffect），fade 完成后延迟挂避免 effect 互斥 | _util.attach_dialog_shadow、command_palette、dialog.py |
| P1-c | 任务页工具栏「速览」→ 右侧 Context Inspector（260px 默认折叠；显示状态/优先级/截止/等待至/关联段落可点击定位/标签，选中刷新） | task_page |
| P2-a | UButton solid hover 底色 150ms 渐变（css 模板 + QVariantAnimation 帧插值，replace 占位符避开 CSS 花括号冲突）；ghost 保持 Qt 即时态 | widgets.py |
| P2-b | 笔记树文件夹 chevron 展开/折叠 120ms 旋转（delegate 角度插值 + attach_view/expanded 信号） | note_tree / note_page |
| P2-c | QTabWidget 切页 150ms 淡入（设置/收件箱/回收站）+ PageHeader 入场统一 page token（200ms InOutQuad 8px） | motion.attach_tab_fade、widgets |
| P2-d | 全局 QProgressBar 语义绿渐变圆角 chunk（新增 success token 读取） | theme.component_qss |

**取舍**：hover 渐变仅 solid（ghost 透明底插值留待后续）；chevron 旋转作用于笔记树自绘 chevron（任务树行无原生箭头，依赖 reveal 动效）；弹窗柔影需 translucency，个别平台若显示异常可回退 `_attach_shadow`。
