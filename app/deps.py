# -*- coding: utf-8 -*-
"""FastAPI 公共依赖：登录校验、班级/学期校验。"""
from fastapi import Depends, Header
from sqlalchemy.orm import Session

from .database import get_db
from .exceptions import BizError
from .models import Class, Semester, User
from .security import parse_token


def get_current_user(
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
) -> User:
    token = authorization.removeprefix("Bearer ").strip() if authorization else ""
    user_id = parse_token(token) if token else None
    if not user_id:
        raise BizError("未登录或登录已过期，请重新登录", code=401)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise BizError("用户不存在", code=401)
    return user


def require_class(db: Session, class_id: int) -> Class:
    cls = db.query(Class).filter(Class.id == class_id, Class.is_deleted.is_(False)).first()
    if not cls:
        raise BizError("班级不存在或已删除", code=404)
    return cls


def get_class(db: Session, class_id: int) -> Class:
    return require_class(db, class_id)


def require_semester(db: Session, semester_id: int, class_id: int = None) -> Semester:
    q = db.query(Semester).filter(Semester.id == semester_id, Semester.is_deleted.is_(False))
    if class_id is not None:
        q = q.filter(Semester.class_id == class_id)
    sem = q.first()
    if not sem:
        raise BizError("学期不存在或已删除", code=404)
    return sem
