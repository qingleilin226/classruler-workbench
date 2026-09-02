# -*- coding: utf-8 -*-
"""Excel 导出工具：中文表头，保留当前筛选条件（以筛选后数据为准）。"""
import io

import pandas as pd


def export_excel(headers: list, rows: list, sheet_name: str = "数据") -> bytes:
    """headers: 中文表头列表；rows: 与表头等长的二维数组。返回 xlsx 字节流。"""
    df = pd.DataFrame(rows, columns=headers)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name=sheet_name[:28] or "数据")
        # 表头加粗、列宽自适应
        ws = writer.sheets[sheet_name[:28] or "数据"]
        for cell in ws[1]:
            cell.font = cell.font.copy(bold=True)
        for col_idx, col in enumerate(ws.columns, start=1):
            max_len = max((len(str(v)) for v in col), default=8)
            ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = \
                min(max_len + 4, 40)
    return buf.getvalue()
