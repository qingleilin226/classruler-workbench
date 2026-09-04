# -*- coding: utf-8 -*-
"""SQLAlchemy 引擎与会话管理。默认 SQLite，可通过 .env 切换 PostgreSQL。"""
import logging

from sqlalchemy import create_engine, event
from sqlalchemy.orm import declarative_base, sessionmaker

from .config import DATABASE_URL

_connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    # SQLite 的 timeout 单位为秒；短暂写锁时等待而不是立刻报 database is locked。
    _connect_args = {"check_same_thread": False, "timeout": 30}

engine = create_engine(
    DATABASE_URL,
    connect_args=_connect_args,
    pool_pre_ping=True,
    future=True,
)

# SQLite 开启外键约束（默认关闭）
if DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.execute("PRAGMA journal_mode=WAL")
        # FULL 优先保证断电时的数据持久性；低并发私有部署的性能足够。
        cursor.execute("PRAGMA synchronous=FULL")
        cursor.execute("PRAGMA wal_autocheckpoint=1000")
        cursor.execute("PRAGMA journal_size_limit=67108864")
        cursor.close()

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()


def get_db():
    """FastAPI 依赖：请求级会话。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def verify_database() -> None:
    """启动时验证数据库可读且结构未损坏；失败则阻止服务带病运行。"""
    with engine.connect() as conn:
        if engine.dialect.name == "sqlite":
            result = conn.exec_driver_sql("PRAGMA quick_check").scalar()
            if result != "ok":
                raise RuntimeError(f"SQLite 数据库完整性检查失败: {result}")
        else:
            conn.exec_driver_sql("SELECT 1").scalar()


def checkpoint_database() -> None:
    """服务退出前尽量把 SQLite WAL 合并回主数据库文件。"""
    if engine.dialect.name != "sqlite":
        return
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)")
    except Exception:
        logging.getLogger("class_manager.database").exception("SQLite WAL checkpoint 失败")
