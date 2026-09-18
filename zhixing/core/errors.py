# -*- coding: utf-8 -*-
"""业务错误类型：用中文人话给 UI 直接展示。"""


class ZhiXingError(Exception):
    """带用户可读信息的业务错误基类。"""

    def __init__(self, message: str, hint: str = ""):
        super().__init__(message)
        self.message = message
        self.hint = hint


class DatabaseLockedError(ZhiXingError):
    def __init__(self):
        super().__init__(
            "数据库被其他实例占用",
            "请关闭正在运行的其他「知行」窗口后重试。",
        )


class RestoreFailedError(ZhiXingError):
    pass


class ThemeParseError(ZhiXingError):
    pass
