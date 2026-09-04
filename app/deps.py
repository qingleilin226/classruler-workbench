# -*- coding: utf-8 -*-
"""FastAPI 公共依赖：登录校验、班级/学期校验。"""
from fastapi import Depends, Header
from sqlalchemy.orm import Session

from .database import get_db
from .exceptions import BizError
from .models import Class, Semester, Student, User
from .security import parse_token, password_version


def get_current_user(
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
) -> User:
    token = authorization.removeprefix("Bearer ").strip() if authorization else ""
    payload = parse_token(token) if token else None
    if not payload:
        raise BizError("未登录或登录已过期，请重新登录", code=401)
    user = db.query(User).filter(User.id == payload["uid"]).first()
    if not user:
        raise BizError("用户不存在", code=401)
    if payload.get("pwdv") != password_version(user.password_hash):
        raise BizError("密码已变更，请重新登录", code=401)
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


def require_student(db: Session, student_id: int, class_id: int = None) -> Student:
    """校验学生存在；传入 class_id 时同时阻止跨班错挂。"""
    q = db.query(Student).filter(
        Student.id == student_id,
        Student.is_deleted.is_(False),
    )
    if class_id is not None:
        q = q.filter(Student.class_id == class_id)
    student = q.first()
    if not student:
        message = "学生不存在或已删除"
        if class_id is not None:
            message = "学生不存在、已删除或不属于当前班级"
        raise BizError(message, code=404)
    return student
