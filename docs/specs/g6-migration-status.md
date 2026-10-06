# 图谱与工作流迁移到 @antv/g6 · 实施进程

> **方案见 [`g6-migration.md`](./g6-migration.md)** —— 那份是调研与方案（已成文于迁移前），本文记录**实施进程**：现状、与迁移前的差异、剩余工作、踩过的坑。
>
> 最后更新：2026-10-06。

## 一、一句话现状

**两个页面都已切到 G6，两套手写 SVG 画布与其依赖（`usePanZoom`、`d3-force`）已删除。** 剩三项收尾：一处功能缺陷（切方向后 DOM 不刷新）、一处纯清理（16 个孤儿导出）、一处冗余（两套 dagre 并存）。

## 二、阶段完成情况

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **P0** | 主题桥 `lib/g6-theme.ts` + 数据适配 `lib/g6-adapt.ts` + 最小图冒烟 | ✅ |
| **P1** | 图谱页替换（`GraphCanvasG6.tsx`） | ✅ |
| **P2** | 工作流页替换（`WorkflowCanvasG6.tsx`） | ✅ |
| **P3** | 清理与文档 | ⚠️ **大部分完成**，见下 |

## 三、现状数据

### 行数对比

| 文件 | 迁移前 | 现状 | 说明 |
| --- | ---: | ---: | --- |
| `pages/GraphPage.tsx` | 1164 | **646** | 渲染层全部搬进 `GraphCanvasG6` |
| `pages/WorkflowPage.tsx` | 2030 | **1225** | 渲染层全部搬进 `WorkflowCanvasG6` |
| `lib/edge-path.ts` | 264 | **157** | 瘦身过（删了 5 个没人用的导出），**未删** |
| `lib/workflow-layout.ts` | 196 | **177** | 仍在用（自动布局时算落库坐标） |
| `lib/panzoom.ts` | 58 | **已删** | 换成 G6 的 `DragCanvas` / `ZoomCanvas` |
| `lib/edge-path.test.ts` | — | **80** | 从 227 行瘦身（删掉测已删函数的两个块） |
| `styles/graph.css` | — | **248** | |
| `styles/workflow.css` | — | **723** | 节点的类名被 HTML 节点复用，大部分保留 |

### 新增的 G6 层

| 文件 | 行数 | 职责 |
| --- | ---: | --- |
| `components/GraphCanvasG6.tsx` | 337 | 图谱画布：力导向布局、HTML 节点、边、右键菜单、点选式连线 |
| `components/WorkflowCanvasG6.tsx` | 514 | 工作流画布：antv-dagre 分层、HTML 节点、自定义边、端口、右键菜单 |
| `lib/g6-theme.ts` | 123 | 主题桥：tokens → G6 样式，监听 `zhixing:theme` |
| `lib/g6-adapt.ts` | 77 | 数据适配：`GraphPayload` → G6 `nodes` / `edges` |
| `lib/g6-workflow-edge.ts` | 165 | 自定义边 `wf-edge`：从端口出发的正交折线，四类语义 |
| `lib/workflow-anchors.ts` | 41 | 端口与锚点几何（从 WorkflowPage 抽出） |
| `lib/workflow-node-box.ts` | 48 | 节点尺寸常量与文字自适应 |
| `lib/graph-colors.ts` | 71 | 配色（从 GraphPage 抽出） |

### 依赖

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `@antv/g6` | ^5.1.1 | 两个画布 |
| `@dagrejs/dagre` | ^3.1.1 | **仅**用于「自动布局时把新坐标落库」 |

`d3-force` / `@types/d3-force` **已卸**——G6 内置了同名的 `d3-force` 布局（那是布局的**名字**，不是 npm 包）。

## 四、与迁移前的差异（行为变化）

### 一致的部分

- **业务规则一行未动**：15 + 26 个 IPC、破环规则、归属/引用分色、双击分派、条件确认流、节点位置持久化、步骤对话框那一整套。
- **外观同源**：节点仍是 HTML，**沿用 `workflow.css` / `graph.css` 原有的类名**（`.wf-node__box` / `.wf-node__diamond` / `.wf-port` …），不是用 G6 的原生图形重画。
- **连线语义不变**：工作流的四类边（顺序实线 / 满足绿虚线 / 不满足红虚线 / 跳到中性虚线）。

### 明确的行为变化

| # | 变化 | 原因 |
| --- | --- | --- |
| 1 | **图谱连线从「拖拽手柄」改成「点选式」**（点起点 → 点终点） | G6 的 HTML 节点命中区域限于节点盒，而手柄在盒外 |
| 2 | **工作流分支从「拖端口到目标节点」改成两段式点选** | 同上 |
| 3 | **工作流分支清除改走「节点右键菜单」** | 边的命中区域只有 1.2px，实测右键命中率约 6–10% |
| 4 | **画布平移缩放由 G6 的 `DragCanvas`/`ZoomCanvas` 接管** | 自研的 `usePanZoom` 已删 |
| 5 | **节点的浮卡（`foreignObject`）没了** | G6 路径下节点是 canvas 上的 HTML，不再有 SVG `foreignObject`；工作流的分支信息改由右键菜单承担 |
| 6 | **布局飞位动画移除** | 它读 `svgRef` 定位，随手写 SVG 一起删；判定为纯装饰，不做 |

## 五、剩余工作

### ① 切方向后 DOM 不刷新 🔴 **功能缺陷**

**现象**：点工作流工具栏的「纵向 / 横向」，**模型坐标确实重排了**（`getElementPosition` 从 TB 的 `[99,204]` 变成 LR 的 `[345,52]`），**但页面上 HTML 节点的 DOM 位置一动不动**，用户看不到变化。

**已经查明的链路**：

```
graph.context.canvas.getRenderer('main')          → Renderer2
  └─ getPlugins()                                  → 8 个插件
      └─ 'html-renderer'                           → 只管子插件
          └─ plugins.values()[0]                   → HTMLRenderingPlugin2
                apply()                            ← 把变换写进 DOM 的入口
                displayObjectHTMLElementMap        ← WeakMap（无法遍历）
```

**试过且无效的手段**：`shapeMap.key.setPosition` / `shapeMap['key-container'].setPosition` / `translateElementTo` / `updateNodeData + draw()` / `render()` / 直接调 `apply()`（报内部 `root` undefined）。`canvas` 上只有 `getRenderer`/`setRenderer`，没有 `draw`；`changeSize` 不存在。

**⚠️ 下一轮第一件事**：**先验证对照物**。我一直用 `document.querySelector('svg.wf-node__svg')`（第一个节点）读位置，移动的却是节点 `12` —— **它们可能不是同一个**。G6 的 HTML 节点有 `getDomElement()`，用它才是正确对照：

```js
graph.context.element.getElement('12').getDomElement() === document.querySelector('svg.wf-node__svg')
```

**影响面**：初始方向是生效的（建图时那份配置带着当时的 `rankdir`），且 `handleAutoLayout` 会把新坐标落库，**下次打开就是对的**。只有「运行中切方向」看不到变化。

### ② 16 个孤儿导出 🟡 **纯清理**

`g6-adapt.ts`（7 个类型）、`workflow-layout.ts`（3 个）、`workflow-node-box.ts`（2 个）、`g6-theme.ts`（`G6Theme`）、`g6-workflow-edge.ts`（`svgPathToArray`）、`edge-path.ts`（8 个）。

**为什么难**：它们**互相引用形成环**。试过四种方法都失败 —— 单遍跨文件计数（漏了同文件内部引用）、加上"删掉声明后在全文计数"（环里互为引用，永远不为 0）、不动点传播（环里没有一个能"第一个"成为候选）、标记-清除（把 lib 里的非导出内容当成了存活入口）。

**正确做法**：**递归判定文件的存活性** —— 一个文件里的内部辅助如果只被死代码引用，它也是死的。**没做完。**

### ③ 两套 dagre 并存 🟢 **冗余，可以不修**

`@dagrejs/dagre` 用于「自动布局时算落库坐标」，`antv-dagre`（G6 内置）用于画布布局。**统一要改落库算法，风险最高**，建议长期不做。

### 图谱页的已知取舍

| 项 | 结论 |
| --- | --- |
| 拖拽式连线 | **判定不值得做**，改点选式 |
| `fitView` 内边距 | **不可行** —— G6 顶层的 `padding` 会让布局把所有节点堆到一点 |
| 改挂端点 | ✅ 已接入右键菜单 |

## 六、踩过的坑（值得留档）

### G6 / Canvas 的

1. **Canvas 不认 `color-mix()`** —— 静默回退成白色。主题桥必须把 token 解成具体色值。
2. **`new Graph()` 顶层的 `padding` 会废掉布局** —— 类型合法、编译通过、所有节点堆在一点。
3. **`canvas.autoResize` 不在 `CanvasConfig` 里** —— 要自己用 `ResizeObserver` + `graph.resize()`。
4. **`getCenter()` 返回的是「盒的右下角」不是中心** —— 锚点整体偏 `(+75,+56)`，线画到节点外面。
5. **自定义边（`BaseEdge`）的 `getKeyPath` 是抽象方法，不能通过 `super` 调**。
6. **`halo` 不能扩大命中区域**（只管视觉），G6 也没有公开的命中区域配置；1.2px 的线右键命中率约 6–10%。
7. **`setOptions` 不更新 `context.layout` 的 `presetOptions`** —— 布局配置必须**直接传给 `layout()`**。
8. **`render()` 用的是建图那一刻的 options** —— 数据同步的 effect 不能只 `render()`。
9. **dev 下 `React.StrictMode` 会「挂载→卸载→再挂载」** —— 第一次的图被 `destroy()` 而 G6 的异步任务还在飞，控制台**必定**有那两条报错。**生产环境没有 StrictMode**，不是 bug。

### 验证方法上的

10. **synthetic `PointerEvent` 进不了 G6 的事件系统** —— 它有自己的命中检测，必须用 CDP 的 `Input.dispatchMouseEvent`。
11. **CDP 的 `Page.captureScreenshot` 在带 G6 canvas 的页面上会超时** —— 改用 DOM 值验证。
12. **验证工具本身也会坏** —— 我用同一个有缺陷的读取片段（`visibility === 'hidden'` 判断）「证明」了菜单不工作好几轮，实际它一直正常。
13. **「错误总数不增」是个会骗人的验证** —— 语法错误会让 tsc 提前停止分析，总数**反而下降**。必须同时要求"无语法错"。
14. **提交信息说「删了」不等于删了** —— 有一次 `unlinkSync` 用 `/` 分隔路径在 Windows 上静默失败，而我没核对 `--stat`，两个文件在仓库里留了好几轮。
15. **「源码对、实测不对」先怀疑 Vite 构建缓存** —— 清了 `node_modules/.vite` 才有决定性证据。
