# -*- coding: utf-8 -*-
"""学生名单：搜索/筛选/行内编辑/软删除/导出。姓名为主键，修改后全模块联动。"""
from datetime import date

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user, get_class
from ..exceptions import BizError, ok
from ..models import Student, User
from ..security import decrypt_phone, encrypt_phone
from ..utils.excel_export import export_excel

router = APIRouter(prefix="/api/students", tags=["学生名单"])

STATUS_LIST = ["在读", "休学", "转学"]


class StudentIn(BaseModel):
    class_id: int
    name: str = Field(min_length=1, max_length=64)
    gender: str = "男"
    student_no: str = Field(min_length=1, max_length=32)
    birth_date: date = None
    status: str = "在读"
    guardian_name: str = ""
    guardian_phone: str = ""
    address: str = ""


class StudentUpdate(BaseModel):
    name: str = None
    gender: str = None
    student_no: str = None
    birth_date: date = None
    status: str = None
    guardian_name: str = None
    guardian_phone: str = None
    address: str = None


class StudentBatchDelete(BaseModel):
    ids: list[int]


class StudentBatchUpdate(BaseModel):
    """批量统一赋值。只允许这 5 个字段；不暴露 name/student_no/birth_date
    （name 是跨模块关联主键、student_no 班内唯一，禁止批量覆盖）。"""
    ids: list[int]
    status: str = None
    gender: str = None
    guardian_phone: str = None
    guardian_name: str = None
    address: str = None


def _to_dict(stu: Student, mask_phone: bool = False) -> dict:
    phone = ""
    if stu.guardian_phone:
        phone = decrypt_phone(stu.guardian_phone)
    if mask_phone and len(phone) >= 11:
        phone = phone[:3] + "****" + phone[-4:]
    return {
        "id": stu.id, "class_id": stu.class_id, "name": stu.name,
        "gender": stu.gender, "student_no": stu.student_no,
        "birth_date": str(stu.birth_date) if stu.birth_date else "",
        "status": stu.status, "guardian_name": stu.guardian_name or "",
        "guardian_phone": phone, "address": stu.address or "",
    }


def _check_no_conflict(db: Session, class_id: int, student_no: str, name: str, exclude_id: int = None):
    """学号在班内唯一；姓名允许重复，跨模块一律使用学生 id 关联。"""
    q = db.query(Student).filter(Student.class_id == class_id,
                                 Student.is_deleted.is_(False))
    if exclude_id:
        q = q.filter(Student.id != exclude_id)
    if student_no and q.filter(Student.student_no == student_no).first():
        raise BizError(f"学号「{student_no}」在本班已存在")


def _fetch_batch_students(db: Session, ids: list[int]) -> list[Student]:
    """批量操作公共入口：去重 + 空列表报错 + 全部命中（all-or-nothing）。"""
    ids = list(dict.fromkeys(ids))
    if not ids:
        raise BizError("请选择要操作的学生")
    stus = db.query(Student).filter(Student.id.in_(ids),
                                    Student.is_deleted.is_(False)).all()
    if len(stus) != len(ids):
        missing = [i for i in ids if i not in {s.id for s in stus}]
        raise BizError(f"部分学生不存在或已删除（id: {missing}），请刷新列表后重试")
    return stus


@router.get("")
def list_students(
    class_id: int = Query(...),
    keyword: str = Query("", description="按姓名/学号搜索"),
    status: str = Query("", description="状态筛选：在读/休学/转学，空为全部"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_class(db, class_id)
    q = db.query(Student).filter(Student.class_id == class_id,
                                 Student.is_deleted.is_(False))
    if keyword:
        like = f"%{keyword.strip()}%"
        q = q.filter(or_(Student.name.like(like), Student.student_no.like(like)))
    if status and status in STATUS_LIST:
        q = q.filter(Student.status == status)
    students = q.order_by(Student.student_no).all()
    return ok([_to_dict(s, mask_phone=True) for s in students])


@router.get("/export")
def export_students(
    class_id: int = Query(...),
    keyword: str = Query(""),
    status: str = Query(""),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """导出为 Excel：中文表头，保留当前筛选条件。手机号以脱敏形式导出。"""
    data = list_students(class_id=class_id, keyword=keyword, status=status,
                         user=user, db=db)["data"]
    headers = ["姓名", "性别", "学号", "出生日期", "状态", "监护人", "监护人电话", "家庭住址"]
    rows = [[d["name"], d["gender"], d["student_no"], d["birth_date"], d["status"],
             d["guardian_name"], d["guardian_phone"], d["address"]] for d in data]
    content = export_excel(headers, rows, sheet_name="学生名单")
    return Response(content=content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": "attachment; filename=students.xlsx"})


@router.post("/batch-delete")
def batch_delete_students(body: StudentBatchDelete, user: User = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    """批量软删除，与 DELETE /{student_id} 语义一致：置 is_deleted，不清理子表。"""
    stus = _fetch_batch_students(db, body.ids)
    for s in stus:
        s.is_deleted = True
    db.commit()
    return ok({"deleted": len(stus)}, message=f"已删除 {len(stus)} 名学生（软删除）")


@router.post("/batch-update")
def batch_update_students(body: StudentBatchUpdate, user: User = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    """批量统一赋值（一次一个或多个字段）。电话加密存储；空串表示清空字段。"""
    data = body.model_dump(exclude={"ids"}, exclude_unset=True)
    if not data:
        raise BizError("请提供要批量修改的字段")
    if "status" in data and data["status"] not in STATUS_LIST:
        raise BizError("状态只能是 在读/休学/转学")
    if "gender" in data and data["gender"] not in ("男", "女"):
        raise BizError("性别只能是 男/女")
    stus = _fetch_batch_students(db, body.ids)
    for s in stus:
        for k, v in data.items():
            if k == "guardian_phone":
                raw = (v or "").strip()
                s.guardian_phone = encrypt_phone(raw) if raw else None
            else:
                setattr(s, k, v)
    db.commit()
    return ok({"updated": len(stus)}, message=f"已更新 {len(stus)} 名学生")


@router.post("")
def create_student(body: StudentIn, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    get_class(db, body.class_id)
    if body.status not in STATUS_LIST:
        raise BizError("状态只能是 在读/休学/转学")
    if body.gender not in ("男", "女"):
        raise BizError("性别只能是 男/女")
    name = body.name.strip()
    student_no = body.student_no.strip()
    if not name or not student_no:
        raise BizError("姓名和学号不能为空")
    _check_no_conflict(db, body.class_id, student_no, name)
    phone = body.guardian_phone or ""
    values = body.model_dump(exclude={"guardian_phone"})
    values.update({"name": name, "student_no": student_no})
    stu = Student(**{**values,
                     "guardian_phone": encrypt_phone(phone) if phone else None})
    db.add(stu)
    db.commit()
    return ok(_to_dict(stu), message="学生添加成功")


@router.put("/{student_id}")
def update_student(student_id: int, body: StudentUpdate,
                   user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    stu = db.query(Student).filter(Student.id == student_id,
                                   Student.is_deleted.is_(False)).first()
    if not stu:
        raise BizError("学生不存在或已删除", code=404)
    data = body.model_dump(exclude_unset=True)
    new_name = data.get("name", stu.name)
    new_no = data.get("student_no", stu.student_no or "")
    if not str(new_name or "").strip() or not str(new_no or "").strip():
        raise BizError("姓名和学号不能为空")
    data["name"] = str(new_name).strip()
    data["student_no"] = str(new_no).strip()
    _check_no_conflict(db, stu.class_id, data["student_no"], data["name"], exclude_id=stu.id)
    if "guardian_phone" in data:
        phone = data.pop("guardian_phone") or ""
        stu.guardian_phone = encrypt_phone(phone) if phone else None
    if "status" in data and data["status"] not in STATUS_LIST:
        raise BizError("状态只能是 在读/休学/转学")
    if "gender" in data and data["gender"] not in ("男", "女"):
        raise BizError("性别只能是 男/女")
    for k, v in data.items():
        setattr(stu, k, v)
    db.commit()
    return ok(_to_dict(stu), message="修改成功")


@router.delete("/{student_id}")
def delete_student(student_id: int, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """软删除：置 is_deleted，不物理删除。"""
    stu = db.query(Student).filter(Student.id == student_id,
                                   Student.is_deleted.is_(False)).first()
    if not stu:
        raise BizError("学生不存在或已删除", code=404)
    stu.is_deleted = True
    db.commit()
    return ok(message="已删除（可联系管理员从备份恢复）")
