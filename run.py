# -*- coding: utf-8 -*-
"""PyInstaller 打包入口：调用 zhixing.__main__.main()。"""
import multiprocessing
import sys

from zhixing.__main__ import main


if __name__ == "__main__":
    # Windows 下 PyInstaller 冻结的 GUI 程序需要 freeze_support()
    if sys.platform == "win32":
        multiprocessing.freeze_support()
    sys.exit(main())
