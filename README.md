# 班主任工作台

私有化部署的班级日常事务一体化管理系统，替代 Excel 管理班级事务。所有功能模块的数据围绕 **学生** 与 **学期** 两个核心维度关联，支持手动录入与文件导入（.xlsx / .docx / .pdf）双模式，导入过程必须经过**字段人工映射**，禁止静默导入。

## 功能总览

| 模块 | 核心能力 |
|---|---|
| 学生名单 | 搜索/状态筛选、行内编辑、三步走导入（含冲突检测 覆盖/跳过）、导出 Excel |
| 座次表 | Div 矩阵、拖拽换座、保存为新版本（历史版本保留可回溯）、Word/PDF 坐标打标 |
| 值日表 | 周视图日历、高亮当天、批量勾选、下周自动轮换（顺延一组） |
| 成绩分析 | 统计卡片（均分/最高/及格率）、ECharts 分数分布图、学生明细（含班级排名，窗口函数计算）、Excel 多 Sheet 导入（列名→科目）、手动逐行录入 |
| 班委名单 | 职位卡片墙、任职起止日期、一键导出 HTML 任职证明（可打印） |
| 家长联系方式 | 手机号中间 4 位 `****` 脱敏，输入登录密码二次确认方可查看明文 |
| 课程表 | 矩阵视图、合并单元格 Excel 导入（前端重构二维数组）、临时调课（原课置灰 + 新位置标「调」） |

通用能力：
- 多班级切换（默认预设 3 个班级，可扩展）；关闭浏览器再打开自动恢复上次选中的班级/学期
- 所有删除均为软删除（`is_deleted`），不物理删除
- 每个模块右上角「导出为 Excel」，中文表头、保留当前筛选条件
- 全局异常拦截，统一返回 `{code, message, data}`；前端网络/解析错误明确 Toast，不白屏
- 每日凌晨自动备份所有数据到 `./backup` 目录（保留最近 30 份）
- 响应式适配 1366×768 笔记本与 iPad Pro 11" 横屏

## 技术栈

- **后端**：Python 3.9+ / FastAPI（异步）/ SQLAlchemy 2.0 / 窗口函数（RANK OVER）
- **数据库**：默认 **SQLite**（零配置、事务一致、外键约束）；`.env` 中可一键切换 **PostgreSQL 15+**
- **前端**：Vue 3 + Element Plus + Pinia + ECharts + SheetJS(xlsx) + pdf.js，全部 CDN 引入，由 FastAPI 直接托管，**无需安装 Node.js**
- **安全**：密码 PBKDF2 哈希；监护人手机号 Fernet 对称加密存储
- **定时任务**：APScheduler 每日备份

## 环境要求

- Python 3.9 及以上（Windows / macOS / Linux 均可）
- 现代浏览器（Chrome / Edge / Safari），首次使用需联网加载 CDN 依赖

## 快速启动

```bash
# 1. 安装依赖（建议在虚拟环境中）
pip install -r requirements.txt

# 2. 启动（首次启动自动建表、写入种子数据：3 个班级 + 示例学生/成绩/座次/值日/班委/课表）
python main.py

# 3. 浏览器访问
#    http://localhost:8000
```

> 开发模式（代码修改自动重载）：`uvicorn main:app --reload`

**默认账号**：`admin` / `admin123`（可在 `.env` 中修改，首次启动后生效）

## 数据库初始化说明

### 自动初始化（推荐）

首次启动 `main.py` 时自动完成：
1. 按 ORM 模型建表（`app/models.py`，含外键约束与唯一约束）
2. 创建默认管理员账号
3. 写入种子数据（3 个班级 × 2 学期、示例学生、座次方案、两次考试成绩、值日模板、班委、课程表）

手动重建（删除数据库后重新初始化）：

```bash
python -c "import main; from app.init_db import init_db; init_db(force_seed=True)"
```

### 表结构（10 张核心表 + 4 张补充表）

`classes`、`students`、`semesters`（部分唯一索引保证**同班仅一个激活学期**）、`seat_plans`、`seat_details`（位置/学生唯一约束）、`exam_records`、`scores`（考试+学生+科目唯一约束，排名由窗口函数计算）、`duty_templates`、`duty_details`、`import_mappings`（导入习惯记忆），以及 `users`、`committee`（班委）、`timetable`、`timetable_changes`（临时调课）。

### 切换 PostgreSQL

编辑 `.env`：

```
DATABASE_URL=postgresql+psycopg2://postgres:你的密码@localhost:5432/class_manager
```

安装驱动 `pip install psycopg2-binary` 后启动即可（首次启动自动建表）。备份任务在 PostgreSQL 模式下自动导出为 SQL 脚本（INSERT 语句），在 SQLite 模式下直接复制 .db 文件。

### 备份与恢复

- **备份**：每日凌晨 2:00 自动备份到 `./backup/`（SQLite 模式为 `backup_YYYYMMDD_HHMMSS.db` 文件），保留最近 30 份；可修改 `.env` 中 `BACKUP_HOUR/BACKUP_MINUTE`。
- **恢复**：关闭服务 → 将备份文件复制覆盖 `class_manager.db` → 重启。**注意**：`.env` 中的 `ENCRYPTION_KEY` 必须保持不变，否则备份中的监护人手机号无法解密。

## 目录结构

```
班主任管理系统/
├── main.py                 # FastAPI 入口（python main.py 启动）
├── requirements.txt
├── .env.example            # 环境变量示例（复制为 .env）
├── README.md
├── app/
│   ├── config.py           # 配置（数据库/密钥/备份时间）
│   ├── database.py         # SQLAlchemy 引擎与会话
│   ├── models.py           # ORM 模型（14 张表）
│   ├── init_db.py          # 建表 + 种子数据
│   ├── security.py         # 密码哈希 / 手机号加密 / Token
│   ├── deps.py             # 登录与参数校验依赖
│   ├── exceptions.py       # 全局异常拦截（统一 {code,message,data}）
│   ├── tasks.py            # 每日自动备份调度
│   ├── utils/
│   │   ├── file_parser.py  # xlsx/docx/pdf 解析 → 二维数组（解析与入库分离）
│   │   └── excel_export.py # Excel 导出（中文表头）
│   └── routers/            # 10 组 API 路由（auth/classes/students/seats/duty/
│                           #   exams/committee/parents/timetable/imports）
├── static/
│   ├── index.html          # SPA 入口（CDN 依赖）
│   ├── css/app.css
│   └── js/                 # api.js / store.js / 通用 ImportModal / 10 个页面视图
├── backup/                 # 每日自动备份输出目录
└── uploads/                # 上传临时目录
```

## 导入三步走（所有模块通用）

1. **上传解析**：`POST /api/import/upload` → 后端解析（pandas/xlsx、python-docx、pypdf）返回前 10 行预览 + `file_id`，**不写库**
2. **字段映射**：前端左侧文件列名 → 右侧系统字段下拉（含「忽略此列」）；按文件 MD5 记忆上次映射习惯；Word/PDF 支持正则预筛（如 `姓名：张三`）
3. **预览确认**：完整数据分页预览 → 冲突检测（学号/姓名已存在，逐行选择 覆盖/跳过）→ 勾选「我已核对数据无误」→ `POST /api/import/confirm` 事务入库，任一失败整体回滚并返回具体行号

## 常见问题

| 问题 | 解决 |
|---|---|
| 启动报 numpy/pandas 兼容错误（Anaconda 环境） | `pip install -U numexpr bottleneck` 或 `pip install "numpy<2"` |
| 页面加载慢/白屏 | unpkg CDN 不可达时，将 `static/index.html` 中的 `unpkg.com` 替换为 `cdn.jsdelivr.net` |
| 监护人手机号无法解密 | `.env` 中 `ENCRYPTION_KEY` 与备份时不一致，请保持一致 |
| 忘记密码 | 删除 `class_manager.db` 重新初始化（会丢失数据），或改用 `init_db` 重置 admin 密码 |

## API 约定

- 认证：`Authorization: Bearer <token>`（登录接口返回，7 天有效）
- 统一响应：`{"code": 0, "message": "ok", "data": {...}}`，`code != 0` 表示失败
- 错误码：400 业务错误、401 未登录、404 不存在、422 参数校验、500 服务器错误
