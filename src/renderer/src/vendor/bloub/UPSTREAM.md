# bloub（上游第三方组件）

- **来源**：https://github.com/jeremy-prt/bloub
- **上游版本**：`b4bb3c1b5f93c7b87a2e8d620f667c4093d97749`（v0.1.1，2026-08-17）
- **引入日期**：本轮「浮窗悬浮球换形象」
- **引入方式**：`src/bot/` 下的 12 个 `.ts` **按原始文件逐字拷贝**（仅统一为 LF 行尾），
  `src/ui/gaze.ts` 只做一处机械替换：`@/bot/` → `./bot/`（本项目没有那个路径别名）。
  其余一个字符未动 —— 包括法语注释：上游明说**数值是量出来的测量值，不是可随手取整的配置**。
- **调用方**：`src/renderer/src/components/BloubAvatar.tsx`（React 渲染层）→
  `WidgetBall.tsx`（浮窗贴边收缩后的悬浮球）

## 为什么不是直接用它的 Vue 组件

上游是一个 Vue 3 站点，但 `src/bot/` 是**无框架、无时钟**的纯 TS 引擎：`engine.sample(t)`
是时间的纯函数（没有 `Date.now()`、没有 Vue import、不修改自身状态）。上游的 `BloubBot.vue`
也只是它的一个客户端，SVG 组装那几十行照抄成 React 即可；本项目不引入 Vue。

`src/ui/capture.ts`（导出用的离屏渲染）依赖 Vue，**未引入**；`mediabunny`（MP4 导出）同理。

## 文件清单

全部文件为 **LF 行尾**，SHA256 前 16 位由 `scripts/` 之外的本地脚本核对（下表即拷贝后的实测值）。
除 `gaze.ts` 的路径替换外，`bot/` 下每一个文件的字节都与上游一致。

| 文件 | SHA256 前 16 位 | 字节 | 作用 |
| --- | --- | --- | --- |
| `bot/engine.ts` | `D824C715B6EC38B2` | 22227 | `BotEngine`：状态机 + 弹簧插值 + `sample(t)` |
| `bot/states.ts` | `7B67BFC4EE950112` | 17031 | 15 个状态的姿势定义与关键帧 |
| `bot/eyefit.ts` | `8DA411D7643C24F3` | 18589 | 自定义形状下的眼部适配表 |
| `bot/shape.ts` | `72020197E3FF1174` | 10222 | 径向轮廓 → 路径 |
| `bot/cycles.ts` | `7567AAECF000FA8D` | 8924 | 蒙太奇（时间轴）编排 |
| `bot/decor.ts` | `6C300F8AAA7D2F95` | 8652 | 环轨 / 粒子 / 通知点 |
| `bot/face.ts` | `F9DDF7F750B101DB` | 5832 | 眨眼与视线姿态 |
| `bot/expressions.ts` | `66C5562AFCF376C7` | 5539 | 16 套静态表情 |
| `bot/skins.ts` | `2FA0F296E8A49B7B` | 4785 | 自定义器用的形状与 12 种颜色 |
| `bot/math.ts` | `736BE559B961109C` | 1566 | lerp / 缓动 / 钳位 |
| `bot/profiles.ts` | `62DC55BC860B9E2B` | 2077 | 从参考视频量出的轮廓（生成物） |
| `bot/repere.ts` | `2F74419387868A13` | 1317 | 坐标系：`RAYON` / `DEMI_VIEWBOX` |
| `gaze.ts` | `74EFD32113C310AF` | 6990 | 指针 → `Look` 的换算（`YAW_MAX` / `PITCH_MAX`） |
| `LICENSE` | — | 1093 | MIT 原文 |

> `bot/profiles.ts` 是上游用 `tools/extract-profiles.py` 从参考视频逐帧量出来的生成物，
> **不要手改**；上游的 `docs/measurements.md` 记了重新生成的办法。

## 许可证

**MIT**（完整原文见同目录 `LICENSE`，版权归 Jérémy Perret）。与本项目此前用的
emotion-ball 相比宽松得多：那个是「非商业免费 + 球形角色形象永不授予商业授权」，
而这里是标准 MIT，商用无碍。

上游 README 另有一句值得照抄的说明：**它不是 x.ai 的官方项目**，只是把那个 bot 的
视觉行为当作练习复刻出来；MIT 覆盖的是仓库里的代码，不是它所模仿的设计。

## 集成要点

- `new BotEngine(RAYON, state, shapeRadii, expression)`；`shapeRadii` / `expression` 传 `null`
  表示「不覆盖」，由状态自带的姿势决定。
- `sample(t)` 是纯函数：暂停、跳帧、回到某个时刻都得到同一张图，所以渲染层只负责
  「按时间取帧 → 画进 SVG」，不需要自己维护动画状态。
- 引擎**不监听 DOM**：鼠标注视要宿主把指针换算成 `Look`（`yaw` / `pitch` 是**绝对角度**，
  单位度）再 `setLook(...)`；不跟随时传 `null`，引擎自己保留漂移与眨眼。
- 眼睛是 `<mask>` 上的**洞**，不是盖在上面的白形状 —— 这正是它们会自己贴着轮廓裁切的原因。
- 往 `bot/` 里改数值前，先读上游 `docs/measurements.md` 与 `CLAUDE.md`：那里的常数是量出来的，
  取整就会失去相似度。
