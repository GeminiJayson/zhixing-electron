@echo off
REM =====================================================
REM  知行 ZhiXing - Windows 打包脚本（PyInstaller）
REM  在 Windows 上运行：双击或命令行 build_windows.bat
REM =====================================================
chcp 65001 >nul
cd /d "%~dp0"

echo [1/3] 安装依赖...
python -m pip install -r requirements.txt
python -m pip install pyinstaller
if errorlevel 1 goto :error

echo [2/3] 清理旧产物并打包...
pyinstaller --clean --noconfirm zhixing.spec
if errorlevel 1 goto :error

echo [3/3] 打包完成！
echo 可执行文件：dist\ZhiXing\ZhiXing.exe
echo 建议把整个 dist\ZhiXing 目录一起分发（含 Qt 运行库与主题资源）。
goto :end

:error
echo 打包失败，请检查上方错误信息。
pause
exit /b 1

:end
pause
