# -*- coding: utf-8 -*-
"""班级与学期管理：多班级切换、激活学期唯一、新增班级/学期。"""
from datetime import date

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user
from ..exceptions import BizError, ok
from ..models import Class, Semester, User

router = APIRouter(prefix="/api/classes", tags=["班级学期"])


class ClassIn(BaseModel):
    grade: str
    name: str
    academic_year: str


class SemesterIn(BaseModel):
    class_id: int
    name: str
    start_date: date
    end_date: date
    is_active: bool = False


@router.get("")
def list_classes(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    classes = db.query(Class).filter(Class.is_deleted.is_(False)).order_by(Class.id).all()
    data = []
    for c in classes:
        active_sem = db.query(Semester).filter(
            Semester.class_id == c.id, Semester.is_active.is_(True),
            Semester.is_deleted.is_(False)).first()
        data.append({
            "id": c.id, "grade": c.grade, "name": c.name,
            "academic_year": c.academic_year,
            "active_semester_id": active_sem.id if active_sem else None,
            "student_count": len([s for s in c.students if not s.is_deleted]),
        })
    return ok(data)


@router.get("/{class_id}/semesters")
def list_semesters(class_id: int, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    sems = db.query(Semester).filter(
        Semester.class_id == class_id, Semester.is_deleted.is_(False)
    ).order_by(Semester.start_date).all()
    return ok([{"id": s.id, "name": s.name, "start_date": str(s.start_date),
                "end_date": str(s.end_date), "is_active": s.is_active} for s in sems])


@router.post("/{class_id}/semesters/activate")
def activate_semester(class_id: int, payload: dict, user: User = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    """切换激活学期：先把同班其他学期置为非激活，再激活目标学期（部分唯一索引兜底）。"""
    semester_id = payload.get("semester_id")
    if not semester_id:
        raise BizError("缺少 semester_id")
    sem = db.query(Semester).filter(Semester.id == semester_id,
                                    Semester.class_id == class_id,
                                    Semester.is_deleted.is_(False)).first()
    if not sem:
        raise BizError("学期不存在")
    db.query(Semester).filter(Semester.class_id == class_id,
                              Semester.is_active.is_(True)).update({"is_active": False})
    sem.is_active = True
    db.commit()
    return ok(message=f"已切换为「{sem.name}」")


@router.post("/semesters")
def create_semester(body: SemesterIn, user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    if body.end_date < body.start_date:
        raise BizError("结束日期不能早于开始日期")
    if db.query(Semester).filter(Semester.class_id == body.class_id,
                                 Semester.name == body.name,
                                 Semester.is_deleted.is_(False)).first():
        raise BizError("该班级已存在同名学期")
    if body.is_active:
        db.query(Semester).filter(Semester.class_id == body.class_id,
                                  Semester.is_active.is_(True)).update({"is_active": False})
    sem = Semester(**body.model_dump())
    db.add(sem)
    db.commit()
    return ok({"id": sem.id}, message="学期创建成功")


@router.post("")
def create_class(body: ClassIn, user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    if db.query(Class).filter(Class.name == body.name, Class.is_deleted.is_(False)).first():
        raise BizError("班级名称已存在")
    cls = Class(**body.model_dump())
    db.add(cls)
    db.commit()
    # 自动创建默认两个学期
    year_start = 2024
    try:
        year_start = int(body.academic_year[:4])
    except ValueError:
        pass
    db.add_all([
        Semester(class_id=cls.id, name="第一学期",
                 start_date=date(year_start, 9, 1),
                 end_date=date(year_start + 1, 1, 15), is_active=True),
        Semester(class_id=cls.id, name="第二学期",
                 start_date=date(year_start + 1, 2, 10),
                 end_date=date(year_start + 1, 7, 5), is_active=False),
    ])
    db.commit()
    return ok({"id": cls.id}, message="班级创建成功，已自动生成两个学期")
