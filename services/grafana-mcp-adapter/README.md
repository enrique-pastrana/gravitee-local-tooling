# grafana-mcp-adapter

Read-only MCP server that exposes Grafana datasources and metric/log queries as
tools.

## Architecture

The adapter *is* the MCP server. Internally it calls the **Grafana HTTP API**
directly. MCP servers are
not chained to one another.

- Auth (required): this adapter needs a Grafana **service account** and its
  **token**, sent as a Bearer token in the `Authorization` header. The service
  account is provisioned by Gravitee personnel — request it via a change
  management request, scoped to a read-only role (Viewer). Put the token in
  `GRAFANA_TOKEN` in your `.env`.
- Most tools return **raw** payloads (e.g. datasource lists). The exception is
  the high-volume one: `grafana_query` returns a compact per-series digest by
  default (a full `up` query is ~8 MB of frames, far past what an MCP context
  wants); pass `raw=true` for the full frames. `grafana_logs_link` never returns
  log bodies at all — it discovers matching streams via Loki's `/series` (label
  sets only) and returns links plus those stream labels.
- Read-only by design. Note that `grafana_query` is a `POST` (Grafana's
  `/api/ds/query` is POST-shaped) but only **reads** metrics/logs.

## Tools

| Tool | Purpose |
| --- | --- |
| `grafana_health` | Config/connectivity check (makes one authenticated call). |
| `grafana_list_datasources` | List configured datasources (uid, name, type). |
| `grafana_query` | Run a read-only query against a datasource uid over a time range. Pass `expr` for Prometheus/Loki, or `query` (the datasource's own fields) for Elasticsearch/Tempo/Graphite/Pyroscope. Returns a compact digest by default. |
| `grafana_logs_trend` | "When did this start?" — counts matching lines into fixed time buckets and reports total, onset, last seen and peak. Counts only, no log lines. |
| `grafana_logs_patterns` | "What is dominating this log volume?" — Loki's detected line shapes, ranked by volume. **Does not surface rare lines** (see below). |
| `grafana_logs_link` | Build a shareable Grafana logs link for a customer's logs. Discovers matching streams via Loki's `/series` (label sets only, no log lines) to scope the link. Defaults to Logs Drilldown links (per-namespace); pass `link_style="explore"` for a raw LogQL Explore link. |
| `grafana_logs_context` | Every line around a moment in time, **unfiltered** — "what else was happening right then". Refuses a line filter, because a filter is what hides the continuation lines. |
| `grafana_logs_noise` | What is actually filling a stream: lines reduced to their shape, ranked, each with a pasteable LogQL exclusion. Covers what pattern detection cannot see below its floor. |
| `grafana_find_customer` | Which customer or deployment is this, by name or by id — and **which cluster** they are on. Touches no logs. |
| `grafana_http_requests` | HTTP request logs: status distribution, latency percentiles, and parsed individual requests. The only tool that can reach them (see below). |

### HTTP request logs are not in the customer's namespace

Every `client`-scoped tool resolves the customer to their **own** namespaces, and
those hold application logs only. The access logs — status code, request
duration, upstream response time — are emitted by the shared ingress controller,
which runs in the `ingress-nginx` namespace and is identified by the **cluster**
label:

```logql
{cluster="<cluster>", job="flow/ingress-nginx-ingress-nginx"}
```

No namespace-scoped query can reach them. The failure mode is not a missing
feature: a question like "is the Management API slow for this customer" gets
probed with `client`-scoped queries, every one comes back empty, and the empty
results read as evidence the data does not exist.

So `grafana_find_customer` returns `clusters` alongside the namespaces, every
`client`-scoped tool carries a `scope_note` saying what it did **not** search,
and `grafana_http_requests` resolves the cluster for you.

Scoping is handled rather than left to the caller. On a cluster dedicated to one
customer the cluster-wide ingress stream *is* their request log. On a shared
cluster it is not, so the query is narrowed to requests whose upstream is one of
that customer's namespaces — with the one honest limit stated in the response: a
request rejected at the ingress before an upstream was chosen carries no upstream
and is therefore excluded.

Prefer it over a line filter on the raw stream. The access-log line carries
several bare numbers, so `|= " 499 "` also matches 200s whose request length
happened to be 499 bytes; `status_filter` matches the parsed field only.

### Adaptive Logs sampling is reported, not assumed

Grafana Adaptive Logs discards lines before they reach Loki, and marks the
affected streams with an `__adaptive_logs_sampled__` label. That label was
already on every stream Loki returned; nothing read it, so a stream that was
dropping lines looked exactly like a complete one.

`grafana_query`, `grafana_logs_context` and `grafana_logs_noise` now report
`adaptive_logs_sampling` whenever any matched stream carries it, with the label's
value. Counts from a sampled stream are lower bounds. Multi-line content suffers
worst: an exception header can survive while its stack frames are dropped, which
reads as a truncated log rather than as a retention rule someone can lift — a
per-cluster/job exemption can be requested from the Platform team.

### Which datasources `grafana_query` will touch

The read-only guarantee comes from the **query language**, not from token
permissions, so each datasource type is allowed individually:

| Allowed | Why |
| --- | --- |
| `prometheus`, `loki` | PromQL/LogQL have no write statements |
| `elasticsearch` | Grafana's backend only issues `_msearch` |
| `graphite`, `grafana-pyroscope-datasource`, `grafanacloud-cardinality-datasource` | read-only query paths |
| `cloudwatch` | **billable, metrics only** — Logs Insights refused; every result carries a `billing_notice` (see below) |

Deliberately blocked, because these can **act**, not just read:

| Blocked | Why |
| --- | --- |
| `alertmanager` | the Alertmanager API can create silences |
| `grafana-incident-datasource` | can create and modify incidents |
| `k6-datasource` | can trigger load test runs against real targets |
| `grafana-knowledgegraph-datasource` | unreviewed plugin surface |
| `tempo` | read-only, but unused here — unused surface is surface nobody verifies |

#### CloudWatch is metrics-only

CloudWatch is the one type where the datasource type alone is not a sufficient
guard. Metrics mode reads published metrics; **Logs Insights bills per GB
scanned**, an unbounded cost a single careless query can run up. The query
payload is therefore inspected, and anything that is not plainly a Metrics query
is refused *before the request is sent* — `queryMode: "Logs"`, `logGroups`,
`logGroupNames`, `queryLanguage`, or `subtype: "StartQuery"`.

This blocks the unbounded cost, not literally every cost: `GetMetricData` is
itself metered by AWS at a small per-request rate. There is no way to query
CloudWatch for free; the guard removes the failure mode that can produce a large
bill.

Because of that, **every** CloudWatch result carries a `billing_notice` alongside
`results` (on the raw response too), and each CloudWatch query emits a `warn`
log line. Results from other datasources carry no such notice — a warning
attached to free datasources would just train the reader to ignore it.

```jsonc
{
  "billing_notice": "BILLABLE: this query was run against CloudWatch, which AWS meters per request ...",
  "results": { "A": { ... } }
}
```

#### Drilldown links and multiple services

Verified against the live Logs Drilldown app, because both obvious approaches
fail silently:

- A `=~` regex alternation does **not** work. The app treats a filter value as a
  literal and regex-escapes it, so `a|b` reaches Loki as `service_name=~"a\|b"`
  and matches **nothing**.
- The app's own multi-value operator (`=|`) keeps only the **first two** values.
  Observed 1→1, 2→2, 3→2, 5→2, consistently and regardless of settle time.

So a link pins `service_name` only when exactly one service matched. With several
it is scoped to the namespace — broader, but never silently wrong — and the
response carries `scope: "namespace"` plus a `scope_note`. The exact set is always
available in `service_names` and in the `explore_url`, which honours the full
LogQL.

`expr` works **only** for Prometheus and Loki — Elasticsearch rejects it with
HTTP 400 (Tempo, when it was briefly enabled, rejected it with HTTP 500). Use
`query` for the others, e.g.

```jsonc
// Elasticsearch: count over time
{"query": "*", "timeField": "@timestamp",
 "metrics": [{"id": "1", "type": "count"}],
 "bucketAggs": [{"id": "2", "type": "date_histogram", "field": "@timestamp",
                 "settings": {"interval": "auto"}}]}

// Graphite
{"target": "some.metric"}
```

The datasource is always pinned from `datasource_uid` after `query` is merged, so
a caller cannot redirect a query to an unverified (or blocked) datasource.

### `grafana_query` response shape

The raw `/api/ds/query` response carries a full timestamp+value array per series,
and a query like `up` can return thousands of series (~8 MB). By default the tool
collapses each series to its labels + a numeric digest and caps the list:

```jsonc
{
  "results": {
    "A": {
      "status": 200,
      "series_count": 3085,        // total series before capping
      "series": [                  // capped to maxSeries (50)
        { "labels": { "job": "..." }, "count": 60, "first": 1, "last": 1, "min": 0, "max": 1, "avg": 0.98 }
      ],
      "truncated": 3035            // how many series were dropped from `series`
    }
  }
}
```

Pass `raw=true` to get the full (potentially very large) frames instead.

### `grafana_logs_link`

Identify a customer/component with free text (`client='april'`,
`component='gateway'`); it matches case-insensitively against the `service_name`
label, which on this instance encodes both (e.g.
`graviteeio-ae-april-rec-engine`). Returns `{ query, link_style,
resolved_namespaces, links, range, matched_count, matched_streams }`, where
`matched_streams` is the list of `{ namespace, service_name }` label sets the
selector matched (discovered via Loki's `/series` — no log lines are fetched) and
`resolved_namespaces` is the customer's own namespace(s) the `client` resolved to
(empty when the customer only lives in a shared namespace — see the drilldown
section). The default range is the last hour; widen with `from`/`to`. When nothing
matches, it returns close `service_name` values as `suggestions` so typos like
`aprl → april` surface.

Two conditional fields also appear:

- `env_filter_dropped: true` — set when the query pinned the customer's namespace,
  the `client` asked for an env (e.g. `prod`), the first `/series` discovery
  returned nothing, and dropping the env token and retrying *did* find streams.
  Env tokens aren't reliably in `service_name` for every tenant (some name prod
  `plt-live`/`multitenant`), so this flags that the reported streams are the
  customer's namespace-wide results, not env-narrowed ones.
- `suggestions` — close `service_name` values (see above), only when the `client`
  matched no namespace **and** no streams.

#### `link_style`: Logs Drilldown (default) vs Explore

`link_style` chooses the link format in `links`:

- **`drilldown`** (default) — links into Grafana's **Logs Drilldown** app (the
  "Logs" menu, plugin `grafana-lokiexplore-app`). This app navigates
  **per-namespace** (`/explore/namespace/{ns}/logs`), so `links` carries **one
  link per namespace** the query matched (a customer's logs can span several
  namespaces — e.g. `april-prod`, `april-rec`). Each link pins the namespace and
  adds a `service_name` filter built from the **exact** service names seen in
  that namespace (the app treats a raw LogQL regex value as a literal and matches
  nothing, so we use `=` for one value or a `=~` alternation for several),
  dropping you in already scoped so you can filter/drill (levels, fields,
  patterns) by hand in the UI.
- **`explore`** — a single raw **Explore** deep link carrying the LogQL `query`
  (Grafana 11+ `panes` form). Use this when you want the raw query view.

Each entry in `links` is `{ url }` (explore) or `{ namespace, service_names, url }`
(drilldown). The matching stream label sets are always returned in
`matched_streams` regardless of `link_style` — no log lines are fetched.

> **Multitenant note.** On the multitenant Cockpit instance the customer name is
> *not* in `service_name`/`namespace` (it uses a tenant id, e.g. `cp2222`), so a
> free-text `client` won't find those tenants. Resolving customer → tenant id is
> a planned improvement; for now pass the tenant's namespace/id you were given.

#### Examples (how a user asks for it)

Just ask in plain language — the agent maps it to the `client` / `component` /
`from` / `to` / `line_filter` arguments for you.

> "Give me the last hour of API gateway logs for **Northwind**."
> → `{ "client": "northwind", "component": "gateway" }`

> "Show me the engine logs for **Contoso** over the last 6 hours."
> → `{ "client": "contoso", "component": "engine", "from": "now-6h" }`

> "Find the gateway errors for **Globex** in the last 3 hours."
> → `{ "client": "globex", "component": "gateway", "line_filter": "error", "from": "now-3h" }`

> "I need the UI logs for **Initech** during yesterday's incident between 10:00 and 11:00."
> → `{ "client": "initech", "component": "ui", "from": "<epoch ms 10:00>", "to": "<epoch ms 11:00>" }`

> "Give me the **production** gateway logs for **Northwind**."
> → `{ "client": "northwind prod", "component": "gateway" }`

(The environment — `prod`, `rec`, `dev` — isn't a separate argument: it lives
inside `service_name`, so just fold it into `client` as another word. Words are
matched as case-insensitive substrings with `.*` between them, so `northwind
prod` matches `…-northwind-prod-…`. Known environment words (`prod`, `rec`,
`dev`, `nonprod`, `preprod`, `qa`, `int`, `ppr`, `sandbox`, …) are anchored to a
whole `service_name` segment, so `prod` matches `…-prod-…` but **not** the
`prod` inside `nonprod`/`preprod`. Non-env words stay plain substrings, so a
partial customer name like `arcelor` still matches `arcelor-mittal`.)

Each call returns `links` — shareable Grafana links (Logs Drilldown per namespace
by default; see `link_style` above) — plus `matched_streams`, the
`{ namespace, service_name }` label sets the selector matched. No log lines are
fetched; open a link to read the logs in Grafana.

## Setup

This service ships as part of `ia-tooling`. It is **opt-in** and disabled by
default, so teams that don't use Grafana are unaffected.

To enable it, set the following in your `ia-tooling` `.env` (which is
git-ignored — never hardcode the token):

```bash
GRAFANA_ENABLED=true
GRAFANA_BASE_URL=https://your-grafana-host   # e.g. https://gravitee.grafana.net
GRAFANA_TOKEN=...                            # service account token (see Auth above)
```

Then build and start the stack as usual (`bin/local-tooling start`). Once
`GRAFANA_ENABLED=true`, `bin/local-tooling` exposes the `grafana` MCP server
automatically — it is added to your agent config (`.mcp.json` / Codex) just like
`zendesk` / `vectordb` / `github`, with no manual wiring. It only needs HTTPS
egress to the Grafana instance.

`GRAFANA_LOGS_DATASOURCE_UID` is **required** — it has no default. A uid that is
correct for one Grafana org is a silent, plausible failure in every other one, so
the adapter refuses to guess: `doctor` reports it as a config error and the logs
tools fail with a clear message rather than returning an empty result.

Find it under Connections > Data sources > (Loki). **The uid is not always the
same as the display name.** On the Gravitee instance the datasource is displayed
as `grafanacloud-gravitee-logs` but its uid is `grafanacloud-logs`.

### Rotating the token (or any `GRAFANA_*` value)

`GRAFANA_*` reaches the container through the compose `environment:` block, which
is captured when the container is **created**. So the container's own copy of the
token goes stale the moment `.env` changes.

`bin/local-tooling exec-mcp grafana` therefore forwards the resolved `GRAFANA_*`
values into each exec session (`docker exec -e GRAFANA_TOKEN ...`, by name — never
`-e VAR=value`, which would put the token on the command line where `ps` exposes
it). `.env` is authoritative at **connect** time, so:

```bash
# edit .env, then simply reconnect the MCP client. No container recreate.
```

An **already-connected** MCP session keeps the values it started with, because its
`docker exec` is still running. Reconnect that client to pick up a new token —
`doctor` reads `.env` and so describes what the *next* connection will use.

Only variables that are actually set are forwarded: `docker exec -e VAR` for an
unset VAR does not leave the container's baked value in place, it removes it.

### The customer snapshot is never committed

`customers-snapshot.json` is a **local fallback cache** and is deliberately
gitignored. It is generated from `gravitee-io/cloud-deployments-configuration`,
which is **private**, and it contains the customer list with their control-plane
and data-plane ids. **This repository is public** — committing that file would
publish who Gravitee's customers are and how their infrastructure is addressed.

Generate it locally when you want an offline fallback:

```bash
cd services/grafana-mcp-adapter
GITHUB_PERSONAL_ACCESS_TOKEN=... npm run refresh-customers
```

Nothing breaks without it. The Dockerfile's `COPY customers-snapshot.jso[n]` is a
no-op when the file is absent, so a fresh clone builds; the adapter fetches the
map from GitHub at runtime and, if GitHub is unreachable AND no snapshot exists,
reports that Gravitee Cloud customers cannot be resolved rather than failing or
guessing. Hosted customers are unaffected either way — they resolve from Loki.

### Why hosted customers are NOT in the bundled map

The map covers Gravitee Cloud (Cockpit) tenants only. Hosted/standalone customers
are resolved by matching Loki's `namespace` label, and that is deliberate — the
question was measured, not assumed.

`gravitee-techops-hosted-customers` lists 93 standalone customers as directory
names, but those directories are **not** namespaces, and the namespace string does
not appear in that repo at all (verified: GitHub code search finds
`adminPassword` 30 times and `arcelor-prod` zero times — namespaces are generated
at deploy time). Checked against a 30-day window of live namespaces:

| | |
| --- | --- |
| 71 of 93 | resolve today via the namespace matcher |
| 8 of 93 | directory name differs from the real namespace |
| 14 of 93 | no live namespace at all (dormant/decommissioned) |

The 8 are the reason not to bundle: `arcelor-mittal` -> `arcelor-prod`,
`falcon-air` -> `falcon-prod`, `nimbusco` -> `nimbus-prod`, `zenithfr` ->
`zenith-prod`, `blueyonder-apac` -> `blueyonder-plt-live`. Bundling the
directory names would add eight customer names that match no namespace, while the
existing matcher already resolves all eight from the name a human would type
(`arcelor`, `falcon`, `nimbus`). Loki is the authority for this population.

### `grafana_logs_patterns` has a volume floor

Loki's pattern detection only reports patterns above a volume threshold. Rare
lines are **absent entirely**, not ranked last. Measured on this instance over a
48h window: the smallest reported pattern was **34 lines**, while a 10-line
`DeserializationException` in the same window did not appear at all.

So an error missing from the pattern list is **not** evidence it did not happen.
Every response carries `smallest_pattern_count` and a `coverage_note` saying so.
To find or count a specific or rare error, use `grafana_logs_trend` (which counts
a `line_filter` over time) or `grafana_query`.

`lines_in_patterns` counts only the lines Loki assigned to some pattern — it is
not a total line count for the range.

## Testing

Tests use Node's built-in runner — no extra framework. Run them with:

```bash
npm test          # node --test
npm run check     # syntax-check the source files
```

Coverage:

- `helpers.test.js` — the pure helpers (`helpers.js`).
- `grafanaClient.test.js` — the HTTP client (`grafanaClient.js`): config
  validation, auth headers, param handling.
- `server.test.js` — the `server.js` orchestration that talks to Loki, with
  `fetch` stubbed per Loki endpoint: `grafana_logs_link`'s namespace resolution,
  per-namespace drilldown grouping, the `explore_url` fallback, the env
  auto-retry, and the empty-result `note`/`suggestions` branches, plus
  `grafana_query`'s digest-vs-`raw` output. `server.js` only starts the stdio
  transport when run as the entrypoint, so tests import it and invoke the
  registered tool handlers directly (via the exported `tools` map).
