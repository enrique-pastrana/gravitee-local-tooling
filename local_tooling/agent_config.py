from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from .files import atomic_write, backup_file
from .paths import ROOT
from .zendesk import zendesk_enabled

CODEX_MARKER_START = "# >>> local-tooling managed"
CODEX_MARKER_END = "# <<< local-tooling managed"

GITHUB_DISABLED_TOOLS = [
    "create_branch",
    "create_pull_request",
    "create_repository",
    "delete_file",
    "fork_repository",
    "issue_write",
    "merge_pull_request",
    "pull_request_review_write",
    "push_files",
    "request_copilot_review",
    "update_pull_request",
    "update_pull_request_branch",
    "assign_copilot_to_issue",
    "add_issue_comment",
    "add_comment_to_pending_review",
    "create_or_update_file",
]

ATLASSIAN_DISABLED_TOOLS = [
    "editJiraIssue",
    "createJiraIssue",
    "addCommentToJiraIssue",
    "transitionJiraIssue",
    "addWorklogToJiraIssue",
]


def local_tooling_command() -> str:
    return str(ROOT / "bin" / "local-tooling")


def parse_agents(value: str) -> list[str]:
    if value == "all":
        return ["codex", "cursor", "claude"]
    agents = [item.strip().lower() for item in value.split(",") if item.strip()]
    invalid = sorted(set(agents) - {"codex", "cursor", "claude"})
    if invalid:
        raise SystemExit(f"Unsupported agent(s): {', '.join(invalid)}")
    return agents


def env_path(env: dict[str, str], key: str, default: Path) -> Path:
    configured = env.get(key, "").strip()
    return Path(configured).expanduser() if configured else default.expanduser()


def codex_config_path(env: dict[str, str]) -> Path:
    return env_path(env, "CODEX_CONFIG", Path("~/.codex/config.toml"))


def cursor_config_path(env: dict[str, str]) -> Path:
    return env_path(env, "CURSOR_MCP_CONFIG", Path("~/.cursor/mcp.json"))


def claude_config_path(env: dict[str, str]) -> Path:
    if env.get("CLAUDE_MCP_CONFIG", "").strip():
        return Path(env["CLAUDE_MCP_CONFIG"]).expanduser()
    if sys.platform == "darwin":
        return Path("~/Library/Application Support/Claude/claude_desktop_config.json").expanduser()
    return Path("~/.config/Claude/claude_desktop_config.json").expanduser()


def toml_array(items: list[str]) -> str:
    return "[\n" + "".join(f'  "{item}",\n' for item in items) + "]"


def codex_block(env: dict[str, str] | None = None) -> str:
    cmd = local_tooling_command()
    zendesk_block = ""
    if env is not None and zendesk_enabled(env):
        zendesk_block = f"""

[mcp_servers.zendesk]
command = "{cmd}"
args = ["mcp", "zendesk"]
enabled = true
""".rstrip()
    return f"""
{CODEX_MARKER_START}

[mcp_servers.vectordb]
command = "{cmd}"
args = ["mcp", "vectordb"]
enabled = true

[mcp_servers.github-mcp-server]
command = "{cmd}"
args = ["mcp", "github"]
disabled_tools = {toml_array(GITHUB_DISABLED_TOOLS)}
enabled = true

[mcp_servers.atlassian]
command = "{cmd}"
args = ["mcp", "atlassian"]
disabled_tools = {toml_array(ATLASSIAN_DISABLED_TOOLS)}
enabled = true

[mcp_servers.kapa]
command = "{cmd}"
args = ["mcp", "kapa"]
enabled = true
{zendesk_block}

[mcp_servers.vectordb.tools.rag_health]
approval_mode = "approve"

[mcp_servers.vectordb.tools.rag_search]
approval_mode = "approve"

[mcp_servers.vectordb.tools.rag_prepare_task]
approval_mode = "approve"

[mcp_servers.vectordb.tools.rag_ingest]
approval_mode = "approve"

{CODEX_MARKER_END}
""".strip()


def patch_codex(env: dict[str, str]) -> Path:
    path = codex_config_path(env)
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    pattern = re.compile(
        rf"\n?{re.escape(CODEX_MARKER_START)}.*?{re.escape(CODEX_MARKER_END)}\n?",
        re.DOTALL,
    )
    cleaned = pattern.sub("\n", existing).rstrip()
    updated = (cleaned + "\n\n" if cleaned else "") + codex_block(env) + "\n"
    if updated != existing:
        backup_file(path)
        atomic_write(path, updated)
    return path


def mcp_json(env: dict[str, str] | None = None) -> dict[str, object]:
    cmd = local_tooling_command()
    servers = {
        "vectordb": {"command": cmd, "args": ["mcp", "vectordb"]},
        "github-mcp-server": {
            "command": cmd,
            "args": ["mcp", "github"],
            "disabledTools": GITHUB_DISABLED_TOOLS,
        },
        "atlassian-mcp-server": {
            "command": cmd,
            "args": ["mcp", "atlassian"],
            "disabledTools": ATLASSIAN_DISABLED_TOOLS,
        },
        "kapa": {"command": cmd, "args": ["mcp", "kapa"]},
    }
    if env is not None and zendesk_enabled(env):
        servers["zendesk"] = {"command": cmd, "args": ["mcp", "zendesk"]}
    return servers


def patch_json_mcp(path: Path, env: dict[str, str] | None = None) -> Path:
    if path.exists():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise SystemExit(f"Cannot parse JSON config {path}: {exc}") from exc
    else:
        payload = {}

    if not isinstance(payload, dict):
        raise SystemExit(f"Expected JSON object in {path}")

    servers = payload.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        raise SystemExit(f"Expected mcpServers object in {path}")

    servers.update(mcp_json(env))
    if env is not None and not zendesk_enabled(env):
        servers.pop("zendesk", None)
    updated = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    if updated != existing:
        backup_file(path)
        atomic_write(path, updated)
    return path


def configure_agents(agents: list[str], env: dict[str, str]) -> None:
    for agent in agents:
        if agent == "codex":
            path = patch_codex(env)
        elif agent == "cursor":
            path = patch_json_mcp(cursor_config_path(env), env)
        elif agent == "claude":
            path = patch_json_mcp(claude_config_path(env), env)
        else:
            raise AssertionError(agent)
        print(f"Configured {agent}: {path}")
