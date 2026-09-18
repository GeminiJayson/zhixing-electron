# -*- coding: utf-8 -*-
"""抓取动效测试窗口的帧序列，合成动画 GIF（视觉证据工具）。

用法：
    QT_QPA_PLATFORM=offscreen .venv/bin/python scripts/capture_motion.py

帧时长按真实时间戳计算，因此播放速度与实际一致；总时长不可控地受抓帧开销影响，
但 GIF 的观感是真实节奏。
"""
from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Callable, List, Optional, Sequence, Tuple

from PySide6.QtCore import QEventLoop, QTimer
from PySide6.QtGui import QImage
from PySide6.QtWidgets import QApplication

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

OUT_DIR = ROOT / "docs" / "qfluent_core_gallery"
GIF_WIDTH = 520
INTERVAL_MS = 40          # 采样间隔：动画只有 150-280ms，间隔太大就抓不到中间态
SLOW_FACTOR = 2.0         # 展示用慢放倍数（真实节奏的 1/2，便于看清曲线）


def to_pil(pixmap, width: int = GIF_WIDTH):
    """QPixmap -> PIL.Image（等比缩放到给定宽度，便于生成体积可控的 GIF）。"""
    from PIL import Image
    image = pixmap.toImage().convertToFormat(QImage.Format_RGBA8888)
    raw = bytes(image.constBits())
    row_bytes = image.bytesPerLine()
    height = image.height()
    pil = Image.frombytes("RGBA", (image.width(), height),
                          raw[: row_bytes * height])
    pil = pil.convert("RGB")
    scale = width / float(pil.width)
    return pil.resize((width, max(1, int(pil.height * scale))), Image.LANCZOS)


def capture_script(window, cues: Sequence[Tuple[int, Callable[[], None]]],
                   total_ms: int, interval_ms: int = INTERVAL_MS
                   ) -> List[Tuple[int, object]]:
    """按时间表执行动作并抓帧，返回 [(相对毫秒, PIL.Image)]。"""
    pending = sorted(cues, key=lambda item: item[0])
    frames: List[Tuple[int, object]] = []
    start = time.monotonic()
    index = 0

    def elapsed() -> int:
        return int((time.monotonic() - start) * 1000)

    while elapsed() < total_ms or index < len(pending):
        now = elapsed()
        while index < len(pending) and pending[index][0] <= now:
            pending[index][1]()
            index += 1
        loop = QEventLoop()
        QTimer.singleShot(interval_ms, loop.quit)
        loop.exec()
        frames.append((elapsed(), to_pil(window.grab())))
        if index >= len(pending) and elapsed() >= total_ms:
            break
    return frames


def save_gif(frames: List[Tuple[int, object]], path: Path,
             slow_factor: float = SLOW_FACTOR) -> int:
    """按真实帧间隔（可慢放）写 GIF；间隔按 10ms 取整（GIF 的最小单位）。"""
    if not frames:
        return 0
    images = [image for _ms, image in frames]
    durations = []
    for i in range(len(frames) - 1):
        delta = (frames[i + 1][0] - frames[i][0]) * slow_factor
        durations.append(max(30, int(round(delta / 10.0)) * 10))
    durations.append(int(400 * slow_factor))
    path.parent.mkdir(parents=True, exist_ok=True)
    images[0].save(path, save_all=True, append_images=images[1:],
                   duration=durations, loop=0, optimize=True, disposal=2)
    return path.stat().st_size


def build_cues(window) -> Tuple[List[Tuple[int, Callable[[], None]]], int]:
    """动效剧本：导航折叠 -> 切页 -> 控件动效 -> 反馈动效 -> 降级。"""
    cues: List[Tuple[int, Callable[[], None]]] = [
        (400, window.toggle_navigation),                 # 折叠导航（宽度 OutExpo）
        (1500, window.toggle_navigation),                # 展开
        (2600, lambda: window.set_current_index(1)),     # 页面淡入切换
        (3100, window.roll_numbers),                     # 数字滚动
        (3200, window.advance_progress),                 # 进度条数值动画
        (5000, lambda: window.set_current_index(2)),
        (5500, window.replay_stagger),                   # 逐条入场
        (6100, window.ring_sweep),                       # 进度环扫过
        (7600, lambda: window.set_current_index(3)),
        (8200, lambda: window._motion_switch.setChecked(False)),  # 关闭动效
        (8900, window.advance_progress),                 # 降级：应瞬间到 100%
    ]
    return cues, 10000


def main() -> int:
    app = QApplication.instance() or QApplication(sys.argv)
    from examples.motion_showcase import build_showcase
    from qfluent_core import ThemeManager, UISettings

    settings = UISettings()
    theme = ThemeManager()
    window = build_showcase(settings, theme)
    window.resize(1180, 780)
    window.show()

    warmup = QEventLoop()
    QTimer.singleShot(400, warmup.quit)
    warmup.exec()

    cues, total = build_cues(window)
    frames = capture_script(window, cues, total)
    out = OUT_DIR / "motion-showcase.gif"
    size = save_gif(frames, out)
    print("帧数 %d，时长约 %.1fs，文件 %.1f KB -> %s"
          % (len(frames), total / 1000.0, size / 1024.0, out))

    # 关键状态截一张静态图（降级后的终态）
    window.grab().save(str(OUT_DIR / "motion-reduced-motion.png"))
    window.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
