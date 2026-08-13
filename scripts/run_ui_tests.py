import os
import socket
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "test" / "fixtures" / "dashboard_preview_server.js"
CASES = (
    (False, ROOT / "test" / "ui" / "dashboard_ui.py"),
    (True, ROOT / "test" / "ui" / "dashboard_onboarding_ui.py"),
)


def find_available_port():
    with socket.socket() as candidate:
        candidate.bind(("127.0.0.1", 0))
        return candidate.getsockname()[1]


def wait_for_server(port, process, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"预览服务提前退出，退出码 {process.returncode}")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)
    raise TimeoutError(f"预览服务未在 {timeout} 秒内监听端口 {port}")


def stop_process(process):
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def run_case(empty_config, test_file):
    port = find_available_port()
    env = os.environ.copy()
    env["DASHBOARD_PREVIEW_PORT"] = str(port)
    env["DASHBOARD_EMPTY_CONFIG"] = "true" if empty_config else "false"
    env.setdefault("DASHBOARD_SCREENSHOT_DIR", str(ROOT / "test" / "artifacts"))
    server = subprocess.Popen(
        ["node", str(FIXTURE)],
        cwd=ROOT,
        env=env,
    )
    try:
        wait_for_server(port, server)
        subprocess.run([sys.executable, str(test_file)], cwd=ROOT, env=env, check=True)
    finally:
        stop_process(server)


def main():
    for case in CASES:
        run_case(*case)
    print("dashboard-ui-suite-ok")


if __name__ == "__main__":
    main()
