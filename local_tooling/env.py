from __future__ import annotations

import os

from .paths import ENV_FILE


def load_env() -> dict[str, str]:
    env = dict(os.environ)
    if not ENV_FILE.exists():
        return env
    for raw_line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in env:
            env[key] = value
    return env


def bool_env(env: dict[str, str], key: str, default: bool = False) -> bool:
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def api_url(env: dict[str, str]) -> str:
    if env.get("VDB_API_URL", "").strip():
        return env["VDB_API_URL"].strip()
    return f"http://localhost:{env.get('VDB_API_PORT', '8000')}"
