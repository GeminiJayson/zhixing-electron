# -*- coding: utf-8 -*-
"""统一日志（loguru）：滚动文件 + 控制台 + 全局异常兜底。

隐私规约（需求 §4 / F11）：仅记录事件与元数据，绝不把划词/笔记/任务正文
明文写入日志。搜索词、捕获内容、剪贴板一律不落。
"""
import os
import sys
import threading
from pathlib import Path

from loguru import logger

_NAME = "zhixing"
# 高频或噪音信号：不进 DEBUG（避免每秒/每次主题事件刷盘）
_QUIET_SIGNALS = {"pomodoro_state", "theme_changed", "settings_changed"}

# 与旧 logging 一致的格式：HH:mm:ss.SSS LEVEL name message（name 右对齐 16 宽）
_FMT = "{time:HH:mm:ss.SSS} {level:<5} {extra[name]:<16} {message}"


def get_logger(name: str = ""):
    """返回带 name 绑定的 loguru logger，兼容旧 logging.getLogger(name) 用法。"""
    return logger.bind(name=name or _NAME)


def ensure_std_streams(log_dir):
    """windowed 冻结（sys.stderr/sys.stdout 为 None）时把标准流重定向到日志目录文件。

    Windows 下 PyInstaller console=False 冻结后 sys.stdout/sys.stderr 为 None，
    任何 print/traceback 都会静默丢弃，loguru 的 add(sys.stderr, ...) 也会抛错。
    这里按需把两者改写到 <log_dir>/stdout.log、stderr.log（行缓冲），幂等：
    非 None 的流原样保留。返回 (sys.stdout, sys.stderr)。
    """
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    if sys.stdout is None:
        sys.stdout = open(str(log_dir / "stdout.log"), "a",
                          encoding="utf-8", buffering=1)
    if sys.stderr is None:
        sys.stderr = open(str(log_dir / "stderr.log"), "a",
                          encoding="utf-8", buffering=1)
    return sys.stdout, sys.stderr


def setup_logging(data_dir, console_debug: bool = False):
    """装配 loguru（幂等）。日志文件 <data_dir>/logs/zhixing.log，滚动 1MB×3。

    data_dir: zhixing.model.infrastructure.db.data_dir()。
    文件恒 DEBUG；控制台默认 INFO，ZHIXING_DEBUG=1 或 console_debug=True 时 DEBUG。
    enqueue=True 使文件写入走异步队列，不阻塞主线程。
    """
    try:
        logger.remove()
    except ValueError:
        pass
    # 默认 extra：确保 format 里的 {extra[name]} 在未显式 bind 时也有值
    logger.configure(extra={"name": _NAME})

    log_dir = Path(data_dir) / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    # windowed 冻结下 sys.stderr/stdout 可能为 None：先重定向到文件，避免 add(None) 抛错
    ensure_std_streams(log_dir)
    log_path = log_dir / "zhixing.log"

    logger.add(str(log_path), level="DEBUG", rotation="1 MB", retention=3,
               encoding="utf-8", format=_FMT, enqueue=True, backtrace=False, diagnose=False)
    dbg = console_debug or os.environ.get("ZHIXING_DEBUG") == "1"
    # 控制台 sink 只在有真实 stderr 时装配（windowed 下已重定向到 stderr.log）
    if sys.stderr is not None:
        logger.add(sys.stderr, level="DEBUG" if dbg else "INFO", format=_FMT)
    logger.bind(name=_NAME).info("日志系统就绪 file={}", log_path)
    return logger


def logfile_path(data_dir) -> Path:
    return Path(data_dir) / "logs" / "zhixing.log"


def install_excepthooks():
    """未捕获异常（主线程 + 子线程）写入 logger，再交由默认 handler 收尾。"""
    def _hook(etype, value, tb):
        logger.bind(name=_NAME).opt(exception=(etype, value, tb)).error(
            "未捕获异常: {}: {}", getattr(etype, "__name__", etype), value)
        sys.__excepthook__(etype, value, tb)

    sys.excepthook = _hook

    def _thread_hook(args):
        name = getattr(args, "thread", None) or ""
        logger.bind(name=_NAME).opt(exception=(args.exc_type, args.exc_value,
                                               args.exc_traceback)).error(
            "线程异常[{}]: {}: {}", name,
            args.exc_type.__name__ if args.exc_type else "",
            args.exc_value)

    threading.excepthook = _thread_hook


def log_signal(name: str, args) -> None:
    """EventBus 事件审计（DEBUG；只记信号名 + 前两个标量/枚举，绝不含正文）。"""
    if name in _QUIET_SIGNALS:
        return
    parts = []
    try:
        for a in list(args)[:2]:
            if isinstance(a, (str, bytes, int, float, bool)) or a is None:
                parts.append(repr(a)[:48])
            else:
                parts.append(f"<{type(a).__name__}>")
    except Exception:
        parts = []
    logger.bind(name="zhixing.bus").debug("signal={}({})", name, ", ".join(parts))
