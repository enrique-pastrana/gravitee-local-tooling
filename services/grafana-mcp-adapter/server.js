import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ENABLED,
  BASE_URL,
  log,
  requireConfig,
  grafanaGet,
  grafanaPost,
  grafanaDatasourceProxyGet,
} from "./grafanaClient.js";
import {
  summarizeQueryResult,
  isLogFrame,
  requireDatasourceUid,
  buildLogsQuery,
  buildExploreUrl,
  buildDrilldownUrl,
  buildExactLogsQuery,
  toLokiNs,
  rankClientSuggestions,
  splitClientEnv,
  matchNamespaces,
  chooseInterval,
  durationSeconds,
  buildTrendBuckets,
  summarizeTrend,
  summarizePatterns,
  resolvedWindow,
  mergeContextStreams,
  profileNoise,
} from "./helpers.js";
import { loadCustomerMap, warmCustomerMap, resolveCustomerNamespaces, matchCustomers, groupByCustomer, lookupById, dataPlaneNamespace, controlPlaneNamespace } from "./customerMap.js";

// Loki datasource uid for the logs tools. Required — deliberately NOT defaulted:
// a uid that is correct for one Grafana org is a silent, plausible failure in
// every other one. requireDatasourceUid() turns "unset" into a clear error at
// the point of use instead.
const LOGS_DATASOURCE_UID = (process.env.GRAFANA_LOGS_DATASOURCE_UID || "").trim();

// Allowlist of datasource types whose QUERY LANGUAGE cannot write. This is the
// whole basis of the read-only guarantee — it is not about token permissions, so
// every entry is a deliberate judgement, not a convenience.
//
// Allowed: PromQL/LogQL have no write statements; Grafana's Elasticsearch backend
// only issues _msearch; Graphite render, Pyroscope and the cardinality plugin are
// read paths.
//
// Deliberately NOT allowed, and each for a concrete reason:
//   alertmanager                  - the Alertmanager API can create silences
//   grafana-incident-datasource   - can create and modify incidents
//   k6-datasource                 - can trigger load test runs against real targets
//   cloudwatch                    - reads only, but Logs Insights starts billable
//                                   query executions; enable deliberately, not by default
//   grafana-knowledgegraph-datasource - unreviewed plugin surface
//   tempo                         - read-only, but unused here; not worth the
//                                   surface area, and it was never verified
//                                   against real trace data
const READONLY_QUERY_TYPES = new Set([
  "prometheus",
  "loki",
  "elasticsearch",
  "graphite",
  "grafana-pyroscope-datasource",
  "grafanacloud-cardinality-datasource",
  // cloudwatch is allowed for METRICS ONLY - see CLOUDWATCH_LOGS_FIELDS below.
  "cloudwatch",
]);

// CloudWatch is the one allowed type where the datasource type alone is not a
// sufficient guard. Its Metrics mode reads published metrics, but its Logs mode
// runs Logs Insights, which bills per GB SCANNED — an unbounded, open-ended cost
// that a single careless query can run up. So the query payload is inspected and
// anything that is not plainly a Metrics query is refused.
//
// Honest caveat: this blocks the unbounded cost, not literally every cost.
// GetMetricData (Metrics mode) is itself metered by AWS at a small per-request
// rate. There is no way to query CloudWatch at zero cost; the guard removes the
// failure mode that can produce a large bill.
const CLOUDWATCH_LOGS_FIELDS = ["logGroups", "logGroupNames", "logGroupName", "queryLanguage", "logsQuery"];

// Every CloudWatch query costs money, including the Metrics ones this adapter
// allows: AWS meters GetMetricData per request. The guard above removes the
// unbounded Logs Insights cost, but it cannot make CloudWatch free — so every
// CloudWatch result carries this notice rather than letting a caller assume the
// reads are free the way Loki and Prometheus reads are.
const CLOUDWATCH_BILLING_NOTICE =
  "BILLABLE: this query was run against CloudWatch, which AWS meters per request " +
  "(GetMetricData is charged per 1000 metrics requested). Unlike the Loki/Prometheus " +
  "datasources, CloudWatch reads are not free. Logs Insights queries, which bill per " +
  "GB scanned, are refused by this adapter.";

// Attach the notice as a sibling of `results` so it is visible on both the digest
// and the raw response, without disturbing either shape.
function withBillingNotice(out, type) {
  if (type !== "cloudwatch") return out;
  return { billing_notice: CLOUDWATCH_BILLING_NOTICE, ...out };
}

function assertCloudwatchNotBillableLogs(query = {}) {
  const mode = String(query.queryMode ?? "Metrics").trim().toLowerCase();
  if (mode !== "metrics") {
    throw new Error(
      `CloudWatch queryMode "${query.queryMode}" is refused: only "Metrics" is allowed. ` +
        "Logs Insights queries bill per GB scanned and are blocked by this adapter.",
    );
  }
  for (const field of CLOUDWATCH_LOGS_FIELDS) {
    if (query[field] !== undefined) {
      throw new Error(
        `CloudWatch query field "${field}" is refused: it selects a Logs Insights query, ` +
          "which bills per GB scanned and is blocked by this adapter.",
      );
    }
  }
  // `subtype: "StartQuery"` is how the Logs path is dispatched regardless of mode.
  if (String(query.subtype ?? "").toLowerCase() === "startquery") {
    throw new Error(
      'CloudWatch subtype "StartQuery" is refused: it starts a billable Logs Insights execution.',
    );
  }
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

// Grafana gates /api/datasources and /api/datasources/uid/:uid behind the
// `datasources:read` permission, which the built-in Viewer role does NOT have:
// a Viewer can QUERY a datasource but cannot read its configuration. This
// adapter is meant to run with a Viewer-scoped token, so nothing on the query
// path may depend on those endpoints — otherwise the read-only guard itself
// fails and grafana_query stops working entirely the moment the token is
// correctly scoped.
//
// /api/frontend/settings is what the Grafana UI loads on every page, so any
// authenticated user can read it, and each entry carries the uid/name/type we
// need. It is the least-privileged source for the datasource catalogue, and is
// used as the fallback wherever a privileged endpoint is tried first.
// The catalogue backs a security guard, so it is cached but never indefinitely:
// a stale entry must not be able to outlive a real permissions or configuration
// change. Past the TTL we re-fetch, and a failed re-fetch propagates rather than
// serving stale data — the guard fails closed.
const CATALOGUE_TTL_MS = 5 * 60 * 1000;
let dsCatalogue = null;
let dsCatalogueFetchedAt = 0;

async function fetchFrontendDatasources() {
  const settings = await grafanaGet("/frontend/settings");
  const byUid = new Map();
  for (const ds of Object.values(settings?.datasources || {})) {
    // `-- Mixed --` / `-- Dashboard --` are UI pseudo-datasources with no uid.
    if (!ds?.uid || !ds?.type) continue;
    byUid.set(ds.uid, { uid: ds.uid, name: ds.name ?? null, type: ds.type });
  }
  // defaultDatasource is keyed by NAME, not uid.
  return { byUid, defaultName: settings?.defaultDatasource ?? null };
}

async function frontendDatasources({ refresh = false } = {}) {
  const expired = Date.now() - dsCatalogueFetchedAt > CATALOGUE_TTL_MS;
  if (refresh || !dsCatalogue || expired) {
    dsCatalogue = await fetchFrontendDatasources();
    dsCatalogueFetchedAt = Date.now();
  }
  return dsCatalogue;
}

// Resolve one datasource by uid from the Viewer-safe catalogue. A miss refreshes
// once, so a datasource created since this process started is still found rather
// than being rejected from a stale cache.
async function lookupFrontendDatasource(uid) {
  let cat = await frontendDatasources();
  if (!cat.byUid.has(uid)) cat = await frontendDatasources({ refresh: true });
  return cat.byUid.get(uid) ?? null;
}

// Given a datasource uid, verify it is read-only against the allowlist defined by READONLY_QUERY_TYPES. 
// Throws if not allowed or not found. Returns the datasource's uid, name and type.
async function assertReadOnly(uid) {
  if (typeof uid !== "string" || uid.trim() === "") {
    throw new Error("datasource_uid is required");
  }

  // Prefer the authoritative datasource record, but treat its absence as a
  // permissions problem rather than a verification failure: a Viewer-scoped
  // token cannot read it. Fall back to the catalogue every authenticated user
  // can see. If NEITHER source can name the type we still refuse the query —
  // the guard fails closed, it just no longer requires Admin to pass.
  let ds = null;
  let primaryError = null;
  try {
    ds = await grafanaGet(`/datasources/uid/${encodeURIComponent(uid)}`);
  } catch (err) {
    primaryError = err;
    try {
      ds = await lookupFrontendDatasource(uid);
    } catch (fallbackErr) {
      throw new Error(
        `datasource "${uid}" could not be verified read-only: ${err.message} (fallback failed: ${fallbackErr.message})`,
      );
    }
  }
  if (!ds) {
    throw new Error(
      `datasource "${uid}" could not be verified read-only: ${primaryError ? primaryError.message : "not found"}`,
    );
  }

  const type = ds?.type ?? null;
  if (!type || !READONLY_QUERY_TYPES.has(type)) {
    throw new Error(
      `datasource "${uid}" (type "${type ?? "unknown"}") is not in the read-only allowlist ${JSON.stringify([...READONLY_QUERY_TYPES])}`
    )
  }

  return { uid: ds.uid ?? uid, name: ds.name ?? null, type };
}


// raw=true returns Grafana's frames untouched, which means a log result that hit
// the line cap is indistinguishable from a complete one. Attach a note (and only
// a note — the frames themselves stay verbatim) when the cap was reached.
function withRawTruncationNote(payload, limit) {
  for (const res of Object.values(payload?.results || {})) {
    const frames = Array.isArray(res?.frames) ? res.frames : [];
    const lines = frames.filter(isLogFrame).reduce((n, frame) => {
      const idx = (frame?.schema?.fields || []).findIndex((f) => f?.name === "Line");
      return n + (idx === -1 ? 0 : (frame?.data?.values?.[idx] || []).length);
    }, 0);
    if (lines >= limit) {
      res.limit_reached = true;
      res.note = `Returned ${lines} log lines, the maximum requested — more lines almost certainly match. Raise max_lines or narrow the range.`;
    }
  }
  return payload;
}

async function listDatasources() {
  try {
    const items = await grafanaGet("/datasources");
    const list = Array.isArray(items) ? items : [];
    return {
      count: list.length,
      source: "datasources",
      datasources: list.map((ds) => ({
        uid: ds.uid ?? null,
        name: ds.name || null,
        type: ds.type || null,
        is_default: ds.isDefault ?? false,
      })),
    };
  } catch (err) {
    // Expected under a Viewer-scoped token (no datasources:read). The catalogue
    // carries uid/name/type — everything needed to pick a uid for grafana_query
    // — but not the full datasource configuration.
    const cat = await frontendDatasources({ refresh: true });
    const list = [...cat.byUid.values()];
    return {
      count: list.length,
      source: "frontend_settings",
      note:
        `Listed from /frontend/settings because /api/datasources was refused (${err.message}). ` +
        "That is expected for a Viewer-scoped token. uid/name/type are accurate; other " +
        "datasource settings are not exposed by this endpoint.",
      datasources: list.map((ds) => ({
        uid: ds.uid,
        name: ds.name,
        type: ds.type,
        is_default: cat.defaultName != null && ds.name === cat.defaultName,
      })),
    };
  }
}


// Discover which log streams match a selector WITHOUT pulling any log lines.
// Loki's /series returns just the label sets of the matching streams (one object
// per stream, e.g. {namespace, service_name, pod, ...}); we only need namespace
// and service_name to build the link, so this is far cheaper than query_range
// (no log bodies, no timestamps). The `|= "..."` line filter is dropped from the
// selector here — /series matches on the stream selector only, and the
// service_name we need for the link doesn't depend on the line filter anyway.
async function fetchMatchingStreams({ query, from, to }) {
  const data = await grafanaDatasourceProxyGet(LOGS_DATASOURCE_UID, "loki/api/v1/series", {
    "match[]": query,
    start: toLokiNs(from, 60 * 60),
    end: toLokiNs(to, 0),
  });
  const series = data?.data || [];
  return series.map((s) => ({
    namespace: s.namespace || null,
    service_name: s.service_name || null,
  }));
}

// Resolve a free-text `client` to the customer's own namespace(s). Many
// customers have a dedicated namespace that names them (`april-prod`,
// `blueyonder-plt-live`) — that namespace is the most reliable customer
// identifier, more so than `service_name` (which for some tenants carries an
// opaque id, not the name). We fetch the `namespace` label values and keep the
// ones whose name contains the customer "core" (env tokens excluded — they
// aren't reliably in the namespace). Returns [] for customers that only live in
// a shared namespace (e.g. `prod`), which tells the caller to fall back to a
// plain `service_name` match.
// Resolve a free-text client to the namespaces holding its logs, by two routes:
//
//  1. The namespace label itself. Hosted/standalone customers get a namespace
//     named after them (`april-prod`, `demo-qa`), so matching label values works.
//
//  2. The Gravitee Cloud customer map. Cockpit tenants live in
//     `apim-dp-<controlPlaneId>-<dataPlaneId>` and carry their name NOWHERE in
//     their labels, so route 1 returns nothing for them however the name is
//     spelled — the customers this tooling is most useful for were exactly the
//     ones it could not find.
//
// Returns which route answered, and any warning about the map's freshness, so a
// caller can tell a live mapping from a fallback one.
async function resolveNamespaces(client, { from, control_plane_id } = {}) {
  const { core, envs } = splitClientEnv(client);
  if (!core) return { namespaces: [], via: "none" };

  let values = [];
  try {
    const data = await grafanaDatasourceProxyGet(LOGS_DATASOURCE_UID, "loki/api/v1/label/namespace/values", {
      start: toLokiNs(from, 60 * 60),
    });
    values = data?.data || [];
  } catch {
    values = [];
  }

  // BOTH routes, always — never stop at the first hit. A customer can exist in
  // both populations at once: acme has a hosted `acme-prod` namespace
  // AND Cockpit data planes under `apim-dp-cp1111-*`. Returning early on the
  // label match searched half its logs and reported that as the whole story.
  const byLabel = matchNamespaces(values, core);
  const map = await loadCustomerMap();
  const resolved = resolveCustomerNamespaces(map.rows, { core, envs, controlPlaneId: control_plane_id });
  const namespaces = [...new Set([...byLabel, ...resolved.namespaces])];

  // An ambiguous fragment contributes NOTHING from the map rather than merging
  // several customers together. The label route is unaffected — a hosted
  // customer that matched by name is still searched — but the caller is told
  // which Cockpit customers were withheld and why.
  // A customer that does not resolve may simply be missing from a stale map, and
  // that is a different answer from "no such customer".
  if (resolved.ambiguous) {
    return {
      namespaces: byLabel,
      via: byLabel.length ? "namespace_label" : "none",
      ambiguous_customer: true,
      candidates: resolved.candidates,
      note: resolved.reason,
      map_source: map.source,
      map_warning: map.warning,
    };
  }

  if (!namespaces.length) {
    return {
      namespaces: [],
      via: "none",
      map_source: map.source,
      map_generated_at: map.generated_at,
      map_generated_days_ago: map.generated_days_ago,
      map_warning: map.warning,
    };
  }

  const via =
    byLabel.length && resolved.namespaces.length
      ? "namespace_label+customer_map"
      : byLabel.length
        ? "namespace_label"
        : "customer_map";

  // The map is not complete or eternally fresh: measured against a 30-day window,
  // 129 of 462 live data planes are absent from it, and some customers' mapped
  // ids no longer exist because their deployment was recreated. A mapped
  // namespace that Loki has never heard of in this range would otherwise produce
  // a confident "no logs for this customer" — a false negative dressed as an
  // answer. Flag it instead.
  const liveNamespaces = new Set(values);
  const absent = resolved.namespaces.filter((n) => !liveNamespaces.has(n));

  return {
    namespaces,
    via,
    ...(absent.length ? { mapped_namespaces_absent_in_range: absent } : {}),
    ...(resolved.namespaces.length
      ? {
          map_source: map.source,
          map_generated_at: map.generated_at,
          map_generated_days_ago: map.generated_days_ago,
          map_warning: map.warning,
        }
      : {}),
    label_namespaces: byLabel,
    matched_deployments: resolved.matched.map((r) => ({
      customer: r.customer,
      data_plane_id: r.data_plane_id,
      region: r.region,
      provider: r.provider,
      env: r.env,
    })),
    env_filter_applied: resolved.env_filter_applied,
    control_plane_ids: resolved.control_plane_ids,
    ...(resolved.spans_multiple_organizations
      ? { spans_multiple_organizations: true, organizations_note: resolved.organizations_note }
      : {}),
    // Control-plane namespaces are SHARED by every customer on that control
    // plane, so they are never searched implicitly under one customer's name.
    // Reported so the caller knows they exist and can ask for them explicitly.
    shared_control_plane_namespaces: resolved.control_plane_namespaces,
  };
}

// When a logs query returns nothing, the `client` text often just doesn't match
// any `service_name`. Fetch the label's values and suggest the closest ones so
// the caller can correct the spelling. Returns a small, de-duplicated list.
async function suggestClients(client, { from } = {}) {
  let values = [];
  try {
    const data = await grafanaDatasourceProxyGet(LOGS_DATASOURCE_UID, "loki/api/v1/label/service_name/values", {
      start: toLokiNs(from, 60 * 60),
    });
    values = data?.data || [];
  } catch {
    return [];
  }
  return rankClientSuggestions(values, client);
}

// grafana_logs_trend / grafana_logs_patterns scope a customer exactly the way
// grafana_logs_link does — same namespace resolution, same selector — so the
// three tools always describe the same set of logs. Returns the selector plus the
// namespaces it resolved to.
async function resolveCustomerSelector({ client, component, lineFilter, from, controlPlaneId, caseSensitive = false }) {
  const resolution = await resolveNamespaces(client, { from, control_plane_id: controlPlaneId });
  const pinned = resolution.namespaces.length ? resolution.namespaces : undefined;
  return {
    resolution,
    namespaces: resolution.namespaces,
    selector: buildLogsQuery({ client, component, lineFilter, namespaces: pinned, caseSensitive }),
  };
}

// The parts of a resolution worth returning to the caller: how the customer was
// found, and whether the mapping behind it was live or a fallback.
function resolutionReport(resolution = {}) {
  const out = { resolved_via: resolution.via };
  for (const key of [
    "map_source",
    "map_generated_at",
    "map_generated_days_ago",
    "label_namespaces",
    "matched_deployments",
    "env_filter_applied",
    "shared_control_plane_namespaces",
    "ambiguous_customer",
    "candidates",
    "spans_multiple_organizations",
    "organizations_note",
    "control_plane_ids",
    "mapped_namespaces_absent_in_range",
  ]) {
    if (resolution[key] !== undefined && resolution[key] !== null) out[key] = resolution[key];
  }
  if (resolution.map_warning) out.map_warning = resolution.map_warning;
  if (resolution.note) out.customer_note = resolution.note;
  return out;
}

// Resolve a Grafana-style range to whole seconds for Loki's query_range.
function rangeSeconds(from, to) {
  const start = Math.floor(Number(toLokiNs(from, 24 * 3600)) / 1e9);
  const end = Math.floor(Number(toLokiNs(to, 0)) / 1e9);
  return { start, end };
}

async function withToolLogging(tool, fields, fn) {
  const start = Date.now();
  log("info", "Tool call started", { tool, ...fields });
  try {
    const result = await fn();
    log("info", "Tool call succeeded", { tool, duration_ms: Date.now() - start });
    return result;
  } catch (err) {
    log("error", "Tool call failed", {
      tool,
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// MCP server + tool registration
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "grafana-mcp-adapter",
  version: "0.1.0",
});

// Registered tool handlers, keyed by tool name, so tests can invoke the tool
// orchestration directly (with fetch stubbed) without going through the stdio
// transport. `server.tool()` returns a registration object carrying `.handler`.
export const tools = {};
function registerTool(name, ...rest) {
  tools[name] = server.tool(name, ...rest).handler;
}

registerTool(
  "grafana_health",
  "Read-only Grafana health/config check. Reports reachability and whether the token " +
    "carries the optional datasources:read permission.",
  {},
  async () =>
    withToolLogging("grafana_health", {}, async () => {
      requireConfig();
      // Probe with an endpoint every authenticated user can read. Probing via
      // /api/datasources would make health report "unhealthy" for a correctly
      // Viewer-scoped token — failing on privilege rather than on reachability,
      // and contradicting this adapter's own advice to run as a Viewer.
      const cat = await frontendDatasources({ refresh: true });
      const probe = await listDatasources();
      const readable = probe.source === "datasources";
      return textResult({
        status: "ok",
        enabled: ENABLED,
        base_url: BASE_URL,
        reachable: true,
        datasource_count: readable ? probe.count : cat.byUid.size,
        // Surfaced because it has no default: unset means the logs tools cannot
        // work, and that should be visible from health rather than discovered
        // as an empty result later.
        logs_datasource_uid: LOGS_DATASOURCE_UID || null,
        logs_datasource_configured: Boolean(LOGS_DATASOURCE_UID),
        // Optional: queries work without it. Only the full datasource listing needs it.
        datasources_readable: readable,
        ...(readable
          ? {}
          : {
              note:
                "Token lacks the datasources:read permission, which is expected for a " +
                "Viewer-scoped token. Querying and log links are unaffected; the datasource " +
                "list comes from /frontend/settings (uid/name/type only).",
            }),
      });
    }),
);

registerTool(
  "grafana_list_datasources",
  "Read-only list of configured Grafana datasources. Returns uid, name, type and " +
    "is_default. Use a datasource uid with grafana_query.",
  {},
  async () => withToolLogging("grafana_list_datasources", {}, async () => textResult(await listDatasources())),
);

registerTool(
  "grafana_query",
  "Read-only metric/log query via Grafana's /api/ds/query. Provide the datasource " +
    "uid (from grafana_list_datasources) and either `expr` (PromQL/LogQL) or `query` " +
    "(the datasource's own query fields, for types that do not use `expr`), plus an " +
    "optional time range. `expr` works ONLY for Prometheus and Loki; other types reject " +
    "it. Use `query` for them, e.g. Elasticsearch: " +
    '{\"query\":\"*\",\"timeField\":\"@timestamp\",\"metrics\":[{\"id\":\"1\",\"type\":\"count\"}],' +
    '\"bucketAggs\":[{\"id\":\"2\",\"type\":\"date_histogram\",\"field\":\"@timestamp\",\"settings\":{\"interval\":\"auto\"}}]}; ' +
    'Graphite: {\"target\":\"some.metric\"}. ' +
    "CloudWatch is BILLABLE and METRICS ONLY: every CloudWatch query is metered by AWS " +
    "(unlike the free Loki/Prometheus reads), and Logs Insights queries are refused " +
    "outright because they bill per GB scanned. CloudWatch results carry a billing_notice. " +
    "Prefer another datasource when one can answer the question. " +
    "By default returns a compact " +
    "digest: for metrics, one entry per series (labels + count/first/last/min/max/avg); " +
    "for Loki log queries, the line count, time window, the streams the lines came from " +
    "and the DISTINCT KINDS of line present — near-identical lines are collapsed into one " +
    "entry with an `occurrences` count, so a repeated message is reported once rather than " +
    "filling the sample, and rarer kinds stay visible; for anything else (e.g. Elasticsearch " +
    "raw documents) " +
    "the row count, the columns and a few sample rows. Pass raw=true for the " +
    "full (potentially very large) " +
    "frames. Log queries are capped at max_lines lines (Grafana defaults to 100 when " +
    "unset); when the cap is hit the result says so, AND reports how much of the requested " +
    "window those lines actually span — Loki fills the cap backwards from the window end, so a " +
    "capped 1-hour query may cover only its last minute. Every log result carries a `coverage` " +
    "verdict: NO_DATA_SCANNED (Loki scanned zero bytes: wrong selector or window, NOT evidence of " +
    "absence), EMPTY_BUT_SCANNED (trustworthy negative), TRUNCATED, or OK. Check it before " +
    "reporting any negative finding. Times accept 'now-1h', epoch ms, or ISO 8601 with an explicit " +
    "offset; a timestamp without a timezone is refused rather than guessed. " +
    "Only datasources whose query language is " +
    `read-only are allowed (types: ${[...READONLY_QUERY_TYPES].join(", ")}); a uid of ` +
    "any other type is rejected.",
  {
    datasource_uid: z.string().describe("Datasource uid from grafana_list_datasources."),
    expr: z.string().optional().describe("Query expression. Prometheus (PromQL) and Loki (LogQL) only."),
    query: z
      .record(z.any())
      .optional()
      .describe(
        "Native query fields for datasource types that do not use `expr` (Elasticsearch, " +
          "Graphite, Pyroscope). Merged into the query sent to Grafana. The " +
          "datasource is always pinned from datasource_uid and cannot be overridden here.",
      ),
    from: z.string().default("now-1h").describe("Range start, e.g. 'now-1h' or epoch ms."),
    to: z.string().default("now").describe("Range end, e.g. 'now' or epoch ms."),
    max_data_points: z
      .number().int().min(1).max(5000).default(1000).optional()
      .describe("Resolution for METRIC queries. Has no effect on log queries — use max_lines for those."),
    max_lines: z
      .number().int().min(1).max(5000).default(100).optional()
      .describe("Maximum log lines to return for a Loki log query. Grafana's own default is 100."),
    raw: z.boolean().default(false).optional().describe("Return the full raw frames instead of the digest. Can be very large."),
  },
  async ({ datasource_uid, expr, query, from = "now-1h", to = "now", max_data_points = 1000, max_lines = 100, raw = false }) =>
    withToolLogging("grafana_query", { datasource_uid }, async () => {
      if (!expr && !query) throw new Error("either expr (Prometheus/Loki) or query (other datasource types) is required");
      const ds = await assertReadOnly(datasource_uid);
      // Type-level allowlisting is not enough for CloudWatch: the same datasource
      // can run cheap metric reads or unbounded, billable Logs Insights scans.
      if (ds.type === "cloudwatch") {
        assertCloudwatchNotBillableLogs(query || {});
        log("warn", "Billable datasource queried", { tool: "grafana_query", datasource_uid, type: ds.type });
      }
      const payload = await grafanaPost("/ds/query", {
        from,
        to,
        queries: [
          {
            // `query` is spread FIRST so the fields below always win. The
            // datasource in particular must not be overridable: assertReadOnly
            // verified datasource_uid, so letting a caller-supplied field
            // replace it would route the query to an unverified datasource and
            // defeat the read-only guard entirely.
            ...(query || {}),
            refId: "A",
            datasource: { uid: datasource_uid, type: ds.type },
            ...(expr === undefined ? {} : { expr }),
            // maxDataPoints sets the resolution of a METRIC query. Grafana's
            // Loki backend ignores it for log queries and caps those with
            // maxLines instead (defaulting to 100 when neither the query nor
            // the datasource sets it), so both have to be sent explicitly —
            // otherwise the line cap is invisible and uncontrollable.
            maxDataPoints: max_data_points,
            maxLines: max_lines,
          },
        ],
      });
      if (raw) {
        // The raw frames carry the cap silently: a log query that hit it looks
        // exactly like one that didn't. Flag it rather than let a partial page
        // be read as the complete set.
        return textResult(withBillingNotice(withRawTruncationNote(payload, max_lines), ds.type));
      }
      const window = resolvedWindow(from, to, 3600);
      return textResult(
        withBillingNotice(
          {
            // Echo the window the query actually ran over. A wrong window is the
            // commonest cause of a confident empty answer, and it belongs in the
            // result rather than being inferred from surprise at the results.
            window: { requested: { from, to }, resolved_utc: `${window.from_utc} .. ${window.to_utc}` },
            ...summarizeQueryResult(payload, { limit: max_lines, window }),
          },
          ds.type,
        ),
      );
    }),
);

registerTool(
  "grafana_logs_link",
  "Read-only: build a shareable Grafana logs link for a customer's logs. Discovers " +
    "which log streams match (via Loki's /series — label sets only, no log lines) so " +
    "the link is scoped to the exact service_name values that exist. Identify the " +
    "customer/component with free text (e.g. client='april', component='gateway') — it " +
    "matches case-insensitively against the `service_name` label, which encodes both. " +
    "Optionally pre-fill the link's line filter with line_filter. Default range is the " +
    "last 1 hour; widen with from/to (e.g. from='now-6h'). " +
    "link_style controls the link format: 'drilldown' (default) builds Grafana's Logs " +
    "Drilldown app links (the 'Logs' menu), navigated per-namespace, so the user can " +
    "filter/drill by hand; 'explore' builds a raw Explore (LogQL) deep link instead. " +
    "Returns { query, links, range, matched_count, matched_streams }; `links` is " +
    "per-namespace for drilldown (multitenant customers can span several). When a " +
    "line_filter is set, each drilldown link also carries an `explore_url`: the Logs " +
    "Drilldown app pre-fills the filter but doesn't apply it on load, so paste the " +
    "explore_url for evidence — it honours the filter immediately. Ask the user before " +
    "widening the range since logs are large.",
  {
    client: z.string().describe("Customer name fragment, e.g. 'april', 'alliander', 'apim-cloudgate'."),
    component: z.string().optional().describe("Component fragment, e.g. 'gateway', 'engine', 'ui'."),
    line_filter: z.string().optional().describe("Pre-fill the link's line filter with this substring (lines containing it)."),
    case_sensitive: z
      .boolean()
      .default(false)
      .optional()
      .describe(
        "Match line_filter case-sensitively. Default false: `|=` is case-sensitive, and a wrong-case " +
          "filter returns a clean, believable empty result rather than an error.",
      ),
    link_style: z
      .enum(["drilldown", "explore"])
      .default("drilldown")
      .describe("Link format: 'drilldown' (Logs Drilldown app, per-namespace; default) or 'explore' (raw LogQL Explore)."),
    control_plane_id: z.string().optional().describe("Narrow to one Cockpit organization when a customer name spans several (see grafana_find_customer)."),
    from: z.string().default("now-1h").describe("Range start, e.g. 'now-1h', 'now-6h', or epoch ms."),
    to: z.string().default("now").describe("Range end, e.g. 'now' or epoch ms."),
  },
  async ({ client, component, line_filter, link_style = "drilldown", control_plane_id, case_sensitive = false, from = "now-1h", to = "now" }) =>
    withToolLogging("grafana_logs_link", { client, component, link_style, from, to }, async () => {
      // Fail loudly and once, rather than querying a nonexistent datasource and
      // reporting "no log streams matched" for what is really a config error.
      requireDatasourceUid(LOGS_DATASOURCE_UID);
      // Prefer the customer's own namespace when it has one (`april-prod`,
      // `blueyonder-plt-live`): the namespace names the customer reliably,
      // whereas `service_name` doesn't for every tenant. Customers that only
      // live in a shared namespace (`prod`) resolve to [] and fall back to the
      // plain service_name match.
      const resolution = await resolveNamespaces(client, { from, control_plane_id });
      const namespaces = resolution.namespaces;
      const pinned = namespaces.length ? namespaces : undefined;
      // The selector we discover streams with carries no line filter — /series
      // matches on the stream selector only, and the line_filter is applied in
      // the generated link itself, not here.
      let query = buildLogsQuery({ client, component, namespaces: pinned, caseSensitive: case_sensitive });
      let streams = await fetchMatchingStreams({ query, from, to });

      // Env tokens (prod, stage, …) aren't reliably in the service_name either —
      // some customers name their prod `plt-live`/`multitenant`. So if we pinned
      // the customer's namespace, asked for an env, and got nothing, drop the env
      // filter and retry once: the namespace pin still scopes us to the customer,
      // which beats a misleading empty result. (We can't be perfect against
      // legacy/inconsistent labels; this just maximizes useful hits.)
      let env_filter_dropped = false;
      if (streams.length === 0 && pinned && splitClientEnv(client).envs.length) {
        const retryQuery = buildLogsQuery({ client: splitClientEnv(client).core, component, namespaces: pinned });
        const retryStreams = await fetchMatchingStreams({ query: retryQuery, from, to });
        if (retryStreams.length) {
          query = retryQuery;
          streams = retryStreams;
          env_filter_dropped = true;
        }
      }

      // Re-attach the line filter to the reported query so the caller sees the
      // full LogQL (the discovery query above intentionally omitted it). Only
      // rebuild when there's actually a line filter to add — otherwise `query`
      // (already env-adjusted by the retry) is exactly what we'd produce.
      const reportedQuery = line_filter
        ? buildLogsQuery({ client: env_filter_dropped ? splitClientEnv(client).core : client, component, lineFilter: line_filter, namespaces: pinned, caseSensitive: case_sensitive })
        : query;

      const result = {
        query: reportedQuery,
        link_style,
        resolved_namespaces: namespaces,
        ...resolutionReport(resolution),
        ...(env_filter_dropped ? { env_filter_dropped: true } : {}),
        range: { from, to },
        matched_count: streams.length,
        matched_streams: streams,
      };

      if (link_style === "explore") {
        // Single raw Explore (LogQL) deep link.
        result.links = [{ url: buildExploreUrl({ datasourceUid: LOGS_DATASOURCE_UID, query: reportedQuery, from, to }) }];
      } else {
        // Logs Drilldown navigates per-namespace. Group the matched streams by
        // namespace (a multitenant customer can span several, e.g. two data plane
        // gateways) and emit one link each, scoped to the EXACT service_name
        // values seen in that namespace — the app treats a raw regex value as a
        // literal, so we can't reuse the LogQL selector here.
        const byNamespace = new Map();
        for (const s of streams) {
          if (!s.namespace) continue;
          if (!byNamespace.has(s.namespace)) byNamespace.set(s.namespace, new Set());
          if (s.service_name) byNamespace.get(s.namespace).add(s.service_name);
        }
        result.links = [...byNamespace.entries()].map(([namespace, names]) => {
          const serviceNames = [...names];
          const link = {
            namespace,
            service_names: serviceNames,
            // The Drilldown app cannot honour a multi-service filter (it
            // regex-escapes a `=~` alternation, and truncates its own
            // multi-value operator past two values), so such links are scoped to
            // the namespace. Say so, rather than let the caller assume the link
            // is narrowed to service_names.
            ...(serviceNames.length > 1
              ? {
                  scope: "namespace",
                  scope_note:
                    `Link is scoped to namespace "${namespace}" only — the Logs Drilldown app cannot ` +
                    `filter on ${serviceNames.length} service_name values. Use explore_url, or the ` +
                    "app's own filter UI, to narrow to specific services.",
                }
              : { scope: "service_name" }),
            url: buildDrilldownUrl({
              namespace,
              serviceNames,
              datasourceUid: LOGS_DATASOURCE_UID,
              from,
              to,
              lineFilter: line_filter,
              caseSensitive: case_sensitive,
            }),
          };
          // The Logs Drilldown app pre-fills the line filter in its box but does
          // not apply it on load (it renders empty until the user re-types it).
          // When a line_filter is set, attach a raw Explore (LogQL) link scoped to
          // this namespace's exact service_names — Explore honours the filter
          // immediately, so it's the reliable evidence link.
          if (line_filter) {
            link.explore_url = buildExploreUrl({
              datasourceUid: LOGS_DATASOURCE_UID,
              query: buildExactLogsQuery({ namespace, serviceNames, lineFilter: line_filter, caseSensitive: case_sensitive }),
              from,
              to,
            });
          }
          return link;
        });
      }

      // No streams: if we resolved the customer's namespace(s) but nothing
      // matched, the customer is right — it's just a quiet range (or the
      // component/env narrowed too far). Otherwise the `client` text likely
      // didn't match any service_name; offer close matches to correct it.
      if (streams.length === 0) {
        const absent = resolution.mapped_namespaces_absent_in_range || [];
        if (absent.length) {
          result.note =
            `No log streams matched, and ${absent.length} of the mapped namespace(s) (${absent.join(", ")}) do not ` +
            "appear in Loki for this range at all. That usually means the customer map is stale — the deployment was " +
            "recreated under a new id — rather than that the customer has no logs. Check grafana_find_customer, or " +
            "widen from/to in case the deployment is simply dormant.";
        } else if (namespaces.length) {
          result.note = `No log streams in this range for namespace(s) ${namespaces.join(", ")}. Try widening from/to or relaxing component/env.`;
        } else {
          const suggestions = await suggestClients(client, { from });
          if (suggestions.length) {
            result.note = `No log streams matched in this range. Did you mean one of these service_name values? Re-run with a closer 'client'.`;
            result.suggestions = suggestions;
          } else {
            result.note = `No log streams matched in this range. Try widening from/to or adjusting client/component.`;
          }
        }
      }
      return textResult(result);
    }),
);

registerTool(
  "grafana_logs_trend",
  "Read-only: how a customer's matching log volume changes over time — the 'when did " +
    "this start?' tool. Counts matching lines into fixed time buckets and reports the " +
    "total, the first bucket with any matches (onset), the last, and the peak. Scopes " +
    "the customer exactly like grafana_logs_link (client='april', component='gateway'). " +
    "Use line_filter to trend one error rather than all traffic. The bucket size is " +
    "chosen from the range; override with interval (30s/5m/1h/1d). Default range is the " +
    "last 24h, because incidents are usually reported well after they start. Returns " +
    "counts only — no log lines.",
  {
    client: z.string().describe("Customer name fragment, e.g. 'april', 'demo qa'."),
    component: z.string().optional().describe("Component fragment, e.g. 'gateway', 'api'."),
    line_filter: z.string().optional().describe("Only count lines containing this substring."),
    case_sensitive: z
      .boolean()
      .default(false)
      .optional()
      .describe("Match line_filter case-sensitively. Default false, so a wrong-case filter does not read as zero."),
    from: z.string().default("now-24h").describe("Range start, e.g. 'now-24h', 'now-7d', or epoch ms."),
    to: z.string().default("now").describe("Range end."),
    interval: z.string().optional().describe("Bucket size (30s, 5m, 1h, 1d). Defaults to a size giving a readable number of buckets."),
    control_plane_id: z.string().optional().describe("Narrow to one Cockpit organization (see grafana_find_customer)."),
  },
  async ({ client, component, line_filter, from = "now-24h", to = "now", interval, control_plane_id, case_sensitive = false }) =>
    withToolLogging("grafana_logs_trend", { client, component, from, to }, async () => {
      const uid = requireDatasourceUid(LOGS_DATASOURCE_UID);
      const { namespaces, selector, resolution } = await resolveCustomerSelector({ client, component, lineFilter: line_filter, from, controlPlaneId: control_plane_id, caseSensitive: case_sensitive });
      const { start, end } = rangeSeconds(from, to);
      const step = interval || chooseInterval(Math.max(end - start, 1));
      const stepSeconds = durationSeconds(step);

      // count_over_time's range vector matches the step, so buckets tile the
      // window exactly: no overlap (which double-counts) and no gaps.
      const query = `sum(count_over_time(${selector} [${step}]))`;
      const data = await grafanaDatasourceProxyGet(uid, "loki/api/v1/query_range", {
        query,
        start: `${start * 1e9}`,
        end: `${end * 1e9}`,
        step,
      });

      const points = data?.data?.result?.[0]?.values || [];
      const buckets = buildTrendBuckets(points, { startSeconds: start, endSeconds: end, stepSeconds });
      const summary = summarizeTrend(buckets);

      const result = {
        query,
        resolved_namespaces: namespaces,
        ...resolutionReport(resolution),
        range: { from, to },
        resolved_window_utc: `${new Date(start * 1000).toISOString()} .. ${new Date(end * 1000).toISOString()}`,
        interval: step,
        ...summary,
        buckets,
      };
      // An all-zero series and a broken query look identical in the numbers, so
      // say which one this is.
      if (summary.total === 0) {
        result.note =
          "No matching lines in this range — the query ran and returned zero, which is not the " +
          "same as an error. Widen from/to, relax component/line_filter, or check the client name " +
          "with grafana_logs_link.";
      }
      return textResult(result);
    }),
);

registerTool(
  "grafana_logs_patterns",
  "Read-only: the distinct SHAPES of a customer's log lines, ranked by volume, using " +
    "Loki's own pattern detection. Answers 'what is dominating this log volume?' without " +
    "reading thousands of near-identical lines — variable parts appear as <_>. Good for " +
    "characterising noise, seeing what a service normally emits, and spotting a NEW " +
    "high-volume error. " +
    "IMPORTANT — it will NOT surface rare lines. Loki only reports patterns above a " +
    "volume floor, so infrequent errors are absent entirely, not merely ranked last " +
    "(measured on this instance: the smallest reported pattern was 34 lines while a " +
    "10-line exception in the same window did not appear at all). The response reports " +
    "smallest_pattern_count so you can see that floor. To find or count a specific or " +
    "rare error, use grafana_logs_trend or grafana_query instead. " +
    "Scopes the customer exactly like grafana_logs_link. lines_in_patterns counts only " +
    "lines Loki assigned to a pattern, so it is NOT a total line count. Loki's pattern " +
    "endpoint does not support line filters.",
  {
    client: z.string().describe("Customer name fragment, e.g. 'april', 'demo qa'."),
    component: z.string().optional().describe("Component fragment, e.g. 'gateway', 'api'."),
    from: z.string().default("now-24h").describe("Range start, e.g. 'now-24h'."),
    to: z.string().default("now").describe("Range end."),
    max_patterns: z.number().int().min(1).max(100).default(20).optional(),
    control_plane_id: z.string().optional().describe("Narrow to one Cockpit organization (see grafana_find_customer)."),
  },
  async ({ client, component, from = "now-24h", to = "now", max_patterns = 20, control_plane_id }) =>
    withToolLogging("grafana_logs_patterns", { client, component, from, to }, async () => {
      const uid = requireDatasourceUid(LOGS_DATASOURCE_UID);
      // No line filter: Loki's /patterns rejects a selector carrying one, so it
      // is not offered as a parameter rather than failing at request time.
      const { namespaces, selector, resolution } = await resolveCustomerSelector({ client, component, from, controlPlaneId: control_plane_id });
      const { start, end } = rangeSeconds(from, to);
      const step = chooseInterval(Math.max(end - start, 1));

      const data = await grafanaDatasourceProxyGet(uid, "loki/api/v1/patterns", {
        query: selector,
        start: `${start * 1e9}`,
        end: `${end * 1e9}`,
        step,
      });

      const summary = summarizePatterns(data?.data || [], { maxPatterns: max_patterns });
      const result = {
        query: selector,
        resolved_namespaces: namespaces,
        ...resolutionReport(resolution),
        range: { from, to },
        resolved_window_utc: `${new Date(start * 1000).toISOString()} .. ${new Date(end * 1000).toISOString()}`,
        ...summary,
        // Travels with the data, not just in the docs: a caller reading this
        // result must not conclude "no errors" from the absence of an error
        // pattern.
        coverage_note:
          "Loki reports only patterns above a volume floor" +
          (summary.smallest_pattern_count ? ` (smallest here: ${summary.smallest_pattern_count} lines)` : "") +
          ". Rare lines are absent entirely, so this is not evidence that an infrequent error " +
          "did not occur — use grafana_logs_trend or grafana_query to check a specific string.",
      };
      if (summary.pattern_count === 0) {
        result.note =
          "Loki detected no patterns in this range. That can mean no logs matched, or that " +
          "pattern detection has nothing to group. Check volume with grafana_logs_trend.";
      }
      return textResult(result);
    }),
);

// An id rather than a name: `apim-dp-cp1111-dp0001` or `cp1111-dp0001`. Requires
// the apim- prefix or two hyphen-separated segments, so a plain customer name
// like "orbit" is never mistaken for an id. A bare control plane id ("cp1111")
// needs no test here — lookupById resolves it outright.
const ID_SHAPED = /^(apim-(dp|cp)-[0-9a-z-]+|[0-9a-z]+(-[0-9a-z]+)+)$/i;

registerTool(
  "grafana_find_customer",
  "Read-only: find which customers and deployments match a name, WITHOUT querying any " +
    "logs. Use this when a name is ambiguous, when a log tool reports ambiguous_customer, " +
    "or simply to see what a customer has. Searches both populations: Gravitee Cloud " +
    "(Cockpit) customers via the deployment map, and hosted customers via Loki's namespace " +
    "label. Returns per customer: deployment count, Cockpit organizations (control plane " +
    "ids), environments, regions and the exact namespaces — so the caller can pass a " +
    "precise client (or control_plane_id) to grafana_logs_link / _trend / _patterns.",
  {
    query: z
      .string()
      .describe(
        "Customer name or fragment ('money', 'orbit'), OR an id/namespace seen in an alert, pod or " +
          "dashboard ('apim-dp-cp1111-dp0001', 'cp1111-dp0001', 'cp1111') to look up who owns it.",
      ),
    max_results: z.number().int().min(1).max(50).default(20).optional(),
  },
  async ({ query, max_results = 20 }) =>
    withToolLogging("grafana_find_customer", { query }, async () => {
      const uid = requireDatasourceUid(LOGS_DATASOURCE_UID);
      const { core } = splitClientEnv(query);
      const needle = (core || query || "").trim();

      const map = await loadCustomerMap();
      // Ids are the only handle a Cockpit tenant has in an alert or a pod name, so
      // the reverse lookup is always attempted - no guessing whether the query
      // "looks like" an id.
      const byId = lookupById(map.rows, query);
      const groups = groupByCustomer(matchCustomers(map.rows, needle));
      const cockpit = [...groups.entries()]
        .map(([customer, rows]) => ({
          customer,
          kind: "gravitee_cloud",
          deployments: rows.length,
          organizations: [...new Set(rows.map((r) => r.control_plane_id).filter(Boolean))],
          envs: [...new Set(rows.map((r) => r.env).filter(Boolean))].sort(),
          regions: [...new Set(rows.map((r) => r.region).filter(Boolean))].sort(),
          namespaces: [...new Set(rows.map((r) => dataPlaneNamespace(r.data_plane_id)))],
          shared_control_plane_namespaces: [
            ...new Set(rows.map((r) => r.control_plane_id).filter(Boolean).map(controlPlaneNamespace)),
          ],
        }))
        .sort((a, b) => a.customer.localeCompare(b.customer));

      // Hosted customers have no map entry; their namespace carries the name.
      let hostedNamespaces = [];
      let allNamespaces = [];
      try {
        const data = await grafanaDatasourceProxyGet(uid, "loki/api/v1/label/namespace/values", {
          // 30 days: a deployment absent over that window is gone, not merely quiet.
          start: toLokiNs("now-30d", 30 * 24 * 3600),
        });
        allNamespaces = data?.data || [];
        hostedNamespaces = matchNamespaces(allNamespaces, needle);
      } catch {
        hostedNamespaces = [];
      }

      // Data planes that are live on this customer's control planes but which the
      // map does not attribute to anyone. They may belong to another customer on
      // the same (shared) control plane, so they are reported as unattributed and
      // never folded into the customer's namespaces.
      const mappedNs = new Set(map.rows.map((r) => dataPlaneNamespace(r.data_plane_id)));
      const cpOf = (n) => n.replace("apim-dp-", "").split("-").slice(0, -1).join("-");
      for (const entry of cockpit) {
        const unattributed = allNamespaces.filter(
          (n) => n.startsWith("apim-dp-") && entry.organizations.includes(cpOf(n)) && !mappedNs.has(n),
        );
        if (unattributed.length) {
          entry.unattributed_namespaces_on_same_control_plane = unattributed;
          entry.unattributed_note =
            "Live data planes on this customer's control plane that the map does not attribute to any customer. " +
            "A control plane is shared, so these may belong to someone else — they are NOT searched as this customer.";
        }
      }

      const result = {
        query,
        ...(byId && byId.kind !== "unknown" ? { matched_by_id: byId } : {}),
        map_source: map.source,
        ...(map.generated_at ? { map_generated_at: map.generated_at } : {}),
        ...(map.generated_days_ago !== undefined ? { map_generated_days_ago: map.generated_days_ago } : {}),
        ...(map.warning ? { map_warning: map.warning } : {}),
        gravitee_cloud_customers: cockpit.slice(0, max_results),
        gravitee_cloud_truncated: cockpit.length > max_results ? cockpit.length - max_results : 0,
        hosted_namespaces: hostedNamespaces,
      };

      if (cockpit.length > 1) {
        result.note =
          `"${query}" matches ${cockpit.length} different Gravitee Cloud customers. The log tools will not ` +
          "search them together — pass one exact customer name.";
      } else if (cockpit.length === 1 && cockpit[0].organizations.length > 1) {
        result.note =
          `"${cockpit[0].customer}" spans ${cockpit[0].organizations.length} separate Cockpit organizations ` +
          `(${cockpit[0].organizations.join(", ")}). Pass control_plane_id to narrow to one.`;
      } else if (byId && byId.kind === "unknown" && !cockpit.length && ID_SHAPED.test(query.trim())) {
        // A live namespace the map cannot attribute — 116 of these exist, 67 on
        // control planes the CSV has never heard of. Saying nothing here would
        // leave the caller thinking the lookup simply failed, when the real
        // answer is "this exists and nobody knows whose it is".
        const live = hostedNamespaces.length > 0;
        result.note =
          `${byId.note}${live ? " The namespace does exist in Loki, so this is a real deployment the map does not " +
          "cover — you can still query it directly by namespace, but its owner cannot be determined from the map." : ""}`;
      } else if (byId && byId.kind !== "unknown" && byId.note) {
        result.note = byId.note;
      } else if (!cockpit.length && !hostedNamespaces.length) {
        result.note =
          byId && byId.kind === "unknown"
            ? `No Gravitee Cloud customer, hosted namespace, or known id matched "${query}".`
            : `No Gravitee Cloud customer or hosted namespace matched "${query}".`;
      }
      return textResult(result);
    }),
);

registerTool(
  "grafana_logs_context",
  "Read-only: every log line around a moment in time, UNFILTERED — the 'what else was " +
    "happening right then' tool. Give it a timestamp (from a grafana_query sample, or an " +
    "ISO 8601 instant with an explicit offset) and it returns all lines in a tight window " +
    "on either side, in time order, merged across services. " +
    "Why unfiltered matters: a logger formatting with a newline emits SEPARATE Loki " +
    "entries. The first carries the text you searched for, the second carries the actual " +
    "reason and contains none of your keywords — the same for stack traces and 'Caused " +
    "by:' chains. A filtered query finds the header and hides the answer, one line away at " +
    "the same millisecond. This tool therefore REFUSES a line filter rather than warning " +
    "about one. " +
    "Scope it by client (resolved exactly like grafana_logs_link) or by exact namespace/" +
    "service_name from a previous result. Typical use: grafana_logs_trend to find when, " +
    "grafana_query to find the line and its timestamp, then this to read what surrounded it.",
  {
    at: z
      .string()
      .describe(
        "The instant to read around: an ISO 8601 timestamp WITH an explicit offset " +
          "(2026-08-20T15:00:00Z), epoch milliseconds, or the nanosecond value from a prior result.",
      ),
    client: z.string().optional().describe("Customer name fragment. Omit if giving an exact namespace."),
    component: z.string().optional().describe("Component fragment, e.g. 'gateway'."),
    namespace: z.string().optional().describe("Exact namespace, e.g. from a previous result's streams."),
    service_name: z.string().optional().describe("Exact service_name, to read one service rather than the whole namespace."),
    window_seconds: z
      .number().int().min(1).max(300).default(2).optional()
      .describe("Seconds either side of `at`. Default 2 — wide enough for a multi-line entry, narrow enough to read."),
    max_lines: z.number().int().min(1).max(1000).default(200).optional(),
    control_plane_id: z.string().optional().describe("Narrow to one Cockpit organization (see grafana_find_customer)."),
    line_filter: z
      .string()
      .optional()
      .describe("NOT SUPPORTED — this tool refuses a line filter. Filtering is what hides the answer it exists to find."),
  },
  async ({ at, client, component, namespace, service_name, window_seconds = 2, max_lines = 200, control_plane_id, line_filter }) =>
    withToolLogging("grafana_logs_context", { client, namespace, at, window_seconds }, async () => {
      const uid = requireDatasourceUid(LOGS_DATASOURCE_UID);

      // Refused, not warned about: a filter here re-creates the exact failure
      // this tool exists to solve, and a warning is easy to read past.
      if (line_filter) {
        throw new Error(
          "grafana_logs_context does not accept a line filter. Its purpose is to show the lines a filter " +
            "would hide — a continuation line carries the reason but none of the filter's keywords. " +
            "Use grafana_query to find the moment, then read around it here unfiltered.",
        );
      }
      if (!client && !namespace) throw new Error("either client or namespace is required");

      // Resolve the instant first: a bad timestamp must fail loudly here rather
      // than silently reading a different moment.
      const atNs = BigInt(toLokiNs(at, 0));
      const halfWindowNs = BigInt(Math.round(window_seconds * 1e9));
      const startNs = atNs - halfWindowNs;
      const endNs = atNs + halfWindowNs;

      let selector;
      let resolution = null;
      if (namespace) {
        const matchers = [`namespace="${namespace}"`];
        if (service_name) matchers.push(`service_name="${service_name}"`);
        selector = `{${matchers.join(", ")}}`;
      } else {
        const resolved = await resolveCustomerSelector({ client, component, from: at, controlPlaneId: control_plane_id });
        selector = resolved.selector;
        resolution = resolved.resolution;
      }

      const data = await grafanaDatasourceProxyGet(uid, "loki/api/v1/query_range", {
        query: selector,
        start: startNs.toString(),
        end: endNs.toString(),
        // Forward: oldest first, so a continuation line follows the line it
        // continues. Backward would present the reason before the message.
        direction: "forward",
        limit: String(max_lines),
      });

      const merged = mergeContextStreams(data?.data?.result || [], { maxLines: max_lines });
      const result = {
        query: selector,
        ...(resolution ? resolutionReport(resolution) : {}),
        at: new Date(Number(atNs / 1000000n)).toISOString(),
        window: {
          from_utc: new Date(Number(startNs / 1000000n)).toISOString(),
          to_utc: new Date(Number(endNs / 1000000n)).toISOString(),
          seconds_either_side: window_seconds,
        },
        line_count: merged.total,
        lines: merged.lines,
        filtered: false,
      };
      if (merged.truncated) {
        result.truncated = merged.truncated;
        result.note =
          `${merged.total} lines fell in this window and ${merged.truncated} were dropped at max_lines. ` +
          "Narrow window_seconds or pin service_name to see the sequence around the moment itself.";
      }
      if (merged.total === 0) {
        result.note =
          "No lines in this window. Check the instant is right (it is echoed above in UTC) and that the " +
          "selector matches — grafana_logs_trend will show whether this stream has any data nearby.";
      }
      return textResult(result);
    }),
);

registerTool(
  "grafana_logs_noise",
  "Read-only: what is actually filling this log stream. Samples recent lines, reduces each " +
    "to its SHAPE by replacing the variable parts (timestamps, uuids, ips, numbers, stack " +
    "frames) with placeholders, and ranks the shapes by how much of the sample they account " +
    "for — with a ready-to-paste LogQL exclusion for each. One repeating message is routinely " +
    "most of a stream's volume, and it crowds out whatever you were looking for. " +
    "Unlike grafana_logs_patterns, which uses Loki's own detection and therefore cannot see " +
    "below a volume floor, this profiles the lines it actually fetched, so a shape occurring " +
    "twice in the sample still appears. " +
    "Percentages describe THE SAMPLE, not the time range: Loki fills a limit backwards from " +
    "the end of the window, so the sample is both capped and biased towards the most recent " +
    "moment. The window the sample actually covered is reported — read the percentages " +
    "against that, not against from/to.",
  {
    client: z.string().optional().describe("Customer name fragment. Omit if giving an exact namespace."),
    component: z.string().optional().describe("Component fragment, e.g. 'gateway'."),
    namespace: z.string().optional().describe("Exact namespace, if you already know it."),
    from: z.string().default("now-1h").describe("Range start, e.g. 'now-1h'."),
    to: z.string().default("now").describe("Range end."),
    sample_size: z.number().int().min(50).max(5000).default(500).optional().describe("Lines to sample. Larger is more representative and slower."),
    max_shapes: z.number().int().min(1).max(50).default(10).optional(),
    control_plane_id: z.string().optional().describe("Narrow to one Cockpit organization (see grafana_find_customer)."),
  },
  async ({ client, component, namespace, from = "now-1h", to = "now", sample_size = 500, max_shapes = 10, control_plane_id }) =>
    withToolLogging("grafana_logs_noise", { client, namespace, from, to, sample_size }, async () => {
      const uid = requireDatasourceUid(LOGS_DATASOURCE_UID);
      if (!client && !namespace) throw new Error("either client or namespace is required");

      let selector;
      let resolution = null;
      if (namespace) {
        selector = `{namespace="${namespace}"}`;
      } else {
        const resolved = await resolveCustomerSelector({ client, component, from, controlPlaneId: control_plane_id });
        selector = resolved.selector;
        resolution = resolved.resolution;
      }

      const { start, end } = rangeSeconds(from, to);
      const data = await grafanaDatasourceProxyGet(uid, "loki/api/v1/query_range", {
        query: selector,
        start: `${start * 1e9}`,
        end: `${end * 1e9}`,
        direction: "backward",
        limit: String(sample_size),
      });

      const streams = data?.data?.result || [];
      const rows = streams.flatMap((st) => (st.values || []).map((v) => [Number(v[0]), v[1]]));
      const profile = profileNoise(rows.map((r) => r[1]), { maxShapes: max_shapes });

      const result = {
        query: selector,
        ...(resolution ? resolutionReport(resolution) : {}),
        range: { from, to },
        ...profile,
      };

      // A sample that hit its cap describes a slice, not the range. Say which
      // slice, or the percentages get read as a property of from/to.
      if (rows.length) {
        const times = rows.map((r) => r[0]).filter(Number.isFinite);
        const earliest = Math.min(...times) / 1e6;
        const latest = Math.max(...times) / 1e6;
        result.sample_window = {
          from_utc: new Date(earliest).toISOString(),
          to_utc: new Date(latest).toISOString(),
          covered_seconds: Math.max(0, Math.round((latest - earliest) / 1000)),
          requested_seconds: Math.max(0, end - start),
        };
        if (rows.length >= sample_size) {
          result.sample_window.warning =
            `The sample hit its ${sample_size}-line cap and covers ` +
            `${result.sample_window.covered_seconds}s of the ${result.sample_window.requested_seconds}s requested. ` +
            "Loki fills the cap backwards from the end of the window, so these proportions describe the most " +
            "recent slice only — a shape that stopped earlier in the range will not appear at all.";
        }
      } else {
        result.note = "No lines sampled. Check the selector and range — grafana_logs_trend shows whether this stream has data.";
      }
      return textResult(result);
    }),
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  log("info", "Starting MCP adapter", { enabled: ENABLED, base_url: BASE_URL || null });
  // Warm the customer map now, so the GitHub round trip overlaps the MCP
  // handshake instead of being paid by whoever runs the first query.
  warmCustomerMap();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "MCP adapter connected", { transport: "stdio" });
}

// Only start the stdio transport when run as the entrypoint (`node server.js`).
// Tests import this module to exercise the tool handlers directly, and must not
// spin up a transport.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log("error", "MCP adapter failed to start", { error: err.message, stack: err.stack });
    process.exit(1);
  });
}
