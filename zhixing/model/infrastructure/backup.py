# -*- coding: utf-8 -*-
"""数据库自动备份与恢复：启动备份、保留最近 10 份。"""
import shutil
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from ...core.errors import RestoreFailedError


class BackupService:
    MAX_KEEP = 10

    def __init__(self, db):
        self.db = db
        self.dir = db.path.parent / "backups"
        self.dir.mkdir(parents=True, exist_ok=True)

    def backup(self, reason: str = "auto") -> Optional[Path]:
        """拷贝主库文件（WAL 模式下用 sqlite backup API 保证一致性）。"""
        import sqlite3
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        target = self.dir / f"{reason}-{stamp}.db"
        try:
            src = sqlite3.connect(str(self.db.path))
            dst = sqlite3.connect(str(target))
            with dst:
                src.backup(dst)
            dst.close()
            src.close()
        except Exception:
            return None
        self._prune()
        return target

    def _prune(self):
        files = sorted(self.dir.glob("*.db"), key=lambda p: p.name, reverse=True)
        for f in files[self.MAX_KEEP:]:
            try:
                f.unlink()
            except OSError:
                pass

    def list_backups(self) -> List[Path]:
        return sorted(self.dir.glob("*.db"), key=lambda p: p.name, reverse=True)

    def restore(self, backup_path: Path):
        """用备份覆盖主库（调用方负责先关闭会话并再次备份当前库）。"""
        src = Path(backup_path)
        if not src.exists():
            raise RestoreFailedError(f"备份文件不存在：{src.name}")
        self.backup(reason="pre-restore")
        try:
            shutil.copyfile(src, self.db.path)
            for suffix in ("-wal", "-shm"):
                p = Path(str(self.db.path) + suffix)
                if p.exists():
                    p.unlink()
        except OSError as e:
            raise RestoreFailedError(str(e)) from e
