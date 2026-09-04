# -*- coding: utf-8 -*-
"""全局配置：从 .env 读取，首次启动自动生成加密密钥。"""
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BASE_DIR / ".env"
load_dotenv(ENV_FILE)


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"环境变量 {name} 必须是整数，当前值为 {raw!r}") from exc
    if not minimum <= value <= maximum:
        raise RuntimeError(f"环境变量 {name} 必须在 {minimum}-{maximum} 之间，当前值为 {value}")
    return value

# ---- 数据库 ----
_database_url = os.getenv("DATABASE_URL", "sqlite:///./class_manager.db")
if _database_url.startswith("sqlite:///") and not _database_url.startswith("sqlite:////"):
    db_value = _database_url[len("sqlite:///"):]
    db_name, separator, query = db_value.partition("?")
    db_path = Path(db_name)
    if db_name != ":memory:" and not db_path.is_absolute():
        db_path = (BASE_DIR / db_path).resolve()
        _database_url = f"sqlite:///{db_path.as_posix()}"
        if separator:
            _database_url += f"?{query}"
DATABASE_URL = _database_url

# ---- 加密密钥（Fernet），不存在则自动生成并持久化到 .env ----
def _load_or_create_encryption_key() -> str:
    key = os.getenv("ENCRYPTION_KEY", "").strip()
    if not key:
        from cryptography.fernet import Fernet
        key = Fernet.generate_key().decode()
        # 追加写入 .env
        with open(ENV_FILE, "a", encoding="utf-8") as f:
            f.write(f"\nENCRYPTION_KEY={key}\n")
    return key

ENCRYPTION_KEY = _load_or_create_encryption_key()

# ---- 默认管理员 ----
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")

# ---- 服务 ----
HOST = os.getenv("HOST", "0.0.0.0")
PORT = _env_int("PORT", 8000, 1, 65535)
CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "").split(",")
    if origin.strip()
]

# ---- 备份 ----
BACKUP_DIR = BASE_DIR / os.getenv("BACKUP_DIR", "./backup")
BACKUP_HOUR = _env_int("BACKUP_HOUR", 2, 0, 23)
BACKUP_MINUTE = _env_int("BACKUP_MINUTE", 0, 0, 59)
BACKUP_KEEP_COUNT = _env_int("BACKUP_KEEP_COUNT", 30, 3, 365)

# ---- 日志 ----
LOG_FILE = BASE_DIR / os.getenv("LOG_FILE", "./server.log")
LOG_MAX_BYTES = _env_int("LOG_MAX_BYTES", 5 * 1024 * 1024, 1024, 1024 * 1024 * 1024)
LOG_BACKUP_COUNT = _env_int("LOG_BACKUP_COUNT", 5, 1, 50)

# 导入文件临时存储目录
UPLOAD_DIR = BASE_DIR / "uploads"
