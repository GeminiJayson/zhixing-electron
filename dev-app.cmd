@echo off
REM 开发环境启动知行 ZhiXing（HMR，改代码即时生效，不必重启）。
REM
REM 与 run-app.cmd 的两点差别：
REM   1. 走 electron-vite dev —— 渲染进程改动走 HMR，主进程改动自动重启；
REM   2. 带 --remote-debugging-port，供 CDP 做实测（读 DOM / 计算样式 / 调用 db）。
REM
REM 数据库仍是真实的那个（APPDATA\ZhiXing），所以不设 ZHIXING_HOME。
REM 必须清掉 ELECTRON_RUN_AS_NODE —— 它会让 electron.exe 跑成纯 Node，
REM 于是 electron 模块里没有 app，"app.setAsDefaultProtocolClient" 直接抛错。
set ELECTRON_RUN_AS_NODE=
set ZHIXING_HOME=
cd /d "%~dp0"
call node_modules\.bin\electron-vite.cmd dev -- --remote-debugging-port=9222
