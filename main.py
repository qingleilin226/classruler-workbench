# -*- coding: utf-8 -*-
"""班主任工作台 - FastAPI 入口。
启动：python main.py    （或 uvicorn main:app --reload）
首次启动自动建表、写入种子数据（3 个班级）、启动每日备份任务。
"""
import logging
from logging.handlers import RotatingFileHandler
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import (
    CORS_ORIGINS, HOST, LOG_BACKUP_COUNT, LOG_FILE, LOG_MAX_BYTES, PORT,
)
from app.database import checkpoint_database, engine, verify_database
from app.exceptions import register_exception_handlers
from app.init_db import init_db
from app.tasks import start_scheduler, stop_scheduler
from app.routers import (
    auth, classes, committee, duty, exams, imports, parents, seats, students, timetable,
)

_root_logger = logging.getLogger()
_root_logger.setLevel(logging.INFO)
LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
_log_format = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
_resolved_log_file = str(LOG_FILE.resolve())
if not any(
    isinstance(handler, logging.FileHandler)
    and getattr(handler, "baseFilename", "") == _resolved_log_file
    for handler in _root_logger.handlers
):
    _file_handler = RotatingFileHandler(
        LOG_FILE, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUP_COUNT, encoding="utf-8",
    )
    _file_handler.setFormatter(_log_format)
    _root_logger.addHandler(_file_handler)
if not any(
    isinstance(handler, logging.StreamHandler)
    and not isinstance(handler, logging.FileHandler)
    for handler in _root_logger.handlers
):
    _console_handler = logging.StreamHandler()
    _console_handler.setFormatter(_log_format)
    _root_logger.addHandler(_console_handler)
logger = logging.getLogger("class_manager")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    verify_database()
    start_scheduler()
    logger.info("班主任工作台后端已就绪")
    try:
        yield
    finally:
        stop_scheduler()
        checkpoint_database()
        engine.dispose()


app = FastAPI(title="班主任工作台", version="1.0.0", lifespan=lifespan)

if CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

register_exception_handlers(app)

# API 路由
app.include_router(auth.router)
app.include_router(classes.router)
app.include_router(students.router)
app.include_router(seats.router)
app.include_router(duty.router)
app.include_router(exams.router)
app.include_router(committee.router)
app.include_router(parents.router)
app.include_router(timetable.router)
app.include_router(imports.router)


@app.get("/api/health")
def health():
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("SELECT 1").scalar()
    except Exception:
        logger.exception("健康检查无法连接数据库")
        return JSONResponse(
            status_code=503,
            content={"code": 503, "message": "数据库不可用", "data": {"status": "degraded"}},
        )
    return {"code": 0, "message": "ok", "data": {
        "status": "running", "database": "ok",
    }}


# 前端静态资源（SPA）——必须放在所有 API 路由之后
app.mount("/", StaticFiles(directory="static", html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)
