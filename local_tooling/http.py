from __future__ import annotations

import json
from urllib import error, request


def json_post(api_url_value: str, path: str, payload: dict[str, object], timeout: int = 30) -> dict[str, object]:
    url = api_url_value.rstrip("/") + path
    req = request.Request(url, method="POST", data=json.dumps(payload).encode("utf-8"))
    req.add_header("Content-Type", "application/json")
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"{path} failed with {exc.code}: {body}") from exc
    except error.URLError as exc:
        raise SystemExit(f"{path} failed at {url}: {exc}") from exc
