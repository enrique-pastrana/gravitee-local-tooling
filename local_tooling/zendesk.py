from __future__ import annotations

import base64
import json
import time
from urllib import error, request
from urllib.parse import quote, urlencode, urlparse

from .env import api_url, bool_env
from .http import json_post

ZENDESK_DISABLED_MESSAGE = "Zendesk is disabled. Set ZENDESK_ENABLED=true in .env and configure ZENDESK_* secrets."


def zendesk_enabled(env: dict[str, str]) -> bool:
    return bool_env(env, "ZENDESK_ENABLED", False)


def require_zendesk_enabled(env: dict[str, str]) -> None:
    if not zendesk_enabled(env):
        raise SystemExit(ZENDESK_DISABLED_MESSAGE)


def zendesk_base_url(env: dict[str, str]) -> str:
    return env.get("ZENDESK_BASE_URL", "").strip().rstrip("/")


def zendesk_subdomain(env: dict[str, str]) -> str:
    host = urlparse(zendesk_base_url(env)).hostname or "unknown"
    return host.split(".")[0] or "unknown"


def zendesk_page_size(env: dict[str, str]) -> int:
    try:
        return max(1, min(int(env.get("ZENDESK_PAGE_SIZE", "50")), 100))
    except ValueError:
        return 50


def zendesk_timeout(env: dict[str, str]) -> int:
    try:
        return max(1, int(env.get("ZENDESK_TIMEOUT_SECONDS", "15")))
    except ValueError:
        return 15


def zendesk_config_errors(env: dict[str, str]) -> list[str]:
    if not zendesk_enabled(env):
        return []
    errors: list[str] = []
    base_url = zendesk_base_url(env)
    auth_mode = env.get("ZENDESK_AUTH_MODE", "oauth").strip().lower()
    if not base_url or "your-subdomain" in base_url:
        errors.append("ZENDESK_BASE_URL must be set to the team's Zendesk account URL")
    if auth_mode not in {"oauth", "api-token"}:
        errors.append("ZENDESK_AUTH_MODE must be oauth or api-token")
    if auth_mode == "oauth" and not env.get("ZENDESK_OAUTH_ACCESS_TOKEN", "").strip():
        errors.append("ZENDESK_OAUTH_ACCESS_TOKEN is required for ZENDESK_AUTH_MODE=oauth")
    if auth_mode == "api-token":
        if not env.get("ZENDESK_EMAIL", "").strip():
            errors.append("ZENDESK_EMAIL is required for ZENDESK_AUTH_MODE=api-token")
        if not env.get("ZENDESK_API_TOKEN", "").strip():
            errors.append("ZENDESK_API_TOKEN is required for ZENDESK_AUTH_MODE=api-token")
    return errors


def require_zendesk_config(env: dict[str, str]) -> None:
    require_zendesk_enabled(env)
    errors = zendesk_config_errors(env)
    if errors:
        raise SystemExit("Zendesk configuration is invalid:\n- " + "\n- ".join(errors))


def zendesk_auth_headers(env: dict[str, str]) -> dict[str, str]:
    auth_mode = env.get("ZENDESK_AUTH_MODE", "oauth").strip().lower()
    if auth_mode == "oauth":
        return {"Authorization": f"Bearer {env.get('ZENDESK_OAUTH_ACCESS_TOKEN', '').strip()}"}
    raw = f"{env.get('ZENDESK_EMAIL', '').strip()}/token:{env.get('ZENDESK_API_TOKEN', '').strip()}"
    token = base64.b64encode(raw.encode("utf-8")).decode("ascii")
    return {"Authorization": f"Basic {token}"}


def zendesk_get(env: dict[str, str], path: str, params: dict[str, str] | None = None) -> dict[str, object]:
    require_zendesk_config(env)
    query = urlencode(params or {})
    url = zendesk_base_url(env) + path + (f"?{query}" if query else "")
    req = request.Request(url, method="GET")
    req.add_header("Accept", "application/json")
    for key, value in zendesk_auth_headers(env).items():
        req.add_header(key, value)
    try:
        with request.urlopen(req, timeout=zendesk_timeout(env)) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as exc:
        retry_after = exc.headers.get("Retry-After")
        suffix = f"; retry-after={retry_after}" if retry_after else ""
        raise SystemExit(f"Zendesk GET {path} failed with HTTP {exc.code}{suffix}") from exc
    except error.URLError as exc:
        raise SystemExit(f"Zendesk GET {path} failed: {exc}") from exc


def zendesk_search_tickets(env: dict[str, str], query: str, limit: int | None = None) -> dict[str, object]:
    if not query.strip():
        raise SystemExit("Zendesk query must not be empty")
    requested = limit if limit is not None else zendesk_page_size(env)
    page_size = max(1, min(requested, zendesk_page_size(env)))
    payload = zendesk_get(env, "/api/v2/search.json", {"query": query, "per_page": str(page_size)})
    results = payload.get("results", [])
    if not isinstance(results, list):
        results = []
    tickets = [
        item
        for item in results
        if isinstance(item, dict) and item.get("id") is not None and item.get("result_type", "ticket") == "ticket"
    ][:page_size]
    return {
        "count": payload.get("count"),
        "next_page": payload.get("next_page"),
        "results": tickets,
    }


def zendesk_ticket(env: dict[str, str], ticket_id: str) -> dict[str, object]:
    payload = zendesk_get(env, f"/api/v2/tickets/{quote(ticket_id)}.json")
    ticket = payload.get("ticket")
    if not isinstance(ticket, dict):
        raise SystemExit(f"Zendesk ticket not found: {ticket_id}")
    return ticket


def zendesk_ticket_comments(env: dict[str, str], ticket_id: str) -> list[dict[str, object]]:
    payload = zendesk_get(env, f"/api/v2/tickets/{quote(ticket_id)}/comments.json")
    comments = payload.get("comments")
    if not isinstance(comments, list):
        return []
    return [item for item in comments if isinstance(item, dict)]


def zendesk_ticket_url(env: dict[str, str], ticket_id: object) -> str:
    return f"{zendesk_base_url(env)}/agent/tickets/{ticket_id}"


def zendesk_ticket_text(ticket: dict[str, object], comments: list[dict[str, object]]) -> str:
    parts = [
        f"Ticket {ticket.get('id')}: {ticket.get('subject') or ''}",
        "",
        "Description:",
        str(ticket.get("description") or ""),
        "",
        "Comments:",
    ]
    for comment in comments:
        body = str(comment.get("plain_body") or comment.get("body") or "").strip()
        if not body:
            continue
        parts.append(
            f"Comment {comment.get('id') or ''} by {comment.get('author_id') or 'unknown'} "
            f"({comment.get('created_at') or 'unknown'}):"
        )
        parts.append(body)
        parts.append("")
    return "\n".join(parts).strip()


def zendesk_ingest_ticket(env: dict[str, str], ticket_id: str, query: str = "") -> dict[str, object]:
    ticket = zendesk_ticket(env, ticket_id)
    comments = zendesk_ticket_comments(env, ticket_id)
    text = zendesk_ticket_text(ticket, comments)
    if not text:
        raise SystemExit(f"Zendesk ticket has no indexable text: {ticket_id}")
    payload = {
        "source": f"zendesk/{zendesk_subdomain(env)}",
        "path": f"tickets/{ticket.get('id')}",
        "text": text,
        "metadata": {
            "kind": "zendesk-ticket",
            "ticket_id": ticket.get("id"),
            "url": zendesk_ticket_url(env, ticket.get("id")),
            "status": ticket.get("status"),
            "priority": ticket.get("priority"),
            "tags": ticket.get("tags") if isinstance(ticket.get("tags"), list) else [],
            "requester_id": ticket.get("requester_id"),
            "organization_id": ticket.get("organization_id"),
            "created_at": ticket.get("created_at"),
            "updated_at": ticket.get("updated_at"),
            "indexed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "query": query or None,
            "comment_count": len(comments),
        },
        "chunk_size": 1200,
        "chunk_overlap": 200,
    }
    response = json_post(api_url(env), "/ingest", payload, timeout=60)
    return {
        "ticket_id": ticket.get("id"),
        "source": payload["source"],
        "path": payload["path"],
        "ingest_response": response,
    }


def zendesk_index_query(env: dict[str, str], query: str, limit: int | None = None) -> dict[str, object]:
    search = zendesk_search_tickets(env, query, limit)
    results = search.get("results", [])
    ingested = []
    for ticket in results if isinstance(results, list) else []:
        if isinstance(ticket, dict) and ticket.get("id") is not None:
            ingested.append(zendesk_ingest_ticket(env, str(ticket["id"]), query=query))
    return {"query": query, "matched": len(results) if isinstance(results, list) else 0, "ingested": ingested}
