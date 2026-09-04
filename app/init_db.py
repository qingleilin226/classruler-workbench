# -*- coding: utf-8 -*-
"""数据库初始化：建表 + 种子数据（3 个预设班级、学期、学生、座次、成绩、值日、班委、课表）。"""
import logging
from datetime import date, timedelta

from sqlalchemy import text
from sqlalchemy.orm import Session

from .config import ADMIN_PASSWORD, ADMIN_USERNAME
from .database import Base, SessionLocal, engine
from .models import (
    Class, Committee, DutyDetail, DutyTemplate, ExamRecord, Score, SeatDetail,
    SeatPlan, Semester, Student, TimetableCell, User,
)
from .security import encrypt_phone, hash_password

logger = logging.getLogger("class_manager")

# 常见姓氏/名字，用于生成示例学生
_SURNAMES = list("赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜")
_GIVEN_1 = list("伟芳娜敏静丽强磊军洋勇艳杰娟涛明超秀兰霞平刚桂英玉")
_GIVEN_2 = list("华建国文辉力明永红建华雪文婷博轩子涵雨欣浩然晨曦梓萱宇航欣怡诗涵")


def _gen_names(count):
    names = []
    used = set()
    i = 0
    while len(names) < count:
        s = _SURNAMES[i % len(_SURNAMES)]
        g = _GIVEN_1[(i * 3 + 1) % len(_GIVEN_1)] + _GIVEN_2[(i * 5 + 2) % len(_GIVEN_2)]
        name = s + g[:1] + (g[1:] if i % 2 else "")
        if name not in used:
            used.add(name)
            names.append(name)
        i += 1
    return names


def init_db(force_seed: bool = False) -> None:
    Base.metadata.create_all(bind=engine)
    _migrate_student_unique_index()
    _migrate_score_type()
    db = SessionLocal()
    try:
        # 管理员
        if not db.query(User).filter(User.username == ADMIN_USERNAME).first():
            db.add(User(username=ADMIN_USERNAME,
                        password_hash=hash_password(ADMIN_PASSWORD),
                        display_name="系统管理员"))
            db.commit()
            logger.info("已创建默认管理员账号: %s", ADMIN_USERNAME)

        # 已有班级则跳过种子数据
        if db.query(Class).count() > 0 and not force_seed:
            return

        _seed(db)
        db.commit()
        logger.info("种子数据初始化完成")
    finally:
        db.close()


def _migrate_student_unique_index() -> None:
    """把旧版全量唯一索引升级为仅约束未删除学生的部分唯一索引。"""
    dialect = engine.dialect.name
    with engine.begin() as conn:
        if dialect == "sqlite":
            row = conn.execute(text(
                "SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_student_no'"
            )).fetchone()
            definition = (row[0] or "") if row else ""
            if row and " WHERE " not in definition.upper():
                conn.execute(text("DROP INDEX uq_student_no"))
                conn.execute(text(
                    "CREATE UNIQUE INDEX uq_student_no "
                    "ON students (class_id, student_no) WHERE is_deleted = 0"
                ))
        elif dialect == "postgresql":
            row = conn.execute(text(
                "SELECT indexdef FROM pg_indexes "
                "WHERE schemaname = current_schema() AND indexname = 'uq_student_no'"
            )).fetchone()
            definition = (row[0] or "") if row else ""
            if row and " WHERE " not in definition.upper():
                conn.execute(text("DROP INDEX uq_student_no"))
                conn.execute(text(
                    "CREATE UNIQUE INDEX uq_student_no "
                    "ON students (class_id, student_no) WHERE is_deleted = false"
                ))


def _migrate_score_type() -> None:
    """PostgreSQL 旧库把成绩存为整数；升级为双精度以支持小数成绩。"""
    if engine.dialect.name != "postgresql":
        return
    with engine.begin() as conn:
        row = conn.execute(text(
            "SELECT data_type FROM information_schema.columns "
            "WHERE table_schema = current_schema() "
            "AND table_name = 'scores' AND column_name = 'score'"
        )).fetchone()
        if row and row[0] in {"smallint", "integer", "bigint"}:
            conn.execute(text(
                "ALTER TABLE scores ALTER COLUMN score TYPE DOUBLE PRECISION "
                "USING score::double precision"
            ))


def _seed(db: Session) -> None:
    # ---------- 班级与学期 ----------
    class_specs = [
        ("2024级", "2024级3班", "2024-2025", 30),
        ("2024级", "2024级4班", "2024-2025", 12),
        ("2023级", "2023级2班", "2024-2025", 10),
    ]
    semester_specs = [
        ("第一学期", date(2024, 9, 1), date(2025, 1, 15), True),
        ("第二学期", date(2025, 2, 10), date(2025, 7, 5), False),
    ]

    for grade, cls_name, year, student_count in class_specs:
        cls = Class(grade=grade, name=cls_name, academic_year=year)
        db.add(cls)
        db.flush()

        # 学期
        for name, start, end, active in semester_specs:
            db.add(Semester(class_id=cls.id, name=name, start_date=start,
                            end_date=end, is_active=active))

        # 学生
        students = []
        for idx, name in enumerate(_gen_names(student_count), start=1):
            stu = Student(
                class_id=cls.id,
                name=name,
                gender="男" if idx % 3 != 0 else "女",
                student_no=f"{year.split('-')[0][-2:]}{cls.id:02d}{idx:03d}",
                birth_date=date(2007, (idx % 12) + 1, (idx % 28) + 1),
                status="在读",
                guardian_name=("父亲" if idx % 3 != 0 else "母亲") + "家长",
                guardian_phone=encrypt_phone(f"138{idx:08d}"),
                address=f"{cls_name}学生家庭住址示例{idx}号",
            )
            db.add(stu)
            students.append(stu)
        db.flush()

        # 只给第一个班级铺设完整的座次/成绩/值日/班委/课表演示数据
        if cls.name == "2024级3班":
            _seed_rich_demo(db, cls, students)


def _seed_rich_demo(db: Session, cls: Class, students) -> None:
    semester = db.query(Semester).filter(
        Semester.class_id == cls.id, Semester.name == "第一学期").first()

    # ---------- 座次（8列 x 4行，30 名学生） ----------
    plan = SeatPlan(class_id=cls.id, semester_id=semester.id,
                    effective_date=date(2024, 9, 1), remark="开学初排布")
    db.add(plan)
    db.flush()
    for i, stu in enumerate(students[:30]):
        db.add(SeatDetail(seat_plan_id=plan.id, student_id=stu.id,
                          row=(i // 8) + 1, col=(i % 8) + 1))

    # ---------- 成绩：期中考试（语文/数学/英语），按分数分布生成 ----------
    import random
    random.seed(42)
    for exam_name, exam_date in [("期中考试", date(2024, 11, 8)), ("期末考试", date(2025, 1, 10))]:
        exam = ExamRecord(class_id=cls.id, semester_id=semester.id,
                          name=exam_name, exam_date=exam_date)
        db.add(exam)
        db.flush()
        subjects = [("语文", 120), ("数学", 120), ("英语", 120)]
        if exam_name == "期中考试":
            subjects += [("物理", 100), ("化学", 100)]
        for stu in students:
            for sub, full in subjects:
                # 模拟成绩：均分约 0.72 满分，个别低分
                base = int(full * (0.55 + random.random() * 0.4))
                score = max(0, min(full, base))
                db.add(Score(exam_record_id=exam.id, student_id=stu.id,
                             subject=sub, score=score))

    # ---------- 值日：周一到周五，每类 2 人轮换 ----------
    duty_types = ["扫地", "擦黑板", "擦窗"]
    template = DutyTemplate(class_id=cls.id, template_type="week_cycle")
    db.add(template)
    db.flush()
    for weekday in range(1, 6):
        for dtype in duty_types:
            base = (weekday - 1) * 3 + duty_types.index(dtype)
            db.add(DutyDetail(template_id=template.id, weekday=weekday,
                              student_id=students[base % len(students)].id,
                              duty_type=dtype))

    # ---------- 班委 ----------
    positions = ["班长", "学习委员", "纪律委员", "卫生委员", "体育委员", "文艺委员", "生活委员"]
    for i, pos in enumerate(positions):
        db.add(Committee(class_id=cls.id, student_id=students[i].id, position=pos,
                         start_date=date(2024, 9, 1), end_date=date(2025, 7, 1)))

    # ---------- 课程表（7 节 x 5 天） ----------
    plan_grid = [
        ["语文", "数学", "英语", "语文", "数学"],
        ["数学", "语文", "数学", "英语", "语文"],
        ["英语", "物理", "化学", "数学", "英语"],
        ["物理", "化学", "语文", "物理", "化学"],
        ["化学", "英语", "物理", "化学", "物理"],
        ["生物", "历史", "地理", "政治", "生物"],
        ["体育", "美术", "音乐", "班会", "劳动"],
    ]
    for period, row in enumerate(plan_grid, start=1):
        for weekday, course in enumerate(row, start=1):
            db.add(TimetableCell(class_id=cls.id, semester_id=semester.id,
                                 weekday=weekday, period=period, course_name=course))
