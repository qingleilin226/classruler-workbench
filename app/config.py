# -*- coding: utf-8 -*-
"""全局配置：从 .env 读取，首次启动自动生成加密密钥。"""
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BASE_DIR / ".env"
load_dotenv(ENV_FILE)

# ---- 数据库 ----
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./class_manager.db")

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
PORT = int(os.getenv("PORT", "8000"))

# ---- 备份 ----
BACKUP_DIR = BASE_DIR / os.getenv("BACKUP_DIR", "./backup")
BACKUP_HOUR = int(os.getenv("BACKUP_HOUR", "2"))
BACKUP_MINUTE = int(os.getenv("BACKUP_MINUTE", "0"))

# 导入文件临时存储目录
UPLOAD_DIR = BASE_DIR / "uploads"
