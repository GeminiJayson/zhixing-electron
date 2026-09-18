# -*- coding: utf-8 -*-
"""迁移链单测：新库幂等、老库升级、升级前备份、缺链显式报错。"""
import os
import sqlite3
import tempfile
import unittest
from unittest import mock

from sqlalchemy import text

import zhixing.model.infrastructure.db as dbmod


class TestMigrationChain(unittest.TestCase):

    def setUp(self):
        self._home = tempfile.mkdtemp()
        os.environ["ZHIXING_HOME"] = self._home
        # 备份与主库同目录，便于断言“前置备份”已生成
        self.backup_dir = dbmod.db_path().parent / "backups"

    def test_fresh_db_is_current_and_idempotent(self):
        db = dbmod.Database()
        try:
            applied = db.migrate()
            self.assertEqual(applied, [], "全新库不应有迁移动作")
            s = db.session()
            try:
                v = s.execute(__import__(
                    "sqlalchemy", fromlist=["text"]).text(
                    "SELECT value FROM settings WHERE key='schema_version'"
                )).scalar()
            finally:
                s.close()
            self.assertEqual(int(v), dbmod.SCHEMA_VERSION)
            # 再跑一次 migrate 仍幂等
            self.assertEqual(db.migrate(), [])
        finally:
            db.engine.dispose()

    def test_upgrade_backs_up_then_applies_and_records(self):
        db = dbmod.Database()  # 建到 V1
        try:
            # 模拟老库：把已落库版本写低，并注入未来 V2 迁移
            with db.engine.begin() as conn:
                conn.execute(__import__(
                    "sqlalchemy", fromlist=["text"]).text(
                    "UPDATE settings SET value='1' WHERE key='schema_version'"))
            ran = []
            real = dbmod.SCHEMA_VERSION
            real_map = dbmod._MIGRATIONS
            dbmod.SCHEMA_VERSION = 2
            def upgrade_v2(conn):
                conn.execute(__import__(
                    "sqlalchemy", fromlist=["text"]).text(
                    "CREATE TABLE IF NOT EXISTS _migrated_v2(ok int)"))
                ran.append(True)
            dbmod._MIGRATIONS = {real: real_map[real], 2: upgrade_v2}
            try:
                applied = db.migrate()
            finally:
                dbmod.SCHEMA_VERSION = real
                dbmod._MIGRATIONS = real_map
            self.assertEqual(applied, [2])
            self.assertTrue(ran)
            # 升级前备份必须落地
            pre = list(self.backup_dir.glob("pre-migrate-*.db"))
            self.assertTrue(pre, "应为升级前生成 pre-migrate 备份")
            s = db.session()
            try:
                v = s.execute(__import__(
                    "sqlalchemy", fromlist=["text"]).text(
                    "SELECT value FROM settings WHERE key='schema_version'"
                )).scalar()
            finally:
                s.close()
            self.assertEqual(int(v), 2)
        finally:
            db.engine.dispose()

    def test_v2_migration_adds_start_date_and_bumps_version(self):
        """真实 V1 老库（task 无 start_date）应自动升级到 V2 并落列、写版本号。"""
        dbpath = str(dbmod.db_path())
        conn = sqlite3.connect(dbpath)
        try:
            conn.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '')")
            conn.execute("INSERT INTO settings(key, value) VALUES('schema_version', '1')")
            # V1 老库的 task 表：只有 id/title/due_date，尚无 start_date
            conn.execute(
                "CREATE TABLE task (id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "title TEXT NOT NULL, due_date DATE)")
            conn.commit()
        finally:
            conn.close()

        db = dbmod.Database()  # 构造时即自动 migrate：V1 -> V2
        try:
            s = db.session()
            try:
                cols = [r[1] for r in s.execute(text("PRAGMA table_info(task)"))]
                self.assertIn("start_date", cols)
                v = s.execute(text(
                    "SELECT value FROM settings WHERE key='schema_version'")).scalar()
                self.assertEqual(int(v), dbmod.SCHEMA_VERSION)
            finally:
                s.close()
            # 再次 migrate 幂等，不重复应用
            self.assertEqual(db.migrate(), [])
        finally:
            db.engine.dispose()

    def test_gap_in_chain_raises(self):
        db = dbmod.Database()
        try:
            with db.engine.begin() as conn:
                conn.execute(__import__(
                    "sqlalchemy", fromlist=["text"]).text(
                    "UPDATE settings SET value='1' WHERE key='schema_version'"))
            real = dbmod.SCHEMA_VERSION
            real_map = dbmod._MIGRATIONS
            dbmod.SCHEMA_VERSION = 4
            dbmod._MIGRATIONS = {real: real_map[real], 4: lambda c: None}  # 缺 2、3
            try:
                with self.assertRaisesRegex(RuntimeError, "迁移链不完整"):
                    db.migrate()
            finally:
                dbmod.SCHEMA_VERSION = real
                dbmod._MIGRATIONS = real_map
        finally:
            db.engine.dispose()

    def tearDown(self):
        pass


if __name__ == "__main__":
    unittest.main(verbosity=2)
