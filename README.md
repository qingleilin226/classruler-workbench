# ClassRuler Workbench

[中文版说明](README-CN.md)

ClassRuler Workbench is a self-hosted classroom management system for homeroom teachers. It replaces scattered spreadsheets with one local web application for student rosters, seating plans, duty schedules, exam records, committee assignments, parent contacts, and timetables.

The application is designed for private, low-concurrency use. Data is organized around students, classes, and semesters and is stored locally by default.

## Features

| Module | Capabilities |
|---|---|
| Student roster | Search and filtering, inline editing, batch updates, soft deletion, Excel/Word/PDF import, conflict handling, and Excel export |
| Seating plan | Create a blank grid, add or remove rows and columns, select students by name or student number, drag to swap seats, auto-arrange by student number, track unseated students, preserve empty cells, save version history, restore old versions, and export to Excel |
| Duty schedule | Weekly view, current-day highlighting, batch assignment, next-week rotation, and Excel export |
| Exam analysis | Create exams with a manually selected exam date, enter or import decimal scores, class statistics, score distributions, class rankings, student details, and Excel export |
| Personal score analysis | Search by student name or number and view that student's scores and rankings across every recorded exam |
| Committee | Manage positions and terms, and generate printable appointment certificates |
| Parent contacts | Mask phone numbers by default and require password verification before revealing them |
| Timetable | Grid editing, merged-cell Excel import, temporary course adjustments, cancellation of adjustments, and Excel export |
| Settings | Change the user display name and password; add, switch, activate, or soft-delete classes and semesters |

Shared behavior:

- The last selected class and semester are restored when the browser is reopened.
- Deletions are soft deletions. Related student, exam, seating, and timetable history is retained.
- Deleting an active semester automatically activates the latest remaining semester when possible.
- Import field mappings are remembered by user, import type, and source headers, and can still be changed before each import.
- Import confirmation is transactional: any validation or database error rejects the entire import and writes no partial data.
- Scores accept decimals in the range `-1000` to `750`, allowing progress/regression and total-score columns.
- Uploads are limited to 20 MB.
- The UI is optimized for 1366×768 laptops and iPad Pro 11-inch landscape layouts.

## Technology

- Backend: Python 3.9+, FastAPI, SQLAlchemy, Pydantic
- Database: SQLite by default; PostgreSQL 15+ can be configured
- Frontend: Vue 3, Element Plus, Pinia, ECharts, SheetJS, and pdf.js
- Security: PBKDF2 password hashing, bearer-token authentication, and Fernet encryption for guardian phone numbers
- Scheduling: APScheduler for automatic backups

All frontend libraries are stored under `static/vendor`, so Node.js is not required to run the application.

## Requirements

- Python 3.9 or newer
- Windows, macOS, or Linux for command-line startup
- Windows for the included one-click launch and stop files
- A modern browser such as Chrome, Edge, Firefox, or Safari

## Quick Start

### 1. Install dependencies

Using a virtual environment is recommended:

```bash
python -m venv .venv
```

Windows:

```powershell
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

macOS or Linux:

```bash
source .venv/bin/activate
python -m pip install -r requirements.txt
```

### 2. Start on Windows with one click

Double-click `启动班主任工作台.bat` in the project directory. The launcher starts the server in the background and opens:

```text
http://127.0.0.1:8000
```

When finished, double-click `关闭班主任工作台.bat` to stop the background server safely.

Starting the launcher more than once does not create duplicate servers. If the application is already running, it only opens the browser. You can create a desktop shortcut to the start file for non-technical users.

### 3. Start from the command line

```bash
python main.py
```

Then visit `http://127.0.0.1:8000`.

For development with automatic reload:

```bash
uvicorn main:app --reload
```

### Default account

- Username: `admin`
- Password: `admin123`

Change the password after the first login. `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env` are only used when the administrator is first created.

## Data Storage and Capacity

The default database is `./class_manager.db`. All users, classes, semesters, students, seating versions, exams, scores, duties, contacts, and timetables are stored there. Mapping preferences are stored in the `import_mappings` table, and automatic backups are written to `./backup`.

The application does not impose a fixed row-count limit on normal business data. Practical SQLite capacity depends on available disk space and hardware and is more than sufficient for typical private classroom use. PostgreSQL is recommended if the application later needs many concurrent users, remote access, or substantially larger datasets.

Do not manually edit or delete `class_manager.db` while the service is running.

## Import Workflow

Student rosters, exam scores, and timetables use a preview-first import process:

1. Upload and parse: the server parses `.xlsx`, `.xls`, `.docx`, or `.pdf` content and returns a preview without writing to the database.
2. Map fields: map source columns to system fields or choose “Ignore this column.” The latest mapping for matching headers is restored automatically.
3. Preview and validate: review all parsed rows, student matching, conflicts, score ranges, and foreign-language splitting.
4. Confirm: after explicit confirmation, the import is committed in one transaction. Any error rolls the entire operation back.

Exam imports support both an existing exam and a new exam. A new exam requires a manually entered exam name and actual exam date; the upload date is never used as the exam date.

Student numbers are unique within a class. Duplicate student names are allowed because internal relationships use student IDs. Importing a previously soft-deleted student number restores that student instead of creating an invalid duplicate.

## Configuration

Copy `.env.example` to `.env` and adjust values as needed:

| Variable | Default | Purpose |
|---|---:|---|
| `DATABASE_URL` | `sqlite:///./class_manager.db` | SQLAlchemy database connection |
| `ENCRYPTION_KEY` | generated automatically | Fernet key for encrypted guardian phone numbers |
| `ADMIN_USERNAME` | `admin` | Initial administrator username |
| `ADMIN_PASSWORD` | `admin123` | Initial administrator password |
| `HOST` | `0.0.0.0` | Server bind address |
| `PORT` | `8000` | Server port |
| `CORS_ORIGINS` | empty | Comma-separated origins for a separate frontend |
| `BACKUP_DIR` | `./backup` | Backup destination |
| `BACKUP_HOUR` | `2` | Daily backup hour |
| `BACKUP_MINUTE` | `0` | Daily backup minute |
| `BACKUP_KEEP_COUNT` | `30` | Number of backups retained |
| `LOG_FILE` | `./server.log` | Runtime log file |
| `LOG_MAX_BYTES` | `5242880` | Maximum size of one log file |
| `LOG_BACKUP_COUNT` | `5` | Number of rotated log files retained |

Keep `ENCRYPTION_KEY` unchanged when restoring a backup or moving the application to another computer. A different key makes existing encrypted phone numbers unreadable.

## Database Initialization and Migration

On startup, the application automatically:

1. creates missing tables and indexes;
2. applies compatible schema migrations;
3. creates the initial administrator if needed;
4. adds demonstration data only when no classes exist;
5. runs a SQLite `quick_check` before accepting requests;
6. creates an immediate backup and schedules the daily backup job.

There are 14 ORM tables: `users`, `classes`, `students`, `semesters`, `seat_plans`, `seat_details`, `exam_records`, `scores`, `duty_templates`, `duty_details`, `import_mappings`, `committee`, `timetable`, and `timetable_changes`.

### PostgreSQL

Set the connection in `.env`:

```dotenv
DATABASE_URL=postgresql+psycopg2://postgres:your_password@localhost:5432/class_manager
```

Install the driver with `python -m pip install psycopg2-binary`. The built-in PostgreSQL backup writes portable SQL `INSERT` statements. For production installations, use `pg_dump` as an additional backup layer.

## Backup and Recovery

- SQLite backups use the SQLite Online Backup API, include committed WAL data, and are integrity-checked before being accepted.
- A backup is created at startup and then at the configured daily time.
- Old backups are removed after `BACKUP_KEEP_COUNT` is reached.
- Runtime logs rotate automatically to avoid unlimited growth.

To restore SQLite:

1. Stop the server with `关闭班主任工作台.bat`.
2. Make a safety copy of the current `class_manager.db` and `.env`.
3. Copy the selected backup over `class_manager.db`.
4. Keep the original `ENCRYPTION_KEY` in `.env`.
5. Restart the application and verify `/api/health`.

## Project Structure

```text
classruler-workbench/
├── main.py                         # FastAPI entry point
├── desktop_launcher.py             # Windows background launcher
├── 启动班主任工作台.bat              # One-click start
├── 关闭班主任工作台.bat              # One-click stop
├── README.md                       # English documentation
├── README-CN.md                    # Chinese documentation
├── requirements.txt
├── requirements-dev.txt
├── .env.example
├── app/
│   ├── config.py                   # Environment configuration
│   ├── database.py                 # Database engine and sessions
│   ├── models.py                   # ORM models
│   ├── init_db.py                  # Initialization, migration, and seed data
│   ├── security.py                 # Authentication and encryption
│   ├── tasks.py                    # Backup scheduler
│   ├── utils/                      # File parsing and Excel export
│   └── routers/                    # API routes
├── static/
│   ├── index.html                  # SPA entry point
│   ├── css/app.css
│   ├── js/                         # Store, components, and page views
│   └── vendor/                     # Local frontend dependencies
├── scripts/stop_workbench.ps1      # Verified process shutdown
├── backup/                         # Automatic backups
├── uploads/                        # Reserved upload workspace
└── tests/                           # Regression tests
```

## API Conventions

- Interactive API documentation: `http://127.0.0.1:8000/docs`
- Authentication: `Authorization: Bearer <token>`
- Success response: `{"code": 0, "message": "ok", "data": ...}`
- Non-zero `code` values indicate errors.
- Common HTTP status codes: `400` business validation, `401` unauthenticated, `404` not found, `405` wrong HTTP method, `422` invalid request data, and `500` server error.

## Development and Verification

```bash
python -m pip install -r requirements-dev.txt
pytest -q
```

The regression suite covers score bounds and decimals, transactional imports, mapping recall, student restoration, class/semester deletion, profile updates, personal score history, seating dimensions, backup integrity, and related behavior.

## Troubleshooting

| Problem | Resolution |
|---|---|
| One-click launcher does not open the page | Check `server.launch.err.log`, verify Python 3.9+, and run `python -m pip install -r requirements.txt` |
| `405 Method Not Allowed` | The browser called an endpoint with the wrong HTTP method or an older server is still running. Stop and restart the workbench, then hard-refresh the page |
| `database is locked` | Avoid running multiple manual server processes. Use the one-click launcher, which detects an existing service |
| Student could not be matched during score import | Confirm that the selected class is correct and that the source student number/name matches the current roster |
| Anaconda reports NumPy/pandas compatibility errors | Run `python -m pip install -U numexpr bottleneck` or use a clean virtual environment |
| Guardian phone numbers cannot be decrypted | Restore the original `ENCRYPTION_KEY` from the `.env` used when the data was created |
| The page is blank or slow | Check `static/vendor`, the browser console, `server.log`, and `server.launch.err.log` |

`.env`, database files, backups, uploads, PID files, and logs contain local or sensitive runtime data and should not be committed to version control.
