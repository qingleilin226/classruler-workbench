"""Windows one-click launcher: start the local server and open the browser."""
import json
import os
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PID_FILE = ROOT / ".workbench.pid"
STDOUT_LOG = ROOT / "server.launch.out.log"
STDERR_LOG = ROOT / "server.launch.err.log"


def show_error(message: str) -> None:
    print(message, file=sys.stderr)
    if os.getenv("WORKBENCH_NO_BROWSER"):
        return
    try:
        from tkinter import messagebox
        messagebox.showerror("ClassRuler Workbench", message)
    except Exception:
        pass


def get_port() -> int:
    port = 8000
    env_file = ROOT / ".env"
    if not env_file.exists():
        return port
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        key, separator, value = raw_line.partition("=")
        if separator and key.strip() == "PORT":
            try:
                port = int(value.strip())
            except ValueError:
                pass
    return port


def is_ready(health_url: str) -> bool:
    try:
        with urllib.request.urlopen(health_url, timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return payload.get("data", {}).get("status") == "running"
    except Exception:
        return False


def open_browser(url: str) -> None:
    if not os.getenv("WORKBENCH_NO_BROWSER"):
        webbrowser.open(url)


def main() -> int:
    port = get_port()
    url = f"http://127.0.0.1:{port}"
    health_url = f"{url}/api/health"
    if is_ready(health_url):
        open_browser(url)
        return 0

    try:
        import fastapi  # noqa: F401
        import uvicorn  # noqa: F401
    except ImportError:
        show_error("Python dependencies are missing. Run: pip install -r requirements.txt")
        return 1

    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    with STDOUT_LOG.open("a", encoding="utf-8") as stdout_file, \
            STDERR_LOG.open("a", encoding="utf-8") as stderr_file:
        process = subprocess.Popen(
            [sys.executable, "main.py"],
            cwd=str(ROOT),
            stdin=subprocess.DEVNULL,
            stdout=stdout_file,
            stderr=stderr_file,
            creationflags=creation_flags,
        )

    identity = {
        "pid": process.pid,
        "started_unix_ms": int(time.time() * 1000),
        "executable": sys.executable,
    }
    PID_FILE.write_text(json.dumps(identity, ensure_ascii=False), encoding="utf-8")

    for _attempt in range(80):
        if is_ready(health_url):
            open_browser(url)
            return 0
        if process.poll() is not None:
            break
        time.sleep(0.25)

    if process.poll() is None:
        process.terminate()
    PID_FILE.unlink(missing_ok=True)
    show_error("The workbench could not start. See server.launch.err.log for details.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

