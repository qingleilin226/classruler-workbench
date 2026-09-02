# -*- coding: utf-8 -*-
"""文件解析工具：xlsx / docx / pdf → 结构化数据。
三步走导入流程 Step 1：仅解析预览，禁止直接写库。"""
import hashlib
import io
import re
import uuid
from datetime import date, datetime

import pandas as pd

from ..exceptions import BizError

# 上传文件解析结果缓存：file_id -> 解析结果（内存态，重启即失效，可重新上传）
_PARSE_CACHE: dict = {}

MAX_PREVIEW_ROWS = 10  # 预览行数（文档要求前10行）


# ---------------------------------------------------------------- 文件指纹
def file_md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def make_file_id() -> str:
    return uuid.uuid4().hex


def cache_parsed(file_id: str, payload: dict) -> None:
    _PARSE_CACHE[file_id] = payload


def get_parsed(file_id: str) -> dict:
    payload = _PARSE_CACHE.get(file_id)
    if not payload:
        raise BizError("文件解析结果已失效，请重新上传", code=404)
    return payload


# ---------------------------------------------------------------- 单元格规范化
def _cell_to_str(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, (datetime, date, pd.Timestamp)):
        return str(pd.Timestamp(v).date())
    return str(v).strip()


def _normalize_matrix(df: pd.DataFrame) -> dict:
    """DataFrame → {headers, rows, total_rows, _full_rows}。所有值转字符串，保留原始列顺序。
    rows 仅预览前 10 行；_full_rows 缓存完整数据供确认入库阶段使用（内存态）。"""
    headers = [str(c).strip() for c in df.columns]
    rows = df.astype(object).where(pd.notnull(df), "").values.tolist()
    rows = [[_cell_to_str(c) for c in r] for r in rows]
    total = len(rows)
    return {
        "headers": headers,
        "rows": rows[:MAX_PREVIEW_ROWS],
        "total_rows": total,
        "preview_limit": MAX_PREVIEW_ROWS,
        "_full_rows": rows,
    }


# ---------------------------------------------------------------- 各类文件解析
def parse_xlsx(data: bytes, filename: str) -> dict:
    try:
        xls = pd.ExcelFile(io.BytesIO(data))
    except Exception as e:
        raise BizError(f"Excel 文件解析失败: {e}")

    sheets = []
    for sheet_name in xls.sheet_names:
        df = xls.parse(sheet_name, header=0)
        if df.empty:
            df = pd.DataFrame()
        m = _normalize_matrix(df)
        m["sheet_name"] = sheet_name
        sheets.append(m)
    if not sheets:
        raise BizError("Excel 文件中没有可用的工作表")
    return {"file_kind": "excel", "sheets": sheets, "sheet_count": len(sheets)}


def _extract_text_lines(text: str) -> list:
    """把解析出的文本按行切分并去除空行。"""
    lines = [ln.strip() for ln in text.splitlines()]
    return [ln for ln in lines if ln]


def _regex_prescreen(lines: list, patterns: list) -> list:
    """正则预筛：识别 '姓名：张三' 等模式行，返回二维行数组。"""
    matched = []
    for ln in lines:
        row = []
        ok = True
        for pat in patterns:
            m = re.search(pat, ln)
            if not m:
                ok = False
                break
            row.append(m.group(1).strip())
        if ok:
            matched.append(row)
    return matched


def parse_docx(data: bytes, filename: str) -> dict:
    try:
        from docx import Document
        doc = Document(io.BytesIO(data))
        lines = [p.text for p in doc.paragraphs if p.text.strip()]
        # 表格行也纳入
        for table in doc.tables:
            for row in table.rows:
                lines.append(" | ".join(c.text.strip() for c in row.cells))
    except Exception as e:
        raise BizError(f"Word 文件解析失败: {e}")

    text = "\n".join(lines)
    cleaned = _extract_text_lines(text)

    # 正则预筛常见模式（姓名：xxx / 学号：xxx / 列:值）
    common_patterns = [
        (["姓名[:：]\s*(.+)", "学号[:：]\s*([0-9]+)"], ["姓名", "学号"]),
        (["学号[:：]\s*([0-9]+)", "姓名[:：]\s*(.+)"], ["学号", "姓名"]),
    ]
    auto = None
    for pats, headers in common_patterns:
        matched = _regex_prescreen(cleaned, pats)
        if len(matched) >= 1:
            auto = {"headers": headers, "rows": matched[:MAX_PREVIEW_ROWS],
                    "total_rows": len(matched), "preview_limit": MAX_PREVIEW_ROWS}
            break

    return {
        "file_kind": "docx",
        "text": text,                      # 完整原文（供坐标打标/人工查看）
        "lines": cleaned,
        "auto_parsed": auto,               # 正则预筛结果（可能为 None → 前端坐标打标）
    }


def parse_pdf(data: bytes, filename: str) -> dict:
    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        lines = []
        for page in reader.pages:
            lines.append((page.extract_text() or ""))
    except Exception as e:
        raise BizError(f"PDF 文件解析失败: {e}")

    text = "\n".join(lines)
    cleaned = _extract_text_lines(text)
    return {
        "file_kind": "pdf",
        "text": text,
        "lines": cleaned,
        "auto_parsed": None,
    }


def parse_file(data: bytes, filename: str, file_id: str = None) -> dict:
    """统一解析入口：按扩展名分派，返回结果并缓存。"""
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if suffix in ("xlsx", "xls"):
        result = parse_xlsx(data, filename)
    elif suffix == "docx":
        result = parse_docx(data, filename)
    elif suffix == "pdf":
        result = parse_pdf(data, filename)
    else:
        raise BizError(f"不支持的文件类型: .{suffix}（支持 .xlsx/.xls/.docx/.pdf）")

    fid = file_id or make_file_id()
    result["file_id"] = fid
    result["filename"] = filename
    result["md5"] = file_md5(data)
    cache_parsed(fid, result)
    return result
