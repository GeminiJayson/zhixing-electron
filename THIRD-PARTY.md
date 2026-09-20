# 第三方组件

本仓库包含下列第三方组件。使用与分发时请遵守各自的许可 —— 本项目自有代码不受其约束。

## bloub（浮窗悬浮球的形象引擎）

| 项 | 内容 |
| --- | --- |
| 来源 | https://github.com/jeremy-prt/bloub |
| 上游版本 | `b4bb3c1b5f93c7b87a2e8d620f667c4093d97749`（v0.1.1，2026-08-17） |
| 引入位置 | `src/renderer/src/vendor/bloub/` —— `src/bot/` 下十二个 `.ts` **逐字拷贝**（仅统一为 LF 行尾）；`src/ui/gaze.ts` 只把 `@/bot/` 换成相对路径 |
| 使用处 | `src/renderer/src/components/BloubAvatar.tsx`（React 渲染层）→ `WidgetBall.tsx` —— 桌面浮窗贴边收缩后的悬浮球 |
| 许可 | **MIT**，原文见 `src/renderer/src/vendor/bloub/LICENSE` |

MIT 无商用限制。上游 README 另有一句值得一并记住：**它不是 x.ai 的官方项目**，
只是把那个 bot 的视觉行为当作练习复刻；MIT 覆盖仓库里的代码，不包括它所模仿的设计。

> 引入方式、文件清单（含每个文件的 SHA）与集成要点见 `src/renderer/src/vendor/bloub/UPSTREAM.md`。

## morphicons（图标形变引擎）

| 项 | 内容 |
| --- | --- |
| 来源 | https://www.morphicons.com · https://github.com/guillermolg00/morphicons |
| 版本 | `morphicons@1.7.1`（npm 依赖，非 vendored） |
| 使用处 | `src/renderer/src/lib/icons.tsx` —— 应用全部图标的渲染与形变 |
| 许可 | **MIT** |

无商用限制；零运行时依赖；它的 `react` / `vue` / `svelte` / `react-native` peer 全部标记为
optional，因此安装它不会把其它框架拖进依赖树（已核对 `node_modules`）。

## dagre（有向图分层布局）

| 项 | 内容 |
| --- | --- |
| 来源 | https://github.com/dagrejs/dagre |
| 版本 | `@dagrejs/dagre@3.1.1`（npm 依赖） |
| 使用处 | `src/renderer/src/lib/workflow-layout.ts` —— 工作流画布的分层布局 |
| 许可 | **MIT** |

无商用限制；零额外运行时依赖（自带 TS 类型）。

## lucide（图标形状数据）

| 项 | 内容 |
| --- | --- |
| 来源 | https://lucide.dev · https://github.com/lucide-icons/lucide |
| 版本 | `lucide@0.468.0`（npm 依赖） |
| 使用处 | 仅作为**形状数据**来源，被 `lib/icons.tsx` 消费；渲染不经过它 |
| 许可 | **ISC** |

> 注意区分：`lucide` 是**数据包**（每个图标是 `[svg, attrs, children]`），`lucide-react` 是组件包。
> morphicons 只能消费前者，所以本项目的组件包 `lucide-react` 已退役并从依赖中移除。
