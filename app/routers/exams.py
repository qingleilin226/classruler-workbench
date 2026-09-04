# -*- coding: utf-8 -*-
"""成绩分析：考试管理、手动录入、统计看板（均分/最高/及格率 + ECharts 分布 + 明细）、
排名按科目计算并回写。"""
from datetime import date

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user, get_class, require_semester, require_student
from ..exceptions import BizError, ok
from ..models import ExamRecord, Score, Semester, Student, User
from ..utils.excel_export import export_excel

router = APIRouter(prefix="/api/exams", tags=["成绩分析"])
MIN_SCORE = -1000
MAX_SCORE = 750


class ExamIn(BaseModel):
    class_id: int
    semester_id: int
    name: str
    exam_date: date
    subjects: list = Field(default_factory=list)


class ScoreItem(BaseModel):
    student_id: int
    subject: str = Field(min_length=1, max_length=32)
    score: float = Field(ge=MIN_SCORE, le=MAX_SCORE)


class ScoreIn(BaseModel):
    exam_id: int
    scores: list[ScoreItem]


def _score_to_dict(s: Score) -> dict:
    return {"id": s.id, "student_id": s.student_id, "subject": s.subject,
            "score": s.score, "rank": s.rank}


def recalc_ranks(db: Session, exam_id: int) -> None:
    """按科目计算并回写并列排名，避免数据库方言相关的布尔 SQL。"""
    exam = db.query(ExamRecord).filter(ExamRecord.id == exam_id).first()
    if not exam:
        return
    scores = db.query(Score).join(Student, Student.id == Score.student_id).filter(
        Score.exam_record_id == exam_id,
        Score.is_deleted.is_(False),
        Student.class_id == exam.class_id,
        Student.is_deleted.is_(False),
    ).order_by(Score.subject, Score.score.desc(), Score.id).all()
    by_subject = {}
    for score in scores:
        by_subject.setdefault(score.subject, []).append(score)
    for items in by_subject.values():
        last_score = None
        last_rank = 0
        for position, item in enumerate(items, start=1):
            if item.score != last_score:
                last_rank = position
                last_score = item.score
            item.rank = last_rank


@router.get("")
def list_exams(class_id: int = Query(...), semester_id: int = Query(...),
               user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    get_class(db, class_id)
    require_semester(db, semester_id, class_id)
    exams = db.query(ExamRecord).filter(
        ExamRecord.class_id == class_id, ExamRecord.semester_id == semester_id,
        ExamRecord.is_deleted.is_(False)
    ).order_by(ExamRecord.exam_date.desc(), ExamRecord.id.desc()).all()
    result = []
    for e in exams:
        active_scores = db.query(Score).join(
            Student, Student.id == Score.student_id
        ).filter(
            Score.exam_record_id == e.id,
            Score.is_deleted.is_(False),
            Student.class_id == e.class_id,
            Student.is_deleted.is_(False),
        )
        subjects = [row[0] for row in active_scores.with_entities(Score.subject)
                    .distinct().order_by(Score.subject).all()]
        result.append({"id": e.id, "name": e.name, "exam_date": str(e.exam_date),
                       "subjects": subjects,
                       "score_count": active_scores.count()})
    return ok(result)


@router.get("/student-history")
def student_score_history(
    class_id: int = Query(...),
    student_id: int = Query(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """个人成绩分析：返回学生在当前班级全部历史考试中的分数和排名。"""
    get_class(db, class_id)
    student = require_student(db, student_id, class_id)
    exams = db.query(ExamRecord).filter(
        ExamRecord.class_id == class_id,
        ExamRecord.is_deleted.is_(False),
    ).order_by(ExamRecord.exam_date, ExamRecord.id).all()

    exam_ids = [exam.id for exam in exams]
    scores = []
    if exam_ids:
        scores = db.query(Score).filter(
            Score.student_id == student.id,
            Score.exam_record_id.in_(exam_ids),
            Score.is_deleted.is_(False),
        ).order_by(Score.exam_record_id, Score.id).all()

    score_map = {}
    subjects = []
    for score in scores:
        score_map[(score.exam_record_id, score.subject)] = score
        if score.subject not in subjects:
            subjects.append(score.subject)

    semester_ids = {exam.semester_id for exam in exams}
    semesters = {}
    if semester_ids:
        semesters = {
            semester.id: semester.name
            for semester in db.query(Semester).filter(
                Semester.id.in_(semester_ids),
                Semester.class_id == class_id,
                Semester.is_deleted.is_(False),
            ).all()
        }

    records = []
    for exam in exams:
        values = {}
        for subject in subjects:
            score = score_map.get((exam.id, subject))
            if score:
                values[subject] = {"score": score.score, "rank": score.rank}
        records.append({
            "exam_id": exam.id,
            "exam_name": exam.name,
            "exam_date": str(exam.exam_date),
            "semester_id": exam.semester_id,
            "semester_name": semesters.get(exam.semester_id, ""),
            "scores": values,
        })

    return ok({
        "student": {
            "id": student.id,
            "name": student.name,
            "student_no": student.student_no,
            "class_id": student.class_id,
        },
        "subjects": subjects,
        "records": records,
        "exam_count": len(exams),
        "score_count": len(scores),
    })


@router.post("")
def create_exam(body: ExamIn, user: User = Depends(get_current_user),
                db: Session = Depends(get_db)):
    get_class(db, body.class_id)
    require_semester(db, body.semester_id, body.class_id)
    exam = ExamRecord(class_id=body.class_id, semester_id=body.semester_id,
                      name=body.name, exam_date=body.exam_date)
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
        sid, subject, score = item.student_id, item.subject.strip(), item.score
        require_student(db, sid, exam.class_id)
        exist = db.query(Score).filter(
            Score.exam_record_id == exam.id, Score.student_id == sid,
            Score.subject == subject).first()
        if exist:
            exist.score = score
            exist.is_deleted = False
        else:
            db.add(Score(exam_record_id=exam.id, student_id=sid,
                         subject=subject, score=score))
    # Session 关闭了 autoflush；排名计算前必须显式 flush，并保持一次原子提交。
    db.flush()
    recalc_ranks(db, exam.id)
    db.commit()
    return ok(message="成绩录入成功，排名已自动计算")


@router.post("/{exam_id}/recalc-rank")
def recalc_rank_api(exam_id: int, user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    exam = db.query(ExamRecord).filter(
        ExamRecord.id == exam_id,
        ExamRecord.is_deleted.is_(False),
    ).first()
    if not exam:
        raise BizError("考试不存在", code=404)
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

    q = db.query(Score).join(Student, Student.id == Score.student_id).filter(
        Score.exam_record_id == exam_id,
        Score.is_deleted.is_(False),
        Student.class_id == exam.class_id,
        Student.is_deleted.is_(False),
    )
    if subject:
        q = q.filter(Score.subject == subject)
    scores = q.all()
    if not scores:
        return ok({"exam": {"id": exam.id, "name": exam.name}, "subject": subject,
                   "stats": {"avg": None, "max": None, "pass_rate": None, "count": 0},
                   "distribution": [], "detail": [], "subjects": []})

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
    subject_list = sorted({s.subject for s in scores})
    if subject:
        subject_list = [subject] if subject in subject_list else []

    # 排名只基于当前仍有效的学生，与统计卡片和明细保持同一口径。
    rank_map = {}
    for sub in subject_list:
        items = sorted((s for s in scores if s.subject == sub),
                       key=lambda s: (-s.score, s.id))
        last_score = None
        last_rank = 0
        for position, item in enumerate(items, start=1):
            if item.score != last_score:
                last_rank = position
                last_score = item.score
            rank_map[(item.student_id, sub)] = last_rank

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
