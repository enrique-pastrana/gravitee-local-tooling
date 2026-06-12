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

## Zendesk ticket analysis

When analyzing a Zendesk ticket (by URL or ticket ID):
1. Always call `zendesk_get_ticket` and `zendesk_get_ticket_comments` to get the full context.
2. Always call `zendesk_get_ticket_attachments` to list all attachments and inline images.
3. For every image found (inline or formal, source: inline or content_type starting with image/), call `zendesk_get_attachment` to download and visually analyze it before forming any conclusion.
4. Treat screenshots as primary evidence — they often reveal configuration details, error messages, or UI states not described in the text.
5. Only after completing steps 1–3 should you summarize the ticket and propose next steps.
