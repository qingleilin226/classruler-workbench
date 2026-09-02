# -*- coding: utf-8 -*-
"""成绩分析：考试管理、手动录入、统计看板（均分/最高/及格率 + ECharts 分布 + 明细）、
排名由数据库窗口函数计算并回写。"""
from datetime import date

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user, get_class, require_semester
from ..exceptions import BizError, ok
from ..models import ExamRecord, Score, Student, User
from ..utils.excel_export import export_excel

router = APIRouter(prefix="/api/exams", tags=["成绩分析"])


class ExamIn(BaseModel):
    class_id: int
    semester_id: int
    name: str
    exam_date: date = None
    subjects: list = []


class ScoreIn(BaseModel):
    exam_id: int
    scores: list   # [{student_id, subject, score}]


def _score_to_dict(s: Score) -> dict:
    return {"id": s.id, "student_id": s.student_id, "subject": s.subject,
            "score": s.score, "rank": s.rank}


def recalc_ranks(db: Session, exam_id: int) -> None:
    """窗口函数计算班级排名：RANK() OVER (PARTITION BY exam, subject ORDER BY score DESC)"""
    from sqlalchemy import text
    sql = text("""
        SELECT id,
               RANK() OVER (PARTITION BY exam_record_id, subject ORDER BY score DESC) AS rk
        FROM scores
        WHERE exam_record_id = :eid AND is_deleted = 0
    """)
    rows = db.execute(sql, {"eid": exam_id}).fetchall()
    for row in rows:
        s = db.get(Score, row.id)
        if s and s.rank != row.rk:
            s.rank = row.rk


@router.get("")
def list_exams(class_id: int = Query(...), semester_id: int = Query(...),
               user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    get_class(db, class_id)
    exams = db.query(ExamRecord).filter(
        ExamRecord.class_id == class_id, ExamRecord.semester_id == semester_id,
        ExamRecord.is_deleted.is_(False)
    ).order_by(ExamRecord.exam_date.desc(), ExamRecord.id.desc()).all()
    result = []
    for e in exams:
        subjects = [s.subject for s in
                    db.query(Score.subject).filter(Score.exam_record_id == e.id,
                                                   Score.is_deleted.is_(False))
                    .distinct().order_by(Score.subject).all()]
        result.append({"id": e.id, "name": e.name, "exam_date": str(e.exam_date),
                       "subjects": subjects,
                       "score_count": db.query(Score).filter(
                           Score.exam_record_id == e.id,
                           Score.is_deleted.is_(False)).count()})
    return ok(result)


@router.post("")
def create_exam(body: ExamIn, user: User = Depends(get_current_user),
                db: Session = Depends(get_db)):
    get_class(db, body.class_id)
    require_semester(db, body.semester_id, body.class_id)
    exam = ExamRecord(class_id=body.class_id, semester_id=body.semester_id,
                      name=body.name, exam_date=body.exam_date or date.today())
    db.add(exam)
    db.commit()
    return ok({"id": exam.id}, message=f"考试「{body.name}」已创建")


@router.post("/scores")
def add_scores(body: ScoreIn, user: User = Depends(get_current_user),
               db: Session = Depends(get_db)):
    """手动逐行录入/更新成绩。"""
    exam = db.query(ExamRecord).filter(ExamRecord.id == body.exam_id,
                                       ExamRecord.is_deleted.is_(False)).first()
    if not exam:
        raise BizError("考试不存在", code=404)
    if not body.scores:
        raise BizError("没有要录入的成绩")
    for item in body.scores:
        sid, subject, score = item.get("student_id"), item.get("subject"), item.get("score")
        if not all([sid, subject]):
            raise BizError("成绩记录缺少学生或科目")
        if not (0 <= score <= 200):
            raise BizError(f"分数必须在 0-200 之间: {score}")
        exist = db.query(Score).filter(
            Score.exam_record_id == exam.id, Score.student_id == sid,
            Score.subject == subject, Score.is_deleted.is_(False)).first()
        if exist:
            exist.score = score
        else:
            db.add(Score(exam_record_id=exam.id, student_id=sid,
                         subject=subject, score=score))
    db.commit()
    recalc_ranks(db, exam.id)
    db.commit()
    return ok(message="成绩录入成功，排名已自动计算")


@router.post("/{exam_id}/recalc-rank")
def recalc_rank_api(exam_id: int, user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    recalc_ranks(db, exam_id)
    db.commit()
    return ok(message="排名已重新计算")


@router.delete("/{exam_id}")
def delete_exam(exam_id: int, user: User = Depends(get_current_user),
                db: Session = Depends(get_db)):
    exam = db.query(ExamRecord).filter(ExamRecord.id == exam_id,
                                       ExamRecord.is_deleted.is_(False)).first()
    if not exam:
        raise BizError("考试不存在", code=404)
    exam.is_deleted = True
    db.query(Score).filter(Score.exam_record_id == exam_id).update({"is_deleted": True})
    db.commit()
    return ok(message="考试已删除（软删除）")


@router.get("/analysis")
def exam_analysis(
    exam_id: int = Query(...),
    subject: str = Query("", description="科目，空为全部"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """成绩看板：①统计卡片 ②分数分布 ③学生明细。"""
    exam = db.query(ExamRecord).filter(ExamRecord.id == exam_id,
                                       ExamRecord.is_deleted.is_(False)).first()
    if not exam:
        raise BizError("考试不存在", code=404)

    q = db.query(Score).filter(Score.exam_record_id == exam_id,
                               Score.is_deleted.is_(False))
    if subject:
        q = q.filter(Score.subject == subject)
    scores = q.all()
    if not scores:
        return ok({"exam": {"id": exam.id, "name": exam.name}, "subject": subject,
                   "stats": None, "distribution": [], "detail": []})

    # ① 统计卡片
    values = [s.score for s in scores]
    avg = round(sum(values) / len(values), 1)
    max_score = max(values)
    pass_count = sum(1 for v in values if v >= 60)
    pass_rate = round(pass_count / len(values) * 100, 1)

    # ② 分数分布（ECharts 柱状图）
    bins = [(0, 59), (60, 69), (70, 79), (80, 89), (90, 100), (101, 999)]
    labels = ["0-59", "60-69", "70-79", "80-89", "90-100", "100+"]
    dist = []
    for (lo, hi), label in zip(bins, labels):
        cnt = sum(1 for v in values if lo <= v <= hi)
        dist.append({"range": label, "count": cnt})

    # ③ 学生明细：行=学生，列=科目，含排名
    students = db.query(Student).filter(
        Student.class_id == exam.class_id, Student.is_deleted.is_(False)
    ).order_by(Student.student_no).all()
    subject_list = []
    for s in db.query(Score.subject).filter(
            Score.exam_record_id == exam_id, Score.is_deleted.is_(False)
    ).distinct().order_by(Score.subject).all():
        subject_list.append(s[0])
    if subject:
        subject_list = [subject] if subject in subject_list else []

    # 排名实时计算：窗口函数 RANK() OVER (PARTITION BY subject ORDER BY score DESC)
    from sqlalchemy import text
    rank_sql = text("""
        SELECT student_id, subject,
               RANK() OVER (PARTITION BY subject ORDER BY score DESC) AS rk
        FROM scores
        WHERE exam_record_id = :eid AND is_deleted = 0
    """)
    rank_map = {(r[0], r[1]): r[2] for r in db.execute(rank_sql, {"eid": exam_id})}

    score_map = {(s.student_id, s.subject): s for s in scores}
    detail = []
    for stu in students:
        row = {"student_id": stu.id, "name": stu.name, "student_no": stu.student_no}
        for sub in subject_list:
            s = score_map.get((stu.id, sub))
            row[sub] = {"score": s.score, "rank": rank_map.get((stu.id, sub), s.rank)} if s else None
        detail.append(row)

    return ok({
        "exam": {"id": exam.id, "name": exam.name, "exam_date": str(exam.exam_date)},
        "subject": subject,
        "stats": {"avg": avg, "max": max_score, "pass_rate": pass_rate, "count": len(values)},
        "distribution": dist,
        "detail": detail,
        "subjects": subject_list,
    })


@router.get("/export")
def export_analysis(
    exam_id: int = Query(...),
    subject: str = Query(""),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    data = exam_analysis(exam_id=exam_id, subject=subject, user=user, db=db)["data"]
    headers = ["学号", "姓名"] + [s for s in data["subjects"]] + ["总分"]
    rows = []
    for d in data["detail"]:
        total = 0
        row = [d["student_no"], d["name"]]
        for sub in data["subjects"]:
            v = d.get(sub)
            if v:
                row.append(f"{v['score']}(第{v['rank']}名)")
                total += v["score"]
            else:
                row.append("-")
        row.append(total if total else "-")
        rows.append(row)
    content = export_excel(headers, rows, sheet_name=data["exam"]["name"])
    return Response(content=content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": "attachment; filename=exam_analysis.xlsx"})
