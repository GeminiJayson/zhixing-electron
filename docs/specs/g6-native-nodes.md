# G6 原生节点 vs HTML 节点 · 调研与取舍

> **问题**：两个画布现在都用 HTML 节点（`node: { type: 'html', style: { innerHTML } }`）。
> 本文评估「换成 G6 原生节点（内置图形节点 + 自定义注册节点）」的可行性与收益。
>
> **依据**：第一轮（§一 ~ §十）逐条读自**本仓库安装的 @antv/g6 v5.1.1 源码**（`node_modules/@antv/g6/src/**`），
> 每条给出**文件路径 + 符号名**（按仓库文档规范，不写行号）。
>
> **第二轮（§十一）补上了官方文档依据**：`web_fetch` 仍被拦（`g6.antv.antgroup.com` 被本机 DNS 解析到
> `198.18.0.8` / `2001:2::29`，属非公网地址），但 `Invoke-WebRequest` 与 Node 的 `fetch` 都能走本机代理
> 拿到 200 —— 抓取方法见 §11.0。**第二轮的实测修正了第一轮的两条判断**，见 §11.5。
>
> 最后更新：2026-10-06（第二轮：按官方文档「图形 Shape / 自定义节点」重新评估）。

## 一、结论（先看这段）

| 问题 | 答案 |
| --- | --- |
| **值不值得换？** | **不值得整体换。** 收益只有两块（端口可原生命中/可拖拽连线、少 251 个 DOM 子树），成本却覆盖两个画布组件、两个样式表、主题桥、以及 **9 个端到端脚本**（41 处 DOM 引用）。 |
| **换哪一部分？** | 只有**工作流的节点**有明确收益（端口语义、连线方式）。图谱的节点**不建议换**：它的外观是 118 行 React + 23 条 CSS 驱动的多色分层图标，搬到 canvas 要重画，而 251 个 DOM 子树目前不是瓶颈（实测渲染正常）。 |
| **先换哪个？** | 如果要做：**先工作流，后图谱**（甚至图谱不做）。工作流节点数少（真实模板 5 个）、收益明确，适合先把「自定义节点 + 原生 ports」这套范式跑通。 |
| **反对理由** | 见 §10.2，最长的一条是：**节点外观现在由 CSS 变量驱动、换主题天然生效；换成原生节点后每个色值都要经主题桥映射，且 `color-mix()` 必须预先算成具体色值**（canvas 不认，本仓库已经踩过）。 |

**一句话**：这是一次「把 CSS 的活搬到 TS 里」的重构，换来的是端口与连线的原生能力 —— 除非确定要做**拖拽式连线 / 端口级交互**，否则不划算。

> ⚠️ **第二轮修正**（见 §十一）：上面四条是**只读源码**时的判断。按官方文档的「自定义节点 / 复合 Shape」机制
> 实测之后，「图谱图标要重画」与「工作流必须重写 `nodeSvg` 的等价物」两条**都被实测推翻或大幅减轻** ——
> 现有 SVG 的 `d` 数据可以直接喂给 `upsert(..., 'path', { d })`，自定义节点就是「继承内置节点 + 几次 upsert」。
> **修正后的结论见 §11.5**；§10 的建议按 §11.5 读。

## 二、内置节点清单（v5.1.1）

`src/elements/nodes/index.ts` 导出的就是全部内置节点，**10 个**：

| 类型名（`type`） | 类 | 自己的样式键（除下表外都继承 `BaseNodeStyleProps`） |
| --- | --- | --- |
| `circle` | `Circle`（`elements/nodes/circle.ts`） | 无额外键；尺寸走 `size` |
| `rect` | `Rect`（`elements/nodes/rect.ts`） | 无额外键；keyShape 是 G 的 `Rect`，所以 `radius` 等 G 样式可用 |
| `diamond` | `Diamond`（`elements/nodes/diamond.ts`） | 继承 `PolygonStyleProps`；顶点按 `size` 算（`getDiamondPoints`） |
| `ellipse` | `Ellipse`（`elements/nodes/ellipse.ts`） | 无额外键 |
| `hexagon` | `Hexagon`（`elements/nodes/hexagon.ts`） | 继承 `PolygonStyleProps` |
| `star` | `Star`（`elements/nodes/star.ts`） | `innerR`（内半径，默认外半径 3/8） |
| `triangle` | `Triangle`（`elements/nodes/triangle.ts`） | `direction: 'up' \| 'left' \| 'right' \| 'down'`（默认 `up`） |
| `donut` | `Donut`（`elements/nodes/donut.ts`） | `innerR`、`donuts`（数值或 `DonutRound[]`）、`donutPalette`、`Prefix<'donut', BaseStyleProps>` |
| `image` | `Image`（`elements/nodes/image.ts`） | `img` / `src`（`string \| HTMLImageElement`） |
| `html` | `HTML`（`elements/nodes/html.ts`） | `innerHTML`、`dx`、`dy` |

**所有节点共享的样式键**（`elements/nodes/base-node.ts` 的 `BaseNodeStyleProps`）：

- 几何：`x` / `y` / `z` / `size` / `collapsed`
- 开关：`label` / `halo` / `icon` / `badge` / `port`（都是布尔，默认除 `halo` 外全开）
- 四组前缀样式：`label*`（`Prefix<'label', NodeLabelStyleProps>`）、`halo*`、`icon*`、`badge*`、`port*`（`Prefix<'port', PortStyleProps>`）
- 数组：`ports[]`（`NodePortStyleProps[]`）、`badges[]`（`NodeBadgeStyleProps[]`）、`badgePalette`
- 其余（`fill` / `stroke` / `lineWidth` / `opacity` …）来自 `BaseShapeStyleProps`，也就是 G 的图形样式

`BaseNode.defaultStyleProps` 里几个值得记住的默认值：`port: true` / `ports: []` / `portZIndex: 2`、
`badge: true` / `icon: true` / `label: true` / `labelPlacement: 'bottom'` / `labelWordWrap: false` /
`labelMaxWidth: '200%'` / `halo: false`。

### 2.1 HTML 节点没有的能力

| 能力 | 原生节点怎么做（依据） | HTML 节点现状 |
| --- | --- | --- |
| **label 折行 + 最多 N 行 + 省略号** | `elements/shapes/label.ts` 的 `Label.defaultStyleProps`：`wordWrap: true`、`maxLines: 1`、`textOverflow: '...'`；节点侧前缀键 `labelWordWrap` / `labelMaxWidth` / `labelMaxLines` / `labelTextOverflow` | 无 G6 层支持，只能自己在 innerHTML/CSS 里做 |
| **icon** | `elements/shapes/icon.ts` 的 `Icon`：传 `iconText` 画文字、传 `iconSrc` 画图片；尺寸由 `utils/node.ts` 的 `inferIconStyle` 自动推断（文字 0.5×min(size)，图片 0.5×size）并居中 | 自己塞进 innerHTML |
| **badge** | `elements/shapes/badge.ts` 的 `Badge`（本质是带背景的 Label），`badges[]` 支持多个 + `placement` + `badgePalette` 自动配色 | 自己塞 |
| **halo（光晕）** | `BaseNode.drawHaloShape` 复制 keyShape 的外形放大 | 有 `halo` 键，但 keyShape 是 `GHTML`，复制出来还是 HTML；本仓库实测「halo 不能扩大命中区域」 |
| **state（选中/激活/高亮/失效/禁用）** | `themes/base.ts` 的 `create(tokens)` 给出 5 个内置 state；`runtime/graph.ts` 的 `setElementState` / `getElementState` 驱动 | 现在靠重写 innerHTML 换 `--on` / `--done` / `--current` 修饰类 |
| **ports（连接桩）** | 见 §3 | 只能自己画 + DOM 命中 |
| **动画** | `theme.node.animation`（`enter` / `exit` / `show` / `hide` / `expand` / `collapse` / `update` / `translate`，可按字段触发） | CSS `transition` 可用，G6 动画用不上 |
| **导出图片** | `runtime/graph.ts` 的 `toDataURL` → `runtime/canvas.ts` 的 `toDataURL`：**新建离屏 `GCanvas` + `CanvasRenderer` 重画一遍** | **导不进去** —— HTML 节点是 DOM 覆盖层，不在 canvas 位图里。本仓库目前没有任何 G6 导出图片的调用（`toDataURL` 只出现在 `lib/rich-media.ts`，与图无关），所以这条能力**对我方不是收益** |

## 三、连接桩 ports（对工作流最关键）

### 3.1 怎么声明

端口写在**节点样式**里（不是数据里），类型是 `types/node.ts` 的 `NodePortStyleProps extends PortStyleProps`：

```ts
data: {
  nodes: [{
    id: 'n1',
    style: {
      ports: [
        { key: 'true',  placement: [1, 0.5], r: 5, fill: '#fff', stroke: '#16a34a' },
        { key: 'false', placement: [0, 0.5], r: 5, fill: '#fff', stroke: '#dc2626' },
      ],
    },
  }],
}
```

- `key`：端口标识（默认是数组下标）；**边的 `sourcePort` / `targetPort` 就是按这个 key 找的**（`elements/edges/base-edge.ts` 的 `BaseEdgeStyleProps.sourcePort`）。
- `placement`：**必填**，见下。
- `r`：圆半径。**不给 `r`（或给 0）就是「简单端口」** —— `utils/element.ts` 的 `isSimplePort` 判定为 true，**不画图形**，但 `getAllPorts` 仍会把它算作一个可连接的「点」。这个特性很适合「只想定义连接点、不想画圆」的场景。

### 3.2 支持哪些位置

`types/placement.ts`：

- `CardinalPlacement`：`'left' | 'right' | 'top' | 'bottom'`
- `CornerPlacement`：8 个角（`left-top` / `top-left` / …）
- `RelativePlacement`：`[number, number]`（**0~1 的相对坐标**）
- `NodePortStyleProps.placement: Placement = RelativePlacement | DirectionalPlacement`

字符串位置由 `utils/element.ts` 的 `PORT_MAP` 翻译成相对坐标（例如 `right → [1, 0.5]`），
最终由 `getPortXYByPlacement` 算成绝对坐标：`bbox.min + bbox.size × 相对坐标`，
其中 bbox 来自 `BaseNode.getPortXY` → `getBoundsInOffscreen(context, keyShape)`（**keyShape 的包围盒**）。

**对工作流的直接映射**：

| 现在的端口 | 原生 ports 写法 |
| --- | --- |
| 条件节点右尖角「满足」 | `placement: [1, 0.5]`（菱形包围盒右中点 = 尖角） |
| 条件节点左尖角「不满足」 | `placement: [0, 0.5]` |
| 普通步骤右边中点「跳到」 | `placement: [1, 0.5]` |

也就是说：**现有的端口几何（`lib/workflow-anchors.ts` 的 `nodePort`）能被 ports 的 placement 精确表达**，不需要自己算坐标了。

### 3.3 能不能按数据动态决定有几个桩

**能。** `spec/element/node.ts` 的 `NodeOptions.style` 支持**函数式**：

```ts
style?: NodeStyle
  | ((this: Graph, data: NodeData) => NodeStyle)
  | { [K in keyof NodeStyle]: NodeStyle[K] | ((this: Graph, data: NodeData) => NodeStyle[K]) }
```

所以「条件节点 2 个桩、普通步骤 1 个桩」可以写成返回不同 `ports` 数组的函数，不必注册两种节点类型。
（`NodeOptions.type` 同样支持函数：`(datum) => string`。）

### 3.4 命中区域与事件 ★

这一节的结论会**推翻一个常见预期**：

- **端口是节点内部的图形**：`BaseNode.drawPortShapes` 对每个非简单端口执行
  `this.upsert(shapeKey, GCircle, style, container)`，`shapeKey = 'port-' + key`。
  圆没有被 G6 关掉命中（`getPortsStyle` 只设 `transform` 并合并样式，不设 `pointerEvents`），所以**端口可以被命中**，命中区域就是那个圆本身（`r` 决定的直径 —— 工作流现在是 5px → 10px 的命中区）。
- **但 `node:click` 事件里拿到的 `e.target` 是「节点」，不是「端口」**：
  `runtime/behavior.ts` 的 `forwardCanvasEvents` 会做
  `const target = eventTargetOf(originalTarget)`（`utils/event/index.ts`：**从命中的图形向上找到最近的 node/edge/combo**），
  然后发出 `{ ...event, target: targetElement, targetType, originalTarget }`。
  → **`e.targetType` 永远是 `'node'`，区分不出是哪一个桩**。
- **正确的区分方式是 `e.originalTarget`**：`types/event.ts` 的 `TargetedEvent` 显式声明了
  `originalTarget: DisplayObject`（就是命中的那个图形）。它应当**等于**节点 shapeMap 里的端口实例，
  所以可以这样判断：

```ts
graph.on('node:click', (e) => {
  const node = e.target as Node
  const hit = e.originalTarget                       // 命中的图形（可能是端口圆）
  for (const [key, port] of Object.entries(node.getPorts())) {
    if (port === hit) return onPortClick(node.id, key)
  }
  onNodeClick(node.id)
})
```

  依据：`BaseNode.getPorts()` 返回 `subObject(this.shapeMap, 'port-')`，
  而 `utils/prefix.ts` 的 `subObject` 会**剥掉前缀** → 得到 `{ [端口 key]: 图形 }`，
  比较对象身份即可（不依赖 className，也不依赖坐标换算）。

> ⚠️ **需要实测确认**：`originalTarget` 是否在**所有**事件（含 `node:contextmenu`、`pointerdown`）里都保留端口图形，
> 以及「在端口上按下」会不会同时触发 `drag-element` 的节点拖拽（`behaviors/drag-element.ts` 的 `enable` 只看 `targetType`，
> 不看命中的是哪个图形）。这两条只能跑起来才知道 —— 见 §7。

### 3.5 桩上/桩旁能不能挂文字标签

**内置不支持。** 依据：`types/node.ts` 的 `PortStyleProps extends Omit<CircleStyleProps, 'r'>` —— 里面**没有 text**；
`BaseNode.drawPortShapes` 也只 upsert `GCircle`，不会画文字。

三条可选路子（按成本从低到高）：

1. **用 badge 冒充**：`badges: [{ text: '满足', placement: 'right' }]` —— 但 badge 是**相对 keyShape 的固定位置**（`getTextStyleByPlacement`），
   两个桩要挂两块文字时位置会打架，且不会跟着端口走。
2. **自定义节点里重写 `drawPortShapes`**（`protected`，可覆盖）：每个端口 upsert 一个 `Group`（圆 + `GText`），文字位置自己算。
3. **端口 + 边标签**：把「满足/不满足」写成边的 label（`BaseEdgeStyleProps.labelText`，边也有完整的 `label*` 前缀键）。

工作流现在用的是**端口旁文字**，所以走第 2 条 —— 这也意味着「端口文字」这一项**换原生节点并不能白拿，仍要自己画**。

## 四、自定义节点

### 4.1 注册

`registry/register.ts`：

```ts
export function register<T extends ExtensionCategory>(category, type, Ctor) { ... }
```

注意签名：**第三个参数是类（构造函数），不是对象字面量** ——
`registry/types.ts` 的 `ExtensionRegistry.node: Record<string, { new (...args: any[]): Node }>`。
所以 `register('node', 'wf-step', {...})` 这种写法**不成立**，必须是 `class WfStep extends BaseNode {}`。

JSDoc 里的用法（`registry/register.ts`）：

```ts
import { register, BaseNode } from '@antv/g6'
class CircleNode extends BaseNode {}
register('node', 'circle-node', CircleNode)
```

### 4.2 `BaseNode` 的绘制钩子

`elements/nodes/base-node.ts` 的 `BaseNode.render()` 顺序固定：

| 顺序 | 方法 | 职责 | 抽象? |
| --- | --- | --- | --- |
| 1 | `drawKeyShape(attributes, container)` | **主图形**（圆/矩形/菱形/自定义 Path） | **抽象，必须实现** |
| 2 | `drawHaloShape` | 复制 keyShape 做光晕 | 可覆盖 |
| 3 | `drawIconShape` | `upsert('icon', Icon, style)` | 可覆盖 |
| 4 | `drawBadgeShapes`（**复数**） | 按 `badges[]` 逐个 `upsert('badge-N', Badge, ...)` | 可覆盖 |
| 5 | `drawLabelShape` | `upsert('label', Label, ...)` | 可覆盖 |
| 6 | `drawPortShapes` | 按 `ports[]` 逐个 `upsert('port-K', GCircle, ...)` | 可覆盖 |

两个实现细节值得知道：

- `upsert(name, Ctor, style, container)` 来自 `elements/shapes/base-shape.ts`：**name 已存在就更新、不存在就建、style 传 `false` 就删** ——
  自定义绘制应当一律用它，而不是自己 new/appendChild。
- `BaseNode.onframe()` 会**每帧重画 badge 与 label**（`drawBadgeShapes` + `drawLabelShape`），
  这是「label 位置依赖 keyShape 尺寸」的兜底；自定义时要注意别在这两个方法里做重活。

### 4.3 画「圆角矩形 / 菱形 + 角标 + 标题 + 省略号」

- **圆角矩形**：直接用内置 `rect`（`Rect.getKeyStyle` 把 `size` 换算成 `width/height` 并居中），`radius` 传给 G 的 `Rect`。
- **菱形**：直接用内置 `diamond`（`getDiamondPoints`），或自定义节点里复用 `elements/shapes/polygon.ts` 的 `Polygon`。
- **角标 / 标题 / 判据 三行文字**：G6 内置节点**只有一个 label**（`drawLabelShape` 只 `upsert('label', ...)`）。
  三行要么用 3 个 badge 拼（`badges[]` 的 `placement` 只有 4 个边 + 8 个角，且各自独立定位），
  要么**自定义节点里自己 upsert 三个 `GText`** —— 后者才是正解。
- **省略号**：label 有 `labelTextOverflow` + `labelMaxLines`（`Label.defaultStyleProps`）直接可用；
  自己 upsert 的 `GText` 则要用 G 的 `textOverflow` / `wordWrap` / `maxLines`（`TextStyleProps`）。

### 4.4 `AutoAdaptLabel` 能替代 `fitNodeText` 吗？——**不能**

这是一个容易望文生义的坑：`behaviors/auto-adapt-label.ts` 的 `AutoAdaptLabel`
**不是排版工具**，而是**标签防重叠策略**：它按 `sortNode`（默认度中心性）给元素排序，
用 `detectLabelCollision` 逐个检查 label 的 `getRenderBounds()` 是否与已显示的包围盒相交 / 是否在视口内，
相交就把标签**隐藏**（`setVisibility`）。它**不折行、不缩字号、不加省略号**。

那 `fitNodeText`（`lib/workflow-node-box.ts`：按像素估宽 → 缩字号 → 截断加省略号）能换成什么？

| `fitNodeText` 的三步 | G6 有没有对应物 |
| --- | --- |
| ① 按像素估宽（`charWidth` / `textWidth`，汉字 1.02、西文 0.56 的保守系数） | **没有**。要么保留自算（可以继续用 `lib/workflow-node-box.ts`），要么改用 G 的 `Text.getComputedTextLength()` 实测（更准，但要拿到图形实例） |
| ② 缩字号（`while (size > minSize && textWidth > maxWidth) size -= 0.5`） | **没有**。G6 不会为了塞进框而缩字号 |
| ③ 截断加省略号 | **有**：`labelTextOverflow: '...'` + `labelMaxLines`（`elements/shapes/label.ts` 的 `Label.defaultStyleProps`） |

**结论**：换原生节点后，`fitNodeText` 的 ② 仍然要自己算；③ 可以交给 G6；① 可以保留或改成实测。
也就是说 **`lib/workflow-node-box.ts` 不会消失**（最多瘦身成「量文本 → 挑字号」）。

## 五、主题

### 5.1 G6 内置主题是怎么组织的

- `themes/base.ts` 的 `create(tokens)`：给一组 token（`bgColor` / `textColor` / `nodeColor` / `nodeStroke` / `edgeColor` …），
  产出完整的 `Theme` 对象 —— **`node.style`（含 `fill` / `stroke` / `size` / `labelFill` / `labelFontSize` / `iconFill` / `portFill` / `portStroke` / `badge*` 等）、
  `node.state`（`selected` / `active` / `highlight` / `inactive` / `disabled`）、`node.animation`、`node.palette`**，edge / combo 同理。
- `themes/light.ts` / `dark.ts`：只是两份 token 表。
- `utils/theme.ts` 的 `themeOf(options)`：按 `GraphOptions.theme` 去注册表取主题对象。
- 节点最终样式 = 主题样式 ⊕ 数据样式 ⊕ state 样式（`runtime/element.ts` 的 `computeStyle`：`themeStyle` / `paletteStyle` / `dataStyle` / `defaultStyle` / `themeStateStyle` / `stateStyle` 按优先级合并）。

### 5.2 换成原生节点后，`lib/g6-theme.ts` 这套桥够不够用

**够用，但会从「够用」变成「吃重」**：

- 桥现在做的是「读 CSS 变量 → 产出 G6 样式对象」（`g6-theme.ts` 的 `tok` / `tokSolid` / `tokNum` / `g6Theme` / `subscribeG6Theme`），
  且已经处理了 **canvas 不认 `color-mix()`** 这个坑（`tokSolid` 会退回兜底 token 并 warn 一次）。
- 现状下节点外观**根本不走桥** —— 它是 innerHTML + CSS 类，颜色由 `workflow.css` / `graph.css` 里的
  `var(--bg-layer)` / `color-mix(in srgb, var(--accent-warm) 14%, var(--bg-layer))` 直接生效，**换主题天然跟随**。
- 换成原生节点后，这些值**每一条都要在桥里映射一遍**，`color-mix()` 还得先在 TS 里算成具体色值
  （`lib/g6-workflow-edge.ts` 里已经有一个现成的 `mix(a, pa, b)` 可复用）。
- 好处也有：`graph.setOptions({ node: { style: next } })` 的增量更新已经跑通（`WorkflowCanvasG6` 的 `subscribeG6Theme` 回调），
  换主题时**不必重建图**，也不用重写 innerHTML。

> 换句话说：**主题这条线是「净损失」**（多了映射工作），只是不至于做不了。

## 六、交互差异

| 维度 | HTML 节点（现状） | 原生节点 |
| --- | --- | --- |
| 命中检测 | 浏览器 DOM 命中 + G6 的 `node:click`（两者要人为对齐，**端口在盒外点不到**，这是本仓库改「点选式连线」的直接原因） | G6/@antv/g 的图形命中（形状样式里的 `pointerEvents` 可开可关 —— `elements/nodes/html.ts` 的 `defaultStyleProps` 就在用它；G 还提供 `increasedLineWidthForHitTesting`，本仓库只在边的主题样式里用过，见 `themes/base.ts` 的 edge 样式）；**端口在盒外照样能命中** |
| 事件的 target | 节点被识别为 node（`targetType: 'node'`） | 同上，但多了可用的 `e.originalTarget`（§3.4） |
| 右键菜单 | 已用 `contextmenu` 插件 + `e.targetType === 'node'`（本仓库实测可用，条件节点菜单两项） | 不变（同一套事件），可继续用 |
| 拖拽 | `drag-element`（`enable` 看 `targetType`） | 不变；但「在端口上按下」会不会被当成拖节点，需要实测 |
| 双击 | `node:dblclick`（`forwardCanvasEvents` 里 `detail === 2` 时补发） | 不变 |
| 事件转发成本 | `elements/nodes/html.ts` 的 `connectedCallback` 给**每个** HTML 节点挂 6 个原生监听（`this.events`：click / pointerdown / pointermove / pointerup / pointerover / pointerleave），`destroy()` 再摘掉 | 无这类转发 |
| G6 自己怎么识别 HTML 节点 | `behaviors/brush-select.ts` 的 `getCursorPoint` 注释写得很直白：「**没有直接判断的方式**，`nativeEvent.target` 非 canvas 则表示 html 节点触发的」 | —— |
| 文本可选中 | 可以（除非 CSS `user-select: none`） | 不可选 |
| 导出图片 | 不包含 | 包含（`graph.toDataURL`） |

## 七、实测（由 Lead 追加）

> **环境与做法**：真实 dev 应用（`dev-app.cmd`，CDP 9222）+ `Emulation.setFocusEmulationEnabled(true)`；
> 在页面里动态 `import` 已经加载过的 `@antv/g6`，建**临时图**（贴在视口角落，测完即 `destroy` + 移除），
> **不改产品代码**。下面每个数字都是这台机器上的实测值，不是估算。

### 7.1 端口命中：`e.originalTarget` + `getPorts()` **可用**（回答了 §3.4 的 ⚠️）

建 4 个内置节点（`rect` / `diamond` / `circle` / `html`），每个配 `ports: [{key:'in',placement:'left'},{key:'out',placement:'right'}]`，
用 CDP 的 `Input.dispatchMouseEvent` 在**真实坐标**上点，再读 `node:click` 事件：

| 点击位置 | `e.originalTarget` 的构造 | `getPorts()` 反查 | 结论 |
| --- | --- | --- | --- |
| 右端口圆 | `Circle` | `'out'` | ✅ 能精确区分 |
| 节点本体（那次压在 icon 上） | `Image` | `null` | ✅ 退化为「点节点」 |
| 左端口圆 | `Circle` | `'in'` | ✅ |
| 菱形右尖角端口 | `Circle` | `'out'` | ✅ |

判定写法就是 §3.4 那段：`Object.entries(node.getPorts())` 与 `e.originalTarget` 做**对象身份比较**即可 ——
实测不需要 className、也不需要坐标换算。节点 shapeMap 的键实测是
`['key','icon','label','port-in','port-out']`，端口就是 `port-<key>`。

**这条能把工作流现在最脏的一处替代掉**：`portOf()` 里「遍历 `originalEvent.target.closest('.wf-port')`、
拿不到再 `document.elementFromPoint` 按坐标反查、最后靠中文字面量 `text.includes('不满足')` 判断槽位」那一整段。

### 7.2 端口旁的文字：**badge 就够，不必自定义 `drawPortShapes`**（补正 §3.5）

§3.5 判断「badge 相对 keyShape 固定定位，两个桩挂两块文字会打架」。实测**不打架** —— 因为工作流的两个桩本来就在
**左右两个中点**（`placement: [0,0.5]` / `[1,0.5]`），正好是 badge 的 `left` / `right` 位置：

```ts
ports: [
  { key: 'true',  placement: 'right', r: 5, fill: '#fff', stroke: '<success>', lineWidth: 1.2 },
  { key: 'false', placement: 'left',  r: 5, fill: '#fff', stroke: '<danger>',  lineWidth: 1.2 },
],
badges: [
  { text: '满足',   placement: 'right', offsetX: 14,  fontSize: 9, fill: '<success>', backgroundFill: 'transparent', padding: 0 },
  { text: '不满足', placement: 'left',  offsetX: -14, fontSize: 9, fill: '<danger>',  backgroundFill: 'transparent', padding: 0 },
]
```

实测渲染结果：矩形节点左右各一个圆点，圆点外侧就是「不满足」「满足」两行小字 —— 与现在 `.wf-port__label` 的观感一致
（普通步骤的单个「跳到」口同理，用一条 badge 即可）。

### 7.3 label 排版：能对齐、能折行截断，但**配错了会溢出 46px**

一条真实踩到的坑：`labelTextAlign: 'left'` 配默认 placement（`center`）时，文本锚点仍在**盒子中心**、
文字向右延伸 —— 实测五个节点的 label 溢出量分别是 **46 / 43 / 10 / 22 / 21 px**
（`label.getLocalBounds()` 与 `key.getLocalBounds()` 相减），画出来就是「文字压在边框上、端口盖住文字」。

正确配置（实测溢出 0）：

```ts
labelPlacement: 'center',
labelTextAlign: 'left',
labelOffsetX: -(NODE_W / 2) + 10,   // 把锚点挪到盒左边界 + 10px
labelOffsetY: -2,
labelWordWrap: true, labelWordWrapWidth: NODE_W - 18, labelMaxLines: 2,
```

**能力边界**（与 §4.4 一致）：折行 / 最多 N 行 / 省略号都能用；**缩字号没有** —— 长标题现在的观感是
「缩到 9px 也不截断」，换过去会变成「12px 折两行 + 省略号」。这是**观感变化**，不是等价替换。

### 7.4 251 个节点：原生图形**更慢**，性能不是换的理由

同一页面、同一时刻、交替各跑 3 轮（251 节点 + 250 边，`await graph.render()` 计时）：

| 轮次 | HTML 节点 | `rect` 原生节点 |
| --- | ---: | ---: |
| 1 | 1044 ms | 2508 ms |
| 2 | 1367 ms | 2053 ms |
| 3 | 1322 ms | 1989 ms |
| 容器内 DOM 元素 | **2014** | **4** |

选中态更新（`updateNodeData` + `draw()`，同样交替实测）：

| 操作 | HTML 节点 | 原生节点 |
| --- | ---: | ---: |
| 改 1 个节点的选中态 | 1013 ms | 1040 ms |
| 改全部 251 个 | 1218 ms | 1414 ms |

**结论**：换原生能换来「DOM 从 2014 降到 4」，但**首次渲染慢 1.5–2 倍**，逐节点更新两者相当。
所以「为了性能换节点」在这台机器上**没有证据支持** —— 与 §10.2 第 6 条一致。
（口径说明：这是**冷启动首帧**，含字体测量与图形对象创建；HTML 节点测的是**真实形态**
——内联 SVG + 两行文字 + 端口圆，不是简化 div。）

### 7.5 图谱图标：`iconSrc` 会把多色图标**变成黑块**（这条路不通）

图谱图标（`GraphNodeIcon` → `svg.gnode` 里的 `g.gnode__icon`）的 `<path>` **没有 `fill` / `stroke` 属性**：

| 元素 | 类 | 属性上的颜色 | 实际颜色来源 |
| --- | --- | --- | --- |
| `path` | `gn-stroke gn-s1` | `fill=null, stroke=null` | `graph.css` 的类规则 + `--gnode-c`（内联在 `<g>` 上） |
| `path` | `gn-s2` | 同上 | 同上 |
| `path` | `gn-lines gn-s3` | 同上 | 同上 |

把它包成独立 SVG 再编码成 data URL 喂给 `iconSrc`，实测结果是**浏览器能解码（36×36）、图也画出来了，但整个图标是纯黑**
—— 因为 data URL 里的 SVG 拿不到页面的 CSS。

**所以「图谱换原生」要么把三档配色搬进 TS 用 G 的 `Path` 重画，要么接受黑图标。**
「沿用现有 SVG 资产」这条捷径**实测不通**。（把计算样式内联进 SVG 再转 data URL 是可行的第三条路，
但要自己写「CSS 内联化」并且主题切换时全部重算 —— 成本不比重画低。）

### 7.6 端到端脚本的安全网**已经破了一部分**（对 §9.1 的补正）

按「节点外观」类名精确统计（`scripts/` 全目录）：`wf-node__` **13 处 / 4 个脚本**、
`wf-port` **4 处 / 2 个脚本**、`gnode__` **1 处 / 1 个脚本**，合计 **18 处 / 5 个脚本**
（§9.1 的「41 处 / 9 个脚本」是更宽的口径，把画布容器、工具栏按钮一类也算进去了）。

更要紧的是：把脚本里的选择器拿到**现网 DOM** 上核对，有几个**在 G6 迁移时就已失效**：

| 脚本里的选择器 | 现网命中数 | 说明 |
| --- | ---: | --- |
| `g.wf-node` | **0** | 手写 SVG 时代的 `<g class="wf-node">` 已不存在 |
| `.wf-port--true` / `.wf-port--false` / `.wf-port--jump` | **0** | 端口改成 `.wf-port` + 文字后就没有这些修饰类 |
| `g.wf-node .wf-node__diamond` | **0** | 同上 |
| `.wf-node--template.wf-node--on strong` | 1 | 命中的是**左侧模板列表卡片**，不是画布节点 |
| `.wf-node__cond text` | 1 | 仍有效（条件胶囊还是 SVG `<text>`） |
| `.wf-port__label` | 6 | 仍有效 |
| `.gnode` | 251 | 仍有效（图谱节点 HTML 里保留了 `gnode` 类） |

也就是说：**换节点之前，这几个脚本本来就该修一遍**（它们断言的是已经不存在的东西）。
这**削弱了**「换节点会先拆掉安全网」这条反对理由的分量 —— 网早就破了一个洞，只是没人跑。

### 7.7 还没测的（要动手前先补）

1. **在端口上按下会不会被 `drag-element` 当成拖节点** —— `behaviors/drag-element.ts` 的 `enable` 只看 `targetType`，
   不看命中的是哪个图形；这决定端口点击会不会顺带拖动节点。
2. **`create-edge` 从端口拖拽连线**（§10.1 说的「第一步收益」）：能不能只从端口起线、
   `graphConnectionAllowed` 的破环规则怎么接进去。
3. **大图交互的帧率与内存**：本轮只量了首帧与逐节点更新，没量平移/缩放时的持续帧率。

## 八、性能与体积

**源码层面能确认的**（不是推断）：

- 每个 HTML 节点是一个真实 DOM 子树，且 G6 为它挂 **6 个原生事件监听**
  （`elements/nodes/html.ts` 的 `connectedCallback` / `events`）；251 个图谱节点 ≈ **1500 个监听器** + 251 棵子树。
- 本仓库实测：图谱页 `div.key`（HTML 节点的容器）**251 个**，每个内含一个 SVG 图标
  （`GraphCanvasG6` 用 `renderToStaticMarkup` 渲染 `GraphNodeIcon`）。这是 §7 之外的既成事实。
- 原生节点是 canvas 图形：**没有 DOM、没有逐节点事件绑定**；代价是它们在**同一条渲染管线**里，
  数量大时要靠 G6 的按需渲染 / 视口裁剪。
- 体积：G6 已经把两种节点实现都打进了包里（`esm` 里 `elements/nodes/*` 全在），
  **换节点类型不会显著改变产物体积** —— 变的是运行时开销，不是包大小。

**官方文档层面**：查不到（本机访问不了），所以本文不给任何「官方说 HTML 节点慢 X%」之类的数字。

## 九、成本与风险

### 9.1 要改的文件（按页面分）

| 文件 | 换原生节点后 |
| --- | --- |
| `components/WorkflowCanvasG6.tsx` | `nodeSvg()` 整段删掉，改成注册自定义节点（或内置 `rect`/`diamond` + 三个自绘 `GText`）；`portOf()` 的 DOM 命中逻辑删掉，改成 `e.originalTarget`（§3.4）；选中态从「重写 innerHTML」改成 state 或重绘 |
| `components/GraphCanvasG6.tsx` | 同样删掉 `innerHTML` 那条路径（现在是 `renderToStaticMarkup(<GraphNodeIcon/>)`） |
| `components/GraphNodeIcon.tsx` | **118 行 React + 23 条 CSS 规则**（`graph.css` 的 `.gnode__icon` 家族）驱动的多色分层图标，要改写成 G 图形（`Path` / `Polygon` + 三档颜色），且三档颜色不能再由 CSS 派生 |
| `lib/workflow-anchors.ts` | `nodePort` / `branchAnchors` 的几何可与 `ports` 的 `placement` 合并或删除 |
| `lib/g6-workflow-edge.ts` | 自定义边可以改用 `sourcePort` / `targetPort`（`BaseEdgeStyleProps`），锚点计算可大幅简化 |
| `lib/g6-theme.ts` | 新增节点样式映射（现在只管边与背景） |
| `lib/g6-adapt.ts` | 数据适配要把 `kind` / `view` 映射成 `style` / `state` / `ports` |
| `lib/workflow-node-box.ts` | `fitNodeText` 的「缩字号」仍要保留（§4.4） |
| `styles/workflow.css` / `styles/graph.css` | **画布节点那一大段样式作废**（`.wf-node__box` / `.wf-node__diamond` / `.wf-node__idx` / `.wf-node__title` / `.wf-node__cond` / `.wf-port` / `.gnode__*`），值要搬进主题桥 |
| **9 个端到端脚本** | `scripts/` 下 **41 处**画布 DOM 引用全部失效：`interactioncheck.mjs`（16）、`wfbranchcheck.mjs`（8）、`layoutfitcheck.mjs`（4）、`wflinkcheck.mjs`（4）、`graphfocus.mjs`（3）、`wfgroupcheck.mjs`（3）、`capture.mjs`、`graphcheck.mjs`、`layoutcheck.mjs`（各 1）。**这是最容易被低估的一项** |

### 9.2 会回退 / 会丢的东西

1. **CSS 变量驱动的主题**：节点的每一处颜色从「改一个变量就全变」变成「桥里逐个映射」。
2. **`color-mix()` 的观感**：现在 `.wf-node__diamond` 的填充是
   `color-mix(in srgb, var(--accent-warm) 14%, var(--bg-layer))`；换 canvas 后必须在 TS 里算好
   （否则静默退回纯色 —— 本仓库已踩过 canvas 不认 `color-mix` 的坑）。
3. **CSS 过渡**：`.wf-node__box` / `.wf-node__diamond` 的 `transition: stroke, stroke-width`、
   `.wf-node__body` 的 `transform: scale(1.03)` 抬升，都要改写成 G6 动画（或直接丢掉）。
4. **`:hover`**：现在悬停/选中是 CSS 伪类；canvas 上要靠 `hover-activate` 这类 behavior + state。
5. **多行文本的排版**：现在三行文字由我们完全控制（`<text>` 的 x/y/font-size）；换原生后要么自绘三个 `GText`，
   要么接受 badge 的固定 placement。
6. **图标**：多色分层 SVG → G 图形，渐变/描边/内层混色都要重算。
7. **脚本与截图**：9 个脚本重写；`capture.mjs` 之类依赖 DOM 的截图断言也要跟着改。
8. **HTML 节点的「额外好处」**：文本可选中、可以用 CSS 调试（DevTools 直接改样式看效果）—— 这些都会没有。

## 十、建议

### 10.1 建议路径

1. **默认不动**。除非确定要做下面某件事，否则这次重构的收益抵不上成本。
2. **只有两个理由值得换**：
   - **要恢复「从端口拖拽连线」**（`create-edge` behavior）—— HTML 节点的端口在盒外点不到，
     这是本仓库当初把连线改成「点选式」的直接原因；换成原生节点后这条限制消失。
   - **要端口级交互**（点端口高亮、端口热区、端口级右键）—— 现在靠 `closest('.wf-port')` 从原生 DOM 事件里猜，
     原生 ports + `e.originalTarget` 更直接。
3. **先换工作流**（节点少、收益明确），**图谱建议不换**。图谱节点数虽多，但
   ① 251 个 DOM 子树目前渲染正常；② 图标重画成本高且会丢掉「颜色由 CSS 派生」这条链路。
4. 真要做时，**分两步落地**：
   - 第一步：工作流节点换成**自定义节点**（保留现有外观：圆角矩形/菱形 + 角标 + 标题 + 判据 + 端口文字），
     主题桥补齐节点样式，跑通「外观不变、交互更原生」；
   - 第二步：接上 `ports` + `sourcePort`，把连线从「点选式」改回「拖拽式」，并删掉 `portOf()` 那段 DOM 命中 hack。
5. **先做验证性冒烟**（不要先写几百行）：一个 5 节点的小图，用自定义节点 + 2 个端口 + 一段文字标签，
   确认 `e.originalTarget` 稳定、端口拖拽可用、主题切换生效 —— 再决定要不要推全量。
   **这个冒烟已经做掉一半**（见 §7）：端口区分、badge 当端口文字、label 排版、251 节点的开销都实测过了；
   只剩「端口按下会不会拖节点」「`create-edge` 端口拖拽连线」与「主题切换后的观感」三项。

### 10.2 反对理由（同样要认真读）

1. **这是一次「把 CSS 的活搬进 TS」的重构**：节点的颜色、状态、过渡现在全部由样式表与 CSS 变量表达，
   换原生节点后它们变成主题桥里的一堆字面量映射，**维护面变大、主题包演进时更容易漏**。
2. **`color-mix()` 与 CSS 过渡的损失是实打实的**：本仓库刚踩过「canvas 不认 `color-mix`、静默变白」的坑，
   换过去等于把这个坑的暴露面从「边」扩大到「所有节点」。
3. **多行文本 + 端口文字意味着「必须写自定义节点」**：内置节点只有 1 个 label、端口只有圆，
   工作流的节点外观**一个都套不上**。所以成本不是「换个 type」，而是「自己重写一遍 `nodeSvg` 的等价物」——
   只不过这次画在 canvas 上、不能用 CSS。
4. **收益是可选的**：拖拽连线与端口级交互**不是当前的需求**（迁移文档里「拖拽式连线判定不值得做」是当时的结论）。
   如果需求没变，换了只是把已知能用的东西换成需要重新验证的东西。
5. **验证体系会被打断**：9 个端到端脚本（41 处 DOM 引用）是这套迁移目前的「安全网」，
   换节点等于**先把安全网拆了**，再重建一套基于 G6 内部 API 的断言 —— 这段时间里回归风险最高。
6. **图谱那条链路尤其不划算**：251 个节点换来的是「少 251 棵 DOM 子树」，代价是重画 6 类多色分层图标
   并放弃「颜色由 CSS 变量派生」。除非实测证明 DOM 造成了卡顿（目前没有这样的证据），否则不值得。
   > **第二轮修正（§11.3）**：前半句不成立 —— 图标的 `d` 可以直接复用，不用重画；
   > 「颜色由 CSS 派生 → 改由 TS 算」这条仍然成立，但配色规则本来就在 `lib/graph-colors.ts` 里。

---

## 十一、第二轮：按官方文档的「图形 Shape / 自定义节点」重新评估

### 11.0 官方文档是怎么拿到的（方法本身值得留档）

`web_fetch` 对这个域名**仍然失败**（工具层检查：`g6.antv.antgroup.com` 被本机 DNS 解析到 `198.18.0.8` /
`2001:2::29`，不是公网地址）。但**本机有代理**（那正是 fake-ip），所以：

```powershell
Invoke-WebRequest -Uri 'https://g6.antv.antgroup.com/manual/introduction' -UseBasicParsing
```

**能拿到 200**；Node 里的 `fetch()` 同样可以。拿到 HTML 后从 `<div class="markdown">` 处切出正文即可
（文档站是 SSR，正文在 HTML 里，不用等前端渲染）。

本轮读的四页（用户给的入口是 `/manual/introduction`）：

| 页面 | 内容 |
| --- | --- |
| `/manual/element/shape/overview` | 图形 Shape 与 KeyShape |
| `/manual/element/shape/properties` | 原子 Shape 清单与属性 |
| `/manual/element/shape/label-shape` | **复合 Shape 的设计与实现**（自定义 Shape 的完整示例） |
| `/manual/element/node/custom-node` | 自定义节点（三种示例：图标卡片 / 可点击按钮 / 状态变色） |

### 11.1 官方文档给出的机制（与源码逐条对得上）

| 文档说 | 源码/实测对应 |
| --- | --- |
| 元素由多个 Shape 组成，keyShape 唯一，负责交互拾取与包围盒 | `BaseNode.render()` 的固定顺序：key → halo → icon → badge → label → port |
| 自定义节点 = **继承内置节点 + 重写 `render` + `this.upsert()`** | `elements/shapes/base-shape.ts` 的 `upsert`：有则更新 / 无则创建 / 传 `false` 则删除 |
| 自定义 Shape = 继承 `BaseShape`（`@antv/g` 的 `CustomElement`），只实现 `render` | `BaseShape` 与 `ExtensionCategory.SHAPE` 都在包导出里（实测 `typeof G6.BaseShape` 存在） |
| 注册：`register(ExtensionCategory.NODE / SHAPE, name, Ctor)` | `registry/register.ts`；第三参**必须是类** |
| 样式**前缀分离**（`Prefix<'background', RectStyleProps>`），用 `subStyleProps` 取 | `utils/prefix.ts` 的 `subStyleProps` / `subObject` |
| 状态：`node.state.selected` + `graph.setElementState()` | 与源码一致（正好替代现在的 `--on` 修饰类） |
| 子图形可以自己绑事件 + `stopPropagation` | `upsert` 返回图形实例，示例里给按钮绑了 `click` |
| 原子 Shape 共 10 种：Circle / Ellipse / Rect / **HTML** / Image / Line / **Path** / Polygon / Polyline / Text | 与 §二/§四 读到的源码一致 |

### 11.2 实测：工作流节点用「继承 + upsert」复刻（可行）

按文档的写法（继承内置节点、重写 `render`、用 `upsert` 加子图形），在临时图里复刻了工作流的两种节点。
骨架（实测跑通）：

```ts
class WfStep extends Rect {
  render(attributes = this.parsedAttributes, container = this) {
    super.render(attributes, container)          // 圆角矩形 + 端口（ports 由 BaseNode 画）
    this.upsert('idx', 'text', { x: -65, y: -14, text: attributes.idxText, fontSize: 9, fill: '#64748b', textAlign: 'left', textBaseline: 'middle' }, container)
    this.upsert('title', 'text', { x: -65, y: 6, text: attributes.titleText, fontSize: 12, fill: '#0f172a',
      textAlign: 'left', textBaseline: 'middle', wordWrap: true, wordWrapWidth: 130, maxLines: 1, textOverflow: '...' }, container)
    this.upsert('portText', 'text', { x: 88, y: 0, text: attributes.portLabel, fontSize: 9, fill: '#16a34a', textAlign: 'left', textBaseline: 'middle' }, container)
  }
}
class WfCond extends Diamond { /* 菱形 + 判据胶囊（rect + text） */ }
register(ExtensionCategory.NODE, 'wf-step', WfStep)
register(ExtensionCategory.NODE, 'wf-cond', WfCond)
```

实测效果（导出画布位图看的）：圆角矩形 + 小字角标 + 左对齐标题（超宽自动省略号）、
橙色菱形 + 「条件」+ 判据文字 + 下方橙色胶囊、左右端口 + 端口旁绿字「跳到」、
`sourcePort: 'true'` 的虚线边从菱形右尖角出发 —— **与现有 HTML 节点的观感一致**。

要点：
- 长标题的省略号**由 G6 直接给**（`wordWrap` + `maxLines` + `textOverflow`），不用自己截断；
- **缩字号仍要自己算**（§4.4 的结论不变）—— `fitNodeText` 保留；
- 端口文字用**自绘 `text`**（跟着端口走），不必重写 `drawPortShapes`（§7.2 说的 badge 方案也可行，二者都比 §3.5 估计的轻）；
- 一个节点类约 20 行，两个类 ≈ 50 行 —— 不是「重写一遍 `nodeSvg`」，是「把模板里的几行搬成 upsert」。

### 11.3 实测：图谱多色图标**可以直接复用现有 SVG 的 `d`**（推翻第一轮判断）

第一轮的结论是「图谱图标要靠 CSS 着色，换 canvas 只能重画」。**那只证明了 `iconSrc` + data URL 走不通**
（§7.5：CSS 不生效 → 纯黑），**不等于资产不能复用**。

第二轮实测：把 `.gnode__icon` 里每个 `<path>` 的 `d` 取出来，逐个 `upsert`：

```ts
class GnIconNode extends Circle {
  render(attributes = this.parsedAttributes, container = this) {
    super.render(attributes, container)
    ;(attributes.iconShapes || []).forEach((s, i) => {
      this.upsert('ic-' + i, 'path', { d: s.d, fill: s.fill, stroke: s.stroke, lineWidth: s.lineWidth, lineCap: s.lineCap, lineJoin: s.lineJoin }, container)
    })
  }
}
```

**结果：完全还原** —— 浅色「笔记」图标（主体 + 折角 + 横线三色）与彩色节点图标都试了，多色分层正确。

⚠️ **一个必须记住的属性名坑**（实测三种写法）：

| `upsert(..., 'path', …)` 的样式 | `getLocalBounds()` | 结论 |
| --- | --- | --- |
| `{ path: 'M0,0 L30,0 L30,30 Z' }` | `[0,0,0,0]` | ❌ 不解析 |
| `{ path: [['M',0,0],['L',30,0],['L',30,30],['Z']] }` | `[0,0,0,0]` | ❌ 不解析 |
| `{ d: 'M0,0 L30,0 L30,30 Z' }` | `[0,0,30,30]` | ✅ |

—— G6 注册出来的 `path` shape 吃的是 **`d`**，不是直接 `new` `@antv/g` 的 `Path` 时的 `path`。
（`@antv/g` 另导出了 `parsePath`，需要 PathArray 时可用。）

⚠️ **颜色仍要自己算**：`getComputedStyle()` 给出的是 `color(srgb 0.679 0.710 0.755 / 0.808)` 这种新语法，
**canvas / G 都不认**，要转成 `rgb()/rgba()`（实测转换后才正常上色）。也就是说图标的**几何可以直接复用、
颜色必须走 TS**（而颜色规则本来就在 `lib/graph-colors.ts` 里）——这比「重画 6 类图标」轻得多。

### 11.4 成本重估（第一轮 vs 第二轮实测）

| 项 | 第一轮估计 | 第二轮实测后 |
| --- | --- | --- |
| 工作流节点外观 | 「必须重写 `nodeSvg` 的等价物」 | 继承 `Rect`/`Diamond` + 3~5 次 `upsert`，**约 50 行** |
| 图谱 6 类图标 | 「要重画」 | **`d` 直接复用**；只需把 JSX 里的 path 抽成数据 + 颜色改由 TS 算 |
| 端口文字 | 「必须自定义 `drawPortShapes`」 | 自绘 `text` 或 badge 都行（§7.2、§11.2） |
| 端口命中 | 靠 `e.originalTarget` | 不变（§7.1 已实测可行） |
| 主题 | 每个色值都要过桥 | **不变**（这条仍然是真成本） |
| `fitNodeText` 缩字号 | 要保留 | **不变**（G6 不会为塞进框而缩字号） |
| CSS 过渡 / `:hover` | 要改 state | 不变 |
| 端到端脚本 | 「安全网会断」 | 部分**已经断了**（§7.6），本来就要修 |

### 11.5 修正后的结论

| 问题 | 第一轮 | **第二轮（修正）** |
| --- | --- | --- |
| 值不值得换 | 不值得整体换 | **仍然不是"顺手就换"，但已从"不划算"变成"成本可控、按需换"** —— 阻滞项从「要重画资产」变成了「主题映射与交互改写」 |
| 图谱能不能换 | 不建议（图标要重画） | **可以换**：图标几何复用 `d`，颜色走已有的 `graph-colors`；保留 HTML 的收益（CSS 直接调试、文本可选中）仍是反对理由 |
| 先换哪个 | 先工作流 | 不变：**先工作流**（节点少、收益明确、范式先跑通），图谱可作为第二步 |

**决定性的判据还是需求**：换过去真正换来的是「端口级交互 / 拖拽连线 / 原生 state」。
如果只是「不想用 HTML 节点」，那不值得 —— 主题映射与 CSS 过渡的损失是实打实的。

### 11.6 第二轮仍没做的

1. 端口上按下会不会触发 `drag-element` 拖节点（§7.7 第 1 条）。
2. `create-edge` 从端口拖拽连线、与 `graphConnectionAllowed` 的接法。
3. 自定义 `Shape`（`register(ExtensionCategory.SHAPE, …)`）封装的实战收益 —— 本轮只验证了「自定义节点 + upsert」，
   没验证把「角标+标题」封成一个可复用 Shape 是否更划算。
