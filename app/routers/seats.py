# -*- coding: utf-8 -*-
"""座次表：网格读取、拖拽后保存为新版本（不覆盖历史）、历史版本列表。"""
from datetime import date

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user, get_class, require_semester, require_student
from ..exceptions import BizError, ok
from ..models import SeatDetail, SeatPlan, Student, User
from ..utils.excel_export import export_excel

router = APIRouter(prefix="/api/seats", tags=["座次表"])


class SeatGridIn(BaseModel):
    class_id: int
    semester_id: int
    grid: list            # 二维数组 [[student_id|null, ...], ...]
    remark: str = ""


def _build_grid(plan: SeatPlan) -> dict:
    details = plan.details
    rows = max([d.row for d in details] or [0])
    cols = max([d.col for d in details] or [0])
    grid = [[None for _ in range(cols)] for _ in range(rows)]
    stu_names = {}
    for d in details:
        stu = d.student
        stu_names[d.student_id] = stu.name if not stu.is_deleted else "(已转出)"
        if 1 <= d.row <= rows and 1 <= d.col <= cols:
            grid[d.row - 1][d.col - 1] = d.student_id
    return {
        "plan_id": plan.id,
        "effective_date": str(plan.effective_date),
        "remark": plan.remark or "",
        "grid": grid,
        "student_names": stu_names,
    }


@router.get("/current")
def current_seat_plan(
    class_id: int = Query(...),
    semester_id: int = Query(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """读取当前班级/学期最新一版座次方案。"""
    get_class(db, class_id)
    require_semester(db, semester_id, class_id)
    plan = db.query(SeatPlan).filter(
        SeatPlan.class_id == class_id, SeatPlan.semester_id == semester_id,
        SeatPlan.is_deleted.is_(False)
    ).order_by(SeatPlan.effective_date.desc(), SeatPlan.id.desc()).first()
    if not plan:
        return ok({"plan_id": None, "effective_date": "", "remark": "",
                   "grid": [], "student_names": {}})
    return ok(_build_grid(plan))


@router.get("/history")
def seat_plan_history(
    class_id: int = Query(...),
    semester_id: int = Query(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    plans = db.query(SeatPlan).filter(
        SeatPlan.class_id == class_id, SeatPlan.semester_id == semester_id,
        SeatPlan.is_deleted.is_(False)
    ).order_by(SeatPlan.effective_date.desc(), SeatPlan.id.desc()).all()
    return ok([{"id": p.id, "effective_date": str(p.effective_date),
                "remark": p.remark or "", "student_count": len(p.details)} for p in plans])


@router.get("/history/{plan_id}")
def get_history_plan(plan_id: int, user: User = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    plan = db.query(SeatPlan).filter(SeatPlan.id == plan_id,
                                     SeatPlan.is_deleted.is_(False)).first()
    if not plan:
        raise BizError("座次方案不存在", code=404)
    return ok(_build_grid(plan))


@router.post("/save")
def save_seat_plan(body: SeatGridIn, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """保存为新版本：每次保存都新建 SeatPlan，历史方案保留可回溯。"""
    get_class(db, body.class_id)
    require_semester(db, body.semester_id, body.class_id)

    flat = [(int(r), int(c), sid) for r, row in enumerate(body.grid, start=1)
            for c, sid in enumerate(row, start=1) if sid is not None]

    # 校验：一名学生只能出现一次
    seen = set()
    for _r, _c, sid in flat:
        if sid in seen:
            raise BizError(f"学生 ID {sid} 在网格中出现了多次，请检查")
        seen.add(sid)
        require_student(db, sid, body.class_id)

    plan = SeatPlan(class_id=body.class_id, semester_id=body.semester_id,
                    effective_date=date.today(), remark=body.remark or "")
    db.add(plan)
    db.flush()
    for r, c, sid in flat:
        db.add(SeatDetail(seat_plan_id=plan.id, student_id=sid, row=r, col=c))
    db.commit()
    return ok({"plan_id": plan.id}, message="座次已保存为新版本，历史版本保留")


@router.get("/export")
def export_seat_plan(
    class_id: int = Query(...),
    semester_id: int = Query(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    plan = db.query(SeatPlan).filter(
        SeatPlan.class_id == class_id, SeatPlan.semester_id == semester_id,
        SeatPlan.is_deleted.is_(False)
    ).order_by(SeatPlan.effective_date.desc(), SeatPlan.id.desc()).first()
    if not plan:
        raise BizError("当前暂无座次方案")
    grid = _build_grid(plan)
    max_cols = max((len(r) for r in grid["grid"]), default=0)
    headers = ["行\\列"] + [f"第{i}列" for i in range(1, max_cols + 1)]
    names = grid["student_names"]
    rows = []
    for r, row in enumerate(grid["grid"], start=1):
        rows.append([f"第{r}排"] + [names.get(cell, "") if cell else "" for cell in row])
    content = export_excel(headers, rows, sheet_name="座次表")
    return Response(content=content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": "attachment; filename=seat_plan.xlsx"})
