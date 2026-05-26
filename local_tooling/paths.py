from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env"
COMPOSE_FILE = ROOT / "docker-compose.yml"
GENERATED_MANIFESTS = ROOT / "manifests" / "generated"
REPORTS = ROOT / "reports"
SEED_SCRIPT = ROOT / "scripts" / "seed_ingest.py"
