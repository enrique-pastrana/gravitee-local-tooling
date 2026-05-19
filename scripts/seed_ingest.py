#!/usr/bin/env python3
"""Ingest manifest-selected local files into the local vectordb API."""

from __future__ import annotations

import argparse
import fnmatch
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib import error, request


@dataclass
class FileCandidate:
    context: str
    source: str
    root: Path
    rel_path: str
    abs_path: Path
    metadata: dict[str, Any]
    size_bytes: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest local seed data into vectordb")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--api-url", default="http://localhost:8000")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--chunk-size", type=int, default=1200)
    parser.add_argument("--chunk-overlap", type=int, default=200)
    parser.add_argument("--report", required=True)
    return parser.parse_args()


def load_manifest(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def should_skip_binary(raw: bytes) -> bool:
    sample = raw[:4096]
    if b"\x00" in sample:
        return True
    if not sample:
        return False
    printable = sum(1 for b in sample if b in b"\t\n\r" or 32 <= b <= 126)
    return printable / len(sample) < 0.7


def collect_files(context_cfg: dict[str, Any]) -> list[FileCandidate]:
    name = context_cfg["name"]
    source = context_cfg["source"]
    root = Path(context_cfg["root"]).expanduser()
    includes: list[str] = context_cfg.get("include", [])
    excludes: list[str] = context_cfg.get("exclude", [])
    max_files = int(context_cfg.get("max_files", 500))
    max_bytes = int(context_cfg.get("max_bytes", 250000))
    metadata = dict(context_cfg.get("metadata", {}))

    if not root.exists():
        return []

    seen: set[Path] = set()
    candidates: list[FileCandidate] = []
    for pattern in includes:
        for file_path in root.glob(pattern):
            if not file_path.is_file() or file_path in seen:
                continue
            rel = file_path.relative_to(root).as_posix()
            if any(fnmatch.fnmatch(rel, ex) for ex in excludes):
                continue
            size_bytes = file_path.stat().st_size
            if size_bytes > max_bytes:
                continue
            seen.add(file_path)
            candidates.append(
                FileCandidate(
                    context=name,
                    source=source,
                    root=root,
                    rel_path=rel,
                    abs_path=file_path,
                    metadata=metadata,
                    size_bytes=size_bytes,
                )
            )

    candidates.sort(key=lambda c: c.rel_path)
    return candidates[:max_files]


def post_json(api_url: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    url = api_url.rstrip("/") + path
    req = request.Request(url, method="POST", data=json.dumps(payload).encode("utf-8"))
    req.add_header("Content-Type", "application/json")
    try:
        with request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{path} failed with {exc.code}: {body}") from exc
    except error.URLError as exc:
        raise RuntimeError(f"{path} failed: {exc}") from exc
    return json.loads(raw.decode("utf-8"))


def ingest_candidates(
    api_url: str,
    candidates: list[FileCandidate],
    chunk_size: int,
    chunk_overlap: int,
    execute: bool,
) -> dict[str, Any]:
    contexts: dict[str, dict[str, Any]] = {}
    errors: list[dict[str, Any]] = []
    total_chunks = 0
    total_files = 0

    for candidate in candidates:
        ctx = contexts.setdefault(
            candidate.context,
            {"files_selected": 0, "files_ingested": 0, "chunks": 0, "bytes": 0},
        )
        ctx["files_selected"] += 1
        ctx["bytes"] += candidate.size_bytes

        raw = candidate.abs_path.read_bytes()
        if should_skip_binary(raw):
            continue
        text = raw.decode("utf-8", errors="ignore").strip()
        if not text:
            continue

        total_files += 1
        if not execute:
            ctx["files_ingested"] += 1
            continue

        payload = {
            "source": candidate.source,
            "path": candidate.rel_path,
            "text": text,
            "metadata": {
                **candidate.metadata,
                "context": candidate.context,
                "root": candidate.root.as_posix(),
                "relative_path": candidate.rel_path,
                "size_bytes": candidate.size_bytes,
                "seeded_at_unix": int(time.time()),
            },
            "chunk_size": chunk_size,
            "chunk_overlap": chunk_overlap,
        }

        try:
            response = post_json(api_url, "/ingest", payload)
            chunks = int(response.get("chunks", 0))
            ctx["files_ingested"] += 1
            ctx["chunks"] += chunks
            total_chunks += chunks
        except Exception as exc:  # noqa: BLE001
            errors.append(
                {
                    "context": candidate.context,
                    "source": candidate.source,
                    "path": candidate.rel_path,
                    "error": str(exc),
                }
            )

    return {
        "mode": "execute" if execute else "dry-run",
        "contexts": contexts,
        "totals": {
            "files_considered": len(candidates),
            "files_textual": total_files,
            "chunks_ingested": total_chunks,
            "errors": len(errors),
        },
        "errors": errors,
    }


def main() -> int:
    args = parse_args()
    manifest_path = Path(args.manifest).expanduser()
    report_path = Path(args.report).expanduser()
    report_path.parent.mkdir(parents=True, exist_ok=True)

    if not manifest_path.exists():
        print(f"Manifest not found: {manifest_path}", file=sys.stderr)
        return 1

    manifest = load_manifest(manifest_path)
    candidates: list[FileCandidate] = []
    for context_cfg in manifest.get("contexts", []):
        candidates.extend(collect_files(context_cfg))

    report = ingest_candidates(args.api_url, candidates, args.chunk_size, args.chunk_overlap, args.execute)
    report["manifest"] = manifest_path.as_posix()
    report["api_url"] = args.api_url
    report["timestamp"] = int(time.time())

    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    print(f"\nReport written to: {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
