# -*- coding: utf-8 -*-
"""后台执行器回传验证（headless offscreen，processEvents）。"""
import os
import sys
import time
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).parent.parent))

from zhixing.core.async_task import run_in_background  # noqa: E402


class TestAsyncWorker(unittest.TestCase):

    def _pump_until(self, cond, timeout=5.0):
        from PySide6.QtWidgets import QApplication
        app = QApplication.instance()
        if app is None:
            app = QApplication([])
        deadline = time.time() + timeout
        while time.time() < deadline and not cond():
            app.processEvents()
            time.sleep(0.005)
        return cond()

    def test_done_result_delivered_and_released(self):
        holder, got = [], {}
        def fn():
            return 6 * 7
        run_in_background(fn,
                          on_done=lambda r: got.setdefault("done", r),
                          on_error=lambda e: got.setdefault("err", e),
                          holder=holder)
        self.assertTrue(self._pump_until(lambda: bool(got)), "应在超时内回传")
        self.assertNotIn("err", got)
        self.assertEqual(got["done"], 42)
        pumped = time.time()
        while holder and time.time() - pumped < 3:
            self._pump_until(lambda: not holder, timeout=0.05)
        self.assertEqual(holder, [], "完成后应从 holder 摘除，供 GC")

    def test_error_delivered(self):
        holder, got = [], {}
        def fn():
            raise ValueError("boom")
        run_in_background(fn,
                          on_done=lambda r: got.setdefault("done", r),
                          on_error=lambda e: got.setdefault("err", e),
                          holder=holder)
        self.assertTrue(self._pump_until(lambda: bool(got)), "应在超时内收到错误")
        self.assertIn("boom", got.get("err", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
