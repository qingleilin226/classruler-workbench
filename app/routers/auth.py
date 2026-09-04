# -*- coding: utf-8 -*-
"""认证：登录、当前用户、修改密码、验证密码（查看隐私用）。"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user
from ..exceptions import BizError, ok
from ..models import User
from ..security import create_token, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["认证"])


class LoginIn(BaseModel):
    username: str
    password: str


class ChangePwdIn(BaseModel):
    old_password: str
    new_password: str


class VerifyPwdIn(BaseModel):
    password: str


class ProfileIn(BaseModel):
    display_name: str = Field(min_length=1, max_length=64)


@router.post("/login")
def login(body: LoginIn, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == body.username).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise BizError("用户名或密码错误", code=401)
    return ok({"token": create_token(user.id, user.password_hash), "username": user.username,
               "display_name": user.display_name})


@router.get("/me")
def me(user: User = Depends(get_current_user)):
    return ok({"id": user.id, "username": user.username,
               "display_name": user.display_name})


@router.put("/profile")
def update_profile(body: ProfileIn, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    display_name = body.display_name.strip()
    if not display_name:
        raise BizError("用户名称不能为空")
    user.display_name = display_name
    db.commit()
    return ok({"id": user.id, "username": user.username,
               "display_name": user.display_name}, message="用户名称已更新")


@router.post("/change-password")
def change_password(body: ChangePwdIn, user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    if not verify_password(body.old_password, user.password_hash):
        raise BizError("原密码错误")
    if len(body.new_password) < 6:
        raise BizError("新密码至少 6 位")
    user.password_hash = hash_password(body.new_password)
    db.commit()
    return ok(message="密码修改成功")


@router.post("/verify-password")
def verify_password_api(body: VerifyPwdIn, user: User = Depends(get_current_user)):
    """查看隐私信息（如家长手机号明文）前的密码二次确认。"""
    if not verify_password(body.password, user.password_hash):
        raise BizError("密码错误，无法查看")
    return ok(message="验证通过")
