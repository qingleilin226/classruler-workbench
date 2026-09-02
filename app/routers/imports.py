# -*- coding: utf-8 -*-
"""通用导入三步走（所有模块复用，解析与入库严格分离）：
Step 1  POST /api/import/upload    —— 上传并解析文件，返回 file_id + 预览数据
Step 2  POST /api/import/preview   —— 传入映射配置，返回映射行 + 冲突检测结果
Step 3  POST /api/import/confirm   —— 用户确认后事务入库，失败整体回滚并返回行号
另提供 import_mappings：记住用户列匹配习惯（按文件 MD5）。
"""
import json

from fastapi import APIRouter, Depends, File, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user
from ..exceptions import BizError, ok
from ..models import ImportMapping, Score, Student, User
from ..security import encrypt_phone
from ..utils.file_parser import file_md5, get_parsed, parse_file
from ..routers.exams import recalc_ranks
from ..routers.timetable import import_timetable, ImportTimetableIn

router = APIRouter(prefix="/api/import", tags=["通用导入"])

STUDENT_FIELDS = ["name", "gender", "student_no", "birth_date", "status",
                  "guardian_name", "guardian_phone", "address"]
IGNORE = "__ignore__"


# ---------------------------------------------------------------- Step 1 上传解析
@router.post("/upload")
async def upload_file(file: UploadFile = File(...),
                      user: User = Depends(get_current_user)):
    data = await file.read()
    if len(data) > 20 * 1024 * 1024:
        raise BizError("文件超过 20MB 限制")
    result = parse_file(data, file.filename or "upload.xlsx")
    return ok(result, message="解析成功，请配置字段映射")


# ---------------------------------------------------------------- 映射习惯记忆
@router.get("/mappings")
def get_mapping(md5: str, user: User = Depends(get_current_user),
                db: Session = Depends(get_db)):
    m = db.query(ImportMapping).filter(ImportMapping.user_id == user.id,
                                       ImportMapping.file_md5 == md5).first()
    if not m:
        return ok(None)
    return ok(json.loads(m.mapping_json))


@router.post("/mappings")
def save_mapping(payload: dict, user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    md5 = payload.get("md5", "")
    config = payload.get("mapping", {})
    if not md5 or not config:
        raise BizError("缺少 md5 或 mapping")
    m = db.query(ImportMapping).filter(ImportMapping.user_id == user.id,
                                       ImportMapping.file_md5 == md5).first()
    if m:
        m.mapping_json = json.dumps(config, ensure_ascii=False)
    else:
        db.add(ImportMapping(user_id=user.id, file_md5=md5,
                             mapping_json=json.dumps(config, ensure_ascii=False)))
    db.commit()
    return ok(message="映射习惯已保存，下次同文件自动填充")


# ---------------------------------------------------------------- 工具函数
def _row_to_obj(header_row: dict, row: list, mapping: dict) -> dict:
    """按 mapping 把一行文件数据映射为 {system_field: value}。"""
    obj = {}
    for col_idx, val in enumerate(row):
        field = mapping.get(str(col_idx))
        if not field or field == IGNORE:
            continue
        obj[field] = str(val).strip() if val is not None else ""
    return obj


# ---------------------------------------------------------------- Step 2 预览与冲突
class PreviewIn(BaseModel):
    file_id: str
    target: str                    # students / exam_scores / timetable
    mapping: dict                  # {file_col_index: system_field|科目名|ignore}
    extra: dict = {}               # 目标参数（exam_id / class_id 等）


@router.post("/preview")
def preview_import(body: PreviewIn, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    parsed = get_parsed(body.file_id)
    mapping = body.mapping

    if body.target == "students":
        return _preview_students(parsed, mapping, db, body.extra)
    if body.target == "exam_scores":
        return _preview_exam_scores(parsed, mapping, db, body.extra)
    if body.target == "timetable":
        return _preview_timetable(parsed, mapping)
    raise BizError(f"未知导入目标: {body.target}")


def _first_sheet(parsed: dict) -> dict:
    if parsed.get("file_kind") != "excel":
        raise BizError("该文件不是 Excel 格式")
    return parsed["sheets"][0]


def _full_rows(parsed: dict) -> list:
    sheet = _first_sheet(parsed)
    # 缓存里存了完整数据吗？upload 时只存了预览 10 行——这里需要完整行。
    # 解决方案：upload 时同时缓存完整 rows。
    return sheet.get("_full_rows", sheet["rows"])


def _preview_students(parsed, mapping, db, extra):
    sheet = _first_sheet(parsed)
    rows = sheet["_full_rows"]
    class_id = extra.get("class_id")
    headers = sheet["headers"]
    mapped = []
    for idx, row in enumerate(rows):
        if not any(str(c).strip() for c in row):
            continue
        obj = _row_to_obj(None, row, mapping)
        mapped.append({"index": idx, "values": obj, "conflict": None})

    # 冲突检测：同班内学号或姓名已存在
    for m in mapped:
        values = m["values"]
        if values.get("student_no"):
            q = db.query(Student).filter(Student.student_no == values["student_no"],
                                         Student.is_deleted.is_(False))
            if class_id:
                q = q.filter(Student.class_id == class_id)
            exist = q.first()
            if exist:
                m["conflict"] = {"type": "student_no",
                                 "message": f"学号已存在（{exist.name}，{exist.student_no}）"}
                continue
        if values.get("name"):
            q = db.query(Student).filter(Student.name == values["name"],
                                         Student.is_deleted.is_(False))
            if class_id:
                q = q.filter(Student.class_id == class_id)
            exist = q.first()
            if exist:
                m["conflict"] = {"type": "name",
                                 "message": f"姓名已存在（{exist.student_no or '无学号'}）"}
    return ok({"headers": headers, "rows": mapped, "total": len(mapped),
               "conflict_count": sum(1 for m in mapped if m["conflict"]),
               "target": "students"})


def _preview_exam_scores(parsed, mapping, db, extra):
    sheet = _first_sheet(parsed)
    rows = sheet["_full_rows"]
    subjects = [v for v in mapping.values() if v not in (IGNORE, "student_no", "name")]
    mapped = []
    for idx, row in enumerate(rows):
        obj = _row_to_obj(None, row, mapping)
        if not obj.get("student_no") and not obj.get("name"):
            continue
        mapped.append({"index": idx, "values": obj})
    return ok({"headers": sheet["headers"], "rows": mapped, "total": len(mapped),
               "subjects": subjects, "target": "exam_scores"})


def _preview_timetable(parsed, mapping):
    sheet = _first_sheet(parsed)
    rows = sheet["_full_rows"]
    # 前端拿到完整矩阵后自行重构合并单元格，再走 /confirm
    return ok({"headers": sheet["headers"], "rows": rows, "total": len(rows),
               "target": "timetable", "mapping": mapping})


# ---------------------------------------------------------------- Step 3 事务入库
class ConfirmIn(BaseModel):
    file_id: str
    target: str
    mapping: dict
    resolutions: dict = {}      # {row_index: "overwrite"|"skip"}，仅 students 用
    extra: dict = {}            # 目标参数


@router.post("/confirm")
def confirm_import(body: ConfirmIn, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    parsed = get_parsed(body.file_id)
    mapping = body.mapping
    try:
        if body.target == "students":
            result = _confirm_students(parsed, mapping, body.resolutions, body.extra, db)
        elif body.target == "exam_scores":
            result = _confirm_exam_scores(parsed, mapping, body.extra, db, user)
        elif body.target == "timetable":
            result = _confirm_timetable(parsed, mapping, body.extra, db)
        else:
            raise BizError(f"未知导入目标: {body.target}")
        db.commit()
        return ok(result, message="导入成功")
    except Exception as e:
        db.rollback()
        if isinstance(e, BizError):
            raise
        raise BizError(f"导入失败，已整体回滚：{e}")


def _confirm_students(parsed, mapping, resolutions, extra, db):
    sheet = _first_sheet(parsed)
    rows = sheet["_full_rows"]
    class_id = extra.get("class_id")
    if not class_id:
        raise BizError("导入学生必须指定目标班级（extra.class_id）")
    inserted = updated = skipped = 0
    errors = []
    for idx, row in enumerate(rows):
        if not any(str(c).strip() for c in row):
            continue
        obj = _row_to_obj(None, row, mapping)
        if not obj.get("name"):
            errors.append({"row": idx + 2, "message": "缺少姓名，已跳过"})
            continue
        no = obj.get("student_no", "")
        exist = None
        if no:
            exist = db.query(Student).filter(Student.student_no == no,
                                             Student.is_deleted.is_(False),
                                             Student.class_id == class_id).first()
        if not exist and obj.get("name"):
            exist = db.query(Student).filter(Student.name == obj["name"],
                                             Student.is_deleted.is_(False),
                                             Student.class_id == class_id).first()

        if exist:
            policy = resolutions.get(str(idx), resolutions.get("default", "skip"))
            if policy == "overwrite":
                if obj.get("guardian_phone"):
                    obj["guardian_phone"] = encrypt_phone(obj["guardian_phone"])
                for k, v in obj.items():
                    if k != "guardian_phone" and v != "":
                        setattr(exist, k, v)
                    elif k == "guardian_phone" and v:
                        exist.guardian_phone = v
                updated += 1
            else:
                skipped += 1
        else:
            phone = obj.pop("guardian_phone", "") or ""
            if phone:
                obj["guardian_phone"] = encrypt_phone(phone)
            stu = Student(class_id=class_id, **obj)
            db.add(stu)
            inserted += 1
    return {"inserted": inserted, "updated": updated, "skipped": skipped, "errors": errors}


def _confirm_exam_scores(parsed, mapping, extra, db, user):
    from ..models import ExamRecord
    sheet = _first_sheet(parsed)
    rows = sheet["_full_rows"]
    subjects = [v for v in mapping.values() if v not in (IGNORE, "student_no", "name")]

    exam_id = extra.get("exam_id")
    if not exam_id:
        exam = ExamRecord(class_id=extra["class_id"], semester_id=extra["semester_id"],
                          name=extra.get("exam_name", "导入考试"))
        db.add(exam)
        db.flush()
        exam_id = exam.id

    exam = db.query(ExamRecord).filter(ExamRecord.id == exam_id,
                                       ExamRecord.is_deleted.is_(False)).first()
    if not exam:
        raise BizError("目标考试不存在")

    inserted = updated = 0
    errors = []
    for idx, row in enumerate(rows):
        if not any(str(c).strip() for c in row):
            continue
        obj = _row_to_obj(None, row, mapping)
        stu = None
        if obj.get("student_no"):
            stu = db.query(Student).filter(Student.student_no == obj["student_no"],
                                           Student.is_deleted.is_(False)).first()
        if not stu and obj.get("name"):
            stu = db.query(Student).filter(Student.name == obj["name"],
                                           Student.is_deleted.is_(False)).first()
        if not stu:
            errors.append({"row": idx + 2, "message": "未匹配到学生（学号/姓名均无效）"})
            continue
        for sub in subjects:
            raw = obj.get(sub, "")
            if raw == "":
                continue
            try:
                score = float(raw)
            except ValueError:
                errors.append({"row": idx + 2, "message": f"科目「{sub}」分数「{raw}」不是数字"})
                continue
            if not (0 <= score <= 200):
                errors.append({"row": idx + 2, "message": f"科目「{sub}」分数越界"})
                continue
            exist = db.query(Score).filter(
                Score.exam_record_id == exam_id, Score.student_id == stu.id,
                Score.subject == sub, Score.is_deleted.is_(False)).first()
            if exist:
                exist.score = int(score)
                updated += 1
            else:
                db.add(Score(exam_record_id=exam_id, student_id=stu.id,
                             subject=sub, score=int(score)))
                inserted += 1
    if errors:
        raise BizError(f"共 {len(errors)} 行数据有误：" + "；".join(
            f"第{e['row']}行 {e['message']}" for e in errors[:10]))
    recalc_ranks(db, exam_id)
    return {"exam_id": exam_id, "inserted": inserted, "updated": updated, "errors": errors}


def _confirm_timetable(parsed, mapping, extra, db):
    sheet = _first_sheet(parsed)
    rows = sheet["_full_rows"]
    weekday_map = extra.get("weekday_map", {})
    # 前端重构后的矩阵（含合并单元格展开）直接由 extra.matrix 传入更可靠
    matrix = extra.get("matrix")
    if matrix is None:
        matrix = [[str(c) for c in row] for row in rows]
    body = ImportTimetableIn(class_id=extra["class_id"], semester_id=extra["semester_id"],
                             matrix=matrix, weekday_map=weekday_map)
    data = import_timetable(body, user=None, db=db)["data"]
    return data
