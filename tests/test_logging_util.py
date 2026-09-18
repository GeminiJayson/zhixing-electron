# -*- coding: utf-8 -*-
"""统一日志系统（loguru）：装配、文件落盘、事件审计与异常钩子装配。"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import zhixing.core.logging_util as lu
from zhixing.core.logging_util import logfile_path


class TestLoggingUtil(unittest.TestCase):
    """loguru logger 全局单例；用例共享一份装配。"""

    d = None

    @classmethod
    def setUpClass(cls):
        cls.d = Path(tempfile.mkdtemp())
        cls.lg = lu.setup_logging(cls.d)

    @classmethod
    def tearDownClass(cls):
        try:
            lu.logger.complete()   # 等待异步队列刷盘
        except Exception:
            pass

    def _logfile(self) -> Path:
        return logfile_path(self.d)

    def test_file_created_and_written(self):
        self.assertTrue(self._logfile().exists())
        lu.get_logger("test").info("smoke-info-msg")
        lu.logger.complete()
        text = self._logfile().read_text(encoding="utf-8")
        self.assertIn("smoke-info-msg", text)
        self.assertIn("INFO", text)

    def test_setup_idempotent(self):
        lu.setup_logging(self.d)               # 再次装配不叠加 handler
        lu.get_logger("test").info("still-works")
        lu.logger.complete()
        self.assertIn("still-works", self._logfile().read_text(encoding="utf-8"))

    def test_event_audit_logs_metadata_only(self):
        lu.log_signal("task_changed", (7, "completed"))
        lu.logger.complete()
        self.assertIn("signal=task_changed(7, 'completed')",
                      self._logfile().read_text(encoding="utf-8"))

    def test_quiet_signals_skipped(self):
        before = self._logfile().read_text(encoding="utf-8")
        lu.log_signal("pomodoro_state", (("focus", 0, 0),))
        lu.logger.complete()
        after = self._logfile().read_text(encoding="utf-8")
        self.assertEqual(before, after)        # quiet 信号不写任何日志

    def test_install_excepthooks(self):
        lu.install_excepthooks()
        self.assertTrue(callable(sys.excepthook))
        import threading
        self.assertTrue(callable(threading.excepthook))


if __name__ == "__main__":
    unittest.main(verbosity=2)
