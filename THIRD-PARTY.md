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
