import sqlite3
from datetime import date

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.exceptions import BizError
from app.models import (
    Class, DutyDetail, DutyTemplate, ExamRecord, Score, Semester, Student,
    TimetableCell, User,
)
from app.routers.duty import _week_view
from app.routers.exams import (
    ScoreIn, ScoreItem, add_scores, exam_analysis, student_score_history,
)
from app.routers.imports import (
    MappingRecallIn, _confirm_exam_scores, _confirm_students, _preview_exam_scores,
    recall_mapping, save_mapping,
)
from app.routers.timetable import ImportTimetableIn, import_timetable
from app.security import create_token, parse_token, password_version
from app.tasks import _backup_sqlite


@pytest.fixture()
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _class_with_semester(db, name):
    cls = Class(grade="2026级", name=name, academic_year="2026-2027")
    db.add(cls)
    db.flush()
    semester = Semester(
        class_id=cls.id,
        name="第一学期",
        start_date=date(2026, 9, 1),
        end_date=date(2027, 1, 15),
        is_active=True,
    )
    db.add(semester)
    db.flush()
    return cls, semester


def test_sqlite_backup_includes_committed_wal_data(tmp_path):
    source_path = tmp_path / "source.db"
    target_path = tmp_path / "backup.db"
    source = sqlite3.connect(source_path)
    try:
        source.execute("PRAGMA journal_mode=WAL")
        source.execute("CREATE TABLE sample (value TEXT NOT NULL)")
        source.execute("INSERT INTO sample VALUES ('latest')")
        source.commit()

        _backup_sqlite(source_path, target_path)

        with sqlite3.connect(target_path) as backup:
            assert backup.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            assert backup.execute("SELECT value FROM sample").fetchone()[0] == "latest"
    finally:
        source.close()


def test_password_change_invalidates_old_token():
    token = create_token(1, "old-password-hash")
    payload = parse_token(token)
    assert payload["pwdv"] == password_version("old-password-hash")
    assert payload["pwdv"] != password_version("new-password-hash")


def test_score_rejects_student_from_another_class(db):
    cls1, semester = _class_with_semester(db, "一班")
    cls2, _ = _class_with_semester(db, "二班")
    student = Student(class_id=cls2.id, name="测试学生", gender="男", student_no="2001")
    exam = ExamRecord(class_id=cls1.id, semester_id=semester.id,
                      name="测试考试", exam_date=date.today())
    user = User(username="tester", password_hash="unused")
    db.add_all([student, exam, user])
    db.commit()

    body = ScoreIn(exam_id=exam.id, scores=[
        {"student_id": student.id, "subject": "语文", "score": 90}
    ])
    with pytest.raises(BizError, match="不属于当前班级"):
        add_scores(body, user=user, db=db)


def test_score_accepts_progress_from_minus_1000_to_total_750():
    assert ScoreItem(student_id=1, subject="数学", score=89.5).score == 89.5
    assert ScoreItem(student_id=1, subject="进/退", score=-1000).score == -1000
    assert ScoreItem(student_id=1, subject="六门总分", score=750).score == 750
    with pytest.raises(ValueError):
        ScoreItem(student_id=1, subject="进/退", score=-1000.1)
    with pytest.raises(ValueError):
        ScoreItem(student_id=1, subject="六门总分", score=750.1)


def test_manual_score_restores_soft_deleted_row_atomically(db):
    cls, semester = _class_with_semester(db, "成绩恢复班")
    student = Student(class_id=cls.id, name="恢复同学", gender="男", student_no="7101")
    exam = ExamRecord(class_id=cls.id, semester_id=semester.id,
                      name="恢复考试", exam_date=date.today())
    user = User(username="restore-score-user", password_hash="unused")
    db.add_all([student, exam, user])
    db.flush()
    deleted_score = Score(exam_record_id=exam.id, student_id=student.id,
                          subject="数学", score=60, is_deleted=True)
    db.add(deleted_score)
    db.commit()
    old_id = deleted_score.id

    add_scores(ScoreIn(exam_id=exam.id, scores=[{
        "student_id": student.id, "subject": "数学", "score": 95.5,
    }]), user=user, db=db)

    scores = db.query(Score).filter(Score.exam_record_id == exam.id).all()
    assert len(scores) == 1
    assert scores[0].id == old_id
    assert scores[0].is_deleted is False
    assert scores[0].score == 95.5
    assert scores[0].rank == 1


def test_exam_import_accepts_decimal_subjects_and_totals(db):
    cls, semester = _class_with_semester(db, "成绩导入班")
    student = Student(class_id=cls.id, name="导入学生", gender="女", student_no="7001")
    exam = ExamRecord(class_id=cls.id, semester_id=semester.id,
                      name="导入考试", exam_date=date.today())
    user = User(username="importer", password_hash="unused")
    db.add_all([student, exam, user])
    db.commit()
    sheet = {
        "headers": ["学号", "姓名", "数学", "语数英总分", "六门总分", "进/退"],
        "rows": [["7001", "导入学生", "89.5", "215.5", "416.5", "-26"]],
        "eff_header_row": 2,
    }
    mapping = {"0": "student_no", "1": "name", "2": "数学",
               "3": "语数英总分", "4": "六门总分", "5": "进/退"}

    preview = _preview_exam_scores(sheet, mapping, db, {"exam_id": exam.id})
    assert preview["error_count"] == 0
    result = _confirm_exam_scores(sheet, mapping, {"exam_id": exam.id}, db, user)
    db.commit()

    assert result["inserted"] == 4
    values = {score.subject: score.score for score in db.query(Score).all()}
    assert values == {
        "数学": 89.5,
        "语数英总分": 215.5,
        "六门总分": 416.5,
        "进/退": -26.0,
    }


def test_new_exam_import_requires_and_uses_manual_exam_date(db):
    cls, semester = _class_with_semester(db, "导入日期班")
    student = Student(class_id=cls.id, name="日期同学", gender="男", student_no="8101")
    user = User(username="date-importer", password_hash="unused")
    db.add_all([student, user])
    db.commit()
    sheet = {
        "headers": ["学号", "姓名", "数学"],
        "rows": [["8101", "日期同学", "92.5"]],
        "eff_header_row": 1,
    }
    mapping = {"0": "student_no", "1": "name", "2": "数学"}
    extra = {
        "class_id": cls.id,
        "semester_id": semester.id,
        "exam_name": "九月月考",
    }

    with pytest.raises(BizError, match="实际考试日期"):
        _preview_exam_scores(sheet, mapping, db, extra)

    extra["exam_date"] = "2026-09-18"
    preview = _preview_exam_scores(sheet, mapping, db, extra)
    assert preview["error_count"] == 0
    result = _confirm_exam_scores(sheet, mapping, extra, db, user)
    db.commit()

    exam = db.get(ExamRecord, result["exam_id"])
    assert exam.name == "九月月考"
    assert exam.exam_date == date(2026, 9, 18)


def test_student_score_history_contains_all_class_exams(db):
    cls, semester = _class_with_semester(db, "个人分析班")
    student = Student(class_id=cls.id, name="张同学", gender="女", student_no="8001")
    exam1 = ExamRecord(class_id=cls.id, semester_id=semester.id,
                       name="第一次考试", exam_date=date(2026, 9, 10))
    exam2 = ExamRecord(class_id=cls.id, semester_id=semester.id,
                       name="第二次考试", exam_date=date(2026, 10, 10))
    exam3 = ExamRecord(class_id=cls.id, semester_id=semester.id,
                       name="缺考记录", exam_date=date(2026, 11, 10))
    user = User(username="history-user", password_hash="unused")
    db.add_all([student, exam1, exam2, exam3, user])
    db.flush()
    db.add_all([
        Score(exam_record_id=exam1.id, student_id=student.id,
              subject="数学", score=80, rank=5),
        Score(exam_record_id=exam1.id, student_id=student.id,
              subject="六门总分", score=420.5, rank=8),
        Score(exam_record_id=exam2.id, student_id=student.id,
              subject="数学", score=91.5, rank=2),
    ])
    db.commit()

    data = student_score_history(
        class_id=cls.id, student_id=student.id, user=user, db=db,
    )["data"]

    assert data["student"]["student_no"] == "8001"
    assert data["subjects"] == ["数学", "六门总分"]
    assert [row["exam_name"] for row in data["records"]] == [
        "第一次考试", "第二次考试", "缺考记录",
    ]
    assert data["records"][0]["scores"]["六门总分"]["score"] == 420.5
    assert data["records"][1]["scores"]["数学"]["rank"] == 2
    assert data["records"][2]["scores"] == {}


def test_mapping_habit_recalled_by_header_after_columns_reordered(db):
    user = User(username="mapping-user", password_hash="unused")
    db.add(user)
    db.commit()
    save_mapping({
        "md5": "a" * 32,
        "target": "exam_scores",
        "headers": ["学号", "姓名", "六门总分", "进/退"],
        "mapping": {
            "0": "student_no",
            "1": "name",
            "2": "六门总分",
            "3": "__ignore__",
        },
    }, user=user, db=db)

    response = recall_mapping(MappingRecallIn(
        target="exam_scores",
        headers=["姓名", "六门总分", "学号", "进/退"],
    ), user=user, db=db)

    assert response["data"] == {
        "0": "name",
        "1": "六门总分",
        "2": "student_no",
        "3": "__ignore__",
    }


def test_student_import_restores_deleted_student_and_allows_duplicate_names(db):
    cls, _ = _class_with_semester(db, "名单恢复班")
    deleted = Student(class_id=cls.id, name="旧姓名", gender="男",
                      student_no="9001", is_deleted=True)
    db.add(deleted)
    db.commit()
    deleted_id = deleted.id
    sheet = {
        "headers": ["学号", "姓名", "性别"],
        "rows": [["9001", "同名学生", "男"], ["9002", "同名学生", "女"]],
        "eff_header_row": 1,
    }
    mapping = {"0": "student_no", "1": "name", "2": "gender"}

    result = _confirm_students(sheet, mapping, {}, {"class_id": cls.id}, db)
    db.commit()

    assert result == {
        "inserted": 1, "updated": 0, "restored": 1, "skipped": 0, "errors": [],
    }
    restored = db.get(Student, deleted_id)
    assert restored.is_deleted is False
    assert restored.name == "同名学生"
    assert db.query(Student).filter(Student.name == "同名学生").count() == 2


def test_exam_analysis_excludes_soft_deleted_students(db):
    cls, semester = _class_with_semester(db, "三班")
    active = Student(class_id=cls.id, name="有效学生", gender="女", student_no="3001")
    deleted = Student(class_id=cls.id, name="已删除学生", gender="男",
                      student_no="3002", is_deleted=True)
    exam = ExamRecord(class_id=cls.id, semester_id=semester.id,
                      name="测试考试", exam_date=date.today())
    user = User(username="tester2", password_hash="unused")
    db.add_all([active, deleted, exam, user])
    db.flush()
    db.add_all([
        Score(exam_record_id=exam.id, student_id=active.id, subject="语文", score=80),
        Score(exam_record_id=exam.id, student_id=deleted.id, subject="语文", score=100),
    ])
    db.commit()

    data = exam_analysis(exam.id, "语文", user=user, db=db)["data"]
    assert data["stats"] == {"avg": 80.0, "max": 80, "pass_rate": 100.0, "count": 1}
    assert [row["student_id"] for row in data["detail"]] == [active.id]


def test_soft_deleted_student_number_can_be_reused(db):
    cls, _ = _class_with_semester(db, "四班")
    db.add(Student(class_id=cls.id, name="旧学生", gender="男",
                   student_no="4001", is_deleted=True))
    db.add(Student(class_id=cls.id, name="新学生", gender="女",
                   student_no="4001", is_deleted=False))
    db.commit()
    assert db.query(Student).filter(Student.class_id == cls.id).count() == 2


def test_duty_view_ignores_deleted_details_and_does_not_create_on_get(db):
    cls, _ = _class_with_semester(db, "五班")
    student = Student(class_id=cls.id, name="值日生", gender="男", student_no="5001")
    db.add(student)
    db.commit()

    empty = _week_view(db, cls.id, 0)
    assert all(not items for items in empty["days"].values())
    assert db.query(DutyTemplate).count() == 0

    template = DutyTemplate(class_id=cls.id)
    db.add(template)
    db.flush()
    db.add_all([
        DutyDetail(template_id=template.id, weekday=1, student_id=student.id,
                   duty_type="扫地", is_deleted=False),
        DutyDetail(template_id=template.id, weekday=2, student_id=student.id,
                   duty_type="扫地", is_deleted=True),
    ])
    db.commit()
    view = _week_view(db, cls.id, 0)
    assert len(view["days"]["1"]) == 1
    assert view["days"]["2"] == []


def test_timetable_import_reuses_soft_deleted_unique_cells(db):
    cls, semester = _class_with_semester(db, "六班")
    old = TimetableCell(class_id=cls.id, semester_id=semester.id,
                        weekday=1, period=1, course_name="旧课", is_deleted=True)
    db.add(old)
    db.commit()

    body = ImportTimetableIn(
        class_id=cls.id,
        semester_id=semester.id,
        matrix=[["新课"]],
        weekday_map={"0": 1},
    )
    import_timetable(body, user=None, db=db)
    cells = db.query(TimetableCell).filter(
        TimetableCell.class_id == cls.id,
        TimetableCell.semester_id == semester.id,
    ).all()
    assert len(cells) == 1
    assert cells[0].course_name == "新课"
    assert cells[0].is_deleted is False
