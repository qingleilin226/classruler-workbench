# -*- coding: utf-8 -*-
"""定时任务：每日凌晨自动备份所有数据表为 SQL 文件到 ./backup 目录。
SQLite 直接备份 .db 文件；PostgreSQL 生成 pg_dump 兼容的 INSERT 脚本。"""
import logging
import shutil
from datetime import datetime
from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy import text

from .config import BACKUP_DIR, BACKUP_HOUR, BACKUP_MINUTE, DATABASE_URL
from .database import engine

logger = logging.getLogger("class_manager.backup")


def run_backup() -> dict:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    result = {"time": stamp}

    if DATABASE_URL.startswith("sqlite"):
        db_path = Path(DATABASE_URL.replace("sqlite:///", ""))
        if not db_path.exists():
            logger.warning("数据库文件不存在，跳过备份: %s", db_path)
            return result
        target = BACKUP_DIR / f"backup_{stamp}.db"
        shutil.copy2(db_path, target)
        result["file"] = str(target)
        logger.info("SQLite 备份完成: %s", target)
    else:
        # PostgreSQL：导出所有表为 INSERT 脚本（无需 pg_dump，纯 SQL 兼容）
        target = BACKUP_DIR / f"backup_{stamp}.sql"
        lines = [f"-- 班主任工作台自动备份 {stamp}\n", "BEGIN;\n"]
        with engine.connect() as conn:
            tables = [r[0] for r in conn.execute(text(
                "SELECT tablename FROM pg_tables WHERE schemaname='public'"))]
            for table in tables:
                rows = conn.execute(text(f"SELECT * FROM {table}")).fetchall()
                cols = conn.execute(text(
                    f"SELECT column_name FROM information_schema.columns "
                    f"WHERE table_name='{table}'")).fetchall()
                col_str = ", ".join(f'"{c[0]}"' for c in cols)
                for row in rows:
                    vals = []
                    for v in row:
                        if v is None:
                            vals.append("NULL")
                        elif isinstance(v, (int, float)):
                            vals.append(str(v))
                        else:
                            vals.append("'" + str(v).replace("'", "''") + "'")
                    lines.append(f"INSERT INTO \"{table}\" ({col_str}) VALUES ({', '.join(vals)});\n")
        lines.append("COMMIT;\n")
        target.write_text("".join(lines), encoding="utf-8")
        result["file"] = str(target)
        logger.info("PostgreSQL 备份完成: %s", target)

    # 只保留最近 30 份备份
    for old in sorted(BACKUP_DIR.glob("backup_*"))[:-30]:
        old.unlink()
    return result


_scheduler = None


def start_scheduler() -> BackgroundScheduler:
    """启动每日备份调度（启动时立即执行一次，之后每日凌晨执行）。"""
    global _scheduler
    if _scheduler is not None:
        return _scheduler
    _scheduler = BackgroundScheduler(timezone="Asia/Shanghai")
    _scheduler.add_job(run_backup, "cron", hour=BACKUP_HOUR, minute=BACKUP_MINUTE,
                       id="daily_backup", misfire_grace_time=3600)
    _scheduler.start()
    logger.info("每日备份任务已启动（%02d:%02d，目录 %s）", BACKUP_HOUR, BACKUP_MINUTE, BACKUP_DIR)
    # 启动时立即备份一次，保证当天有备份
    try:
        run_backup()
    except Exception as e:
        logger.error("启动备份失败: %s", e)
    return _scheduler
