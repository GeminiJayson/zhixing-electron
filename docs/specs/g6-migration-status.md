# 图谱与工作流迁移到 @antv/g6 · 实施进程

> **方案见 [`g6-migration.md`](./g6-migration.md)** —— 那份是调研与方案（已成文于迁移前），本文记录**实施进程**：现状、与迁移前的差异、剩余工作、踩过的坑。
>
> 最后更新：2026-10-06（第二轮收尾：切方向刷新的真相、孤儿导出清理、验证环境）。

## 一、一句话现状

**两个页面都已切到 G6，两套手写 SVG 画布与其依赖（`usePanZoom`、`d3-force`）已删除，P3 收尾已完成。**

原先挂账的三件事都有了结论：

| 挂账项 | 结论 |
| --- | --- |
| ① 「切方向后 DOM 不刷新」🔴 | **不是缺陷，是验证环境的假象** —— 窗口不可见时 Chromium 停掉 rAF，G6 的动画与 HTML 节点刷新一起冻结。补丁 `syncPositions` 已删（见 §5.1） |
| ② 16 个孤儿导出 🟡 | **已清理**（连带把「抽了没接上」的 `graph-colors` 接回页面，见 §5.2） |
| ③ 两套 dagre 并存 🟢 | **保留** —— 统一要改落库算法，风险最高、收益最低（见 §5.3） |

## 二、阶段完成情况

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **P0** | 主题桥 `lib/g6-theme.ts` + 数据适配 `lib/g6-adapt.ts` + 最小图冒烟 | ✅ |
| **P1** | 图谱页替换（`GraphCanvasG6.tsx`） | ✅ |
| **P2** | 工作流页替换（`WorkflowCanvasG6.tsx`） | ✅ |
| **P3** | 清理与文档 | ✅ |

## 三、现状数据

> 行数用 `node` 数的（**别用 PowerShell 的 `Get-Content`**，它会按系统编码读 UTF-8，数字对不上，见 §7 第 20 条）。

| 文件 | 迁移前 | 现状 | 说明 |
| --- | ---: | ---: | --- |
| `pages/GraphPage.tsx` | 1164 | **632** | 渲染层全部搬进 `GraphCanvasG6`；配色也改成引用 `lib/graph-colors` |
| `pages/WorkflowPage.tsx` | 2030 | **1315** | 渲染层全部搬进 `WorkflowCanvasG6` |
| `lib/edge-path.ts` | 264 | **106** | 只剩「按边方向的正交折线」；贝塞尔那一套随图谱换代删掉 |
| `lib/workflow-layout.ts` | 196 | **188** | 仍在用（自动布局时算落库坐标） |
| `lib/graph-colors.ts` | — | **90** | 图谱配色**唯一来源**：页面与画布共用一份 |
| `lib/panzoom.ts` | 58 | **已删** | 换成 G6 的 `DragCanvas` / `ZoomCanvas` |
| `lib/edge-path.test.ts` | — | **85** | 只钉正交路由的几何 |
| `lib/workflow-layout.test.ts` | — | **171** | 17 条：投影 4 / 分层 8 / 锚点 3 / 包围盒 2 |
| `styles/graph.css` | — | **265** | |
| `styles/workflow.css` | — | **743** | 节点的类名被 HTML 节点复用，大部分保留 |

### 新增的 G6 层

| 文件 | 行数 | 职责 |
| --- | ---: | --- |
| `components/GraphCanvasG6.tsx` | 384 | 图谱画布：力导向布局、HTML 节点、边、右键菜单、点选式连线 |
| `components/WorkflowCanvasG6.tsx` | 597 | 工作流画布：antv-dagre 分层、HTML 节点、自定义边、端口、右键菜单 |
| `lib/g6-theme.ts` | 146 | 主题桥：tokens → G6 样式，监听 `zhixing:theme` |
| `lib/g6-adapt.ts` | 83 | 数据适配：`GraphPayload` → G6 `nodes` / `edges` |
| `lib/g6-workflow-edge.ts` | 197 | 自定义边 `wf-edge`：从端口出发的正交折线，四类语义 |
| `lib/workflow-anchors.ts` | 52 | 端口与锚点几何（从 WorkflowPage 抽出） |
| `lib/workflow-node-box.ts` | 59 | 节点尺寸常量与文字自适应（**尺寸的唯一来源**） |

### 依赖

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `@antv/g6` | ^5.1.1 | 两个画布 |
| `@dagrejs/dagre` | ^3.1.1 | **仅**用于「自动布局时把新坐标落库」 |

`d3-force` / `@types/d3-force` **已卸** —— G6 内置了同名的 `d3-force` 布局（那是布局的**名字**，不是 npm 包）。

## 四、与迁移前的差异（行为变化）

### 一致的部分

- **业务规则一行未动**：15 + 26 个 IPC、破环规则、归属/引用分色、双击分派、条件确认流、节点位置持久化、步骤对话框那一整套。
- **外观同源**：节点仍是 HTML，**沿用 `workflow.css` / `graph.css` 原有的类名**（`.wf-node__box` / `.wf-node__diamond` / `.wf-port` / `.gnode` …），不是用 G6 的原生图形重画。
- **连线语义不变**：工作流的四类边（顺序实线 / 满足绿虚线 / 不满足红虚线 / 跳到中性虚线）；图谱的归属实线 / 引用虚线。

### 明确的行为变化

| # | 变化 | 原因 |
| --- | --- | --- |
| 1 | **图谱连线从「拖拽手柄」改成「点选式」**（点起点 → 点终点） | G6 的 HTML 节点命中区域限于节点盒，而手柄在盒外 |
| 2 | **工作流分支从「拖端口到目标节点」改成两段式点选** | 同上 |
| 3 | **工作流分支清除改走「节点右键菜单」** | 边的命中区域只有 1.2px，实测右键命中率约 6–10% |
| 4 | **画布平移缩放由 G6 的 `DragCanvas`/`ZoomCanvas` 接管** | 自研的 `usePanZoom` 已删 |
| 5 | **节点的浮卡（`foreignObject`）没了** | G6 路径下节点是 canvas 上的 HTML，不再有 SVG `foreignObject`；工作流的分支信息改由右键菜单承担 |
| 6 | **布局变化带 1.2s 补间动画**（旧实现的「飞位动画」当年被删掉，G6 又送回来了） | G6 的 `postLayout` 默认走 `element.draw({ animation: true })`；实测切方向后节点逐帧移动 ≈1.2s 到位 |
| 7 | **图谱文件夹色位跨「离开页面再回来」保持稳定** | 色位缓存从 `GraphPage` 的 `useMemo`（随组件卸载清空）变成 `lib/graph-colors` 的模块级缓存 |

## 五、本次收尾（2026-10-06 第二轮）

### 5.1 「切方向后 DOM 不刷新」不是缺陷

**原记录**：点工作流工具栏的「纵向 / 横向」，模型坐标确实重排了（`getElementPosition` 从 TB 的 `[99,204]` 变成 LR 的 `[345,52]`），但页面上 HTML 节点的 DOM 位置一动不动。

**真相**：那是**窗口不可见时**的观测结果。知行的窗口被最小化 / 隐藏时，Chromium 会把该页面的
`requestAnimationFrame` **完全停掉**（`document.visibilityState === 'hidden'`）；而 G6 的
`postLayout` 走的是**动画路径**：

```ts
// node_modules/@antv/g6/src/runtime/layout.ts  postLayout
const result = await this.stepLayout(data, opts, index)   // 动画时长内不会 resolve
if (!options.animation) this.updateElementPosition(result, false)
```

于是 rAF 一停：动画不推进 → 元素的 `attributes.x/y` 停在旧值 → 由渲染循环写入 DOM 的
HTML 节点位置自然也不动。**模型是同步更新的，所以「模型变了、DOM 没变」这个组合确实会出现** ——
但它只在窗口不可见时出现，而那时用户根本看不到画布。

**证据（实测，2026-10-06）**：

| 条件 | 结果 |
| --- | --- |
| 窗口 hidden（`hasFocus:false`、`requestAnimationFrame` 900ms 不触发先） | 点方向 → 按钮文字变、库坐标变、**model 变**，DOM **不动**（等 3s 仍不动） |
| 同一页面，开 `Emulation.setFocusEmulationEnabled(true)` 后（`visibilityState: visible`、rAF 恢复） | 点方向 → DOM **逐帧跟随** elem 移动，约 1.2s 到位；连点 3 次全部跟上 |

**处置**：

1. **删掉 `syncPositions()`**（`WorkflowCanvasG6.tsx`）—— 那是按「DOM 不动」这个假象加的补丁：
   读 `getElementPosition` 再 `updateNodeData({style:{x,y}})` 写回。它不但没必要（渲染循环本来就会刷新），
   而且坐标语义可疑（`getElementPosition` 与 `style.x/y` 不是同一套锚点）；
2. 两个 effect 回到最朴素的 `void g.layout(LAYOUT_OPTS(...))`；
3. 把「怎么验证」写进 §6 —— 这一条值得单列，因为**同一类假象会骗过所有 G6 动画相关的验证**。

### 5.2 孤儿导出清理

判据用的是「**声明位置**」而不是符号对象（见 §7 第 19 条），做法：用 TypeScript 编译器 API
建全量 program → 从入口（7 个窗口入口 + 主进程 + preload）算可达模块集 → 统计每个导出在
**其它可达模块**里的引用 → 分四类：没人引用（删）、只有同文件引用（去掉 `export`）、
只被测试引用（生产死代码）、只被 re-export。

清理结果（**去导出 36 个符号，其中 9 个声明直接删除**）：

| 文件 | 处理 |
| --- | --- |
| `lib/edge-path.ts` | 删 `MAX_BULGE` / `EdgeEnds` / `bulgeOf` / `controlPoints` / `edgePath` / `elbowPath`（图谱换 G6 的 cubic 边后没人用了）；`SIDE_NORMAL` / `ORTHO_STUB` 收成内部常量 —— 264 → **106** 行 |
| `lib/workflow-layout.ts` | 删 `edgeAnchors`（生产早已不用，只剩单测）+ 4 条对应单测；`LAYOUT_NODE_W` / `LAYOUT_NODE_H` 删掉，改用 `workflow-node-box` 的 `NODE_W` / `NODE_H`（同一份尺寸常量曾经有两个定义，靠注释「保持一致」维系）；`WorkflowLayoutOptions` / `LayoutEdge` / `LAYOUT_MARGIN` 收成内部 |
| `lib/g6-adapt.ts` | 8 个（7 个类型 + `edgeKey` / `nodeId`）收成内部，只导出 `toG6Data` |
| `lib/graph-colors.ts` | 色板 / 缓存 / 分类色 5 个收成内部，只导出 `colorOf` / `KIND_CN` / `NODE_R` |
| `lib/g6-theme.ts` | `tok` / `G6Theme` 收成内部 |
| `lib/g6-workflow-edge.ts` | `mix` / `svgPathToArray` 收成内部 |
| `lib/workflow-node-box.ts` | `charWidth` / `textWidth` 收成内部 |
| 两个画布组件 | `GraphCanvasProps` / `WorkflowCanvasProps` / `WorkflowNodeView` 收成内部（`*Handle` 与 `WorkflowCanvasNode` 仍导出 —— 页面在用） |

**顺带修掉一个「抽了没接上」**：`lib/graph-colors.ts` 的注释写着「P1 换成 G6 之后画布组件也要按同一套规则
上色，如果两边各留一份会很难查」，但它抽出来之后 **`GraphPage` 仍留着自己那一份**（`FOLDER_PALETTE` /
`KIND_COLOR` / `KIND_CN` / `folderColor` / `knowledgeColor` / `colorOf` 全套），模块里只有 `NODE_R` 被画布引用。
现在 `GraphPage` 改成 `import { KIND_CN, colorOf }`，页面与画布**真的**共用一份了。

**没动的**（记在这里，将来要做时别重新发现一遍）：分析器还报出**本仓库其它区域的**孤儿导出
（`src/main/db/*`、`src/shared/{ai-note,workflow-*}.ts`、`lib/icons.tsx` 的 6 个图标等），以及两个
**生产不可达的模块**：`components/FloatingDock.tsx`（整份组件没人 import）与
`vendor/bloub/bot/cycles.ts`（只被测试引用）。它们与 G6 迁移无关，本次不碰。

### 5.3 两套 dagre 并存 —— 保留

`@dagrejs/dagre` 用于「自动布局时算落库坐标」，`antv-dagre`（G6 内置）用于画布布局。
统一要改落库算法，风险最高、收益最低，**建议长期不做**。

## 六、验证环境：先让窗口「可见」

**这一节是本文最该先读的部分。** 知行窗口被最小化 / 隐藏时，Chromium 停掉该页面的 rAF，
**G6 一切由动画或渲染循环驱动的行为都会静默停摆**（节点不动、DOM 不刷新、promise 不 resolve），
而 IPC、React 状态、库坐标全部照常。这会造出「功能坏了」的假象 —— 上面 ① 就是这么被记了两轮。

**连 CDP 后第一件事**：

```js
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
// 之后：document.visibilityState === 'visible'、document.hasFocus() === true、rAF 恢复触发
```

注意它是**按 CDP session 生效**的：每个脚本 / 每次重连都要设一遍（`Page.bringToFront` 对
最小化的 Electron 窗口**无效**，实测不影响 `visibilityState`）。

判断页面是否真的「活着」：

```js
const raf = await new Promise((res) => {
  const t = setTimeout(() => res('timeout'), 800)
  requestAnimationFrame(() => { clearTimeout(t); res('fired') })
})
```

**读 DOM 位置的正确对照物**：G6 的 HTML 节点是 `<容器> > div(缩放平移) > div.key(节点) > svg`，
要读的是 **`div.key` 的 `transform`**。用 `document.querySelector('svg.wf-node__svg')` 去对号
很可能拿到的不是你在动的那一个（`.wf-canvas--g6` 的直接子元素里，最后那个 div 才是 HTML 容器，
第一个 `overflow:hidden` 的 div 是空的）。

## 七、踩过的坑（值得留档）

### G6 / Canvas 的

1. **Canvas 不认 `color-mix()`** —— 静默回退成白色。主题桥必须把 token 解成具体色值。
2. **`new Graph()` 顶层的 `padding` 会废掉布局** —— 类型合法、编译通过、所有节点堆在一点。
3. **`canvas.autoResize` 不在 `CanvasConfig` 里** —— 要自己用 `ResizeObserver` + `graph.resize()`。
4. **`getCenter()` 返回的是「盒的右下角」不是中心** —— 锚点整体偏 `(+75,+56)`，线画到节点外面。
5. **自定义边（`BaseEdge`）的 `getKeyPath` 是抽象方法，不能通过 `super` 调**。
6. **`halo` 不能扩大命中区域**（只管视觉），G6 也没有公开的命中区域配置；1.2px 的线右键命中率约 6–10%。
7. **`setOptions` 不更新 `context.layout` 的 `presetOptions`** —— 布局配置必须**直接传给 `layout()`**。
8. **`render()` 用的是建图那一刻的 options** —— 数据同步的 effect 不能只 `render()`。
9. **dev 下 `React.StrictMode` 会「挂载→卸载→再挂载」** —— 第一次的图被 `destroy()` 而 G6 的异步任务还在飞，
   控制台**必定**有 `The graph instance has been destroyed` / `Cannot read properties of undefined
   (reading 'postLayout')` 这类报错。**生产环境没有 StrictMode**，不是 bug —— 但**页面切换也会触发同一批报错**
   （见第 18 条）。

### 验证方法上的

10. **synthetic `PointerEvent` 进不了 G6 的事件系统** —— 它有自己的命中检测，必须用 CDP 的 `Input.dispatchMouseEvent`。
11. **CDP 的 `Page.captureScreenshot` 在带 G6 canvas 的页面上会超时** —— 改用 DOM 值验证。
12. **验证工具本身也会坏** —— 用同一个有缺陷的读取片段（`visibility === 'hidden'` 判断）「证明」了菜单不工作好几轮，实际它一直正常。
13. **「错误总数不增」是个会骗人的验证** —— 语法错误会让 tsc 提前停止分析，总数**反而下降**。必须同时要求「无语法错」。
14. **提交信息说「删了」不等于删了** —— 有一次 `unlinkSync` 用 `/` 分隔路径在 Windows 上静默失败，而我没核对 `--stat`，两个文件在仓库里留了好几轮。
15. **「源码对、实测不对」先怀疑 Vite 构建缓存** —— 清了 `node_modules/.vite` 才有决定性证据。

### 本轮新增

16. **窗口不可见 → rAF 停摆 → G6 全线冻结**（§6）。最坑的一点是它**没有任何报错**：
    layout 的 promise 悬着、`await` 的代码不往下走、DOM 不动，看起来就像功能没实现。
17. **`graph.draw()` 默认 `animation: true`，而且没有变化时返回 `undefined`**：
    `ElementController.draw()` 先看 `model.getChanges()`，为空就 `return`（不是 promise）；
    有变化则走动画 —— 在 rAF 停摆的窗口里这一等就是**永远**。想同步重画必须
    `element.draw({ animation: false })`。
18. **页面切换 / HMR 时，`destroy()` 之后的异步任务会报错**：
    `Graph.destroy()` 清掉 `this.context`，而正在飞的 `render()` / `layout()` 的 `await` 回来后继续访问
    `this.context.layout` → `Cannot read properties of undefined (reading 'postLayout')`。
    只在控制台里吵，界面正常；G6 内部行为，**不修**（`stopLayout()` 也拦不住 —— 它只 finish 动画，
    拦不住 await 之后的代码）。
19. **静态分析符号时，Map 的 key 不能用 Symbol 对象**：跨文件 `import` 解析出的 alias 展开后
    **未必是同一个实例**，于是 barrel（`db/index.ts`）里几百个 re-export 会集体误报成孤儿。
    改用「声明位置」（`decl.getSourceFile().fileName + '@' + decl.pos`）当 key，结果立刻自洽。
20. **别用 PowerShell 的 `Get-Content` 数行数**：它按系统编码读 UTF-8，同一个文件 v/s `node` 能差出 20%
    （实测 `WorkflowCanvasG6.tsx`：`Get-Content` 说 497、`node` 说 597、`git diff` 佐证后者）。
    统计一律走 `node`。
21. **tools.edit 漏 watcher 事件时，`touch` 一下文件就够**：Vite 会重新转换该模块
    （`(Get-Item 文件).LastWriteTime = Get-Date`），不必清 `node_modules/.vite`、更不必重启 dev server。
    验证方法：`fetch('/src/...tsx') ` 看磁盘上的改动在不在。
22. **改完先核对「Vite 提供的是哪一版」**：本轮出现过 Vite 手上是**中间状态**的模块
    （函数定义已删、调用还在 → 运行时会 `ReferenceError`）—— 因为三次原子替换之间 watcher 只抓到一次。

## 八、图谱页的已知取舍

| 项 | 结论 |
| --- | --- |
| 拖拽式连线 | **判定不值得做**，改点选式 |
| `fitView` 内边距 | **不可行** —— G6 顶层的 `padding` 会让布局把所有节点堆到一点 |
| 改挂端点 | ✅ 已接入右键菜单 |
