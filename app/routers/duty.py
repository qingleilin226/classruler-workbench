# -*- coding: utf-8 -*-
"""值日表：周视图、某天批量勾选学生、下周自动轮换（持久化）、导出。"""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user, get_class, require_student
from ..exceptions import BizError, ok
from ..models import DutyDetail, DutyTemplate, Student, User
from ..utils.excel_export import export_excel

router = APIRouter(prefix="/api/duty", tags=["值日表"])

DUTY_TYPES = ["扫地", "擦黑板", "擦窗", "擦桌椅", "倒垃圾"]
WEEKDAY_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


class DutySetIn(BaseModel):
    """设置某一天的值日安排：weekday 1-7，assignments=[{student_id, duty_type}]"""
    class_id: int
    weekday: int
    assignments: list


def _template_of(db: Session, class_id: int, create: bool = False):
    tpl = db.query(DutyTemplate).filter(
        DutyTemplate.class_id == class_id, DutyTemplate.is_deleted.is_(False)
    ).first()
    if not tpl and create:
        tpl = DutyTemplate(class_id=class_id, template_type="week_cycle")
        db.add(tpl)
        db.flush()
    return tpl


def _rotate_students(students: list, offset: int) -> list:
    """整组轮换：每组人数 = 每类任务的人数，按组平移。"""
    if not students:
        return []
    group = len(students) // len(DUTY_TYPES) or 1
    step = offset * group
    return students[step:] + students[:step]


def _week_view(db: Session, class_id: int, week_offset: int) -> dict:
    tpl = _template_of(db, class_id)
    details = [] if not tpl else db.query(DutyDetail).filter(
        DutyDetail.template_id == tpl.id,
        DutyDetail.is_deleted.is_(False),
    ).all()
    # 按 weekday -> duty_type 组织学生队列
    by_slot = {}  # (weekday, duty_type) -> [student_id...]
    order = []
    for d in details:
        by_slot.setdefault((d.weekday, d.duty_type), []).append(d.student_id)
        order.append((d.weekday, d.duty_type))
    for slot in order:
        by_slot[slot] = list(dict.fromkeys(by_slot[slot]))

    # 组装周视图：先按模板槽位序填充，再按天分组
    days = {w: [] for w in range(1, 8)}
    for (weekday, dtype), stu_ids in by_slot.items():
        students = []
        for sid in stu_ids:
            stu = db.query(Student).filter(
                Student.id == sid,
                Student.class_id == class_id,
            ).first()
            if stu and not stu.is_deleted:
                students.append({"id": stu.id, "name": stu.name})
        rotated = _rotate_students(students, week_offset)
        for stu in rotated:
            days[weekday].append({**stu, "duty_type": dtype})

    # 周日期范围（相对今天）
    today = date.today()
    monday = today - timedelta(days=today.weekday()) + timedelta(weeks=week_offset)
    week_dates = {1 + i: monday + timedelta(days=i) for i in range(7)}
    return {
        "week_offset": week_offset,
        "week_dates": {str(k): str(v) for k, v in week_dates.items()},
        "days": {str(k): v for k, v in days.items()},
    }


@router.get("/week")
def get_duty_week(
    class_id: int = Query(...),
    week_offset: int = Query(0, ge=-52, le=52),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_class(db, class_id)
    return ok(_week_view(db, class_id, week_offset))


@router.post("/set-day")
def set_duty_day(body: DutySetIn, user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    """设置某天值日（批量勾选）：覆盖该天该类型的学生安排。"""
    get_class(db, body.class_id)
    if not 1 <= body.weekday <= 7:
        raise BizError("星期必须在 1-7 之间")
    tpl = _template_of(db, body.class_id, create=True)

    # 删除该天原有安排（软删除同理会污染唯一性，值日为业务配置直接物理清理该天即可，
    # 但为符合“所有删除均为软删除”，这里对旧记录做软删除并新建）
    old = db.query(DutyDetail).filter(DutyDetail.template_id == tpl.id,
                                      DutyDetail.weekday == body.weekday,
                                      DutyDetail.is_deleted.is_(False)).all()
    for d in old:
        d.is_deleted = True
    for item in body.assignments:
        dtype = item.get("duty_type", "扫地")
        if dtype not in DUTY_TYPES:
            raise BizError(f"值日类型必须是 {'/'.join(DUTY_TYPES)}")
        stu = require_student(db, item.get("student_id"), body.class_id)
        db.add(DutyDetail(template_id=tpl.id, weekday=body.weekday,
                          student_id=stu.id, duty_type=dtype))
    db.commit()
    return ok(message=f"{WEEKDAY_CN[body.weekday - 1]}值日安排已更新")


@router.post("/rotate")
def rotate_duty(payload: dict, user: User = Depends(get_current_user),
                db: Session = Depends(get_db)):
    """下一周自动轮换：将本周值日生顺延至下一组（持久化写回模板）。"""
    class_id = payload.get("class_id")
    get_class(db, class_id)
    tpl = _template_of(db, class_id)
    if not tpl:
        raise BizError("当前班级暂无值日安排")
    details = db.query(DutyDetail).filter(DutyDetail.template_id == tpl.id,
                                          DutyDetail.is_deleted.is_(False)).all()

    # 按 (weekday, duty_type) 分组并轮换一个组
    groups = {}
    order = []
    for d in details:
        groups.setdefault((d.weekday, d.duty_type), []).append(d)
        order.append((d.weekday, d.duty_type))
    for slot in order:
        members = list(dict.fromkeys(groups[slot]))
        group_size = len(DUTY_TYPES)
        if len(members) > 1:
            rotated = members[group_size:] + members[:group_size]
            for old, new in zip(members, rotated):
                old.student_id = new.student_id
    db.commit()
    return ok(message="已轮换至下一组，本周值日生顺延")


@router.get("/export")
def export_duty(
    class_id: int = Query(...),
    week_offset: int = Query(0),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    view = _week_view(db, class_id, week_offset)
    headers = ["星期", "日期", "值日生", "值日类型"]
    rows = []
    for wd in range(1, 8):
        wd_str = str(wd)
        for item in view["days"][wd_str]:
            rows.append([WEEKDAY_CN[wd - 1], view["week_dates"][wd_str],
                         item["name"], item["duty_type"]])
    content = export_excel(headers, rows, sheet_name="值日表")
    return Response(content=content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": "attachment; filename=duty.xlsx"})
