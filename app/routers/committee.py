# -*- coding: utf-8 -*-
"""班委名单：职位卡片墙、任职起止日期、导出 HTML 任职证明（可打印）。"""
from datetime import date
from html import escape

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user, get_class, require_student
from ..exceptions import BizError, ok
from ..models import Committee, Student, User

router = APIRouter(prefix="/api/committee", tags=["班委名单"])

POSITIONS = ["班长", "副班长", "学习委员", "纪律委员", "卫生委员", "体育委员",
             "文艺委员", "生活委员", "宣传委员", "心理委员"]


class CommitteeIn(BaseModel):
    class_id: int
    student_id: int
    position: str
    start_date: date = None
    end_date: date = None


class CommitteeUpdate(BaseModel):
    student_id: int = None
    position: str = None
    start_date: date = None
    end_date: date = None


def _to_dict(c: Committee) -> dict:
    stu = c.student
    return {"id": c.id, "class_id": c.class_id, "student_id": c.student_id,
            "student_name": stu.name if stu else "（学生已删除）",
            "position": c.position, "start_date": str(c.start_date),
            "end_date": str(c.end_date) if c.end_date else ""}


@router.get("")
def list_committee(class_id: int = Query(...),
                   user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    get_class(db, class_id)
    items = db.query(Committee).join(Student, Student.id == Committee.student_id).filter(
        Committee.class_id == class_id,
        Committee.is_deleted.is_(False),
        Student.is_deleted.is_(False),
    ).order_by(Committee.position).all()
    return ok([_to_dict(c) for c in items])


@router.post("")
def create_committee(body: CommitteeIn, user: User = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    get_class(db, body.class_id)
    if body.position not in POSITIONS:
        raise BizError(f"职位必须是 {'/'.join(POSITIONS)} 之一")
    stu = require_student(db, body.student_id, body.class_id)
    # 同一职位同一时段不重复任职
    exist = db.query(Committee).filter(
        Committee.class_id == body.class_id, Committee.position == body.position,
        Committee.is_deleted.is_(False),
        Committee.student_id == body.student_id).first()
    if exist:
        raise BizError(f"{body.position} 已由 {stu.name} 担任")
    c = Committee(**body.model_dump())
    db.add(c)
    db.commit()
    return ok(_to_dict(c), message=f"已任命 {stu.name} 为{body.position}")


@router.put("/{cid}")
def update_committee(cid: int, body: CommitteeUpdate,
                     user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    c = db.query(Committee).filter(Committee.id == cid,
                                   Committee.is_deleted.is_(False)).first()
    if not c:
        raise BizError("班委记录不存在", code=404)
    data = body.model_dump(exclude_unset=True)
    if "position" in data and data["position"] not in POSITIONS:
        raise BizError(f"职位必须是 {'/'.join(POSITIONS)} 之一")
    if "student_id" in data:
        require_student(db, data["student_id"], c.class_id)
    for k, v in data.items():
        setattr(c, k, v)
    db.commit()
    return ok(_to_dict(c), message="更新成功")


@router.delete("/{cid}")
def delete_committee(cid: int, user: User = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    c = db.query(Committee).filter(Committee.id == cid,
                                   Committee.is_deleted.is_(False)).first()
    if not c:
        raise BizError("班委记录不存在", code=404)
    c.is_deleted = True
    db.commit()
    return ok(message="已免职（软删除）")


@router.get("/{cid}/certificate")
def certificate(cid: int, user: User = Depends(get_current_user),
                db: Session = Depends(get_db)):
    """生成可打印的 HTML 任职证明。"""
    c = db.query(Committee).filter(Committee.id == cid,
                                   Committee.is_deleted.is_(False)).first()
    if not c:
        raise BizError("班委记录不存在", code=404)
    cls = get_class(db, c.class_id)
    stu = require_student(db, c.student_id, c.class_id)
    end = c.end_date.strftime("%Y年%m月%d日") if c.end_date else "（至今）"
    student_name = escape(stu.name)
    student_no = escape(stu.student_no)
    class_name = escape(cls.name)
    position = escape(c.position)
    html = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>任职证明 - {student_name}</title>
<style>
  body {{ font-family: "SimSun", "宋体", serif; padding: 60px 80px; color: #222; }}
  h1 {{ text-align: center; letter-spacing: 8px; font-size: 28px; margin-bottom: 50px; }}
  .content {{ font-size: 18px; line-height: 2.2; text-indent: 2em; }}
  .name {{ font-weight: bold; }}
  .footer {{ margin-top: 80px; text-align: right; font-size: 16px; }}
</style></head><body>
<h1>任 职 证 明</h1>
<div class="content">
兹证明 <span class="name">{student_name}</span>（学号：{student_no}），
系 <span class="name">{class_name}</span> 学生。该生于
<span class="name">{c.start_date.strftime('%Y年%m月%d日')}</span> 至
<span class="name">{end}</span> 期间，担任班级
<span class="name">{position}</span> 一职。任职期间工作认真负责，表现良好。
</div>
<div class="footer">
班主任（签字）：________<br>
{class_name}　{date.today().strftime('%Y年%m月%d日')}
</div>
<script>window.onload = function(){{ setTimeout(function(){{ window.print(); }}, 300); }}</script>
</body></html>"""
    from fastapi.responses import HTMLResponse
    return HTMLResponse(content=html)
