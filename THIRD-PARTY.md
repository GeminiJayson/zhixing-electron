# 第三方组件

本仓库包含下列第三方组件。使用与分发时请遵守各自的许可 —— 本项目自有代码不受其约束。

## Emotion Ball（表情引擎）

| 项 | 内容 |
| --- | --- |
| 来源 | https://github.com/sam70361/aora-bot |
| 上游版本 | `e3b6148c818da4a8e1966f2bc89cdb3cee473b73`（2026-08-25） |
| 引入位置 | `src/renderer/src/vendor/emotion-ball/`（四个脚本**逐字拷贝**，未做修改） |
| 使用处 | `src/renderer/src/components/WidgetBall.tsx` —— 桌面浮窗贴边收缩后的悬浮球 |
| 许可 | Emotion Ball 社区许可：**非商业免费** + 可另行获取商业授权，原文见 `src/renderer/src/vendor/emotion-ball/LICENSE` |

### 使用限制（务必遵守）

1. **代码与表情数据**：非商业使用免费；商业用途须向上游取得商业授权。
2. **球形角色的视觉形象**（身体造型、配色方案、彩带等特效视觉及其整体形象）：**仅限个人技术学习与研究，禁止任何商业用途**，且上游明确表示永不提供该部分的商业授权。原文见 `src/renderer/src/vendor/emotion-ball/NOTICE.md`。

> 结论：本项目作为个人非商业使用符合社区许可。
> **若将来涉及商业分发，必须先移除该球形角色视觉形象，或取得上游商业授权。**
>
> 引入方式、文件清单与集成要点见 `src/renderer/src/vendor/emotion-ball/UPSTREAM.md`。

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
