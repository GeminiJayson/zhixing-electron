# Emotion Ball（上游第三方组件）

- **来源**：https://github.com/sam70361/aora-bot
- **上游版本**：`e3b6148c818da4a8e1966f2bc89cdb3cee473b73`（2026-08-25）
- **引入日期**：本轮浮窗悬浮球改造
- **引入方式**：`emotion-ball/js/` 下四个脚本**按原始文件逐字拷贝，未做任何修改**（便于日后与上游 diff / 同步）
- **调用方**：`src/renderer/src/components/WidgetBall.tsx`（浮窗贴边收缩后的悬浮球）

## 文件清单

全部文件为 **LF 行尾**，且其 git blob SHA1 已与上游逐一核对**完全一致**（下表 SHA1 前 12 位即上游 blob 值）——
即本目录与上游**字节相同**，不是「功能等价的重写」。

| 文件 | SHA1（= 上游 blob） | SHA256 前 16 位 | 作用 |
| --- | --- | --- | --- |
| `rings.js` | `f7159a71a42f` | `7FD196046650B827` | 眼环池：25 组轮廓 + 头部几何常量 → `window.EB_RINGS` |
| `emotions.js` | `d802cca6e118` | `C938EB9601BA4B37` | 32 套表情配置（纯数据）→ `window.EMOTION_GROUPS` / `window.EMOTION_SEED` |
| `ball.js` | `a69741b206d5` | `4D7928B66E19DA61` | SVG 渲染层 → `window.EmotionBall.createBall` |
| `engine.js` | `1f9d9d882580` | `6C48DEB09E097F50` | 状态机 / 弹簧插值 / 对外 SDK → `window.EmotionBall.create` |
| `LICENSE` | `ecd0128d4c65` | `CD25A8E1B00D05B2` | 社区许可原文 |
| `NOTICE.md` | `2761c6b69f9e` | `549D6607C9DD13C9` | 球形角色视觉形象使用声明 |

> 注意：克隆上游时若 `core.autocrlf=true`，工作区文件会变成 CRLF（字节数变大），
> 校验和以 LF 版本为准；本仓库 `.gitattributes` 用 `* text=auto eol=lf` 保证入库与检出都是 LF。

上游站点外壳（`app.js` / `i18n.js` / `css/style.css`）与 `hero-particles.js` 是展示站用的，**未引入**。

## 许可证（务必保留）

上游为**双重许可**：非商业免费 + 可另购商业授权。

- 代码与表情数据：非商业免费；商业用途需取得商业授权。
- **球形角色视觉形象**（身体造型 / 配色 / 彩带特效及整体形象）：**仅限个人技术学习与研究，禁止任何商业用途，且永不提供商业授权**。

原文见同目录 `LICENSE`（Emotion Ball 社区许可）与 `NOTICE.md`（使用声明）。本项目为个人非商业用途，符合社区许可；**若本项目将来涉商业分发，必须移除球形角色视觉形象或取得商业授权**。

## 集成要点（读上游 `.cursor/skills/emotion-integration/SKILL.md` 得到）

- 四个脚本**必须按 `rings → emotions → ball → engine` 顺序**加载，彼此通过 `window` 通信。
- `EmotionBall.create(el, opts)`：`el` 需有明确宽高；返回实例。
- 引擎**不监听 DOM**：鼠标注视要宿主换算归一化坐标后调 `setGaze(nx, ny)`。
- 缩略图/小尺寸建议：`lite: true`（关彩带彩纸）+ `eyeScale: 1.5~1.8`（本处 96px 球取 1.7）。
- `opts.idle` 会带来 60s 待机 / 180s 睡眠的自动节拍；本处**不使用**，由组件自己调度（否则两套节拍互相覆盖）。
- 未知 `emotionId` 会回退待机并抛 `error` 事件，不会白屏。
