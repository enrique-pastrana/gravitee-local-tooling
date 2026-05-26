from __future__ import annotations

import shutil
import time
from pathlib import Path


def backup_file(path: Path) -> None:
    if not path.exists():
        return
    ts = time.strftime("%Y%m%d%H%M%S")
    shutil.copy2(path, path.with_name(f"{path.name}.local-tooling.{ts}.bak"))


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
