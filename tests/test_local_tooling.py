from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import tempfile
import unittest
from subprocess import CompletedProcess, TimeoutExpired
from unittest import mock
from pathlib import Path


def load_cli():
    root = Path(__file__).resolve().parents[1]
    loader = importlib.machinery.SourceFileLoader("local_tooling_cli", str(root / "bin" / "local-tooling"))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class LocalToolingTest(unittest.TestCase):
    def test_patch_json_mcp_is_idempotent(self) -> None:
        cli = load_cli()
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "mcp.json"

            cli.patch_json_mcp(config)
            first = config.read_text(encoding="utf-8")
            cli.patch_json_mcp(config)
            second = config.read_text(encoding="utf-8")

            self.assertEqual(first, second)
            payload = json.loads(first)
            self.assertIn("vectordb", payload["mcpServers"])
            self.assertIn("create_pull_request", payload["mcpServers"]["github-mcp-server"]["disabledTools"])
            self.assertIn("addCommentToJiraIssue", payload["mcpServers"]["atlassian-mcp-server"]["disabledTools"])

    def test_patch_codex_replaces_managed_block(self) -> None:
        cli = load_cli()
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.toml"
            env = {"CODEX_CONFIG": str(config)}

            cli.patch_codex(env)
            cli.patch_codex(env)

            text = config.read_text(encoding="utf-8")
            self.assertEqual(text.count(cli.CODEX_MARKER_START), 1)
            self.assertIn("[mcp_servers.vectordb]", text)
            self.assertIn("rag_search", text)

    def test_generate_manifest_default_profile(self) -> None:
        cli = load_cli()
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            cli.GENERATED_MANIFESTS = tmp_path / "generated"

            repo = tmp_path / "sample-repo"
            (repo / "src" / "main" / "java").mkdir(parents=True)
            (repo / "AGENTS.md").write_text("# Rules\n", encoding="utf-8")
            (repo / "README.md").write_text("# Readme\n", encoding="utf-8")
            (repo / "src" / "main" / "java" / "App.java").write_text("class App {}\n", encoding="utf-8")

            manifest_path = cli.generate_manifest(repo, "default")
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))

            self.assertEqual(payload["contexts"][0]["root"], repo.resolve().as_posix())
            self.assertEqual(payload["contexts"][0]["metadata"]["profile"], "default")
            self.assertIn("**/target/**", payload["contexts"][0]["exclude"])

    def test_docker_daemon_running_reports_stopped_daemon(self) -> None:
        cli = load_cli()
        result = CompletedProcess(
            args=["docker", "info"],
            returncode=1,
            stdout="",
            stderr="Cannot connect to the Docker daemon",
        )
        with mock.patch.object(cli, "command_exists", return_value=True), mock.patch.object(
            cli.subprocess, "run", return_value=result
        ):
            running, message = cli.docker_daemon_running()

        self.assertFalse(running)
        self.assertEqual(message, "Cannot connect to the Docker daemon")

    def test_docker_daemon_running_reports_timeout(self) -> None:
        cli = load_cli()
        with mock.patch.object(cli, "command_exists", return_value=True), mock.patch.object(
            cli.subprocess, "run", side_effect=TimeoutExpired(["docker", "info"], timeout=10)
        ):
            running, message = cli.docker_daemon_running()

        self.assertFalse(running)
        self.assertEqual(message, "docker info timed out")


if __name__ == "__main__":
    unittest.main()
