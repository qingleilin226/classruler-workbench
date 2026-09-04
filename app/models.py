# -*- coding: utf-8 -*-
"""ORM 模型：严格按需求文档 10 张表设计 + 用户/班委/课表/调课补充表。
全部业务表带 is_deleted 软删除标记。"""
from datetime import date, datetime

from sqlalchemy import (
    Boolean, Column, Date, DateTime, Float, ForeignKey, Index, Integer, String,
    Text, UniqueConstraint, text,
)
from sqlalchemy.orm import relationship

from .database import Base


class TimestampMixin:
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)


# ---------------------------------------------------------------- 用户
class User(Base, TimestampMixin):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    username = Column(String(64), unique=True, nullable=False, index=True)
    password_hash = Column(String(256), nullable=False)
    display_name = Column(String(64), default="管理员")


# ---------------------------------------------------------------- 1. classes 班级
class Class(Base, TimestampMixin):
    __tablename__ = "classes"

    id = Column(Integer, primary_key=True)
    grade = Column(String(16), nullable=False)            # 如 "2024级"
    name = Column(String(64), nullable=False)             # 如 "2024级3班"
    academic_year = Column(String(16), nullable=False)    # 如 "2024-2025"
    is_deleted = Column(Boolean, default=False, nullable=False)

    students = relationship("Student", back_populates="class_")
    semesters = relationship("Semester", back_populates="class_")


# ---------------------------------------------------------------- 2. students 学生
class Student(Base, TimestampMixin):
    __tablename__ = "students"
    __table_args__ = (
        Index(
            "uq_student_no", "class_id", "student_no", unique=True,
            sqlite_where=text("is_deleted = 0"),
            postgresql_where=text("is_deleted = false"),
        ),
    )

    id = Column(Integer, primary_key=True)
    class_id = Column(Integer, ForeignKey("classes.id"), nullable=False, index=True)
    name = Column(String(64), nullable=False)
    gender = Column(String(8), nullable=False, default="男")   # 男/女
    student_no = Column(String(32), nullable=False)            # 学号（班内唯一）
    birth_date = Column(Date, nullable=True)
    status = Column(String(8), nullable=False, default="在读")  # 在读/休学/转学
    guardian_name = Column(String(64), nullable=True)
    guardian_phone = Column(Text, nullable=True)               # 密文存储
    address = Column(String(255), nullable=True)               # 家庭住址（备注字段）
    is_deleted = Column(Boolean, default=False, nullable=False)

    class_ = relationship("Class", back_populates="students")
    seat_details = relationship("SeatDetail", back_populates="student")


# ---------------------------------------------------------------- 3. semesters 学期
class Semester(Base, TimestampMixin):
    __tablename__ = "semesters"
    __table_args__ = (
        # 同一班级最多一个激活学期（部分唯一索引）
        Index("uq_active_semester", "class_id", unique=True,
              sqlite_where=text("is_active = 1 AND is_deleted = 0")),
    )

    id = Column(Integer, primary_key=True)
    class_id = Column(Integer, ForeignKey("classes.id"), nullable=False, index=True)
    name = Column(String(32), nullable=False)                 # 如 "第一学期"
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=False)
    is_active = Column(Boolean, default=False, nullable=False)
    is_deleted = Column(Boolean, default=False, nullable=False)

    class_ = relationship("Class", back_populates="semesters")


# ---------------------------------------------------------------- 4/5. 座次历史
class SeatPlan(Base, TimestampMixin):
    __tablename__ = "seat_plans"

    id = Column(Integer, primary_key=True)
    class_id = Column(Integer, ForeignKey("classes.id"), nullable=False, index=True)
    semester_id = Column(Integer, ForeignKey("semesters.id"), nullable=False, index=True)
    effective_date = Column(Date, nullable=False, default=date.today)
    remark = Column(String(255), nullable=True)               # 如 "期中后排布"
    rows = Column(Integer, nullable=False, default=0)          # 保留空行，支持页面手工编辑版式
    cols = Column(Integer, nullable=False, default=0)          # 保留空列，支持页面手工编辑版式
    is_deleted = Column(Boolean, default=False, nullable=False)

    details = relationship("SeatDetail", back_populates="plan")


class SeatDetail(Base, TimestampMixin):
    __tablename__ = "seat_details"
    __table_args__ = (
        # 同一方案内 (行, 列) 唯一，即一个座位只能坐一名学生
        UniqueConstraint("seat_plan_id", "row", "col", name="uq_seat_pos"),
        # 同一方案内一名学生只能占一个座位
        UniqueConstraint("seat_plan_id", "student_id", name="uq_seat_student"),
    )

    id = Column(Integer, primary_key=True)
    seat_plan_id = Column(Integer, ForeignKey("seat_plans.id"), nullable=False, index=True)
    student_id = Column(Integer, ForeignKey("students.id"), nullable=False, index=True)
    row = Column(Integer, nullable=False)
    col = Column(Integer, nullable=False)
    is_deleted = Column(Boolean, default=False, nullable=False)

    plan = relationship("SeatPlan", back_populates="details")
    student = relationship("Student", back_populates="seat_details")


# ---------------------------------------------------------------- 6/7. 考试成绩
class ExamRecord(Base, TimestampMixin):
    __tablename__ = "exam_records"

    id = Column(Integer, primary_key=True)
    class_id = Column(Integer, ForeignKey("classes.id"), nullable=False, index=True)
    semester_id = Column(Integer, ForeignKey("semesters.id"), nullable=False, index=True)
    name = Column(String(64), nullable=False)                 # 如 "期中考试"
    exam_date = Column(Date, nullable=False, default=date.today)
    is_deleted = Column(Boolean, default=False, nullable=False)

    scores = relationship("Score", back_populates="exam", cascade="all, delete-orphan")


class Score(Base, TimestampMixin):
    __tablename__ = "scores"
    __table_args__ = (
        UniqueConstraint("exam_record_id", "student_id", "subject", name="uq_exam_subject_student"),
    )

    id = Column(Integer, primary_key=True)
    exam_record_id = Column(Integer, ForeignKey("exam_records.id"), nullable=False, index=True)
    student_id = Column(Integer, ForeignKey("students.id"), nullable=False, index=True)
    subject = Column(String(32), nullable=False)
    score = Column(Float, nullable=False)                     # 成绩/总分/进退（支持小数，-1000~750）
    rank = Column(Integer, nullable=True)                     # 班级排名（窗口函数计算后回写）
    is_deleted = Column(Boolean, default=False, nullable=False)

    exam = relationship("ExamRecord", back_populates="scores")
    student = relationship("Student")


# ---------------------------------------------------------------- 8/9. 值日
class DutyTemplate(Base, TimestampMixin):
    __tablename__ = "duty_templates"

    id = Column(Integer, primary_key=True)
    class_id = Column(Integer, ForeignKey("classes.id"), nullable=False, index=True)
    template_type = Column(String(16), nullable=False, default="week_cycle")  # week_cycle 周循环 / group_cycle 组循环
    is_deleted = Column(Boolean, default=False, nullable=False)

    details = relationship("DutyDetail", back_populates="template", cascade="all, delete-orphan")


class DutyDetail(Base, TimestampMixin):
    __tablename__ = "duty_details"

    id = Column(Integer, primary_key=True)
    template_id = Column(Integer, ForeignKey("duty_templates.id"), nullable=False, index=True)
    weekday = Column(Integer, nullable=False)                 # 1-7 周一~周日
    student_id = Column(Integer, ForeignKey("students.id"), nullable=False, index=True)
    duty_type = Column(String(32), nullable=False, default="扫地")  # 扫地/擦黑板/擦窗/擦桌椅/倒垃圾
    is_deleted = Column(Boolean, default=False, nullable=False)

    template = relationship("DutyTemplate", back_populates="details")
    student = relationship("Student")


# ---------------------------------------------------------------- 10. import_mappings 导入习惯记忆
class ImportMapping(Base, TimestampMixin):
    __tablename__ = "import_mappings"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    file_md5 = Column(String(32), nullable=False, index=True)  # 文件内容 MD5
    mapping_json = Column(Text, nullable=False)                # 映射配置 JSON 字符串
    is_deleted = Column(Boolean, default=False, nullable=False)

    user = relationship("User")


# ---------------------------------------------------------------- 补充：班委名单
class Committee(Base, TimestampMixin):
    __tablename__ = "committee"

    id = Column(Integer, primary_key=True)
    class_id = Column(Integer, ForeignKey("classes.id"), nullable=False, index=True)
    student_id = Column(Integer, ForeignKey("students.id"), nullable=False, index=True)
    position = Column(String(32), nullable=False)             # 班长/学习委员/纪律委员/卫生委员/体育委员/文艺委员/生活委员
    start_date = Column(Date, nullable=False, default=date.today)
    end_date = Column(Date, nullable=True)
    is_deleted = Column(Boolean, default=False, nullable=False)

    student = relationship("Student")


# ---------------------------------------------------------------- 补充：课程表
class TimetableCell(Base, TimestampMixin):
    __tablename__ = "timetable"
    __table_args__ = (
        UniqueConstraint("class_id", "semester_id", "weekday", "period", name="uq_timetable_cell"),
    )

    id = Column(Integer, primary_key=True)
    class_id = Column(Integer, ForeignKey("classes.id"), nullable=False, index=True)
    semester_id = Column(Integer, ForeignKey("semesters.id"), nullable=False, index=True)
    weekday = Column(Integer, nullable=False)                 # 1-7 周一~周日
    period = Column(Integer, nullable=False)                  # 节次 1-N
    course_name = Column(String(64), nullable=False)
    teacher = Column(String(64), nullable=True)
    is_deleted = Column(Boolean, default=False, nullable=False)


class TimetableChange(Base, TimestampMixin):
    """临时调课记录：原位置置灰，新位置标记"调"。"""
    __tablename__ = "timetable_changes"

    id = Column(Integer, primary_key=True)
    class_id = Column(Integer, ForeignKey("classes.id"), nullable=False, index=True)
    semester_id = Column(Integer, ForeignKey("semesters.id"), nullable=False, index=True)
    change_date = Column(Date, nullable=False, default=date.today)  # 调课生效日
    old_weekday = Column(Integer, nullable=False)
    old_period = Column(Integer, nullable=False)
    new_weekday = Column(Integer, nullable=False)
    new_period = Column(Integer, nullable=False)
    course_name = Column(String(64), nullable=False)
    is_deleted = Column(Boolean, default=False, nullable=False)
