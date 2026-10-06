/**
 * 工作流节点的**盒尺寸** —— 单一来源。
 *
 * 这些值原先分居两处：`WorkflowPage` 的 `NODE_W` / `NODE_H`，和
 * `workflow-layout.ts` 的 `LAYOUT_NODE_W` / `LAYOUT_NODE_H`，后者还带着一句注释
 * 「与 WorkflowPage 的 NODE_W / NODE_H 保持一致」。**靠注释维持一致就是迟早会不一致** ——
 * 换成 G6 之后画布、布局、页面三处都要用同一套尺寸，这里收成一份。
 *
 * 这里原来还有一套**自己算的文字排版**（`fitNodeText`：先缩字号、再按像素截断加省略号），
 * 那是给手写 SVG 的 `<text>` 用的 —— 它既不换行也不会缩小。现在标题交给 G6 的
 * `labelText`（`labelWordWrap` / `labelMaxLines` / `labelTextOverflow` 三件套），
 * 排版由 G6 负责，那套估算连同 `NODE_TEXT_W` / `COND_TEXT_W` 一并删了。
 */

/** 节点盒尺寸（普通步骤）。 */
export const NODE_W = 150
export const NODE_H = 56
