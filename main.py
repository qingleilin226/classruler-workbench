# -*- coding: utf-8 -*-
"""班主任工作台 - FastAPI 入口。
启动：python main.py    （或 uvicorn main:app --reload）
首次启动自动建表、写入种子数据（3 个班级）、启动每日备份任务。
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import HOST, PORT
from app.exceptions import register_exception_handlers
from app.init_db import init_db
from app.tasks import start_scheduler
from app.routers import (
    auth, classes, committee, duty, exams, imports, parents, seats, students, timetable,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("class_manager")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    start_scheduler()
    logger.info("班主任工作台后端已就绪")
    yield


app = FastAPI(title="班主任工作台", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
    return {"code": 0, "message": "ok", "data": {"status": "running"}}


# 前端静态资源（SPA）——必须放在所有 API 路由之后
app.mount("/", StaticFiles(directory="static", html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)
