# 知行 ZhiXing × Neo-Dark Glass：控件 / 布局 / 动效 / 交互 全量对照矩阵

> 配套文档：《docs/ui_design_compare_vs_neodark_glass.md》（高层差异与扩展提案）
> 本文件做**控件级逐项对照**，所有「知行现状」均为源码核验（文件+行号级），非臆测。基准：知行 v0.14/v0.15（232 测试绿）。
> 日期：2026-09-09

**对照方法**：以对手文档 §1 Token / §2 布局 / §3 控件与动效 / §4 Master QSS 逐项列出，逐一对照知行真实控件；对「对手规范无法在 Qt QSS 落地」的点，给出可行替代并标注。

---

## 0. 阅读约定

- ✅ **已有且等效/更优**：知行已实现且不低于对手描述 → 只引用证据，不重复做。
- 🔸 **可补（有差距）**：知行缺或弱 → 给最小实现路径 + 优先级（P0/P1/P2）。
- 🚫 **不采**：违反知行原则或对手自身缺陷。
- 动效/交互两矩阵与控件矩阵正交（控件矩阵看「有/无」；动效矩阵看「怎么动」）。

---

## 1. 动作 / 输入控件矩阵

| 控件 | Neo-Dark 规范 | 知行现状（证据） | 判定与建议 |
| --- | --- | --- | --- |
| **主按钮**（accent） | 极光紫发光、hover 提亮、**按下 0.97 缩放** | UButton(tone=accent,solid) 语义 token+派生明暗+focus ring（v0.14 T1/T6）；pressed 变色无缩放 | 🔸 补「按下微缩放」需 QSS 外实现（UButton 自绘/几何动画），见 §4 动效矩阵 R3 |
| **次级/幽灵按钮** | 透明微边框 | UButton kind=ghost（accent/默认）+ 散落 QToolButton 全局 QSS | ✅ |
| **QLineEdit/QTextEdit/QPlainTextEdit** | 深底、focus=紫 1px + 外发光 | 主题 token 输入框；**focus = 2px accent ring**（theme.py:135/165-167） | 🔸 发光落地=QGraphicsDropShadowEffect 挂聚焦控件（P0-2，QSS 无 box-shadow） |
| 占位符色 | `--text-muted` | 未统一（QSS 无 placeholder 色控；个别 setPlaceholderText 颜色） | 🔸 低优先：关键输入框（速记/命令面板）占位符用 fg3 |
| **QComboBox / 下拉** | popup 圆角+阴影+**150ms 淡入** | 原生 31 处 + fluent；弹层圆角/选中 accent_soft/箭头主题化已做（component_qss:340-354） | ✅ 视觉；popup 淡入原生不可控（Qt），不采 |
| 下拉选中项 | 紫底白字 | selection accent_soft+fg（对比 8.5:1） | ✅ 知行可达性更优 |
| **QDateEdit / QCalendarWidget** | （未详述） | 日历弹层随主题、today accent、文字 token（component_qss:356-367） | ✅ |
| **开关 ModernSwitch** | iOS 滑轨 OutCubic | qfluentwidgets SwitchButton×16，滑轨动画原生自带；控件高已对齐（v0.10.2 ⑦） | ✅ |
| **复选框 QCheckBox** | （未专述；Things 勾选见 AnimatedCheckbox） | 全局**圆形** indicator accent（theme.py:169-176）；任务行勾选=**自绘 spring 勾选**（task_delegate 9b，OutBack） | ✅ 已实现对手「AnimatedCheckbox」 |
| **QRadioButton** | （未专述） | 全局圆角长方形 QSS 有；实际页面多用 segmented/下拉，使用少（settings/theme.py） | ✅ |
| **SpinBox** | （未专述） | qfluentwidgets SpinBox（设置字号/控件高）；垂直居中已修（v0.10.2 ⑧） | ✅ |
| **QProgressBar** | 绿渐变 6px 圆角 | splash 进度 + BusySpinner 自转条（widgets.py:336-360） | 🔸 P2：补 green 渐变 chunk 样式（纯 QSS 可行） |
| **滚动条** | 细、hover 增亮 | 全局 QSS 9px、handle 圆角、hover fg2（theme.py:196-202） | ✅（无 hover 过渡属 Qt QSS 限制） |
| **QMenu / RoundMenu 右键菜单** | （未专述） | 原生 QMenu 主题化 + qfluentwidgets RoundMenu×3（任务树/收件箱/编辑器右键） | ✅ |

---

## 2. 数据 / 视图控件矩阵

| 控件 | Neo-Dark 规范 | 知行现状 | 判定 |
| --- | --- | --- | --- |
| **QTreeView / QListView 行** | 行高 32/36、hover 圆角高亮、item 用 QSS `height` | 行高经 delegate sizeHint 控制（task 38 / 笔记树 34），**QSS item 高度无效（Qt 限制）**；hover/选中 accent_soft 圆角 | ✅ 知行实现正确（对手示例 `QTreeWidget::item{height:32px}` 为无效代码，见 §6 揭穿） |
| 树折叠箭头 | chevron 旋转动画 | 原生箭头随主题；无旋转 | 🔸 P2（低） |
| **任务行（本产品核心，对手无此级）** | — | 自绘 delegate：勾选圈/优先级 pill/标签 chip/日期 chips/悬浮动作按钮/勾选弹簧/完成划线/拖拽排序/hover 不挤压文本（v0.14 T9）/hover tooltip 段落（v0.15） | ✅ 超越对手文档范畴 |
| **看板 / 日历 / 四象限** | — | 页内自绘/自定义控件全实现 | ✅（对手文档无此产品纵深） |
| **QTableWidget** | 隔行透明、表头去分割线 | 仅 1 处：Excel 只读预览（note_previews.py:478） | ✅ 无更多表格场景 → 不需补样式 |
| **QHeaderView** | 深底灰字 | Excel 预览内置 | ✅（无通用表格页） |
| **QTextBrowser / Markdown** | —（对手用富文本 HTML 概念） | 三态 Markdown 预览 + 代码高亮 + `[[链接]]` + Word/Excel/链接五格式 | ✅ 远超对手 |
| **QListWidget 列表页** | — | 回收站/命令面板/看板等 + 空态 EmptyState | ✅ |

---

## 3. 容器 / 浮层 / 扩展控件矩阵

| 控件 | Neo-Dark 规范 | 知行现状 | 判定 |
| --- | --- | --- | --- |
| **卡片 QFrame/卡片体系** | Glass 浮层 | 沉浸 UCard（自绘羽影+顶部受光，v0.7+），全局分区 | ✅（v0.14 复核过卡片层次） |
| **QGroupBox** | （示例中出现） | 0 使用（以 UCard 分组替代） | 🚫 无场景不引入 |
| **QTabWidget** | pane 圆角、tab 底边 2px | 主题化：accent 下划线 + 圆角 pane（component_qss:369-379）；收件箱/设置/编辑器 | 🔸 P2：切 Tab 淡入（可选项） |
| **UDialog / 弹窗** | 深阴影+圆角 | 无边框 UDialog + 自绘标题栏 + 圆角 token + fade_in 进场（v0.15 T10）+ 主题自愈 | 🔸 P1-3 阴影加深（CommandPalette/弹窗统一） |
| **MessageBox** | — | qfluentwidgets MessageBox×34（删除确认等），主题随 | ✅ |
| **InfoBar/Toast** | — | 统一 InfoBarPosition.BOTTOM + 撤销 Toast | ✅（v0.10.1） |
| **Raycast ⌘K 弹窗** | 居中深影、键盘平滑光标 | CommandPalette（命令/任务/笔记/标签）`exec()` | 🔸 P0-1 入口胶囊 + P1-3 阴影 |
| **ContextLinkBadge（段落胶囊）** | 22px、点击滚动高亮 | v0.15 已实现近似：任务编辑页「§ 段落定位按钮」+ 图谱 anchor 节点 + Markdown 定位高亮（extraSelection 1.4s） | ✅ 超对手（对手为纸面概念） |
| **FloatingDock 底部快捷条** | hover 展开新建 | 无 | 🔸 **P0-3 新增**（今日/任务页） |
| **右栏 Inspector** | 280 常驻可折叠 | 无常驻；图谱页有页内选中面板；任务编辑走弹层 | 🔸 P1-1 实验（默认折叠） |
| **桌面浮窗/速记/捕获卡** | —（双核文档有 QuickCapture 概念） | 全部实现且更深（贴边滑出/捕获去向五选/语法糖解析） | ✅ |
| **QToolTip** | — | 全局主题化 + 自定义 delegate/图形 tooltip | ✅ |
| **EmptyState / Skeleton / BusySpinner** | — | 全铺（v0.14 §5 确认） | ✅ |
| **Splash / 欢迎页** | — | SVG+进度+淡出，启动期完成全部初始化 | ✅ |

---

## 4. 布局矩阵

| 布局点 | Neo-Dark | 知行 | 判定 |
| --- | --- | --- | --- |
| 窗口形式 | Frameless + 自绘卡片阴影 | FluentWindow（qfluentwidgets 壳，Mica 可选） | ✅ 不换壳（macOS offscreen 限制已记录） |
| **标题栏** | 居中 ⌘K 胶囊 + 指示器 | 品牌+签名+翻页时钟+红绿灯；⌘K 无可见入口 | 🔸 **P0-1** |
| 三栏 QSplitter | 220/主/280 | 页内局部分栏（笔记=树|编辑器|反链用 QSplitter；图谱页内侧栏）；全局不分三栏 | 🔸 P1-1 右栏实验；不默认展开 |
| QStackedWidget 转场 | 淡入淡出+4px | 页切换 + PageHeader 入场（fade+slide）；弹层 fade_in | ✅ 同族（整页交叉淡化成本高，可选 P2） |
| QGridLayout 使用 | 仪表盘多列 | 设置「数据」卡 4 列、快捷键表 grid（settings_page） | ✅ |
| QFormLayout | 右对齐标签+折行 | 设置 5 Tab 表单化已做（v0.13 ⑥） | ✅ |
| FlowLayout | 标签云防横滚 | 主题包选择/强调色/成就卡/导出按钮流 | ✅（已有实现，非提案） |
| 内容留白规约 | margins/stretch | 各页 UCard 16px 内边距 + stretch 布局 | ✅ |

---

## 5. 动效矩阵（对齐对手 §3.2 曲线表 + 知行 motion.py 实测）

知行 DURATION=`{instant:100, fast:150, normal:250, slow:400, strike:200}`；EASING=`{standard/decelerate:OutCubic, accelerate:InCubic, spring:OutBack}`。

| 对手动效类型 | 对手参数 | 知行对应 | 知行落地证据 | 差距与建议 |
| --- | --- | --- | --- | --- |
| **Micro 颜色/透明过渡** | 100-150ms OutCubic | instant/fast 已定义 | hover 即时变色（**Qt QSS 无 transition**）；入场/勾选走动画 | 🔸 hover 渐变需自绘（QSS 做不到）→ P2 试点 UButton（QVariantAnimation 改背景） |
| **Bounce（勾选回弹）** | 200-250 OutBack | spring=OutBack 已定义 | 任务勾选 spring_check（150ms fast）；Skeleton 脉动；抽屉 | ✅ 等效已实现 |
| **Panel 抽屉/侧栏展开** | 250-300 OutExpo | normal=250 OutCubic | FluentWindow 侧栏折叠（qfluentwidgets 原生动画） | ✅ 等效；🔸 motion 可补 `panel=OutExpo` 供 FloatingDock/右栏使用（P1） |
| **Page 页面转场** | 200 InOutQuad + 4px | 入场 title_enter 300 OutCubic + slide15 | PageHeader.play_enter（widgets.py:185-189） | ✅ 等效微调（若要一致可改 InOutQuad+8px，P2 可选） |
| **Popup 弹层 150 淡入** | 150 | fast=150 OutCubic | UDialog/capture/quick_capture fade_in（v0.15 T10 统一）；CommandPalette | ✅ 已统一 |
| — 对手未提，知行已有 | — | — | 完成划线 200ms、子任务 stagger、图表生长、翻页时钟、数字滚动、完成撤销 Toast | ✅ 超越 |
| — reduce-motion | 未提 | OS 探测 + 设置「完整/精简」 | app_controller _os_reduce_motion/_motion_enabled（:813/833-838） | ✅ 可达性领先 |
| **R3 按下 0.97 缩放** | — | 无 | — | 🔸 需 UButton 几何/自绘实现（QSS 无 transform）；按下反馈现为变色，够用则不做（P2 候选） |
| **R4 Focus 外发光过渡** | — | 无过渡 | 2px ring 即时 | 🔸 P0-2（QGraphicsDropShadowEffect 或自绘） |

---

## 6. 对手规范的 Qt 落地缺陷（矩阵外重要说明：避免误照搬）

1. **QSS `box-shadow` / `transition` / `transform: scale` 不存在于 Qt**：对手「hover 渐变发光」「0.97 缩放」「外发光 focus」若照 QSS 抄全部无效 → 需 QGraphicsDropShadowEffect / QVariantAnimation / 自绘；本矩阵已在各条标注可行替代。
2. **`QTreeWidget::item { height: 32px }` 无效**：Qt QSS item 不支持 height；行高须 delegate `sizeHint`（知行做法正确，task_delegate:61-62）。
3. **对手示例语法错误**：`def get_circleFactor((self)` → 其 AnimatedCheckbox 不可运行；知行 spring 勾选是真实现。
4. **emoji 图标**与**纯黑背景**违反知行图标/对比纪律 → 不采。
5. **单一日深色主题**：对手把「Neo-Dark Glass」当唯一视觉；知行 14 主题包是卖点 → 可加「深黑」预设而非推翻。

---

## 7. 建议实施批次（增量、可回退、不动业务层）

| 批次 | 内容 | 类型 |
| --- | --- | --- |
| **P0（推荐先做）** | P0-1 标题栏 ⌘K 入口胶囊 · P0-2 聚焦输入/主钮发光（QGraphicsDropShadowEffect）· P0-3 底部 FloatingDock（今日/任务页） | 可见入口 + 质感 |
| **P1** | motion 补 `panel=OutExpo` 等 token · 弹窗/⌘K 阴影加深 · 右栏 Context Inspector 实验（默认折叠） | 层次 + 空间 |
| **P2（低优先/可选项）** | UButton hover 渐变试点 · 树 chevron 旋转 · Tab 切淡入 · 绿色渐变进度条 · 整页转场微调 | 打磨 |
| **明确不做** | QTableWidget 表格样式（无场景）· QGroupBox（用 UCard）· 换壳 Frameless 覆盖 qfluentwidgets · hover 依赖唯一反馈（无渐变时保底色） | 守原则 |

*实施顺序建议 P0 三件各自独立提交；每件跑全量测试 + 真机截图前后对比后，由用户决定 P1/P2。*

---

## 8. v0.16 实施完成（2026-09-09）

上表 🔸 项全部落地，逐条对应：R1 Focus 发光=P0-2（QGraphicsDropShadowEffect）；R2 ⌘K 入口=P0-1 标题栏胶囊；R3 快捷新建 Dock=P0-3（今日/任务页）；R4 右栏 Context=P1-c（默认折叠）。动效侧：panel/page 曲线入 token（P1-a），hover 渐变（P2-a，solid 试点）、chevron 旋转（P2-b，笔记树）、Tab 淡入+页面转场微调（P2-c）、语义绿渐变进度条（P2-d）。弹窗外柔影（P1-b）。232 测试绿 + 真机截图复核通过。未做项记录于 §6（ghost hover 插值、任务树行内箭头等，均属低收益/平台限制）。
