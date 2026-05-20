from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import subprocess
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

    def test_doctor_warns_for_missing_embedding_api_key(self) -> None:
        cli = load_cli()
        env = {"EMBEDDING_BACKEND": "openai-compatible", "VDB_API_PORT": "8000"}
        with mock.patch.object(cli, "docker_compose_available", return_value=(True, "ok")), mock.patch.object(
            cli, "docker_daemon_running", return_value=(True, "running")
        ), mock.patch.object(cli, "command_exists", return_value=True), mock.patch.object(
            cli, "check_port", return_value=True
        ), mock.patch.object(
            cli, "health", return_value={"status": "ok", "documents": 0}
        ), mock.patch(
            "builtins.print"
        ) as mocked_print:
            cli.doctor(env)

        output = "\n".join(str(call.args[0]) for call in mocked_print.call_args_list if call.args)
        self.assertIn("EMBEDDING_API_KEY is required for EMBEDDING_BACKEND=openai-compatible", output)

    def test_doctor_warns_for_unsupported_embedding_backend(self) -> None:
        cli = load_cli()
        env = {"EMBEDDING_BACKEND": "openai", "VDB_API_PORT": "8000"}
        with mock.patch.object(cli, "docker_compose_available", return_value=(True, "ok")), mock.patch.object(
            cli, "docker_daemon_running", return_value=(True, "running")
        ), mock.patch.object(cli, "command_exists", return_value=True), mock.patch.object(
            cli, "check_port", return_value=True
        ), mock.patch.object(
            cli, "health", return_value={"status": "ok", "documents": 0}
        ), mock.patch(
            "builtins.print"
        ) as mocked_print:
            cli.doctor(env)

        output = "\n".join(str(call.args[0]) for call in mocked_print.call_args_list if call.args)
        self.assertIn("Unsupported EMBEDDING_BACKEND=openai", output)

    def test_review_change_warns_for_production_change_without_context(self) -> None:
        cli = load_cli()
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            (repo / "src" / "main" / "java").mkdir(parents=True)
            subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
            (repo / "src" / "main" / "java" / "App.java").write_text("class App {}\n", encoding="utf-8")

            result = cli.review_change(repo, session_id=None, strict=True)

        self.assertEqual(result, 1)

    def test_review_change_passes_with_context_learning_and_tests(self) -> None:
        cli = load_cli()
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            (repo / "src" / "main" / "java").mkdir(parents=True)
            (repo / "src" / "test" / "java").mkdir(parents=True)
            subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
            session = "20260520-test"
            session_dir = cli.session_dir(repo, session)
            session_dir.mkdir(parents=True)
            (session_dir / "context.json").write_text("{}\n", encoding="utf-8")
            (session_dir / "learning-skip.json").write_text("{}\n", encoding="utf-8")
            cli.write_latest_session(repo, session)
            (repo / "src" / "main" / "java" / "App.java").write_text("class App {}\n", encoding="utf-8")
            (repo / "src" / "test" / "java" / "AppTest.java").write_text("class AppTest {}\n", encoding="utf-8")

            result = cli.review_change(repo, session_id=None, strict=True)

        self.assertEqual(result, 0)

    def test_learn_skip_writes_receipt(self) -> None:
        cli = load_cli()
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            repo.mkdir()
            subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)

            path = cli.learn(
                repo,
                {},
                task="APIM-1 example",
                session_id="session-1",
                summary="",
                summary_file=None,
                skip="mechanical change",
            )
            payload = json.loads(path.read_text(encoding="utf-8"))

        self.assertEqual(payload["skip_reason"], "mechanical change")
        self.assertEqual(payload["session_id"], "session-1")

    def test_prepare_context_writes_session_and_ignores_local_tooling(self) -> None:
        cli = load_cli()
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            repo.mkdir()
            subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)

            with mock.patch.object(
                cli,
                "json_post",
                return_value={"count": 1, "results": [{"source": "repo/test", "path": "README.md", "score": 1.0}]},
            ):
                session_dir = cli.prepare_context(repo, "APIM-1 example task", {"VDB_API_URL": "http://localhost:8000"})

            self.assertTrue((session_dir / "context.json").exists())
            self.assertEqual((repo / ".local-tooling" / "latest-session").read_text(encoding="utf-8").strip(), session_dir.name)
            self.assertIn(".local-tooling/", (repo / ".git" / "info" / "exclude").read_text(encoding="utf-8"))

    def test_install_agent_rules_writes_cursor_rule(self) -> None:
        cli = load_cli()
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            repo.mkdir()

            cli.install_agent_rules(repo, ["cursor"])
            rule = repo / ".cursor" / "rules" / "local-tooling.mdc"

            self.assertTrue(rule.exists())
            self.assertIn("local-tooling context", rule.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
