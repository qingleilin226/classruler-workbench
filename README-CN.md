# 班主任工作台

[English documentation](README.md)

班主任工作台是一套私有化部署的班级日常事务管理系统，用一个本地 Web 应用替代分散的 Excel 文件，统一管理学生名单、座次、值日、考试成绩、班委、家长联系方式和课程表。

本系统面向个人或低并发场景设计，数据默认保存在本机，并以学生、班级和学期为核心进行关联。

## 功能概览

| 模块 | 主要功能 |
|---|---|
| 学生名单 | 姓名/学号搜索、状态筛选、行内编辑、批量修改、软删除、Excel/Word/PDF 导入、冲突处理和 Excel 导出 |
| 座次表 | 创建空白网格、增加或删除行列、按姓名或学号选择学生、拖拽换座、按学号自动排座、显示未排座学生、保留空位版式、保存历史版本、恢复旧版本和 Excel 导出 |
| 值日表 | 周视图、当天高亮、批量安排、下周轮换和 Excel 导出 |
| 成绩分析 | 手动指定真实考试日期、手工录入或导入小数成绩、班级统计、成绩分布、班级排名、学生明细和 Excel 导出 |
| 个人成绩分析 | 通过姓名或学号检索学生，查看该生历次考试的各科成绩与排名变化 |
| 班委名单 | 管理职务和任期，生成可打印的任职证明 |
| 家长联系方式 | 默认隐藏手机号中间四位，输入登录密码二次验证后查看完整号码 |
| 课程表 | 网格编辑、合并单元格 Excel 导入、临时调课、取消调课和 Excel 导出 |
| 班级学期与设置 | 修改用户显示名称和密码；新增、切换、激活或软删除班级与学期 |

通用能力：

- 关闭浏览器后会记住上次选择的班级和学期。
- 删除采用软删除，相关学生、考试、成绩、座次和课程表历史不会被物理清空。
- 删除当前激活学期后，系统会尽可能自动激活最近的其他学期。
- 字段映射会按用户、导入类型和源文件表头保存，下次导入自动恢复，同时仍可手动修改。
- 导入确认使用数据库事务；任何校验或写入错误都会整体回滚，不会留下部分数据。
- 成绩支持小数，允许范围为 `-1000` 到 `750`，可保存总分和“进/退”等数值。
- 单个上传文件最大 20 MB。
- 页面适配 1366×768 笔记本和 iPad Pro 11 英寸横屏。

## 技术栈

- 后端：Python 3.9+、FastAPI、SQLAlchemy、Pydantic
- 数据库：默认 SQLite，也可配置 PostgreSQL 15+
- 前端：Vue 3、Element Plus、Pinia、ECharts、SheetJS 和 pdf.js
- 安全：PBKDF2 密码哈希、Bearer Token 身份认证、Fernet 加密监护人手机号
- 定时任务：APScheduler 自动备份

前端依赖已经保存在 `static/vendor`，运行系统不需要安装 Node.js。

## 环境要求

- Python 3.9 或以上版本
- Windows、macOS 或 Linux 均可通过命令行启动
- 项目自带的一键启动和关闭文件仅用于 Windows
- Chrome、Edge、Firefox 或 Safari 等现代浏览器

## 快速开始

### 1. 安装依赖

建议使用虚拟环境：

```bash
python -m venv .venv
```

Windows：

```powershell
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

macOS 或 Linux：

```bash
source .venv/bin/activate
python -m pip install -r requirements.txt
```

### 2. Windows 一键启动

双击项目根目录的 `启动班主任工作台.bat`。启动器会在后台运行服务，并自动打开：

```text
http://127.0.0.1:8000
```

使用结束后，双击 `关闭班主任工作台.bat` 即可安全停止后台服务。

重复双击启动文件不会产生多个服务进程；如果服务已经运行，只会打开浏览器。可以右键启动文件并选择“发送到 → 桌面快捷方式”，方便不熟悉电脑的使用者直接从桌面进入。

### 3. 命令行启动

```bash
python main.py
```

随后访问 `http://127.0.0.1:8000`。

开发模式自动重载：

```bash
uvicorn main:app --reload
```

### 默认账号

- 用户名：`admin`
- 密码：`admin123`

首次登录后应立即修改密码。`.env` 中的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 只在首次创建管理员时生效。

## 数据保存位置与容量

默认数据库文件为 `./class_manager.db`。用户、班级、学期、学生、座次历史、考试、成绩、值日、联系方式和课程表都会保存在该数据库中。字段映射习惯保存在 `import_mappings` 表，自动备份保存在 `./backup` 目录。

程序没有对常规业务数据设置固定条数上限。SQLite 的实际容量取决于磁盘空间和硬件条件，对个人私有化管理多个班级通常绰绰有余。如果以后需要多人并发、远程访问或大规模数据，可切换 PostgreSQL。

服务运行期间不要手动编辑或删除 `class_manager.db`。

## 数据导入流程

学生名单、考试成绩和课程表均采用“先预览、后入库”的流程：

1. 上传解析：后端解析 `.xlsx`、`.xls`、`.docx` 或 `.pdf` 文件并返回预览，不写入数据库。
2. 字段映射：把源文件列映射到系统字段，或选择“忽略此列”；表头相同时会自动恢复最近一次映射。
3. 预览校验：检查全部数据、学生匹配、重复冲突、分数范围和外语类型拆分结果。
4. 确认入库：用户明确确认后，在同一个事务中完成写入；任意错误都会整体回滚。

成绩既可以导入到已有考试，也可以在导入时创建新考试。创建新考试必须手动填写考试名称和实际考试日期，系统不会再把文件导入日期当作考试日期。

学号只要求在同一个班级内唯一；允许学生重名，因为内部关联使用学生 ID。再次导入已经软删除的学号时，系统会恢复原学生记录，而不是创建冲突数据。

## 配置说明

复制 `.env.example` 为 `.env`，然后按需修改：

| 变量 | 默认值 | 用途 |
|---|---:|---|
| `DATABASE_URL` | `sqlite:///./class_manager.db` | SQLAlchemy 数据库连接 |
| `ENCRYPTION_KEY` | 自动生成 | 加密监护人手机号的 Fernet 密钥 |
| `ADMIN_USERNAME` | `admin` | 初始管理员用户名 |
| `ADMIN_PASSWORD` | `admin123` | 初始管理员密码 |
| `HOST` | `0.0.0.0` | 服务监听地址 |
| `PORT` | `8000` | 服务端口 |
| `CORS_ORIGINS` | 空 | 独立前端允许的跨域来源，多个值用逗号分隔 |
| `BACKUP_DIR` | `./backup` | 备份目录 |
| `BACKUP_HOUR` | `2` | 每日备份小时 |
| `BACKUP_MINUTE` | `0` | 每日备份分钟 |
| `BACKUP_KEEP_COUNT` | `30` | 保留的备份数量 |
| `LOG_FILE` | `./server.log` | 运行日志文件 |
| `LOG_MAX_BYTES` | `5242880` | 单个日志文件最大字节数 |
| `LOG_BACKUP_COUNT` | `5` | 保留的轮转日志数量 |

恢复备份或迁移电脑时必须保留原来的 `ENCRYPTION_KEY`。如果密钥改变，原有加密手机号将无法解密。

## 数据库初始化与升级

系统每次启动时会自动：

1. 创建缺失的数据表和索引；
2. 执行向后兼容的数据库结构升级；
3. 在不存在管理员时创建初始账号；
4. 仅在数据库没有班级时写入演示数据；
5. 在接受请求前执行 SQLite `quick_check`；
6. 立即生成一次备份，并启动每日备份任务。

当前共有 14 张 ORM 数据表，包括 `users`、`classes`、`students`、`semesters`、`seat_plans`、`seat_details`、`exam_records`、`scores`、`duty_templates`、`duty_details`、`import_mappings`、`committee`、`timetable` 和 `timetable_changes`。

### 切换 PostgreSQL

在 `.env` 中配置：

```dotenv
DATABASE_URL=postgresql+psycopg2://postgres:你的密码@localhost:5432/class_manager
```

执行 `python -m pip install psycopg2-binary` 安装驱动。内置 PostgreSQL 备份会生成可移植的 SQL `INSERT` 语句；正式部署建议再配合 `pg_dump` 作为额外备份手段。

## 备份与恢复

- SQLite 使用 Online Backup API，能够包含 WAL 中已提交的数据，生成后还会执行完整性检查。
- 每次启动会立即备份一次，随后按配置的每日时间继续备份。
- 超过 `BACKUP_KEEP_COUNT` 后自动清理旧备份。
- 运行日志会自动轮转，避免无限增长。

恢复 SQLite 数据库：

1. 双击 `关闭班主任工作台.bat` 停止服务。
2. 先复制保存当前的 `class_manager.db` 和 `.env`。
3. 用选定的备份文件覆盖 `class_manager.db`。
4. 确认 `.env` 中仍然是原来的 `ENCRYPTION_KEY`。
5. 重新启动，并检查 `/api/health`。

## 项目结构

```text
classruler-workbench/
├── main.py                         # FastAPI 入口
├── desktop_launcher.py             # Windows 后台启动器
├── 启动班主任工作台.bat              # 一键启动
├── 关闭班主任工作台.bat              # 一键关闭
├── README.md                       # 英文说明
├── README-CN.md                    # 中文说明
├── requirements.txt
├── requirements-dev.txt
├── .env.example
├── app/
│   ├── config.py                   # 环境变量配置
│   ├── database.py                 # 数据库引擎和会话
│   ├── models.py                   # ORM 模型
│   ├── init_db.py                  # 初始化、升级与演示数据
│   ├── security.py                 # 登录认证与加密
│   ├── tasks.py                    # 自动备份任务
│   ├── utils/                      # 文件解析和 Excel 导出
│   └── routers/                    # API 路由
├── static/
│   ├── index.html                  # 单页应用入口
│   ├── css/app.css
│   ├── js/                         # 状态、组件和页面视图
│   └── vendor/                     # 本地前端依赖
├── scripts/stop_workbench.ps1      # 校验进程后安全关闭
├── backup/                         # 自动备份目录
├── uploads/                        # 预留的上传工作目录
└── tests/                           # 回归测试
```

## API 约定

- 在线 API 文档：`http://127.0.0.1:8000/docs`
- 身份认证：`Authorization: Bearer <token>`
- 成功响应：`{"code": 0, "message": "ok", "data": ...}`
- `code` 不为 0 表示请求失败。
- 常见 HTTP 状态码：`400` 业务校验失败、`401` 未登录、`404` 数据不存在、`405` 请求方法错误、`422` 参数不合法、`500` 服务端错误。

## 开发与验证

```bash
python -m pip install -r requirements-dev.txt
pytest -q
```

回归测试覆盖分数区间和小数、事务导入、映射习惯恢复、已删除学生恢复、班级/学期删除、用户名称修改、个人历史成绩、座次行列保存、备份完整性等关键行为。

## 常见问题

| 问题 | 处理方法 |
|---|---|
| 双击启动后没有打开页面 | 查看 `server.launch.err.log`，确认 Python 版本不低于 3.9，并执行 `python -m pip install -r requirements.txt` |
| 出现 `405 Method Not Allowed` | 浏览器使用了错误的请求方法，或仍在运行旧版服务；关闭并重新启动工作台，然后强制刷新页面 |
| 出现 `database is locked` | 不要同时手工运行多个服务进程；使用会自动检测现有服务的一键启动器 |
| 导入成绩时未匹配到学生 | 检查当前选择的班级，并确认文件中的学号或姓名与当前学生名单一致 |
| Anaconda 出现 NumPy/pandas 兼容错误 | 执行 `python -m pip install -U numexpr bottleneck`，或使用全新的虚拟环境 |
| 监护人手机号无法解密 | 恢复创建这些数据时所使用的 `.env` 中的原始 `ENCRYPTION_KEY` |
| 页面白屏或加载缓慢 | 检查 `static/vendor`、浏览器控制台、`server.log` 和 `server.launch.err.log` |

`.env`、数据库、备份、上传文件、PID 文件和日志都属于本地或敏感运行数据，不应提交到版本库。
