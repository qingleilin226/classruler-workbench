# -*- coding: utf-8 -*-
"""通用导入三步走（所有模块复用，解析与入库严格分离）：
Step 1  POST /api/import/upload    —— 上传并解析文件，返回 file_id + 预览数据
Step 2  POST /api/import/preview   —— 传入映射配置，返回映射行 + 冲突检测结果
Step 3  POST /api/import/confirm   —— 用户确认后事务入库，失败整体回滚并返回行号
另提供 import_mappings：按用户、导入类型与列名记住最近一次列匹配习惯。
"""
import json
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, File, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user, get_class, require_semester
from ..exceptions import BizError, ok
from ..models import ExamRecord, ImportMapping, Score, Student, User
from ..security import encrypt_phone
from ..utils.file_parser import file_md5, get_parsed, parse_file
from ..routers.exams import MAX_SCORE, MIN_SCORE, recalc_ranks
from ..routers.timetable import apply_timetable_import, ImportTimetableIn

router = APIRouter(prefix="/api/import", tags=["通用导入"])
MAX_UPLOAD_BYTES = 20 * 1024 * 1024

STUDENT_FIELDS = ["name", "gender", "student_no", "birth_date", "status",
                  "guardian_name", "guardian_phone", "address"]
IGNORE = "__ignore__"
LANG_SPLIT = "__lang_split__"    # 语种标记列（如“外语类型”）的映射保留值
_EXAM_RESERVED = (IGNORE, LANG_SPLIT, "student_no", "name")


def _cell(row, i):
    if i is None or not 0 <= i < len(row) or row[i] is None:
        return ""
    return str(row[i]).strip()


def _exam_lang_split(sheet, mapping):
    """exam_scores 的“外语按语种拆分”描述 → (marker_col | None, fl_cols)。

    marker_col：被映射为 LANG_SPLIT 的列，即“外语类型/语种”标记列（行值为 英语/日语…），
    仅当用户显式映射该列时拆分才生效（其余情况与旧行为逐字节一致）。
    fl_cols：需要按行语种命名的“外语”成绩列——映射值 == 本列列名、列名以“外语”开头、
    且不含 类型/语种/裸分/总分/排名/学考 等字样（避免误伤“外语类型”“语数英总分”）。
    命中 fl_cols 的列，每行的科目名 = 该行 marker 列的值（如 英语/日语）。"""
    marker = None
    for k, v in mapping.items():
        if v == LANG_SPLIT:
            try:
                marker = int(k)
            except (TypeError, ValueError):
                pass
    if marker is None:
        return None, []
    headers = sheet.get("headers") or []
    fl = []
    for k, v in mapping.items():
        try:
            c = int(k)
        except (TypeError, ValueError):
            continue
        if v in _EXAM_RESERVED:
            continue
        h = _cell(headers, c)
        if v == h and h.startswith("外语") and not any(
                w in h for w in ("类型", "语种", "裸分", "总分", "排名", "学考")):
            fl.append(c)
    return marker, fl


# ---------------------------------------------------------------- Step 1 上传解析
@router.post("/upload")
async def upload_file(file: UploadFile = File(...),
                      user: User = Depends(get_current_user)):
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
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


class MappingRecallIn(BaseModel):
    target: str
    headers: list = Field(default_factory=list)


def _mapping_habit_key(target: str) -> str:
    if target not in {"students", "exam_scores", "timetable"}:
        raise BizError(f"未知导入目标: {target}")
    return f"habit:{target}"


def _header_slot_keys(headers: list) -> list:
    """生成不依赖列顺序的列标识；同名列按出现次数区分。"""
    counts = {}
    keys = []
    for index, raw in enumerate(headers):
        name = " ".join(str(raw or "").split()).casefold()
        if not name:
            name = f"__blank_column_{index + 1}"
        counts[name] = counts.get(name, 0) + 1
        keys.append(f"{name}#{counts[name]}")
    return keys


def _mapping_for_headers(profile: dict, headers: list) -> dict:
    by_header = profile.get("by_header", {}) if isinstance(profile, dict) else {}
    return {
        str(index): by_header[key]
        for index, key in enumerate(_header_slot_keys(headers))
        if key in by_header
    }


@router.post("/mappings/recall")
def recall_mapping(body: MappingRecallIn, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """按导入类型和列名恢复最近一次映射，文件内容或列顺序变化也能复用。"""
    key = _mapping_habit_key(body.target)
    habit = db.query(ImportMapping).filter(
        ImportMapping.user_id == user.id,
        ImportMapping.file_md5 == key,
        ImportMapping.is_deleted.is_(False),
    ).order_by(ImportMapping.updated_at.desc()).first()
    if not habit:
        return ok(None)
    try:
        profile = json.loads(habit.mapping_json)
    except (TypeError, ValueError):
        return ok(None)
    resolved = _mapping_for_headers(profile, body.headers)
    return ok(resolved or None)


def _upsert_mapping(db: Session, user_id: int, key: str, config: dict) -> None:
    item = db.query(ImportMapping).filter(
        ImportMapping.user_id == user_id,
        ImportMapping.file_md5 == key,
        ImportMapping.is_deleted.is_(False),
    ).first()
    encoded = json.dumps(config, ensure_ascii=False)
    if item:
        item.mapping_json = encoded
    else:
        db.add(ImportMapping(user_id=user_id, file_md5=key, mapping_json=encoded))


@router.post("/mappings")
def save_mapping(payload: dict, user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    md5 = payload.get("md5", "")
    config = payload.get("mapping", {})
    if not md5 or not config:
        raise BizError("缺少 md5 或 mapping")
    _upsert_mapping(db, user.id, md5, config)

    target = payload.get("target")
    headers = payload.get("headers")
    if target and isinstance(headers, list):
        slots = _header_slot_keys(headers)
        by_header = {
            slots[index]: value
            for raw_index, value in config.items()
            if value and str(raw_index).isdigit()
            for index in [int(raw_index)]
            if 0 <= index < len(slots)
        }
        _upsert_mapping(db, user.id, _mapping_habit_key(target), {
            "version": 2,
            "target": target,
            "by_header": by_header,
        })
    db.commit()
    return ok(message="映射习惯已保存，下次遇到相同列名会自动填充")


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


def _match_student(db: Session, student_no, name, class_id: int = None):
    """成绩行→学生：优先学号；命中多个同名/同学号时不静默选第一个（防挂错人）。
    返回 (student | None, 错误文案 | None)；两个都为空表示查无此人。"""
    q = db.query(Student).filter(Student.is_deleted.is_(False))
    if class_id is not None:
        q = q.filter(Student.class_id == class_id)
    if student_no:
        hits = q.filter(Student.student_no == student_no).all()
        if len(hits) == 1:
            return hits[0], None
        if len(hits) > 1:
            return None, f"学号「{student_no}」在系统里有多条记录，请先整理花名册"
    if name:
        hits = q.filter(Student.name == name).all()
        if len(hits) == 1:
            return hits[0], None
        if len(hits) > 1:
            return None, f"姓名「{name}」匹配到多个学生，请改用学号列匹配"
    return None, None


# ---------------------------------------------------------------- Step 2 预览与冲突
class PreviewIn(BaseModel):
    file_id: str
    target: str                    # students / exam_scores / timetable
    mapping: dict                  # {file_col_index: system_field|科目名|ignore}
    extra: dict = Field(default_factory=dict)  # 目标参数（exam_id / class_id 等）
    sheet_index: int = 0           # 目标工作表下标（多工作表文件，默认第 1 个）
    header_row: Optional[int] = None  # 列名所在物理行号(1 基)；空 = 用解析时的自动探测值


@router.post("/preview")
def preview_import(body: PreviewIn, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    parsed = get_parsed(body.file_id)
    view = _resolve_sheet(parsed, body.sheet_index, body.header_row)

    if body.target == "students":
        data = _preview_students(view, body.mapping, db, body.extra)
    elif body.target == "exam_scores":
        data = _preview_exam_scores(view, body.mapping, db, body.extra)
    elif body.target == "timetable":
        data = _preview_timetable(view, body.mapping)
    else:
        raise BizError(f"未知导入目标: {body.target}")
    data = dict(data)
    data.update({"sheet_index": body.sheet_index,
                 "sheet_name": view["sheet_name"],
                 "header_row": view["eff_header_row"]})
    return ok(data)


def _resolve_sheet(parsed: dict, sheet_index: int = 0, header_row: Optional[int] = None) -> dict:
    """取出目标工作表并按需重切表头行。返回视图
    {sheet_name, headers, rows(数据区全量), eff_header_row}。
    header_row 为空 → 用解析时的自动探测切片；非空(1 基物理行号) → 从 _raw_grid 重切。"""
    sheets = parsed.get("sheets") or []
    if not sheets:
        raise BizError("文件中没有可用于字段映射的结构化数据")
    if not 0 <= sheet_index < len(sheets):
        raise BizError(f"工作表序号无效（文件含 {len(sheets)} 个工作表），请重新上传")
    src = sheets[sheet_index]
    eff = max(1, int(header_row)) if header_row else int(src.get("_header_row", 1))
    raw = src.get("_raw_grid")
    if raw:
        headers = [str(c).strip() for c in raw[eff - 1]] if eff - 1 < len(raw) else []
        data_rows = raw[eff:]
    else:  # 兜底（新解析器必有 _raw_grid）：用缓存切片
        headers, data_rows = src.get("headers", []), src.get("_full_rows", [])
    return {"sheet_name": src.get("sheet_name", f"工作表{sheet_index + 1}"),
            "headers": headers, "rows": data_rows,
            "eff_header_row": eff}


def _preview_students(sheet, mapping, db, extra):
    # 注意：返回裸 dict（不放 ok()），由 preview_import 统一包一层并追加 sheet 回显
    rows = sheet["rows"]
    class_id = extra.get("class_id")
    headers = sheet["headers"]
    mapped = []
    for idx, row in enumerate(rows):
        if not any(str(c).strip() for c in row):
            continue
        obj = _row_to_obj(None, row, mapping)
        mapped.append({"index": idx, "values": obj, "conflict": None})

    # 学生身份以“同班学号”为准；同名学生是合法数据，不能误判为冲突。
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
    return {"headers": headers, "rows": mapped, "total": len(mapped),
            "conflict_count": sum(1 for m in mapped if m["conflict"]),
            "target": "students"}


def _new_exam_details(extra: dict):
    """新建导入考试必须由用户明确提供名称和实际考试日期。"""
    name = str(extra.get("exam_name") or "").strip()
    raw_date = str(extra.get("exam_date") or "").strip()
    if not name:
        raise BizError("请填写考试名称")
    if not raw_date:
        raise BizError("请选择实际考试日期，系统不会再使用导入当天日期")
    try:
        exam_date = date.fromisoformat(raw_date)
    except ValueError:
        raise BizError("考试日期格式应为 YYYY-MM-DD")
    return name, exam_date


def _preview_exam_scores(sheet, mapping, db, extra):
    rows = sheet["rows"]
    exam = None
    if extra.get("exam_id"):
        exam = db.query(ExamRecord).filter(
            ExamRecord.id == extra["exam_id"],
            ExamRecord.is_deleted.is_(False),
        ).first()
        if not exam:
            raise BizError("目标考试不存在")
    class_id = exam.class_id if exam else extra.get("class_id")
    if not class_id:
        raise BizError("导入成绩必须指定目标班级或目标考试")
    get_class(db, class_id)
    if not exam:
        require_semester(db, extra.get("semester_id"), class_id)
        _new_exam_details(extra)
    marker, fl_cols = _exam_lang_split(sheet, mapping)
    # 映射列清单 (列号, 值)：忽略/语种保留值不参与；关联依据参与进 obj、但不作科目列
    pairs = []
    for k, v in mapping.items():
        if v in (IGNORE, LANG_SPLIT):
            continue
        try:
            pairs.append((int(k), v))
        except (TypeError, ValueError):
            pass
    score_pairs = [p for p in pairs if p[1] not in ("student_no", "name")]  # 与确认同规则

    # “外语”通用列实际出现过的语种（日语/英语固定在前，其余按出现序）
    langs = []
    if marker is not None:
        for row in rows:
            m = _cell(row, marker)
            if m and any(_cell(row, c) for c in fl_cols) and m not in langs:
                langs.append(m)
        order = [x for x in ("日语", "英语") if x in langs]
        order += [x for x in langs if x not in order]
        langs = order

    # 展示科目列：外语通用列展开成 日语/英语（每行只落一科，见 rows.values）
    subjects = []
    for c, v in pairs:
        if v in ("student_no", "name"):
            continue
        if c in fl_cols:
            for lg in langs:
                if lg not in subjects:
                    subjects.append(lg)
        elif v not in subjects:
            subjects.append(v)

    hr = sheet["eff_header_row"]
    # 与 _confirm_exam_scores 完全同规则的逐行预检（未匹配→中止该行；非数字/越界/缺语种标记逐列报）
    mapped = []
    error_count = 0
    for idx, row in enumerate(rows):
        if not any(str(c).strip() for c in row):
            continue
        obj = {}
        for c, v in pairs:
            raw = _cell(row, c)
            if not raw:
                continue
            if c in fl_cols:
                obj[_cell(row, marker) or v] = raw   # 科目名=语种值；缺语种时按原值兜底展示
            else:
                obj[v] = raw
        stu = None
        fail = None
        if obj.get("student_no") or obj.get("name"):
            stu, fail = _match_student(
                db, obj.get("student_no"), obj.get("name"), class_id)
        errs = []
        if fail:
            errs.append({"message": fail})
        elif not stu:
            errs.append({"message": "未匹配到学生（学号/姓名均无效）"})
        else:
            for c, v in score_pairs:
                raw = _cell(row, c)
                if not raw:
                    continue
                sub = v
                if c in fl_cols:            # 外语通用列：科目名 = 该行语种标记
                    m = _cell(row, marker)
                    if not m:
                        errs.append({"message": "外语成绩缺少语种标记（「外语类型」列未填 日语/英语）"})
                        continue
                    sub = m
                try:
                    score = float(raw)
                except ValueError:
                    errs.append({"message": f"科目「{sub}」分数「{raw}」不是数字"})
                    continue
                if not (MIN_SCORE <= score <= MAX_SCORE):
                    errs.append({"message": f"科目「{sub}」分数「{raw}」超出范围 {MIN_SCORE}-{MAX_SCORE}"})
        error_count += len(errs)
        mapped.append({"index": idx, "values": obj,
                       "row_no": idx + hr + 1,
                       "errors": errs or None, "unmatched": stu is None})
    return {"headers": sheet["headers"], "rows": mapped, "total": len(mapped),
            "subjects": subjects, "target": "exam_scores", "error_count": error_count}


def _preview_timetable(sheet, mapping):
    rows = sheet["rows"]
    # 前端拿到完整矩阵后自行重构合并单元格，再走 /confirm
    return {"headers": sheet["headers"], "rows": rows, "total": len(rows),
            "target": "timetable", "mapping": mapping}


# ---------------------------------------------------------------- Step 3 事务入库
class ConfirmIn(BaseModel):
    file_id: str
    target: str
    mapping: dict
    resolutions: dict = Field(default_factory=dict)  # {row_index: "overwrite"|"skip"}，仅 students 用
    extra: dict = Field(default_factory=dict)        # 目标参数
    sheet_index: int = 0        # 目标工作表下标（多工作表文件，默认第 1 个）
    header_row: Optional[int] = None  # 列名所在物理行号(1 基)；空 = 用解析时的自动探测值


@router.post("/confirm")
def confirm_import(body: ConfirmIn, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    parsed = get_parsed(body.file_id)
    view = _resolve_sheet(parsed, body.sheet_index, body.header_row)
    mapping = body.mapping
    try:
        if body.target == "students":
            result = _confirm_students(view, mapping, body.resolutions, body.extra, db)
        elif body.target == "exam_scores":
            result = _confirm_exam_scores(view, mapping, body.extra, db, user)
        elif body.target == "timetable":
            result = _confirm_timetable(view, mapping, body.extra, db)
        else:
            raise BizError(f"未知导入目标: {body.target}")
        db.commit()
        result = dict(result)
        result.update({"sheet_index": body.sheet_index,
                       "sheet_name": view["sheet_name"],
                       "header_row": view["eff_header_row"]})
        return ok(result, message="导入成功")
    except Exception as e:
        db.rollback()
        if isinstance(e, BizError):
            raise
        raise BizError(f"导入失败，已整体回滚：{e}")


def _confirm_students(sheet, mapping, resolutions, extra, db):
    rows = sheet["rows"]
    hr = sheet["eff_header_row"]
    class_id = extra.get("class_id")
    if not class_id:
        raise BizError("导入学生必须指定目标班级（extra.class_id）")
    get_class(db, class_id)
    inserted = updated = skipped = restored = 0
    errors = []
    seen_numbers = set()
    for idx, row in enumerate(rows):
        if not any(str(c).strip() for c in row):
            continue
        obj = _row_to_obj(None, row, mapping)
        row_no = idx + hr + 1
        obj["name"] = obj.get("name", "").strip()
        obj["student_no"] = obj.get("student_no", "").strip()
        if not obj["name"] or not obj["student_no"]:
            errors.append({"row": row_no, "message": "姓名和学号不能为空"})
            continue
        if obj["student_no"] in seen_numbers:
            errors.append({"row": row_no, "message": "文件内存在重复学号"})
            continue
        seen_numbers.add(obj["student_no"])
        if obj.get("gender") and obj["gender"] not in ("男", "女"):
            errors.append({"row": row_no, "message": "性别只能是 男/女"})
            continue
        if obj.get("status") and obj["status"] not in ("在读", "休学", "转学"):
            errors.append({"row": row_no, "message": "状态只能是 在读/休学/转学"})
            continue
        if obj.get("birth_date"):
            try:
                obj["birth_date"] = date.fromisoformat(obj["birth_date"])
            except ValueError:
                errors.append({"row": row_no, "message": "出生日期格式应为 YYYY-MM-DD"})
                continue
        no = obj["student_no"]
        exist = None
        if no:
            exist = db.query(Student).filter(Student.student_no == no,
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
            # 相同学号曾被软删除时恢复原记录，保留其历史成绩/座位/值日关联。
            deleted = db.query(Student).filter(
                Student.student_no == no,
                Student.class_id == class_id,
                Student.is_deleted.is_(True),
            ).order_by(Student.updated_at.desc(), Student.id.desc()).first()
            phone = obj.get("guardian_phone", "") or ""
            if phone:
                obj["guardian_phone"] = encrypt_phone(phone)
            if deleted:
                for key, value in obj.items():
                    if value != "":
                        setattr(deleted, key, value)
                deleted.is_deleted = False
                restored += 1
            else:
                stu = Student(class_id=class_id, **obj)
                db.add(stu)
                inserted += 1
    if errors:
        summary = "；".join(f"第{e['row']}行 {e['message']}" for e in errors[:10])
        raise BizError(f"学生导入校验失败，共 {len(errors)} 行：{summary}")
    return {"inserted": inserted, "updated": updated, "restored": restored,
            "skipped": skipped, "errors": errors}


def _confirm_exam_scores(sheet, mapping, extra, db, user):
    rows = sheet["rows"]
    hr = sheet["eff_header_row"]
    marker, fl_cols = _exam_lang_split(sheet, mapping)
    pairs = []                          # (列号, 映射科目值)，去掉关联依据与保留值
    for k, v in mapping.items():
        if v in _EXAM_RESERVED:
            continue
        try:
            pairs.append((int(k), v))
        except (TypeError, ValueError):
            pass

    exam_id = extra.get("exam_id")
    if not exam_id:
        class_id = extra.get("class_id")
        semester_id = extra.get("semester_id")
        if not class_id or not semester_id:
            raise BizError("新建导入考试必须指定班级和学期")
        get_class(db, class_id)
        require_semester(db, semester_id, class_id)
        exam_name, exam_date = _new_exam_details(extra)
        exam = ExamRecord(class_id=extra["class_id"], semester_id=extra["semester_id"],
                          name=exam_name, exam_date=exam_date)
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
        fail = None
        if obj.get("student_no") or obj.get("name"):
            stu, fail = _match_student(
                db, obj.get("student_no"), obj.get("name"), exam.class_id)
        if fail:
            errors.append({"row": idx + hr + 1, "message": fail})
            continue
        if not stu:
            errors.append({"row": idx + hr + 1, "message": "未匹配到学生（学号/姓名均无效）"})
            continue
        for c, v in pairs:
            raw = obj.get(v, "")
            if raw == "":
                continue
            sub = v
            if c in fl_cols:            # 外语通用列：科目名 = 该行语种标记
                m = _cell(row, marker)
                if not m:
                    errors.append({"row": idx + hr + 1,
                                   "message": "外语成绩缺少语种标记（「外语类型」列未填 日语/英语）"})
                    continue
                sub = m
            try:
                score = float(raw)
            except ValueError:
                errors.append({"row": idx + hr + 1, "message": f"科目「{sub}」分数「{raw}」不是数字"})
                continue
            if not (MIN_SCORE <= score <= MAX_SCORE):
                errors.append({"row": idx + hr + 1,
                               "message": f"科目「{sub}」分数「{raw}」超出范围 {MIN_SCORE}-{MAX_SCORE}"})
                continue
            exist = db.query(Score).filter(
                Score.exam_record_id == exam_id, Score.student_id == stu.id,
                Score.subject == sub).first()
            if exist:
                exist.score = score
                exist.is_deleted = False
                updated += 1
            else:
                db.add(Score(exam_record_id=exam_id, student_id=stu.id,
                             subject=sub, score=score))
                inserted += 1
    if errors:
        raise BizError(f"共 {len(errors)} 行数据有误：" + "；".join(
            f"第{e['row']}行 {e['message']}" for e in errors[:10]))
    # Session 关闭了 autoflush；确保本次新增/恢复的成绩参与排名，仍由外层统一提交。
    db.flush()
    recalc_ranks(db, exam_id)
    return {"exam_id": exam_id, "inserted": inserted, "updated": updated, "errors": errors}


def _confirm_timetable(sheet, mapping, extra, db):
    rows = sheet["rows"]
    weekday_map = extra.get("weekday_map", {})
    # 前端重构后的矩阵（含合并单元格展开）直接由 extra.matrix 传入更可靠
    matrix = extra.get("matrix")
    if matrix is None:
        matrix = [[str(c) for c in row] for row in rows]
    body = ImportTimetableIn(class_id=extra["class_id"], semester_id=extra["semester_id"],
                             matrix=matrix, weekday_map=weekday_map)
    return apply_timetable_import(body, db)
