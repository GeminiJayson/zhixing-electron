# Windows 打包说明

在 Windows 机器上出包只需要**一条命令**（在 `electron/` 目录下执行）：

```bash
npm install && npm run dist:win
```

产物落在 `electron/dist/`：

| 文件 | 说明 |
| --- | --- |
| `Zhixing-<版本>-x64-setup.exe` | NSIS 安装包（可选安装目录、建桌面/开始菜单快捷方式） |
| `Zhixing-<版本>-x64-portable.exe` | 免安装单文件，双击即用 |

> 先 `npm install` 是因为 `better-sqlite3` 是原生模块，需要在目标平台按 Electron 的 ABI 重建。

macOS / Linux 上也能直接出同样的包：electron-builder 自带 wine 与 nsis，`better-sqlite3` 走预编译二进制，
不需要 VS Build Tools（已验证：macOS arm64 + Electron 33.4.11 出包成功）。

## 前置要求

1. **Node.js 20+**（本项目在 Node 26 上开发，20/22 均可）。
2. **Visual Studio Build Tools**，勾选「使用 C++ 的桌面开发」工作负载。

   这一步是为了编译 `better-sqlite3`。若这一步不满足，打包会停在
   `install-app-deps` / `node-gyp` 阶段并报找不到编译器。

   如果不想装 VS Build Tools，可以改用预编译二进制：
   `npx prebuild-install -r electron -t <Electron版本>`（在 `node_modules/better-sqlite3` 里执行），
   本项目 Electron 版本见 `package.json` 的 `devDependencies.electron`。

## 只想看目录结构（不打包安装器）

```bash
npm run dist:dir
```

产物在 `electron/dist/win-unpacked/`，可以直接双击 `知行 ZhiXing.exe` 试跑。
排查「装了却跑不起来」时先看这个目录，能省很多时间。

## 配置在哪

`electron-builder.yml`。几个关键点：

- `asarUnpack: **/node_modules/better-sqlite3/**`、`**/node_modules/@node-rs/**` —— 原生模块必须解包到 asar 之外，否则运行时加载失败；
- `productName` 是中文显示名，产物文件名用 ASCII 的 `artifactName`，避免跨平台路径问题；
- `nsis.language: '2052'` 固定简体中文安装向导。

## 跨平台出包：`@node-rs/jieba` 的平台 binding（踩过的坑）

中文分词 `@node-rs/jieba` 的各平台二进制放在它**自己的** `optionalDependencies` 里，而 npm 只安装
**当前平台**那一份。所以在 macOS 上 `npm run dist:win` 时，`jieba.win32-x64-msvc.node` 压根不在
`node_modules` 里，打出来的包同样没有 —— Windows 上启动即崩：

```
Error: Cannot find native binding. npm has a bug related to optional dependencies
```

现在 `npm run dist:win` / `dist:dir` 会先跑 `scripts/ensure-jieba-win-binding.mjs`：缺 binding 时按
`@node-rs/jieba` 自己声明的版本 `npm pack` 出 win32-x64 再解进 `node_modules/@node-rs/`（版本不写死）。

**不要绕过 npm script 直接调 `electron-builder`**，否则这一步会被跳过，出的就是坏包。

出包后确认 binding 进包了：

```bash
ls dist/win-unpacked/resources/app.asar.unpacked/node_modules/@node-rs/jieba-win32-x64-msvc/
# 应有 jieba.win32-x64-msvc.node（约 2.6 MB）
```

另外 `src/main/db/fts-query.ts` 做了兜底：原生模块加载失败只降级为逐字分词并写日志，
不再让主进程启动即崩。`npm run check:jieba` 验证这个兜底仍然有效（含「构建产物顶层不得出现
`@node-rs/jieba` 的 require」这条断言 —— 改回静态 `import` 会被 rollup 提到 bundle 最前面，try/catch 就白写了）。

## 数据位置

打包版与开发版**共用同一份数据库**：

- Windows：`%APPDATA%/ZhiXing/zhixing.db`
- macOS：`~/Library/Application Support/ZhiXing/zhixing.db`

也支持 `ZHIXING_HOME` 环境变量覆盖，便于便携使用或测试。

## postdist：出包后还原本机 ABI

`better-sqlite3` 是原生模块，开发环境的 ABI 与 electron-builder 打包时重建出来的不同。
``dist:win`` / ``dist:dir`` 结束时会自动跑 ``postdist:win`` / ``postdist:dir``（``npm run rebuild`` →
``electron-rebuild -f -w better-sqlite3``），把 `node_modules` 里的二进制还原成开发机 Electron 的 ABI。
否则下次 ``npm run dev`` 会以「数据库不可用 / 设置全部回退默认值」的形式失败。

npm 会自动执行 ``pre<script>`` / ``post<script>`` 钩子，所以不必手动跑 postdist。

## 尚未配置的部分

- **代码签名**：未配置证书，Windows 会弹 SmartScreen 提示「未知发布者」；
- **macOS 包**：仅配置了 Windows 目标，macOS 需要 `.icns` 与公证流程；
- **自动更新**：未接入 electron-updater。

## 出包后发布

发布走 **GitHub Releases**：

```bash
npm run release:dry     # 预演：打印计划，不做任何写操作
npm run release         # 构建 → 打包 → 源码归档 → 对齐标签 → 更新 GitHub Release → 校验
```

脚本是 `scripts/release.mjs`，带两条硬校验（都是踩过坑才加的）：

1. **开始时工作树必须干净** —— 拒绝带着未提交改动发版；
2. **结束时核对 Release 的 `targetCommitish` 与 `HEAD` 一致** ——
   上一版就是因为 tag 停在旧提交，Release 页面自动生成的源码归档是**旧代码**。

出包前先把 `package.json` 的 version 改掉（`npm version <x.y.z> --no-git-tag-version`）：
产物文件名带版本号，沿用旧版本号会让用户下到旧包。
## 受限 / 无交互会话里打 NSIS 包（两处补丁）

**普通桌面会话不需要看这一节** —— 直接 `npm run dist:win` 即可。

在自动化环境（没有交互桌面、进程受限）里打包时，**NSIS 目标**会连续以两种不同方式失败。
两次都表现为「打包中止」，但原因完全不同 —— **portable 目标两次都不受影响**，
所以现象看起来像「只有安装包打不出来」。

### 现象 ①：ERR_ELECTRON_BUILDER_CANNOT_EXECUTE，退出码 null

electron-builder 生成卸载程序时，要先编译一个中间安装器、再**执行它**得到 `uninstaller.exe`。

那次执行走 builder-util 的 `exec`（默认 `stdio: 'pipe'`），而受限会话**禁止带管道 stdio 的子进程**（EPERM）。

**注意报错里的 `Exit code: null`** —— 不是非零退出码，是**进程根本没起来**。
很容易误读成「安装器自己失败了」，从而去查安装器（我是这么绕了一大圈的）。

改法：让那次执行不捕获输出。文件 `node_modules/app-builder-lib/out/vm/WineVm.js`，
把 `process.platform === "win32"` 分支里的 `exec(target, appArgs, options)`
换成用 `spawn(target, appArgs, { stdio: 'inherit' })`。

### 现象 ②：弹出对话框 "Error writing temporary file. Make sure your temp folder is valid."

修好 ① 之后安装器真的跑起来了，但**弹出一个错误对话框**然后以退出码 2 中止。

NSIS 启动时要把插件解压到 `%TEMP%\$PLUGINSDIR`。**宿主 shell 里 %TEMP% 是可写的**
（可以直接建文件验证），但**子进程继承到的那个上下文不行** —— 所以只看 shell 会误判成"temp 没问题"。

改法：在上面那处 `spawn` 里显式指定 temp ——

```js
const tmpDir = path.join(process.cwd(), '.build-tmp')
fs.mkdirSync(tmpDir, { recursive: true })
spawn(target, appArgs, { stdio: 'inherit', env: { ...process.env, TEMP: tmpDir, TMP: tmpDir } })
```

`.build-tmp/` 已在 `.gitignore` 里。

### 顺带：中间安装器加 /S

`node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js` 里那次调用可以补上 `/S`
（静默），在无交互会话里更稳：`wineVm.exec(installerPath, ['/S'], { env: { __COMPAT_LAYER: 'RunAsInvoker' } })`。

### 排查时不要做的事

- **不要改动 electron-builder 的 NSIS 模板**（`templates/nsis/**`）。我试过用 `nsis.script`
  指向自带模板来"跳过执行那一步"，结果连着踩了三个坑：`UNINSTALLER_OUT_FILE` 未定义 →
  主包没有 `Uninstall` 段 → 宏里 `Var /GLOBAL` 重复声明。**问题不在模板，在进程执行环境。**
- **不要只信日志里的第一个错误**。①的 `Exit code: null` 和 ②的弹框是两回事，
  而②的弹框文字**日志里根本没有** —— 是人在屏幕上看来的。
