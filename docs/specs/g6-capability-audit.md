# G6 能力审计：图谱与工作流还欠什么

> 对照 `@antv/g6@5.1.1` 的**内置扩展全集**（源码 `src/registry/build-in.ts` + `src/behaviors` + `src/plugins`）
> 逐项核对两个画布的现状。审计日期 2026-10-06。
>
> 结论先行：**渲染层已经把该交的都交给 G6 了**（节点/边/布局/主题/基本交互），
> 真正欠的是三类 —— ① **关系图读图能力**（邻居高亮、悬停提示、小地图、边捆绑），
> ② **编辑能力**（撤销重做、拖拽建边、对齐线），③ **运行时表达**（边流动画、组合折叠）。

## 一、G6 内置能力全集（对照基准）

| 分类 | 内置项 |
| --- | --- |
| **节点**（10） | circle, rect, ellipse, diamond, triangle, star, hexagon, donut, image, html |
| **边**（7） | line, polyline, quadratic, cubic, cubic-vertical, cubic-horizontal, cubic-radial |
| **组合 Combo**（2） | circle, rect |
| **图形 Shape**（13） | circle, ellipse, rect, polygon, polyline, path, text, image, html, group, label, badge, line |
| **布局**（14） | d3-force, antv-dagre, circular, concentric, radial, grid, mds, fruchterman, force-atlas2, dendrogram, mindmap, indented, fishbone, snake, random |
| **交互 Behavior**（15） | click-select, hover-activate, brush-select, lasso-select, drag-canvas, zoom-canvas, scroll-canvas, drag-element, drag-element-force, create-edge, collapse-expand, focus-element, auto-adapt-label, fix-element-size, optimize-viewport-transform |
| **插件 Plugin**（14） | tooltip, contextmenu, legend, minimap, toolbar, history, hull, grid-line, background, watermark, fisheye, snapline, timebar, fullscreen, title |
| **动画**（2+） | fade, translate（另有 combo-collapse / node-expand 等） |
| **主题** | 内置 light / dark；自定义主题走 `register(THEME, 名字, 对象)` |
| **元素状态** | selected, active, highlight, inactive, disabled + 自定义 |

## 二、现状：已经用上的

| 能力 | 图谱 | 工作流 |
| --- | --- | --- |
| 节点 | `circle` + `iconSrc`（自包含 SVG data URL） | `rect` / `diamond` + `labelText` + `badges` + 自定义子类（角标 `upsert`） |
| 边 | `cubic` + `endArrow` | `polyline` + `router: shortest-path`（A\* 避障）+ 边 `labelText` |
| 布局 | `d3-force` | `antv-dagre`（回边不参与分层） |
| 交互 | drag-canvas, zoom-canvas, click-select, hover-activate, drag-element-force | 同左（拖节点用 drag-element）+ 自研**拖拽改挂** |
| 插件 | contextmenu | contextmenu |
| 主题 | 自定义主题对象 `zhixing` | 同左 |
| 状态 | selected / active / dim | selected / active / done / current |

**自研且合理的**（G6 确实没有）：拖拽改挂（`lib/g6-edge-rewire.ts`）、工作流角标定位、
图标 SVG 生成、位置快照持久化、ResizeObserver 防抖、按业务的配色（`colorOf`）。

## 三、欠缺清单（按「投入产出」排序）

### 第一梯队：一行到几十行配置，收益立刻可见

| # | 欠什么 | 现状 | G6 能力 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | **悬停/点击时高亮一跳邻居** | `hover-activate` 用的是默认 `degree: 0` —— 只高亮自己；`click-select` 没配邻居 | `hover-activate: { degree: 1 }`、`click-select: { neighborState: 'active' }` | 关系图最基础的读图能力，加两行配置 |
| 2 | **节点悬停提示** | 图谱节点**只有图标没有文字**，看标题得点开侧栏 | `tooltip` 插件 | 装 `tooltip` 插件，`getContent` 返回标题/类型/文件夹 |
| 3 | **对齐辅助线** | 工作流拖节点没有参考线，靠肉眼对 | `snapline` 插件 | 拖拽时显示 x/y 对齐线 |
| 4 | **网格背景** | 空白画布没有任何参照 | `grid-line` 插件 | 低成本提升"工程图"感 |
| 5 | **缩放时保持文字可读** | 缩放后标题跟着缩小 | `fix-element-size`（保元素尺寸）、`optimize-viewport-transform`（缩放时简化） | 大图缩小时用 |

### 第二梯队：需要接业务回调或数据，收益大

| # | 欠什么 | 现状 | G6 能力 | 说明 |
| --- | --- | --- | --- | --- |
| 6 | **运行时边流动** | 工作流实例跑起来后，「当前步骤」只靠节点边框+阴影表达；**边没有任何动效** | 元素动画（`animation` 配置）+ 自定义 keyframes | 让"执行到哪了"一眼可见，比现在读边框直观得多 |
| 7 | **拖拽建边** | 建链/建分支都是「右键选槽位 → 再点目标」两段式；G6 有内置的拖拽建边 | `create-edge`（`trigger: 'drag' \| 'click'`） | 图谱写链、工作流建分支都能换成拖拽；与自研的**改挂**共用起手判定 |
| 8 | **画布导航小地图** | 251 节点的图谱全靠拖拽找 | `minimap` 插件 | 图谱必备；工作流可不开 |
| 9 | **类型/文件夹图例** | 颜色语义（文件夹调色板 / 知识类型色）**没有任何图例** | `legend` 插件 | 让"颜色是什么意思"可自解释 |
| 10 | **框选 / 套索多选** | 只能一个个点 | `brush-select` / `lasso-select` | 配合批量操作（后面接删边/移动） |
| 11 | **边捆绑降噪** | 251 节点、242 条边交叉严重 | `edge-bundling`（通过 `transform` 或布局插件） | 密集图谱的读图利器 |
| 12 | **集群轮廓** | 文件夹的归属只能靠颜色 | `hull` 插件 | 按文件夹/类型圈出选区 |
| 13 | **组合折叠** | 文件夹没有"收起来"的能力 | `combo`（rect）+ `collapse-expand` | 大图分区折叠，也是第一轮明确提过的 combo |
| 14 | **画布上直接改标题** | 改标题要开弹窗 | 无内置 | 自研成本高，优先级低 |

### 第三梯队：要动数据层或有取舍

| # | 欠什么 | 说明 |
| --- | --- | --- |
| 15 | **撤销 / 重做** | G6 有 `history` 插件，但我们的写操作都直接落 SQLite —— 要接上得让插件记录、再回放到主进程，属于架构级改动 |
| 16 | **拖拽建边后的落库事务** | 现在"先建新边再删旧边"（图谱改挂）；拖拽建边要处理失败回滚 |
| 17 | **平行边 / 双向边** | A→B 与 B→A 目前会重叠；G6 有 `processParallelEdges` 一类的数据变换 + `quadratic` 边可用 |
| 18 | **节点内嵌徽标** | 例如"这条笔记挂着 3 个任务"用节点 `badges` 表达；现在信息都在侧栏 |
| 19 | **多套布局切换** | 目前图谱只有力导向、工作流只有 dagre；G6 还有 circular / radial / grid / mindmap 等 —— 是否值得给用户一个"换布局"入口要看需求 |
| 20 | `palette` 调色板机制 | 颜色现在由 `lib/graph-colors.ts` 按业务算（文件夹调色板、知识类型色）—— 不属于 G6 的"按序分配"语义，**保持自研是对的** |

## 四、明确不做的

| 能力 | 为什么不做 |
| --- | --- |
| `html` 节点 | 迁移前就是 HTML 节点，正是要摆脱的东西（CSS/主题/命中都要自己管） |
| `fisheye` / `timebar` / `watermark` / `fullscreen` / `title` | 与产品形态无关 |
| `dendrogram` / `mindmap` / `indented` 布局 | 知识图谱不是树；工作流是 DAG |
| `animate` 全量开关 | 要照顾 `prefers-reduced-motion`，只该在关键处（边流动）用 |

## 五、落地记录（2026-10-06 已实施）

下面这六项**已经做完**，都在 `GraphCanvasG6` / `WorkflowCanvasG6` 的配置里：

| # | 做了什么 | 关键点 |
| --- | --- | --- |
| 1 | **邻居高亮** | `hover-activate: { degree: 1 }` + `click-select: { neighborState: 'active' }`。⚠️ 页面的状态同步 effect **必须保留 G6 自己维护的状态**（只接管 `selected`/`dim`），否则点一下就会把刚点亮的邻居清掉 |
| 2 | **tooltip** | 两个画布都装了。⚠️ 插件**不认 `className`**（传了也没用，外层始终是 `.tooltip`）—— CSS 要按它的类名覆盖，并 `!important` |
| 3 | **网格 + 对齐线** | 工作流装了 `grid-line`（20px，主题边框色）与 `snapline`（容差 6px） |
| 4 | **运行时边流动** | 「当前步骤」的出边改成虚线并由定时器推 `lineDashOffset`（90ms/格），尊重 `prefers-reduced-motion` |
| 5 | **拖拽建边** | 两个画布都装了 `create-edge`。⚠️ 它的起手与「拖节点」**抢同一个手势**，必须加 `enable: (e) => e.shiftKey`（不设条件时控制台会刷 `Edge not found`） |
| 6 | **小地图 + 图例** | 图谱装了 `minimap`（200×140）。**图例是自绘的**：G6 的 `legend` 插件只画色块 + 文字，而这里要用**节点图标**说话（星形=任务、便签=笔记…），所以复用了 `iconDataUrl` 生成 6 个 16px 图标做了一条左下角的图例；位置也顺手挪开——原来的 `legend` 挤在小地图那片区域、还压着节点 |

剩下的（撤销重做、combo 折叠、hull、边捆绑、框选）见下面第三节的第二 / 第三梯队。

## 六、建议的落地顺序（原始清单）

1. **邻居高亮**（`hover-activate.degree: 1` + `click-select.neighborState`）—— 两行配置，读图体验立刻不同；
2. **tooltip 插件** —— 图谱节点只有图标，这是最大的一处「看不懂」；
3. **snapline + grid-line** —— 工作流编辑手感；
4. **运行时边流动** —— 工作流实例的可见性；
5. **create-edge 拖拽建边** —— 与已有的拖拽改挂统一交互语言；
6. **minimap + legend** —— 图谱导航与自解释；
7. 之后才是 combo / hull / 框选 / 撤销这些需要数据层配合的。
