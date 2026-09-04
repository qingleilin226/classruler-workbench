# -*- coding: utf-8 -*-
"""课程表：矩阵视图、手动编辑、合并单元格导入（前端重构后回传）、临时调课（原课置灰+标"调"）。"""
from datetime import date

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user, get_class, require_semester
from ..exceptions import BizError, ok
from ..models import TimetableCell, TimetableChange, User
from ..utils.excel_export import export_excel

router = APIRouter(prefix="/api/timetable", tags=["课程表"])

MAX_PERIODS = 12


class CellIn(BaseModel):
    class_id: int
    semester_id: int
    weekday: int        # 1-7
    period: int         # 1-N
    course_name: str
    teacher: str = ""


class AdjustIn(BaseModel):
    """临时调课：把 old(weekday,period) 的课程调到 new(weekday,period)。"""
    class_id: int
    semester_id: int
    change_date: date = None
    course_name: str = ""
    old_weekday: int
    old_period: int
    new_weekday: int
    new_period: int


class ImportTimetableIn(BaseModel):
    class_id: int
    semester_id: int
    matrix: list      # 二维数组 matrix[period-1][col]，col 为文件列顺序
    weekday_map: dict  # {file_col_index: weekday}，列索引从 0 开始


def _get_cell(db: Session, class_id: int, semester_id: int, weekday: int, period: int) -> TimetableCell:
    return db.query(TimetableCell).filter(
        TimetableCell.class_id == class_id, TimetableCell.semester_id == semester_id,
        TimetableCell.weekday == weekday, TimetableCell.period == period,
        TimetableCell.is_deleted.is_(False)).first()


@router.get("")
def get_timetable(
    class_id: int = Query(...),
    semester_id: int = Query(...),
    change_date: date = Query(None, description="查看哪天的调课状态，默认今天"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_class(db, class_id)
    require_semester(db, semester_id, class_id)

    cells = db.query(TimetableCell).filter(
        TimetableCell.class_id == class_id, TimetableCell.semester_id == semester_id,
        TimetableCell.is_deleted.is_(False)).all()
    max_period = max([c.period for c in cells] or [7])
    grid = [[{"course": "", "teacher": "", "changed": False, "change": None}
             for _ in range(7)] for _ in range(max_period)]
    for c in cells:
        if 1 <= c.weekday <= 7 and 1 <= c.period <= max_period:
            grid[c.period - 1][c.weekday - 1] = {
                "course": c.course_name, "teacher": c.teacher or "", "changed": False,
                "change": None}

    # 当日临时调课：原位置置灰、新位置标记"调"
    the_date = change_date or date.today()
    changes = db.query(TimetableChange).filter(
        TimetableChange.class_id == class_id, TimetableChange.semester_id == semester_id,
        TimetableChange.change_date == the_date, TimetableChange.is_deleted.is_(False)).all()
    applied = []
    for ch in changes:
        while len(grid) < max(ch.old_period, ch.new_period):
            grid.append([{"course": "", "teacher": "", "changed": False, "change": None}
                         for _ in range(7)])
        if 1 <= ch.old_weekday <= 7 and 1 <= ch.old_period <= len(grid):
            grid[ch.old_period - 1][ch.old_weekday - 1]["changed"] = True
            grid[ch.old_period - 1][ch.old_weekday - 1]["change"] = {
                "id": ch.id, "kind": "from", "course": ch.course_name}
        if 1 <= ch.new_weekday <= 7 and 1 <= ch.new_period <= len(grid):
            target = grid[ch.new_period - 1][ch.new_weekday - 1]
            target["course"] = ch.course_name
            target["changed"] = True
            target["change"] = {"id": ch.id, "kind": "to", "course": ch.course_name}
        applied.append({"id": ch.id, "course_name": ch.course_name,
                         "old": f"{ch.old_weekday}-{ch.old_period}",
                         "new": f"{ch.new_weekday}-{ch.new_period}"})
    return ok({"grid": grid, "max_period": len(grid), "changes": applied,
               "change_date": str(the_date)})


@router.post("/cell")
def set_cell(body: CellIn, user: User = Depends(get_current_user),
             db: Session = Depends(get_db)):
    get_class(db, body.class_id)
    require_semester(db, body.semester_id, body.class_id)
    if not 1 <= body.weekday <= 7 or not 1 <= body.period <= MAX_PERIODS:
        raise BizError("星期或节次越界")
    cell = _get_cell(db, body.class_id, body.semester_id, body.weekday, body.period)
    if cell:
        cell.course_name = body.course_name
        cell.teacher = body.teacher
    else:
        cell = db.query(TimetableCell).filter(
            TimetableCell.class_id == body.class_id,
            TimetableCell.semester_id == body.semester_id,
            TimetableCell.weekday == body.weekday,
            TimetableCell.period == body.period,
        ).first()
        if cell:
            cell.course_name = body.course_name
            cell.teacher = body.teacher
            cell.is_deleted = False
        else:
            db.add(TimetableCell(class_id=body.class_id, semester_id=body.semester_id,
                                 weekday=body.weekday, period=body.period,
                                 course_name=body.course_name, teacher=body.teacher))
    db.commit()
    return ok(message="课程已保存")


@router.post("/adjust")
def adjust(body: AdjustIn, user: User = Depends(get_current_user),
           db: Session = Depends(get_db)):
    """临时调课：原位置课程置灰（保留记录），新位置显示课程并标记"调"。"""
    get_class(db, body.class_id)
    require_semester(db, body.semester_id, body.class_id)
    coords = (body.old_weekday, body.new_weekday, body.old_period, body.new_period)
    if not (1 <= coords[0] <= 7 and 1 <= coords[1] <= 7
            and 1 <= coords[2] <= MAX_PERIODS and 1 <= coords[3] <= MAX_PERIODS):
        raise BizError("调课的星期或节次越界")
    if (body.old_weekday, body.old_period) == (body.new_weekday, body.new_period):
        raise BizError("调课目标不能与原位置相同")
    src = _get_cell(db, body.class_id, body.semester_id, body.old_weekday, body.old_period)
    if not src:
        raise BizError("原位置的课程不存在，无法调课")
    course = body.course_name or src.course_name
    # 同日同时段已存在的调课不允许重复
    dup = db.query(TimetableChange).filter(
        TimetableChange.class_id == body.class_id, TimetableChange.semester_id == body.semester_id,
        TimetableChange.change_date == (body.change_date or date.today()),
        TimetableChange.old_weekday == body.old_weekday,
        TimetableChange.old_period == body.old_period,
        TimetableChange.is_deleted.is_(False)).first()
    if dup:
        raise BizError("该节课程今天已有调课记录")
    target_dup = db.query(TimetableChange).filter(
        TimetableChange.class_id == body.class_id,
        TimetableChange.semester_id == body.semester_id,
        TimetableChange.change_date == (body.change_date or date.today()),
        TimetableChange.new_weekday == body.new_weekday,
        TimetableChange.new_period == body.new_period,
        TimetableChange.is_deleted.is_(False),
    ).first()
    if target_dup:
        raise BizError("目标时段已有其他调课记录")
    ch = TimetableChange(class_id=body.class_id, semester_id=body.semester_id,
                         change_date=body.change_date or date.today(),
                         course_name=course,
                         old_weekday=body.old_weekday, old_period=body.old_period,
                         new_weekday=body.new_weekday, new_period=body.new_period)
    db.add(ch)
    db.commit()
    return ok({"id": ch.id}, message=f"「{course}」已调至 {body.new_weekday} 星期 第{body.new_period}节，原位置置灰")


@router.post("/cancel-change")
def cancel_change(payload: dict, user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    change_id = payload.get("change_id")
    ch = db.query(TimetableChange).filter(TimetableChange.id == change_id,
                                          TimetableChange.is_deleted.is_(False)).first()
    if not ch:
        raise BizError("调课记录不存在", code=404)
    ch.is_deleted = True
    db.commit()
    return ok(message="调课已取消，课程恢复原位")


@router.post("/import-confirm")
def import_timetable(body: ImportTimetableIn, user: User = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    """导入课程表（Excel 合并单元格由前端重构为二维数组后回传），整体覆盖本班课表。"""
    result = apply_timetable_import(body, db)
    db.commit()
    return ok(result, message="课程表导入成功（已整体覆盖并复用已有位置记录）")


def apply_timetable_import(body: ImportTimetableIn, db: Session) -> dict:
    """应用课程表导入但不提交，由调用方控制事务边界。"""
    get_class(db, body.class_id)
    require_semester(db, body.semester_id, body.class_id)
    if not body.matrix:
        raise BizError("课表矩阵为空")
    desired = {}
    for period, row in enumerate(body.matrix, start=1):
        if period > MAX_PERIODS:
            raise BizError(f"课程表最多支持 {MAX_PERIODS} 节")
        for col_idx, course in enumerate(row):
            weekday = body.weekday_map.get(str(col_idx))
            if weekday is None or not course or not str(course).strip():
                continue
            weekday = int(weekday)
            if not 1 <= weekday <= 7:
                raise BizError("课程表星期映射必须在 1-7 之间")
            desired[(weekday, period)] = str(course).strip()

    # 唯一约束覆盖全部记录，因此复用同位置旧记录并恢复，其他位置做软删除。
    old = db.query(TimetableCell).filter(
        TimetableCell.class_id == body.class_id,
        TimetableCell.semester_id == body.semester_id).all()
    for c in old:
        key = (c.weekday, c.period)
        if key in desired:
            c.course_name = desired.pop(key)
            c.teacher = ""
            c.is_deleted = False
        else:
            c.is_deleted = True
    for (weekday, period), course in desired.items():
        db.add(TimetableCell(class_id=body.class_id, semester_id=body.semester_id,
                             weekday=weekday, period=period, course_name=course))
    db.flush()
    return {"updated_cells": len(old), "inserted_cells": len(desired)}


@router.get("/export")
def export_timetable(
    class_id: int = Query(...),
    semester_id: int = Query(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    data = get_timetable(class_id=class_id, semester_id=semester_id, user=user, db=db)["data"]
    weekday_names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    headers = ["节次"] + weekday_names
    rows = []
    for p, line in enumerate(data["grid"], start=1):
        row = [f"第{p}节"]
        for cell in line:
            label = cell["course"]
            if cell.get("change") and cell["change"]["kind"] == "to":
                label += "(调)"
            row.append(label)
        rows.append(row)
    content = export_excel(headers, rows, sheet_name="课程表")
    return Response(content=content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": "attachment; filename=timetable.xlsx"})
