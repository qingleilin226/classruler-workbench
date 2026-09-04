# -*- coding: utf-8 -*-
"""全局异常拦截器：所有接口统一返回 {code, message, data}。"""
import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("class_manager")


class BizError(Exception):
    """业务异常：抛出时返回 HTTP 200 + code!=0，或统一 400。"""

    def __init__(self, message: str, code: int = 400, data: dict = None):
        self.message = message
        self.code = code
        self.data = data or {}
        super().__init__(message)


def ok(data=None, message: str = "ok") -> dict:
    """统一成功响应结构。"""
    return {"code": 0, "message": message, "data": data if data is not None else {}}


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(BizError)
    async def biz_error_handler(_request: Request, exc: BizError):
        return JSONResponse(
            status_code=200,
            content={"code": exc.code, "message": exc.message, "data": exc.data},
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(_request: Request, exc: StarletteHTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content={"code": exc.status_code, "message": str(exc.detail), "data": {}},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(_request: Request, exc: RequestValidationError):
        # 提取第一个参数错误，方便前端 Toast 提示
        msg = "参数校验失败"
        errors = exc.errors()
        if errors:
            first = errors[0]
            loc = ".".join(str(x) for x in first.get("loc", []) if x != "body")
            msg = f"参数错误[{loc}]: {first.get('msg', '')}"
        return JSONResponse(
            status_code=200,
            content={"code": 422, "message": msg, "data": {}},
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        logger.exception("未处理异常 %s %s: %s", request.method, request.url.path, exc)
        return JSONResponse(
            status_code=500,
            content={"code": 500, "message": "服务器内部错误，请查看服务端日志", "data": {}},
        )
