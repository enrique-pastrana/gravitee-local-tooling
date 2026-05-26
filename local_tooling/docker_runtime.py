from __future__ import annotations

import json
import shutil
import socket
import subprocess
import time
from urllib import error, request

from .env import api_url
from .paths import COMPOSE_FILE, ROOT


def run(cmd: list[str], *, check: bool = True, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=ROOT, check=check, env=env, text=True)


def compose_cmd(*args: str) -> list[str]:
    return ["docker", "compose", "-f", str(COMPOSE_FILE), *args]


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def docker_daemon_running() -> tuple[bool, str]:
    if not command_exists("docker"):
        return False, "docker command is missing"
    try:
        result = subprocess.run(
            ["docker", "info"],
            cwd=ROOT,
            capture_output=True,
            check=False,
            text=True,
            timeout=10,
        )
    except subprocess.TimeoutExpired:
        return False, "docker info timed out"
    except OSError as exc:
        return False, str(exc)
    if result.returncode == 0:
        return True, "running"
    message = (result.stderr or result.stdout or "docker info failed").strip()
    return False, message.splitlines()[0] if message else "docker info failed"


def docker_compose_available() -> tuple[bool, str]:
    if not command_exists("docker"):
        return False, "docker command is missing"
    result = subprocess.run(
        ["docker", "compose", "version"],
        cwd=ROOT,
        capture_output=True,
        check=False,
        text=True,
    )
    if result.returncode == 0:
        return True, result.stdout.strip()
    message = (result.stderr or result.stdout or "docker compose version failed").strip()
    return False, message.splitlines()[0] if message else "docker compose version failed"


def require_docker() -> None:
    compose_ok, compose_message = docker_compose_available()
    if not compose_ok:
        raise SystemExit(f"Docker Compose is not available: {compose_message}")

    daemon_ok, daemon_message = docker_daemon_running()
    if not daemon_ok:
        raise SystemExit(
            "Docker is installed, but the Docker daemon is not running or is not accessible.\n"
            "Start Docker Desktop or your Docker daemon, then retry.\n"
            f"Details: {daemon_message}"
        )


def check_port(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) == 0


def start_stack(env: dict[str, str]) -> None:
    require_docker()
    run(compose_cmd("up", "-d", "--build"), env=env)


def stop_stack(env: dict[str, str]) -> None:
    run(compose_cmd("down"), env=env)


def health(env: dict[str, str]) -> dict[str, object]:
    url = api_url(env).rstrip("/") + "/health"
    try:
        with request.urlopen(url, timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except error.URLError as exc:
        raise SystemExit(f"Vectordb health check failed at {url}: {exc}") from exc


def wait_for_health(env: dict[str, str], timeout_seconds: int = 60) -> None:
    deadline = time.time() + timeout_seconds
    last_error = ""
    url = api_url(env).rstrip("/") + "/health"
    while time.time() < deadline:
        try:
            with request.urlopen(url, timeout=3) as resp:
                json.loads(resp.read().decode("utf-8"))
                return
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
            time.sleep(2)
    raise SystemExit(f"Vectordb did not become healthy at {url}: {last_error}")
