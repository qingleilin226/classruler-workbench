@echo off
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" desktop_launcher.py >nul 2>nul
    if not errorlevel 1 exit /b 0
)
python desktop_launcher.py
if not errorlevel 1 exit /b 0
py -3 desktop_launcher.py
if not errorlevel 1 exit /b 0
echo Unable to start. Please install Python and run: pip install -r requirements.txt
pause
