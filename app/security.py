# -*- coding: utf-8 -*-
"""安全工具：密码哈希（标准库 PBKDF2）、监护人手机号加密（Fernet）。"""
import base64
import hashlib
import hmac
import os

from cryptography.fernet import Fernet

from .config import ENCRYPTION_KEY

# ---------------- 密码哈希 ----------------
_ITERATIONS = 120_000


def hash_password(password: str) -> str:
    """返回格式: pbkdf2$120000$<salt_b64>$<hash_b64>"""
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _ITERATIONS)
    return f"pbkdf2${_ITERATIONS}${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _algo, iterations, salt_b64, hash_b64 = stored.split("$")
        if _algo != "pbkdf2":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations))
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


# ---------------- 手机号加密 ----------------
_fernet = Fernet(ENCRYPTION_KEY.encode())


def encrypt_phone(phone: str) -> str:
    """加密存储监护人电话。"""
    return _fernet.encrypt(phone.encode("utf-8")).decode()


def decrypt_phone(cipher: str) -> str:
    """解密监护人电话；密文损坏时返回空串。"""
    try:
        return _fernet.decrypt(cipher.encode("utf-8")).decode("utf-8")
    except Exception:
        return ""


# ---------------- 登录令牌（HMAC 无状态签名） ----------------
import json
import time
from .config import ENCRYPTION_KEY as _SECRET

_TOKEN_TTL = 7 * 24 * 3600  # 7 天有效期


def _token_hmac(payload_b64: str) -> str:
    return hmac.new(_SECRET.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()


def password_version(password_hash: str) -> str:
    """生成不可逆的密码版本标记，用于修改密码后立即吊销旧令牌。"""
    return hmac.new(_SECRET.encode(), password_hash.encode(), hashlib.sha256).hexdigest()[:16]


def create_token(user_id: int, password_hash: str) -> str:
    payload = {
        "uid": user_id,
        "pwdv": password_version(password_hash),
        "exp": int(time.time()) + _TOKEN_TTL,
    }
    payload_b64 = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    return f"{payload_b64}.{_token_hmac(payload_b64)}"


def parse_token(token: str):
    """校验令牌签名和有效期，成功返回载荷，失败返回 None。"""
    try:
        payload_b64, sig = token.split(".")
        if not hmac.compare_digest(_token_hmac(payload_b64), sig):
            return None
        payload = json.loads(base64.urlsafe_b64decode(payload_b64.encode()).decode())
        if payload.get("exp", 0) < time.time():
            return None
        return payload if payload.get("uid") else None
    except Exception:
        return None
