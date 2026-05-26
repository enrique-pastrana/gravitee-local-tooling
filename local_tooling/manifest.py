from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from .docker_runtime import run
from .env import api_url
from .files import atomic_write
from .paths import GENERATED_MANIFESTS, REPORTS, SEED_SCRIPT


def common_excludes() -> list[str]:
    return [
        "**/.git/**",
        "**/target/**",
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        "**/.angular/**",
        "**/.cache/**",
        "**/__pycache__/**",
        "**/*.pyc",
        "**/*.class",
        "**/*.jar",
        "**/*.zip",
        "**/*.tar",
        "**/*.gz",
        "**/*.png",
        "**/*.jpg",
        "**/*.jpeg",
        "**/*.gif",
        "**/*.pdf",
        "**/*.key",
        "**/*.crt",
        "**/*.jks",
        "**/*.p12",
    ]


def profile_includes(profile: str) -> tuple[list[str], int]:
    base = [
        "AGENTS.md",
        "**/AGENTS.md",
        ".agent-rules/**/*.md",
        "README*",
        "**/README*",
        "CONTRIBUTING*",
        "SECURITY*",
        "pom.xml",
        "**/pom.xml",
        "package.json",
        "**/package.json",
        "angular.json",
        "tsconfig*.json",
        ".github/**/*.md",
        ".github/**/*.yml",
        ".github/**/*.yaml",
        "docs/**/*.md",
        "docs/**/*.adoc",
        "src/main/**/*.java",
        "src/test/**/*.java",
        "src/**/*.ts",
        "src/**/*.html",
        "src/**/*.scss",
    ]
    if profile == "default":
        return base, 500
    if profile == "gravitee-apim":
        includes = [
            "AGENTS.md",
            ".agent-rules/**/*.md",
            "README.md",
            "CONTRIBUTING.adoc",
            "SECURITY.md",
            "pom.xml",
            "gravitee-apim-*/AGENTS.md",
            "gravitee-apim-*/pom.xml",
            "gravitee-apim-*/README*",
            "gravitee-apim-rest-api/**/src/main/java/**/*Resource.java",
            "gravitee-apim-rest-api/**/src/main/java/**/*Service*.java",
            "gravitee-apim-rest-api/**/src/test/java/**/*Service*Test.java",
            "gravitee-apim-gateway/**/src/main/java/**/*Service*.java",
            "gravitee-apim-gateway/**/src/main/java/**/*Manager*.java",
            "gravitee-apim-definition/**/src/main/java/**/*.java",
            "gravitee-apim-console-webui/AGENTS.md",
            "gravitee-apim-console-webui/package.json",
            "gravitee-apim-console-webui/src/**/mcp/**/*.ts",
            "gravitee-apim-console-webui/src/**/mcp/**/*.html",
            "gravitee-apim-console-webui/src/**/*mcp*.ts",
            "gravitee-apim-console-webui/src/**/*mcp*.html",
            "gravitee-apim-portal-webui-next/AGENTS.md",
            "gravitee-apim-portal-webui-next/package.json",
            "gravitee-apim-portal-webui-next/src/**/*mcp*.ts",
            "gravitee-apim-portal-webui-next/src/**/*mcp*.html",
            "docker/quick-setup/**/README*",
            "docker/quick-setup/**/docker-compose.yml",
        ]
        return includes, 900
    raise SystemExit(f"Unknown profile: {profile}")


def default_profile(repo: Path, requested: str | None) -> str:
    if requested:
        return requested
    if repo.name == "gravitee-api-management":
        return "gravitee-apim"
    return "default"


def generated_manifest_path(repo: Path, profile: str) -> Path:
    safe_repo = re.sub(r"[^A-Za-z0-9_.-]+", "-", repo.name)
    return GENERATED_MANIFESTS / f"{safe_repo}-{profile}.json"


def generate_manifest(repo: Path, profile: str) -> Path:
    repo = repo.expanduser().resolve()
    if not repo.is_dir():
        raise SystemExit(f"Repo path is not a directory: {repo}")

    includes, max_files = profile_includes(profile)
    manifest = {
        "contexts": [
            {
                "name": repo.name,
                "source": f"repo/{repo.name}",
                "root": repo.as_posix(),
                "include": includes,
                "exclude": common_excludes(),
                "max_files": max_files,
                "max_bytes": 300000,
                "metadata": {
                    "kind": "codebase",
                    "profile": profile,
                    "repo": repo.name,
                    "generated_by": "local-tooling",
                },
            }
        ]
    }

    path = generated_manifest_path(repo, profile)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(path, json.dumps(manifest, indent=2) + "\n")
    print(path)
    return path


def index_repo(repo: Path, profile: str, env: dict[str, str]) -> None:
    manifest = generate_manifest(repo, profile)
    REPORTS.mkdir(parents=True, exist_ok=True)
    report = REPORTS / f"{manifest.stem}-seed-report.json"
    run(
        [
            sys.executable,
            str(SEED_SCRIPT),
            "--manifest",
            str(manifest),
            "--api-url",
            api_url(env),
            "--execute",
            "--report",
            str(report),
        ],
        env=env,
    )
