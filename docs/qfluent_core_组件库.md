# qfluent_core 组件库：接入与迁移对照

框架层（皮肤 / 绘制 / 动画 / 基础信号 / 纯 UI 状态）与业务层彻底分离；组件只表达
**外观 + 交互状态**，不含业务语义。样式全部来自 `resources/qss/*.qss` 模板 + 语义 token，
组件代码里不出现色值、字号与圆角。

画廊（可视验收面）：`.venv/bin/python -m examples.component_gallery`
截图：[docs/qfluent_core_gallery](qfluent_core_gallery/)

---

## 一、三步接入

### 1. 装配配置源与主题（启动时一次）

```python
from qfluent_core import ThemeManager, UISettings

ui = UISettings()
ui.set_persister(lambda key, value: my_settings_service.set(key, value))  # 写盘
ui.load(read_from_settings_service())                                     # 载入
UISettings.install(ui)          # 所有打开的界面共用同一配置源

theme = ThemeManager()
theme.apply_tokens(my_theme_engine.tokens, mode=my_theme_engine.mode)     # 已有主题真源
my_theme_engine.changed.connect(
    lambda: theme.apply_tokens(my_theme_engine.tokens, mode=my_theme_engine.mode))
ThemeManager.install(theme)
```

`apply_tokens()` 是**补全**语义：业务表覆盖同名 token，未提供的角色由内置基线补齐，
并按当前强调色重新派生（不残留内置青绿）。业务侧不完整的 token 表也能直接跑。

### 2. 建窗口

```python
from qfluent_core import FluentTemplateWindow

window = FluentTemplateWindow(None, "知行 ZhiXing", signature="知行合一",
                              command_placeholder=" 搜索任务、笔记、命令… ")  # 全部可配
window.add_page(task_page, "任务", key="tasks")
window.commandRequested.connect(self.open_command_palette)  # 框架信号 -> 业务函数
window.show()
```

### 3. 直接用组件

```python
from qfluent_core import UButton, UCard, UField, ULineEdit

card = UCard("任务标题", "最长 80 个字符")
card.add_widget(UField("标题", ULineEdit("", "输入标题…")))
card.add_widget(UButton("保存", tone="accent"))
```

皮肤随窗口自动携带（`base + components + window` 三段模板）；组件独立使用时调用
`qfluent_core.apply_skin()` 上到应用级即可。

---

## 二、组件清单

| 分类 | 组件 | 变体 |
| --- | --- | --- |
| 文字 | `UTitle` | role: title / subtitle / body / caption / muted |
| 动作 | `UButton` | tone: standard, accent, subtle, danger, warn, success, info；kind: solid / ghost；size: compact / standard / large |
| 动作 | `UIconButton` | size；role="close"（tooltip 为必填参数） |
| 动作 | `UToggleSwitch` | 持久设置；自绘滑轨，尊重 reduce-motion |
| 动作 | `USegmentedControl` | 小集合邻近视图互斥切换 |
| 动作 | `UColorSwatch` | 强调色色块（自绘圆点，选中态带描边环） |
| 输入 | `ULineEdit` | state: normal / error；原生清空按钮 |
| 输入 | `USearchBox` | 图标 + 清空 + 焦点态跟随容器 |
| 容器 | `UCard` | variant: raised / sunken / plain；header / body / footer |
| 容器 | `UDivider` | 水平 / 垂直 |
| 容器 | `UExpander` | 单个可折叠区域（高度动画） |
| 容器 | `UPageHeader` | 标题 + 副标题 + 右侧动作区 |
| 容器 | `UField` | 标签 + 控件 + 帮助/错误（错误就近显示） |
| 状态 | `UStatusPill` | kind: soft / solid / outline ⨯ 7 tone |
| 状态 | `UBadge` | 计数（超过阈值显示 N+） |
| 状态 | `UInfoBar` | 内联持久状态 + 可选动作 + 关闭 |
| 状态 | `UProgressBar` | 语义 tone |
| 状态 | `UProgressRing` | determinate / indeterminate |
| 状态 | `UEmptyState` | 有意设计的空态 + 主动作 |
| 状态 | `USkeleton` | 保持几何的加载占位（呼吸动画） |
| 浮层 | `UDialog` | 无边框 + 标题栏 + 底部动作区，可拖动/拉伸 |
| 浮层 | `UConfirmDialog` | `UConfirmDialog.ask(parent, ...) -> bool` |
| 基础 | `UCheckbox` | 标签 + 说明；三态；state=error |
| 表单 | `USlider` | 水平/垂直；范围与步长可配；带无障碍数值 |
| 表单 | `UComboBox` | 单选；items 支持 (文本, 业务值)；current_value / select_value |
| 表单 | `UMultiComboBox` | 多选；收起显示已选摘要（summary_limit 控制长度） |
| 表单 | `UDatePicker` | 弹层日历；默认今天；值域与显示格式可配 |
| 表单 | `UUpload` | 拖拽/点选 + 文件列表 + 移除；只负责挑文件，不发请求 |
| 数据 | `UAvatar` | 首字或图片；圆/方；可选状态点 |
| 数据 | `UTable` | 静态小表：一次填充、只读、列宽均分 |
| 数据 | `UDataTable` | 搜索 + 点表头排序 + 分页；只把当前页交给视图 |
| 数据 | `UImageCompare` | 双图拖拽分割线对比 |
| 数据 | `UConsole` | 分级别着色；maximumBlockCount 限行，长跑不涨内存 |
| 反馈 | `UAlert` | 图标 + 标题 + 正文 + 动作 + 关闭 |
| 导航 | `UMenu` | 侧边菜单：分组 + 选中指示条 + 可折叠，可嵌任意布局 |
| 导航 | `UTopbar` | 顶部栏：标题/副标题 + 左右插槽 |
| 导航 | `UBreadcrumb` | 层级路径 + itemClicked |
| 导航 | `UTabs` | 同一工作区的平级视图切换 |
| 导航 | `UPagination` | set_total 按行数分页；程序化 set_page 不发信号 |
| 导航 | `UDropdown` | 一个入口多个动作；itemTriggered(key) |

---

## 三、从既有项目迁移的对照

| 既有项目（zhixing 等） | qfluent_core | 迁移说明 |
| --- | --- | --- |
| `UButton(text, tone, kind)` | `UButton(text, tone, kind, size)` | 参数兼容；新增 size 档位与按压内缩反馈 |
| `UCard` | `UCard(title, subtitle, variant=...)` | 新增 variant；`body_layout` 用法一致 |
| `UTitle(text, role=...)` | 同名同参 | role 名一致，直接替换 |
| `UStatusPill(text, tone, kind)` | 同名同参 | 新增 outline 变体 |
| `UEmptyState` / `Skeleton` / `BusySpinner` | `UEmptyState` / `USkeleton` / `UProgressRing(indeterminate=True)` | 旋转指示统一为 UProgressRing |
| `UDialog` | `UDialog` | 新增 footer 动作区与 `set_primary_action` |
| `PageHeader` | `UPageHeader` | 新增 `add_action()` |
| — | `UIconButton` `UToggleSwitch` `USegmentedControl` `ULineEdit` `USearchBox` `UField` `UDivider` `UExpander` `UBadge` `UInfoBar` `UProgressBar` | 既有项目缺失或散落自绘的能力 |
| 各页散落的 `setStyleSheet(...)` | `components.qss` 属性选择器 | 用 `setProperty` 表达变体，不要覆盖组件状态 |

迁移时**不要**做的事：不要在页面里给组件 `setStyleSheet`（会绕开组件状态）；不要把业务文案 /
图标路径写进组件（一律走 `__init__` 参数）。

---

## 四、配置变化 -> 界面实时刷新（无需重启）

框架的窗口与组件已自动订阅 `UISettings.changed` 与 `ThemeManager.changed`；业务侧只需订阅
自己关心的那部分：

```python
ui.fontChanged.connect(self.reflow_business_rows)        # 字号 -> 业务行高
ui.themePackChanged.connect(self.reload_business_data)    # 主题包 -> 重新查询
theme.changed.connect(self.repaint_business_skin)         # 亮暗 -> 业务自绘用色
ui.changed.connect(self.on_ui_config_changed)             # 统一入口 -> 桥成业务事件
```

---

## 五、设计约束（避免退化）

- 一个局部决策区**只允许一个 accent 主动作**；
- 破坏性动作常态中性，hover/确认才转红，不做永久大红；
- 先靠 canvas/layer 角色、间距与排版建立层次，**卡片只在有独立填充/边界/交互时**使用；
- 图标按钮必须给可读 `tooltip`（构造参数强制），图标本身不构成标签；
- 状态色成对使用（语义前景 + 低饱和软底），不要只靠色相表达状态；
- 颜色 / 字号 / 圆角 / 间距一律取 token，禁止写死；皮肤只改 `.qss` 模板。

---

## 六、验证

```bash
QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/test_qfluent_core.py \
    tests/test_qfluent_core_components.py -q          # 框架 + 组件契约
.venv/bin/python -m examples.component_gallery         # 人工视觉验收
```

测试覆盖：语义角色齐备、旧 token 名兼容、模板无未满足占位符、组件可构造且有 objectName、
可聚焦组件必有可读标签、变体非法值回落、主题/配置热切换、进度条 chunk 比例（像素级）、
画廊组件确实挂在控件树里。
---

## 七、动效测试窗口

`.venv/bin/python -m examples.motion_showcase`

四页：壳动效 / 控件动效 / 反馈与浮层 / 动效降级。每页进入时自动重播本页动效，
顶栏 ↻ 可手动重播；降级页开关关闭后所有动效立即停（含正在播放的）。

| 动效 | 实现方式 | 时长 / 曲线 |
| --- | --- | --- |
| 导航折叠 | `Property(navWidth)` + QPropertyAnimation | 280ms OutExpo（panel） |
| 导航指示条 | `geometry` 属性动画 | 280ms OutExpo |
| 页面切换 | 淡入 + 4px 上移 | 200ms OutCubic（page） |
| 开关滑轨 | `knobPos` 浮点属性动画 + 自绘 | 150ms OutCubic（fast） |
| 折叠面板 | `maximumHeight` 动画（起点取 maximumHeight 而非 height） | 150ms |
| 骨架呼吸 | 动态属性切换（`[pulse]` 选择器） | 700ms |
| 数字滚动 | QVariantAnimation 逐帧 setText | 400ms（slow） |
| 进度条 | QVariantAnimation 逐帧 setValue | 400ms |
| 进度环 | `angle` 属性动画循环 / 按 value 画弧 | 900ms loop |
| 逐条入场 | `motion.stagger` 逐项 fade_in | 60ms / 项 |
| 对话框入场 | 淡入 + 6px 上移 | 150ms（fast） |

动效证据（GIF 慢放 2 倍，按真实时间戳抓帧）：
[motion-showcase.gif](qfluent_core_gallery/motion-showcase.gif) ·
[关键帧拼图](qfluent_core_gallery/motion-keyframes.png)

抓帧工具：`.venv/bin/python scripts/capture_motion.py`（需 QT_QPA_PLATFORM=offscreen）

> 两个必须守住的实现约束（都踩过）：`QPropertyAnimation` 若无 parent 且无保活引用，
> 函数返回后会被 GC，**动画静默失效**（属性停在起点）；折叠类组件的动画起点必须取
> `maximumHeight`，不能取 `height()`（隐藏不归零、未布局时为 0，两种取法都会让动画空转）。
---

## 八、主题包 / 圆角 / 材质 / 动效档位

画廊第 0 页「主题与材质」是这四项的操作入口（也是验收面）：
`.venv/bin/python -m examples.component_gallery`

### 8.1 主题包与强调色

| API | 作用 |
| --- | --- |
| `theme.set_pack("樱花粉")` | 换整体配色，并同时启用该包的默认强调色 |
| `theme.set_accent("#2563EB")` | 只换强调色家族（hover / pressed / 软底 / 实底自动派生），中性色不动 |
| `theme.register_pack(ThemePack(...))` | 注册主题包 |
| `theme.load_packs(dir)` | 从目录加载 *.json 主题包 |

内置 5 个包：默认 / 墨黑 / 樱花粉 / 奶咖棕 / 青竹。每个包只需给 canvas / layer / fg 三个锚点色，
其余角色由 `pack_palette()` 派生（对亮色与暗色同样成立）。既有项目 zhixing 的 14 个主题包
JSON 可直接 `load_packs()` 吃进来（格式兼容，已有测试覆盖）。

窗口与组件都通过 `ThemeManager.bind_settings(ui_settings)` 自动接线：改主题包或强调色 →
所有打开的界面立即换肤，业务侧不用接线。

### 8.2 全局统一圆角

一个基准值派生整套档位 `radius_tokens(base)`：

```
base  4  6  8  12  16
  xs  -  2  4   8  10
  sm  -  4  6  10  12
  ctl -  6  8  12  14
  md  -  8 10  16  20
  lg  - 12 18  20  24
```

胶囊 `radius-pill` 恒为全圆角（等于半高，不随设置变化）。窗口与组件共用唯一入口
`ThemeManager.render_tokens(settings)`，因此不会出现「改了设置但卡片还是老圆角」。
QSS 模板里每个 `border-radius` 都必须来自 token —— 这条有测试守着（扫描 *.qss 的写死圆角）。

### 8.3 显示材质

| 档位 | 实现 | 可用平台 |
| --- | --- | --- |
| solid | 实色面 | 全平台 |
| translucent | 面半透明 + 窗口透明 | 全平台 |
| glass | 更透明 + 高光描边 | 全平台 |
| mica / acrylic | 系统合成材质 | Windows（DWM）；macOS 默认关闭 |

- 材质同时改「窗口层」（`WA_TranslucentBackground`）与「所有面」（layer / surface / control /
  layer-alt 转 rgba）；
- 系统材质不可用时自动退化（mica → translucent，acrylic → glass），`window.material` 返回
  实际生效档位，UI 用 `window.available_materials()` 灰显不可用档位。

> **macOS 说明**：往 Qt 管理的 contentView 插 `NSVisualEffectView` 会与 Qt 的 Cocoa 集成冲突，
> 实测出现过进程级 Abort（try/except 拦不住的原生崩溃）。因此 macOS 上系统材质默认关闭，
> 对应档位灰显并退化到纯 Qt 观感；确实要试可设 `QFLUENT_MACOS_VIBRANCY=1` 自行评估。

### 8.4 动效档位

`motion.set_profile("snappy" | "standard" | "relaxed")`：整体缩放动画时长 + 换缓动风格。

| 档位 | 时长缩放 | 缓动 |
| --- | --- | --- |
| 迅捷 snappy | 0.6x | OutQuart |
| 标准 standard | 1.0x | OutCubic |
| 舒缓 relaxed | 1.7x | InOutCubic |

所有动画（含 stagger 的每项间隔）都经 `motion.duration(name)` 取时长，档位改一处全局生效。

截图：[主题页默认](qfluent_core_gallery/10-theme-default.png) ·
[樱花粉](qfluent_core_gallery/11-theme-sakura.png) ·
[墨黑](qfluent_core_gallery/12-theme-ink.png) ·
[奶咖棕](qfluent_core_gallery/13-theme-mocha.png) ·
[圆角 16](qfluent_core_gallery/14-radius-16.png) ·
[暗色](qfluent_core_gallery/15-theme-dark.png)
### 8.5 统一控件高度（v0.2.1）

所有可交互控件共用一个高度设置（画廊第 0 页「控件高度」：紧凑 28 / 标准 34 / 宽大 42）。

| token | 含义 |
| --- | --- |
| `control-h` | 控件总高 |
| `control-content-h` | 有边框控件的内容区高（总高 − 2×边框） |
| `control-h-compact` / `control-content-compact` | 紧凑档 |
| `control-h-large` / `control-content-large` | 宽大档 |
| `control-h-sm` | 小圆钮 / 徽标 / 胶囊 |
| `control-h-icon` | 图标按钮命中区 |
| `control-font-size` | 控件内字号 |

三个必须知道的约束：

1. **QSS 的 min-height 作用于内容区**，而各控件 padding/border 不同。都写
   min-height = 总高，渲染出来会差一大截（实测按钮 34 / 菜单项 51）。所以带边框控件
   一律用 `control-content-*` 并把垂直 padding 归零，总高才精确等于设置值。
2. **控件内字号以控件高度为准**：`control-font-size = min(全局字号, 控件高 − 10)`。
   字号调大时先按放得下的上限截断，不会把控件撑变形。
3. 独立使用组件库（不建框架窗口）时用 `apply_skin(theme, settings=ui)` 安装皮肤，
   它会自动跟随设置变化重刷——否则改了控件高度不会生效。

### 8.6 两个 Qt 圆角的硬约束（都踩过）

- **QLabel 不绘制 QSS 的 border-radius**（实测三种写法都不行）。胶囊、徽标、圆角图标块
  必须由 QFrame 承担圆角，QLabel 只放文字 —— `components/base.py` 的 `center_label()` 就是为此；
- **Qt 对超过高度一半的 border-radius 不是 clamp，而是直接不画**。所以全圆角不能用 999px：
  `radius-pill` 现在由控件高度派生（= `control-h-sm / 2`，22px 胶囊 → 11px）。
  固定尺寸的装饰元素各自用匹配的半径：14px 滑块手柄 → `slider-handle-radius`、
  16px 勾选点与 20px 提示图标 → 方形圆角 `radius-sm`。

### 8.7 导航折叠按钮与折叠态图标

- 折叠按钮**不占标题行**：挂在导航栏底部（`NavPanel.add_footer()`），展开时 «，折叠时 »；
- 导航项折叠时**文字转图标块**：`[collapsed="true"]` 收成方形居中字形，
  有 `icon` 用图标、否则用 `icon_text` 或标题首字；业务可传符号自定义字形。

截图：[窗口圆角](qfluent_core_gallery/30-radius-window.png) ·
[折叠态导航](qfluent_core_gallery/31-nav-collapsed.png) ·
[紧凑 28](qfluent_core_gallery/32-controls-compact.png) ·
[宽大 42](qfluent_core_gallery/33-controls-large.png)

---

## 九、扩展组件（v0.2 补充）

在原有 20 个之外补齐的一批。它们与既有组件共用同一套 token、圆角、材质与自愈机制，
没有任何私有配色。画廊第 4-7 页（表单与反馈 / 数据展示 / 导航组件 / 浮层）是它们的验收面。

### 9.1 设计取舍（避免两个组件做同一件事）

| 场景 | 用哪个 | 为什么 |
| --- | --- | --- |
| 静态小表（几十行，只读） | `UTable` | 一次填充即可，不需要模型层 |
| 需要搜索/排序/分页 | `UDataTable` | 过滤排序在内存做一次，只把当前页交给视图，行数恒定 |
| 一行常驻状态 | `UInfoBar` | 轻，适合嵌在页面顶部 |
| 需要解释原因 + 给动作 | `UAlert` | 带图标与标题，能放多行正文与操作按钮 |
| 选文件并展示 | `UUpload` | 只做挑文件；上传/校验/进度属于业务 |
| 表单里选一项 | `UComboBox` | 下拉语义是「从固定集合选一个」 |
| 一个入口多个动作 | `UDropdown` | 菜单语义是「命令」，不是「取值」 |

### 9.2 几个必须守住的实现细节

- `UMultiComboBox` 必须是 editable：非 editable 的 `setCurrentText` 只在文本命中已有项时生效，
  已选摘要根本显示不出来；同时只读 lineEdit 会吃掉点击，需要 eventFilter 转发成展开弹层；
- `UPagination.set_page` 是程序化接口，**不发** `pageChanged`；只有用户点击才发。
  否则调用方在刷新流程里调用它就会递归；
- `UTable` / `UDataTable` 默认用 `QHeaderView.Stretch` 均分列宽：用 StretchLastSection 时
  前几列按默认宽度排布，首列稍长就被压成省略号，末列却空一大片；
- `UConsole` 用 `QPlainTextEdit.maximumBlockCount` 限行，长时间运行不会无限增长；
- `UDatePicker` 默认给今天：留空会让 QDateEdit 显示 2000-01-01，用户第一眼看到的就是错值；
- `UMenu` / `UTopbar` 是把窗口壳里的导航能力抽出来的可独立嵌入版本，
  业务不继承 `FluentTemplateWindow` 也能用同一套导航观感。


### 8.8 输入框内嵌按钮 / 焦点 / 下拉 / 折叠（v0.2.2 修）

四类交互缺陷的修法与约束：

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| 输入框清除按钮不垂直居中 | Qt 把它的 y 定为 `控件高/2 − 9`，按钮越高越偏下（32px 时偏 6px 并溢出） | 按钮高度固定为 `$icon-size`（18px）：中心恰好落在中线上，且与控件高度无关 |
| 复选框 / 单选钮选中时圈整块焦点框 | `QCheckBox:focus { border: ... }` 连文字一起圈住 | 焦点改画在指示器上：`:focus::indicator`；整块改为 `border: none` |
| 多选下拉点击后一闪而过、选不中 | eventFilter 只吞了 MouseButtonPress，抬起事件继续走 QComboBox 逻辑，弹层被判成「点了别处」立刻收起 | 按下与抬起都吞掉 |
| 侧边菜单折叠后文字还在 | ①只把文字换成首字，没做成图标块；②`add_group()` 的分组标题没有参与折叠，被截断成「主\|」；③折叠按钮在菜单外 | ①加 `[collapsed="true"]` 方形图标块样式；②折叠时收起分组标题；③折叠按钮内置并吸附在菜单底部 |

另外：清除按钮、焦点环、折叠这些都有按档位断言偏差的回归测试（清除按钮四档控件高度下偏差 ≤ 2px），
Qt 内部布局一变就会立刻暴露。

截图：[修复后的表单页](qfluent_core_gallery/40-forms-fixed.png) ·
[折叠菜单](qfluent_core_gallery/42-menu-collapsed.png)

### 8.9 状态切换 / 下拉按钮 / 材质（v0.2.3 修）

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| 复选框选中时像有边框 | 选中态只填了 accent，描边仍是 border2；聚焦还额外加粗到 2px | 选中时 **border-color = 填充色**（视觉无边框）；聚焦不再给指示器加边框；整块加 hover 反馈 |
| 下拉按钮与整体割裂 | `::down-arrow` 只设了宽高、**没有 image**，走系统默认箭头 | 生成主题色 chevron SVG（随主题色重新生成），覆盖 ComboBox / DateEdit / DateTimeEdit / SpinBox 上下箭头 |
| 下拉弹窗两层边框 | 弹出容器与内部视图各画一层 | 边框只画在 `QComboBoxPrivateContainer`，视图 `border: none`（实测边缘深色线 2 条 → 1 条） |
| 状态切换点击没反馈 | 点击区域其实是对的（实测点文字、点两侧都生效），但只有指示器有视觉反馈 | 复选框/单选钮整块加 hover 底色 |
| 玻璃材质 | 只有一档固定透明度，且只是半透明 | 改名 **frosted 毛玻璃**：更低不透明度 + 高光描边 + 半透明细边；旧名 `glass` 保留为别名 |

**材质不透明度可调**：`material_opacity`（30–100%），画廊「显示材质」卡里有滑块。
实测 40% → layer alpha 0.33、70% → 0.57、95% → 0.78；毛玻璃在同设置下比半透明再低约 18%。
控件与窗口的面（layer / surface / control / layer-alt）一起跟随。

> **毛玻璃的边界**：真正的背景模糊需要平台合成。Windows 走 DWM（Mica / Acrylic）；
> macOS 的 `NSVisualEffectView` 实测会导致进程级 Abort（try/except 拦不住），所以默认禁用 ——
> macOS 上的毛玻璃是「低透明度 + 高光描边」的观感近似，不是真的模糊。

截图：[状态切换与下拉](qfluent_core_gallery/50-forms-toggles.png) ·
[毛玻璃材质](qfluent_core_gallery/51-material-frosted.png)

### 8.10 下拉弹窗的样式为什么这么难挂（v0.2.4 修）

现象：多选下拉的弹窗**整片透明**，与单选下拉不一致（背景和边框都没了）。

排查下来是三个 Qt 的坑叠在一起，依次踩过：

1. **Qt 私有类名不可靠**：最初把弹窗样式挂在 `QComboBoxPrivateContainer` 上 ——
   它是 Qt 私有类，拿它做 QSS 选择器时命中不稳定；
2. **后代选择器对弹出窗口不成立**：`QComboBox QAbstractItemView { ... }` 要求视图是 combo 的
   后代，但**弹出窗口是独立顶层窗口**，根本不是后代 —— 这条规则从来没匹配过，
   表现出来就像「样式写了但不生效」；
3. **改了 objectName 必须 repolish**：改用 objectName 后仍然无效，因为 QSS 是按当时的属性匹配的，
   设置 objectName 之后要 `unpolish/polish` 重算（这一条在组件变体里我一直有做，唯独这里漏了）。

最终方案：**弹出前用控件级样式表刷新** —— 它一定生效，而且主题变了会自动跟上：

```python
def showPopup(self):
    style_combo_popup(self)      # 用 token 给容器 / 视图设控件级样式表
    super().showPopup()
```

容器负责背景与唯一一层边框，视图保持透明。单选与多选现在完全一致
（实测两者背景都是 surface 白、顶边都是 border 色）。

> 顺带发现一个测试隔离问题：全局 `ThemeManager.instance()` 会被 zhixing 桥接测试替换掉，
> 于是组件测试若不显式传 theme，就会读到另一个主题包的颜色（表现为断言 #E3E7EB 得到 #E4EDE8）。
> 组件测试现在一律显式传 `settings/theme` 实例。

---

## 十、交互动效组件（v0.3）

十个带具体动效的复合组件。画廊第 5 页「交互动效」是它们的验收面。

| # | 组件 | 动效要点 |
| --- | --- | --- |
| 1 | `UCollapseCard` | 高度 / 内容透明度 / 箭头角度**由同一条曲线驱动**（一个 QVariantAnimation 每帧更新三个属性） |
| 2 | `USegmentedControl`（增强） | 选中块 thumb 用 geometry 动画位移；`bind_stack()` 让内容区同步横向滑动 |
| 3 | `USwipeConfirm` | 滑过阈值（默认 80%）才触发，不到就**动画回弹** |
| 4 | `UFlipCard` | 宽度压扁模拟 Y 轴翻转，在 t 跨过 0.5（最窄处）换面 |
| 5 | `UActionCard` | 加减 / 开关 / 滑块**就地生效**，底部自动回显当前值 |
| 6 | `UFilterChips` | 选中态实底（accent solid），超出宽度横向滚动 |
| 7 | `UProgressCard` | 节点三态（done / current / pending），当前节点高亮并展开详情 |
| 8 | `UBottomBar` | 左信息右主按钮；`safe_margin` 留出底部安全区 |
| 9 | `UMaskedInput` | 按 mask 自动插入分隔符（`####-##-##` → 2026-09-13），右侧常驻单位与字数 |
| 10 | `UTabStrip`（新增） | 下划线跟手位移（geometry 动画），选中标签自动滚动居中 |

### 10.1 两点实现说明

- **2 与 10 是「增强同类组件」**：分段控件的 thumb 位移对所有分段场景生效；
  `UTabStrip` 是新增的顶部标签形态（`UTabs` 保持 QTabWidget 形态不变）。
- **滑动确认条的回弹不是直接归零**，而是动画回去 —— 用户能看到「自己没滑够」，这比瞬间复位有效得多。

### 10.2 一个层级坑

分段控件的 thumb 必须 `lower()` 到按钮**之下**：按钮背景透明，thumb 从下面透出来；
若 `raise_()` 到按钮之上，就会盖住选中项的文字（实测该行文字像素为 0）。

另外 thumb 的初始位置不能在构造时算 —— 那时按钮还没被布局，geometry 是默认值，
必须在 `showEvent` / `resizeEvent` 里重新对齐。

截图：[交互动效页](qfluent_core_gallery/70-interactive-top.png) ·
[折叠态](qfluent_core_gallery/71-interactive-collapsed.png)

---

## 十一、零硬编码与统一设置入口（v0.4）

目标：框架里**没有任何写死的颜色 / 尺寸 / 时长 / 布局**，全部可通过设置更改，
并且所有设置汇总到**一个入口**。

### 11.1 审计结果

| 类别 | 审计前 | 处理 |
| --- | --- | --- |
| QSS 字面色值 | **0 处**（早已全 token） | — |
| QSS 裸 px | **34 处** | 全部换成 token |
| Python 固定尺寸 | **7 处**（图标 20 / 头像 44 / 指示条 3 …） | 走 `token_px()`，并在 `restyle()` 重算 |

### 11.2 新增几何 token（原先散落的魔法数字）

`border-w` · `divider-w` · `scrollbar-w` · `groove-h` · `progress-h` ·
`switch-w` / `switch-h` / `switch-knob-inset` · `indicator-w` · `icon-box` ·
`avatar-size` · `chevron-w` · `spin-arrow-w` · `drop-btn-w` · `check-gap` ·
`tab-gap` · `underline-h` · `seg-thumb-inset` · `pad-press-sm/md/lg`

其中开关高度、图标容器、轨道厚度、指示条宽度、箭头尺寸会**跟随控件高度**派生，
其余可通过设置直接覆盖。

### 11.3 统一入口

`UISettings.SCHEMA_SPECS` 是**唯一真相**（14 项，4 组：外观 / 排版 / 动效 / 材质）；
`USettingsPanel` 只是它的渲染器 —— 新增一项设置**只需加一条 Spec**，面板自动出现控件。

新增的可配置项：`spacing_scale`（缩放全部 space-1..6）、`border_width`、
`scrollbar_width`、`icon_size`。

### 11.4 把「不许硬编码」变成会失败的断言

- `test_qss_templates_have_no_raw_px` —— 模板里出现裸 px 即失败；
- `test_qss_templates_have_no_raw_colors` —— 出现字面色值即失败；
- `test_settings_schema_covers_every_key` —— 有配置项没声明就失败（否则面板不显示它）；
- `test_every_setting_reaches_tokens` —— 改设置必须真的改变渲染 token；
- `test_spacing_scale_changes_every_space_token` —— 6 个间距 token 都要跟着档位走；
- `test_component_fixed_sizes_come_from_tokens` —— 组件固定尺寸必须能被设置改变。

### 11.5 过程中抓到的真 bug

组件原先只在**构造时**取一次 token 尺寸，`restyle()` 不重算 —— 于是"改了设置但组件没变"，
即设置面板看起来生效、实际无效。修了 4 处（`UAlert` / `UEmptyState` / `UMenu` / `NavPanel`），
其中 `UAlert`、`UMenu`、`UDivider` 甚至**没有自己的 restyle**（一直是基类的空实现）。

截图：[全部设置页](qfluent_core_gallery/96-all-settings.png)
## 十二、图标装配、交互细节与 Qt 渲染事实（2026-09）

这一批全是"看起来好了但实际没生效"的类型，结论都来自**像素判定**而不是构造成功。

### 12.1 侧边栏图标（展开=图标+文字，折叠=仅图标）

- 框架：`add_page(..., icon="nav.today")` 接受**图标名**，`NavButton` 记住名字，
  换肤时窗口自动 `refresh_icon()` 重渲染（QIcon 是静态 pixmap，不重渲染会停在旧色）。
- 业务：zhixing 侧边栏 8 项全部接线（`nav.today/tasks/inbox/notes/workflow/graph/review/settings`）。

截图：[展开](qfluent_core_gallery/98-nav-icons-expanded.png) ·
[折叠](qfluent_core_gallery/98-nav-icons-collapsed.png)

### 12.2 弹窗标题图标

`UDialog(..., icon_name="nav.notes")` 在标题栏画 16px SVG 图标；
zhixing 的引用/归属/命令面板/快速捕获等弹窗均已传入。

截图：[弹窗标题图标](qfluent_core_gallery/98-dialog-title-icon.png)

### 12.3 选中类指示器：圆角必须**恰好**是半宽

- 症状：`border-radius: $radius-pill`（11px）套 16px 方框 → 渲染出来是**方块**。
- 根因：Qt 对超过半宽的 `border-radius` 不是 clamp，而是**整个丢弃**。
- 另一个坑：`::indicator` 的 `width/height` 会被盒模型各加一圈边框（16px → 18px），
  必须用 `min-*/max-*` 锁定总尺寸。
- 修法：新增 `$indicator-size` / `$radius-indicator`（= 半宽，随控件高度派生），
  并在 `_COMMON` 补默认值 —— 只补 `control_tokens()` 的话，
  不绑定 `UISettings` 直接渲染会留下 `min-width: ;` 这种静默空值。

截图：[圆形指示器](qfluent_core_gallery/99-toggles-circular.png)

### 12.4 通知浮层：不再叠在一起，正文不再被裁

- 堆叠：原先每条通知都算同一个 y，后弹的精确盖住先弹的 → 现在按同侧已显示通知的高度依次排开。
- 正文高度：QLabel 只有拿到**最终宽度**才知道折几行；先 `adjustSize()` 再量高度，
  量到的是"不换行的理想宽度"下的高度，正文首末两行各被裁掉一截。
  现在先定宽（min 280 / max 440）再定高。

截图：[三条通知依次排开](qfluent_core_gallery/99-toasts-stacked.png)

### 12.5 卡片标题：重复与错位

- `UCard.header_row("链接")` 在无标题卡片上会**建两个同文本标题**（标题区 + 行内各一个）。
- 更隐蔽的一条：`header_row`/`header_title` 可能在构造**之后**才调用，
  而 `_root.addWidget(header)` 会把标题区排到正文**下面** → 标题跑到卡片底部。
- 修法：标题标签唯一化（`_ensure_title`）+ 标题区 `insertWidget(0)`。

截图：[笔记页链接卡片](qfluent_core_gallery/99-note-links-card.png)

### 12.6 分栏拖动

实测 `QSplitter` 拖动是好的（handle 8px，拖动按光标位移等比改变两侧宽度，
总宽不变）。**但合成事件必须带 globalPosition** —— 只给 localPos 的
`QMouseEvent` 会让 `QSplitterHandle` 算出错误落点（实测左栏被甩到 14px），
看起来像"拖不动"。这条已固化成测试。

### 12.7 顺带修掉的迁移回归

- `UCard.restyle()` 会覆盖业务 `body_layout.setContentsMargins()`（换肤即被抹掉）
  → 新增 `set_body_margins()`；`StatCard` 的紧凑内边距改走它。
- 全局 `QLabel { font-size }` 的优先级**高于** `setFont()`，概览卡的大数字被压回
  14px 并裁切 → 字号/字重改写成内联样式表，并取 `font-size-title` / `font-weight-strong` token。


### 12.8 提示气泡（QToolTip）：QSS 管不到的两个点

用户反馈"太宽、太高、没圆角" —— 三条都属实，根因都不在颜色上：

| 现象 | 根因 | 修法 |
|---|---|---|
| 没圆角 | 提示是 Qt 自建的**顶层窗口**，窗口不透明时圆角四角被底色填满 | 显示时给 `QTipLabel` 开 `WA_TranslucentBackground` |
| 太宽太高 | QSS 的 `padding` 在 QToolTip 上要么**被忽略**，要么直接跳到默认大边距 | QSS 不写 padding，改 `setContentsMargins()` |
| （附带） | 圆角大于半高同样会被 Qt 整个丢弃 | 半径取 `$radius-pill`，小于等于半高 |

实测数据：36x15 的文字，带 `padding: 5px 12px` 时撑成 **88x53**，去掉 padding 后是 40x19
（只剩 Qt 自带边框），补丁设好内边距后是 **63x27**（横向 space-3、纵向 space-1）。

补丁在 `qfluent_core/tooltip.py`，由 `apply_skin()` 与 `FluentTemplateWindow._restyle()`
幂等安装（应用级事件过滤器，所以宿主控件的 `setToolTip` 也一并生效）。

截图：[提示气泡](qfluent_core_gallery/99-tooltip-capsule.png)

