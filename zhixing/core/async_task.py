# -*- coding: utf-8 -*-
"""主线程非阻塞的任务执行器。

把 >100ms 的纯读写操作（备份、导出、FTS/图谱重算等）放到 QThread 后台，
完成后经信号在主线程回调；避免冻结 UI。回调内持 `holder` 引用防止线程被
GC 回收，完成后自动摘除并 deleteLater。

用法（本文件可被 core/view 共同 import，不依赖 model/domain）::

    self._bg: List[Worker] = []
    run_in_background(fn, on_done, self._bg, on_error=None)
"""
from typing import Callable, List, Optional

from PySide6.QtCore import QThread, Signal


class Worker(QThread):
    """执行 fn()，成功 emit done(结果)，异常 emit error(消息)。"""
    done = Signal(object)
    error = Signal(str)

    def __init__(self, fn: Callable[..., object], parent=None):
        super().__init__(parent)
        self._fn = fn

    def run(self) -> None:  # noqa: D102
        try:
            out = self._fn()
        except Exception as e:  # noqa: BLE001  —— 汇总成可读消息回传主线程
            detail = getattr(e, "message", None) or str(e)
            self.error.emit(f"{type(e).__name__}: {detail}")
            return
        self.done.emit(out)


def run_in_background(fn: Callable[..., object],
                      on_done: Optional[Callable[[object], None]] = None,
                      holder: Optional[List[Worker]] = None,
                      on_error: Optional[Callable[[str], None]] = None) -> None:
    """编排一个后台任务（主线程无阻塞）。

    - fn 在 worker 线程运行，返回结果（None 亦可）。
    - on_done/on_error 在主线程回调（随信号派发）。
    - holder（通常是 self._bg 列表）在此任务完成前保留 Worker 引用防 GC。
    """
    holder = holder if holder is not None else []
    w = Worker(fn)
    holder.append(w)

    def _finish(*_args) -> None:
        if w in holder:
            holder.remove(w)
        w.deleteLater()

    if on_done:
        w.done.connect(lambda r: (on_done(r), _finish()))
    else:
        w.done.connect(lambda r: _finish())
    if on_error:
        w.error.connect(lambda msg: (on_error(msg), _finish()))
    else:
        w.error.connect(lambda msg: _finish())
    w.start()
