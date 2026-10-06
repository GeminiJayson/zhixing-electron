# 图谱与工作流迁移到 @antv/g6 · 调研与方案

> **状态：已完成**（2026-10-06）。图谱与工作流都已切到 G6，两套手写 SVG 画布与其依赖
> （usePanZoom、d3-force）已删除。**实施进程、与迁移前的差异、剩余工作见
> [g6-migration-status.md](./g6-migration-status.md)。**
>
> 本文保留作为**方案**的记录 —— 下文表格里的行数都是**迁移前**的。
> 目标：**UI 渲染与交互全部换成 G6，业务逻辑与数据层原样保留**。

## 一、G6 是什么（v5.1.1，MIT）

AntV 的图可视化框架。v5 是**重写版**：渲染交给 `@antv/g`（自研图形引擎，Canvas / SVG / WebGL 三种渲染器），
布局交给 `@antv/layout`，算法交给 `@antv/algorithm`。**G6 本身是这三层的编排层。**

### 开箱能力（从包的导出清单里逐条核过）

| 类别 | 内置的东西 |
| --- | --- |
| **节点** | Circle · Rect · Diamond · Donut · Ellipse · Hexagon · Star · Triangle · Image · **HTML** |
| **边** | Line · Polyline · Quadratic · **Cubic / CubicVertical / CubicHorizontal / CubicRadial** |
| **Combo** | CircleCombo · RectCombo |
| **布局** | **D3ForceLayout / ForceLayout / ForceAtlas2Layout / FruchtermanLayout**（力导向）· **AntVDagreLayout / DagreLayout / CompactBox / Dendrogram / Indented / Mindmap / Fishbone**（层次）· Circular / Concentric / Grid / MDS / Radial / Snake / ComboCombined |
| **交互** | DragCanvas · ScrollCanvas · ZoomCanvas · **OptimizeViewportTransform** · DragElement · **DragElementForce** · ClickSelect · BrushSelect · LassoSelect · HoverActivate · FocusElement · **CreateEdge** · CollapseExpand · **AutoAdaptLabel** · FixElementSize |
| **插件** | **Tooltip · Contextmenu** · Legend · Minimap · Toolbar · **History** · Hull · **BubbleSets** · GridLine · **Snapline** · Fisheye · **EdgeFilterLens** · **EdgeBundling** · Timebar · Title · Watermark · Background · CameraSetting · Fullscreen |

**这张表是本次调研最有用的产出** —— 下面「现在自己写的」几乎每一项都能在上面找到对应物。

---

## 二、当前实现（要替换的对象）

| 文件 | 行数 | 用什么做的 |
| --- | ---: | --- |
| `pages/GraphPage.tsx` | 1164 | **d3-force** + 手写 SVG + `usePanZoom` |
| `pages/WorkflowPage.tsx` | 2030 | 手写 SVG + `usePanZoom` + 自研布局 |
| `lib/workflow-layout.ts` | 196 | **@dagrejs/dagre** 包装 |
| `lib/edge-path.ts` | 264 | **纯自研连线几何**（bulge / 控制点 / 折线 / 正交 / 中点 / 裁剪 / 端点） |
| `lib/panzoom.ts` | 58 | 自研平移缩放 |
| `styles/graph.css` + `workflow.css` | 933 | 手写 SVG 元素的样式 |
| **合计** | **≈ 4645** | |

**依赖**：`d3-force ^3.0.0`（+ `@types/d3-force`）、`@dagrejs/dagre ^3.1.1`。

### 两个页面的状态密度（说明「逻辑」有多重）

| 页面 | useState | useEffect | useRef | 交互处理函数 | IPC 调用 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 图谱 | 20 | 13 | 10 | 10 | **15** |
| 工作流 | 23 | 10 | 8 | **33** | **26** |

---

## 三、能力对照：自己写的 → G6 内置

| 现在自己写 | G6 对应物 | 结论 |
| --- | --- | --- |
| `d3-force` 模拟 + 手写 SVG 节点 | `D3ForceLayout` / `ForceLayout` | **直接替换** |
| `usePanZoom`（58 行） | `DragCanvas` + `ZoomCanvas` + `OptimizeViewportTransform` | **直接替换** |
| `edge-path.ts`（264 行） | `Cubic` / `CubicHorizontal` / `CubicVertical` / `Polyline` / `Quadratic` | **直接替换**；其中「正交折线」对应 `Polyline` |
| `workflow-layout.ts`（196 行，包 dagre） | `AntVDagreLayout` / `DagreLayout` | **直接替换**，少一层包装 |
| `fitNodeText`（节点文字按像素自适应） | `AutoAdaptLabel` | **直接替换** |
| 手写 tooltip / 浮卡 | `Tooltip` 插件 | **直接替换** |
| 手写右键菜单 | `Contextmenu` 插件 | **直接替换** |
| 手写连线手柄拖拽 | `CreateEdge` + `DragElement` | **直接替换** |
| 手写节点拖拽 + 落位持久化 | `DragElement`（**但持久化回调仍是我们的**） | 交互换、落库保留 |
| 无 | `History`（撤销栈）、`Minimap`、`Snapline`（对齐辅助）、`EdgeBundling`（边捆绑）、`Hull`、`Fisheye` | **白拿的能力** |

**结论：G6 覆盖了当前全部自研渲染能力，且多出 5–6 项我们目前没有的。**

---

## 四、必须保留的「逻辑」（一行都不动）

### 数据层与 IPC（15 + 26 = 41 个调用）

- **图谱**：`db.graph` / `db.graphWatch` / `db.onGraphDelta` / `db.graphPreview` / `db.graphConnectionAllowed` / `db.linkNotes` / `db.linkTaskNoteRef` / `db.linkTaskNote` / `db.reparentTask` / `db.removeGraphEdge` / `db.rewireGraphEdge` / `db.graphOpenNode` …
- **工作流**：模板 / 分组 / 实例 / 分支 / 节点位置 / 运行日志 / 复制 / 重命名 / 自动布局的完整 CRUD

### 业务规则（换 UI 不能碰）

1. **`graphConnectionAllowed` 的破环判断** —— 边能不能连，由它说了算，不是 G6 的 `CreateEdge` 说了算；
2. **归属边与引用边的分野**（实线 / 虚线、`edgeKinds`）—— 见 `docs/specs/ownership-vs-reference.md`；
3. **双击分派**：节点 → 打开笔记 / 待建链接 → 创建；
4. **分支锚点语义**（`branchAnchors` / `directedAnchors`）—— 端口位置是业务约定，不只是画法；
5. **节点位置持久化**（`updateWorkflowNodePos` / `batchUpdateNodePos`）—— 拖完要落库；
6. **工作流的条件确认流**（独立小窗 + `ConditionApp`）；
7. **`describeWorkflowAction` 的动作文案**（后端给的中文描述）。

### 数据表（不动）

图谱：`note_link` · `task_note_link` · `task_note_context` · `task_note_ref` · `note_folder` · `note_tag`
工作流：`workflow_template` · `workflow_node` · `workflow_instance` · `workflow_step_task` · `workflow_run_log`

---

## 五、四个真风险（这是本文最该看的部分）

### 风险 1：**Canvas 渲染会让刚做完的 token 化失效** ⚠️ 最高

我们现在是**手写 SVG + CSS 类名**，所以上一轮 token 化的成果（颜色 / 字重 / 字号 / 间距全走 `tokens.css`）
**在浏览器里天然生效**。

**G6 v5 默认用 Canvas 渲染** —— **canvas 里画的东西不认 CSS 变量**。直接换过去，主题包、强调色、
暗色模式、密度设置**会全部失效**。

**解法（推荐）**：写一层**主题桥** `lib/g6-theme.ts`：

```ts
// 把 tokens.css 的变量读成 G6 能吃的样式对象
$ = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
export const g6Theme = () => ({
  node: { fill: $("--bg-layer"), stroke: $("--border"), labelFill: $("--fg-primary") },
  edge: { stroke: $("--border-strong") },
  /* …每个 G6 样式键映射到一个语义 token */
})
```

**换主题时重建图**（G6 支持 `graph.setOptions` 增量更新，不必整图重建）。
**这条不做，整个迁移就是倒退。**

### 风险 2：**包体积** 📦

| | 现在 | 换成 G6 后 |
| --- | ---: | ---: |
| 可视化依赖 | `d3-force` ~30 KB + `dagre` ~100 KB | **`@antv/g6` dist 1351 KB**（未压缩）+ 11 个传递依赖 |
| 渲染层产物 | `index-*.js` 3308 KB | **预计 4000–4300 KB** |

**而且 `sideEffects` 与 `exports` 都没声明** —— 打包器会**按"有副作用"处理，tree-shaking 效果受限**。
`esm/` 目录 2.14 MB，即使只 `import { Graph }` 也会拉进大半个包。

**离线桌面应用，包大不是致命的**（不下载、不首屏等待），但要**明确接受**：渲染层产物大约涨 25–30%。
**可做的缓解**：先只迁图谱页，量一次真实增量，再决定工作流页是否跟进。

### 风险 3：**Electron 渲染层的兼容性** 🔌

`@antv/g` 需要 canvas 2D 或 WebGL。Electron 33 的 Chromium 应该没问题，
但**这个仓库有过"编译过、跑不起来"的记录**（IPC 重复注册那次），所以：

**先在 dev 环境跑一个最小 G6 图**（10 个节点），确认能渲染、能交互、能随主题变色，**再动真格的**。

### 风险 4：**两个页面的状态机比看起来重** 🧠

图谱 20 个 `useState` + 13 个 `useEffect`，工作流 23 + 10，**工作流还有 33 个交互处理函数**。

**G6 是有状态的对象**（`graph.render()` / `graph.setData()` / 事件订阅），
而 React 是声明式的。**两者的边界要划清**：

- **React 管数据**（IPC 拉来的、要落库的）；
- **G6 管呈现与交互**（布局、拖拽、缩放、选择）；
- **中间用 ref 持有 graph 实例**，`useEffect` 里做「数据变了 → `graph.setData()`」。

**最容易出的问题是重复渲染与事件泄漏** —— G6 实例必须在 `useEffect` 的清理函数里 `destroy()`。

---

## 六、替换方案（四个阶段，每阶段可独立验收）

### P0 · 地基（不动现有页面）

1. `npm i @antv/g6`；
2. **写主题桥** `lib/g6-theme.ts`（tokens → G6 样式）；
3. **写数据适配** `lib/g6-adapt.ts`（`note_link` / `workflow_node` 的行 → G6 的 `nodes` / `edges`）；
4. **dev 里跑一个最小图**，确认渲染 + 主题联动 + 与 Electron 兼容。

**验收**：最小图能画出来、跟着强调色变、拖拽缩放正常、`destroy()` 后无残留。

### P1 · 图谱页替换

| 换掉 | 换成 |
| --- | --- |
| d3-force 模拟 | `D3ForceLayout` |
| 手写 SVG 节点/边 | G6 Canvas + `Circle` / `Rect` 节点 + `Cubic` 边 |
| `usePanZoom` | `DragCanvas` + `ZoomCanvas` + `OptimizeViewportTransform` |
| 手写浮卡 | `Tooltip` 插件 |
| 手写右键菜单 | `Contextmenu` 插件 |
| 手写连线手柄 | `CreateEdge`（**能否连仍由 `graphConnectionAllowed` 判定**） |

**保留**：15 个 IPC、破环规则、归属/引用分色、双击分派、`graphWatch` / `onGraphDelta` 的增量刷新。

**顺带白拿**：`Minimap`、`History`（撤销）、`EdgeBundling`（边多时）、`Hull`。

**验收**：251 节点 / 242 边的真实库上，布局、拖动、连线、双击、主题切换全部与现在一致或更好。

### P2 · 工作流页替换

| 换掉 | 换成 |
| --- | --- |
| `workflow-layout.ts`（dagre 包装） | `AntVDagreLayout` |
| `fitNodeText` | `AutoAdaptLabel` |
| 手写节点/端口/连线 | G6 节点 + `Polyline` / `Cubic` |
| 手写拖拽 + 落位 | `DragElement` + **我们的落库回调** |

**保留**：26 个 IPC、分支锚点语义、条件确认流、节点位置持久化、步骤对话框那一整套。

**顺带白拿**：`Snapline`（对齐辅助）、`History`、`Minimap`。

### P3 · 清理

- 删 `lib/edge-path.ts`（264）· `lib/workflow-layout.ts`（196）· `lib/panzoom.ts`（58）；
- 卸 `d3-force` / `@types/d3-force` / `@dagrejs/dagre`；
- 删/改 `graph.css` + `workflow.css`（933 行里只保留 G6 容器与浮层的部分）；
- 更新 `docs/02`（模块与依赖）· `docs/03`（图谱与工作流两节）· `README`（依赖与目录树）。

---

## 七、工作量与取舍

| 阶段 | 估计 | 说明 |
| --- | --- | --- |
| P0 | 小 | 主题桥 + 适配 + 冒烟，**半天** |
| P1 图谱 | 中 | 替换渲染与交互，逻辑不动 |
| P2 工作流 | **大** | 33 个交互处理函数要重新接到 G6 事件上 |
| P3 清理 | 小 | 删代码 + 改文档 |

**代码量**：自研 ≈ 4645 行 → 替换后估计 **2500–3000 行**（含适配层与主题桥）。

### 三个建议

1. **先做 P0 冒烟再谈后面** —— Electron + G6 能不能好好跑，是整个方案的前提，
   而这件事**半天就能验完**，不要先写几千行再发现不兼容。
2. **图谱先于工作流** —— 图谱是「展示 + 轻交互」，工作流是「编辑器」，后者复杂度高一个量级。
   图谱跑顺了，工作流的坑会提前暴露。
3. **主题桥当成一等公民** —— 上一轮的 token 化是资产，**不要为了换库把它丢掉**。
   主题桥写好了，G6 反而比现在更好做主题（一个函数集中映射）。

---

## 八、待你拍板的三件事

1. **渲染器**：**Canvas（性能好、主题要走桥）** 还是 **SVG（主题天然生效、大图吃力）**？
   我建议 **Canvas + 主题桥** —— 251 节点用 SVG 也能跑，但工作流那 2030 行的编辑器一上来就换 Canvas 更省事；
2. **迁移顺序**：按 P0 → P1（图谱）→ P2（工作流）？**还是两个页面一起换**？
3. **包体积**：接受渲染层产物涨 25–30%（离线应用，我判断可以接受），**还是先只迁图谱、量完增量再定**？