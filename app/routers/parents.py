# -*- coding: utf-8 -*-
"""家长联系方式（隐私保护）：默认手机号中间 4 位脱敏，输密码二次确认后查看明文。"""
from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user, get_class
from ..exceptions import BizError, ok
from ..models import Student, User
from ..security import decrypt_phone, verify_password
from ..utils.excel_export import export_excel

router = APIRouter(prefix="/api/parents", tags=["家长联系方式"])


def _mask(phone: str) -> str:
    if len(phone) >= 11:
        return phone[:3] + "****" + phone[-4:]
    return phone or ""


def _to_dict(stu: Student, reveal: bool = False) -> dict:
    phone = decrypt_phone(stu.guardian_phone) if stu.guardian_phone else ""
    return {
        "student_id": stu.id, "student_name": stu.name, "student_no": stu.student_no,
        "gender": stu.gender, "guardian_name": stu.guardian_name or "—",
        "phone": phone if reveal else _mask(phone),
        "revealed": reveal,
    }


@router.get("")
def list_parents(class_id: int = Query(...),
                 user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """默认返回脱敏号码。"""
    get_class(db, class_id)
    students = db.query(Student).filter(Student.class_id == class_id,
                                        Student.is_deleted.is_(False)
                                        ).order_by(Student.student_no).all()
    return ok([_to_dict(s) for s in students])


class RevealIn(BaseModel):
    password: str


@router.post("/reveal")
def reveal_phones(body: RevealIn, class_id: int = Query(...),
                  user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """输入当前登录密码后，返回该班全部手机号明文。"""
    if not verify_password(body.password, user.password_hash):
        raise BizError("密码错误，无法查看完整号码")
    get_class(db, class_id)
    students = db.query(Student).filter(Student.class_id == class_id,
                                        Student.is_deleted.is_(False)
                                        ).order_by(Student.student_no).all()
    return ok([_to_dict(s, reveal=True) for s in students])


@router.get("/export")
def export_parents(class_id: int = Query(...),
                   user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """导出 Excel：出于隐私保护，导出为脱敏号码；需要明文请在页面验证密码后复制。"""
    students = db.query(Student).filter(Student.class_id == class_id,
                                        Student.is_deleted.is_(False)
                                        ).order_by(Student.student_no).all()
    headers = ["学生姓名", "学号", "性别", "监护人", "监护人电话（脱敏）"]
    rows = [[s.name, s.student_no, s.gender, s.guardian_name or "—",
             _mask(decrypt_phone(s.guardian_phone) if s.guardian_phone else "")]
            for s in students]
    content = export_excel(headers, rows, sheet_name="家长联系方式")
    return Response(content=content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": "attachment; filename=parents.xlsx"})
