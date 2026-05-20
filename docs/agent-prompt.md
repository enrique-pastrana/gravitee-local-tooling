# Agent prompt

Use this prompt after running setup:

```text
Use the local-tooling stack configured in this repository.

Before answering code or Jira questions:
1. Check local repo instructions such as AGENTS.md.
2. Start non-trivial tasks with `rag_prepare_task` or `local-tooling context --repo <repo> --task "<task>"`.
3. Use quick local search and real file reads to verify RAG hits.
4. Treat vectordb as orientation, not source of truth.
5. Verify all vectordb hits against the current repo files before proposing or editing code.
6. Use GitHub, Atlassian, and Kapa MCP as read-only evidence sources unless explicitly told otherwise.
7. Run `local-tooling review-change --repo <repo>` before final answers or commits.
8. Use `local-tooling learn` when you discovered reusable knowledge; use `learn --skip` for explicit no-learning cases.
```
