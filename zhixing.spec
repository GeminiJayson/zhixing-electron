# -*- mode: python ; coding: utf-8 -*-
# 知行 ZhiXing - PyInstaller 打包配置（Windows / macOS / Linux 通用）
# 用法：pyinstaller --clean --noconfirm zhixing.spec

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# ---- 数据文件 ----
datas = [
    # 主题包（14 个主题 JSON），运行时按 theme_dir() 相对路径加载
    ('zhixing/resources/themes', 'zhixing/resources/themes'),
]

# ---- 隐藏导入 ----
hiddenimports = [
    # QtCharts（回顾页图表）、QtSvg（SVG 图标/启动页图标）
    'PySide6.QtCharts',
    'PySide6.QtSvg',
]

# ---- qfluentwidgets：收集 QSS/图标等资源 + 子模块 ----
datas += collect_data_files('qfluentwidgets')
hiddenimports += collect_submodules('qfluentwidgets')

# ---- jieba：结巴分词字典数据 ----
datas += collect_data_files('jieba')

# ---- Pygments：Markdown 语法高亮词法分析器 ----
hiddenimports += collect_submodules('pygments.lexers')

# ---- Word/Excel 笔记只读预览：python-docx / openpyxl 及其依赖 ----
hiddenimports += ['docx', 'docx.opc', 'docx.oxml', 'openpyxl', 'lxml', 'et_xmlfile']
hiddenimports += collect_submodules('docx')
hiddenimports += collect_submodules('openpyxl')
datas += collect_data_files('docx')

a = Analysis(
    ['run.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'pytest', 'unittest', 'tests',
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='ZhiXing',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='assets/zhixing.ico',
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='ZhiXing',
)
