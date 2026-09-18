# 知行 ZhiXing · Electron 重构版

原 Python（PySide6）实现在仓库根目录保留不动，本目录是**并行**的 Electron 重构版。
两者共用同一份 SQLite 数据库，便于对照 UI 与逐步迁移，稳定后再决定旧实现的去留。

## 技术选型

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 壳 | Electron 33 | 无边框窗口 + macOS vibrancy 材质 |
| 构建 | electron-vite 2 + Vite 5 | main / preload / renderer 三端一次构建 |
| UI | React 18 + TypeScript | 样式为 CSS 变量，不使用 UI 框架 |
| 数据 | better-sqlite3 | **直接打开现有数据库**，schema v12 零迁移 |
| 图标 | lucide-react | 与设计规范「风格基准 Lucide/Feather」同源 |

## 数据库复用

路径与 `zhixing/model/infrastructure/db.py` 的 `data_dir()` 完全一致：

- macOS：`~/Library/Application Support/ZhiXing/zhixing.db`
- Windows：`%APPDATA%/ZhiXing/zhixing.db`
- Linux：`~/.zhixing/zhixing.db`

**当前以只读方式打开**（`readonly: true`）。重建期绝不允许写坏 Python 版正在使用的数据；
写入能力会在数据层完成后单独放开，并需同时考虑与 Python 版的并发。

## 设计系统

`src/renderer/src/styles/tokens.css` 是唯一的设计真源，语义与
`docs/03-UI-UX交互设计.md` §2.1–2.4 对齐：色彩语义 Token（浅/深两套）、
圆角 4/6/8/12/16、4px 间距节奏、字体栈、动效 7 档时长与缓动。
组件样式一律引用变量，禁止写死色值与圆角。

## 命令

```bash
npm install --ignore-scripts   # better-sqlite3 需针对 Electron ABI 重建，故跳过脚本
node node_modules/electron/install.js
npx electron-rebuild -f -w better-sqlite3
npm run build                  # 构建三端产物到 out/
node scripts/smoke.mjs         # 冒烟：真实启动 Electron，CDP 读取渲染结果
npm run dev                    # 开发模式（HMR）
```

> 本机 Node 26 无法直接编译 better-sqlite3，因此必须走
> `--ignore-scripts` + `electron-rebuild` 这条路径。

## 迁移进度

| 状态 | 范围 |
| --- | --- |
| ✅ 已完成 | 工程骨架、设计 Token、无边框窗口与自定义标题栏、8 项左侧导航（对齐 `main_window.py`）、今日页（概览四卡 + 今日待办真实数据） |
| ⏳ 待迁移 | 任务页、笔记页（Markdown + 双向链接）、图谱页、收件箱、工作流、回顾、设置；写入能力；桌面浮窗与全局捕获 |

导航与页面的对应关系见 `src/renderer/src/nav.ts`；未迁移页面渲染明确的
「尚未迁移」状态并指向原实现位置，不做假界面。
