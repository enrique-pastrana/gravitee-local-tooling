# Agent prompt

Use this prompt after running setup:

```text
Use the local-tooling stack configured in this repository.

Before answering code or Jira questions:
1. Check local repo instructions such as AGENTS.md.
2. Use quick local search first.
3. Use vectordb through rag_search when the problem-to-code mapping is unclear.
4. Treat vectordb as orientation, not source of truth.
5. Verify all vectordb hits against the current repo files before proposing or editing code.
6. Use GitHub, Atlassian, and Kapa MCP as read-only evidence sources unless explicitly told otherwise.
```
