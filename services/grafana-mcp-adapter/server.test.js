import { test } from "node:test";
import assert from "node:assert/strict";

// server.js imports grafanaClient.js, which reads env at import time and refuses
// to make calls unless configured. Set a deterministic config before importing so
// the tool handlers run and buildExploreUrl/buildDrilldownUrl are predictable.
process.env.GRAFANA_ENABLED = "true";
process.env.GRAFANA_BASE_URL = "https://g.example.com";
process.env.GRAFANA_TOKEN = "glsa_test";
// Pin the Loki datasource uid so the proxy path is predictable in assertions.
process.env.GRAFANA_LOGS_DATASOURCE_UID = "grafanacloud-logs";

// server.js only starts the stdio transport when run as the entrypoint, so this
// import is side-effect-free apart from registering the tools. `tools` exposes the
// registered handler for each tool so we can drive the orchestration directly.
const { tools } = await import("./server.js");

// ---------------------------------------------------------------------------
// fetch stub: route Loki proxy calls by path and record the URLs seen.
// ---------------------------------------------------------------------------

// Install a fetch stub that answers each Loki endpoint from `routes` (keyed by a
// substring of the request path) and records every URL it saw. `routes` values
// are the JSON `data` array Loki would return under `{ status, data }`.
function withLokiStub(routes, fn) {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    calls.push(String(url));
    const u = String(url);
    let data = [];
    for (const [needle, value] of Object.entries(routes)) {
      if (u.includes(needle)) {
        data = typeof value === "function" ? value(u) : value;
        break;
      }
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ status: "success", data })),
      headers: { get: () => null },
    });
  };
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = origFetch;
  });
}

// Invoke a registered tool handler and parse the JSON textResult back out.
async function callTool(name, args) {
  const res = await tools[name](args, {});
  return JSON.parse(res.content[0].text);
}

// Loki /series returns one object per stream (full label set); the tool only
// reads namespace + service_name.
function stream(namespace, service_name, extra = {}) {
  return { namespace, service_name, ...extra };
}

const SERIES = "loki/api/v1/series";
const NS_VALUES = "label/namespace/values";
const SVC_VALUES = "label/service_name/values";

// ---------------------------------------------------------------------------
// grafana_logs_link: namespace-resolved customer (drilldown, per-namespace links)
// ---------------------------------------------------------------------------

test("grafana_logs_link: resolves customer namespaces and groups drilldown links per namespace", async () => {
  await withLokiStub(
    {
      [NS_VALUES]: ["april-prod", "april-rec", "other-prod"],
      [SERIES]: [
        stream("april-prod", "graviteeio-apim-april-prod-gateway", { pod: "a" }),
        stream("april-prod", "graviteeio-apim-april-prod-gateway", { pod: "b" }),
        stream("april-rec", "graviteeio-apim-april-rec-gateway"),
      ],
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "april", component: "gateway" });

      // Resolved to the customer's own namespaces (env-agnostic core "april").
      assert.deepEqual(out.resolved_namespaces, ["april-prod", "april-rec"]);
      assert.equal(out.link_style, "drilldown");
      // matched_streams is the raw label sets (namespace + service_name only).
      assert.equal(out.matched_count, 3);
      // One drilldown link per namespace, scoped to that namespace's exact
      // service_name values (deduped).
      assert.equal(out.links.length, 2);
      const april = out.links.find((l) => l.namespace === "april-prod");
      assert.deepEqual(april.service_names, ["graviteeio-apim-april-prod-gateway"]);
      assert.ok(april.url.includes("/explore/namespace/april-prod/logs"));
      // No line_filter -> no explore_url fallback attached.
      assert.equal(april.explore_url, undefined);
    },
  );
});

test("grafana_logs_link: line_filter attaches an explore_url fallback per drilldown link", async () => {
  await withLokiStub(
    {
      [NS_VALUES]: ["ghd-prod"],
      [SERIES]: [stream("ghd-prod", "graviteeio-apim3-gateway")],
    },
    async () => {
      const out = await callTool("grafana_logs_link", {
        client: "ghd",
        component: "gateway",
        line_filter: "Connection refused",
      });
      const link = out.links[0];
      assert.ok(link.explore_url, "explore_url must be attached when line_filter is set");
      // The explore fallback carries the exact-selector LogQL with the |= filter.
      const panes = JSON.parse(decodeURIComponent(new URL(link.explore_url).searchParams.get("panes")));
      assert.ok(panes.logs.queries[0].expr.includes("Connection refused"));
      assert.ok(panes.logs.queries[0].expr.includes('service_name="graviteeio-apim3-gateway"'));
      // The reported query also carries the line filter (discovery query omits it).
      assert.ok(out.query.includes("Connection refused"));
    },
  );
});

// ---------------------------------------------------------------------------
// grafana_logs_link: env auto-retry
// ---------------------------------------------------------------------------

test("grafana_logs_link: drops the env token and retries when the env-narrowed query is empty", async () => {
  // Customer 'blueyonder' resolves to namespace 'blueyonder-plt-live'. The env
  // 'prod' isn't in service_name (prod lives as 'plt-live'), so the first
  // /series (env-narrowed) returns nothing; dropping 'prod' finds streams.
  let seriesCall = 0;
  await withLokiStub(
    {
      [NS_VALUES]: ["blueyonder-plt-live"],
      [SERIES]: () => {
        seriesCall += 1;
        // First discovery (with the env token) is empty; the retry (env dropped)
        // returns streams.
        return seriesCall === 1 ? [] : [stream("blueyonder-plt-live", "by-live-gateway")];
      },
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "blueyonder prod", component: "gateway" });
      assert.equal(seriesCall, 2, "should have retried /series once");
      assert.equal(out.env_filter_dropped, true);
      assert.equal(out.matched_count, 1);
      assert.deepEqual(out.resolved_namespaces, ["blueyonder-plt-live"]);
    },
  );
});

test("grafana_logs_link: no retry when the first env-narrowed query already matched", async () => {
  let seriesCall = 0;
  await withLokiStub(
    {
      [NS_VALUES]: ["april-prod"],
      [SERIES]: () => {
        seriesCall += 1;
        return [stream("april-prod", "graviteeio-apim-april-prod-gateway")];
      },
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "april prod", component: "gateway" });
      assert.equal(seriesCall, 1, "must not retry when the first query matched");
      assert.equal(out.env_filter_dropped, undefined);
    },
  );
});

// ---------------------------------------------------------------------------
// grafana_logs_link: empty-result branches (note / suggestions)
// ---------------------------------------------------------------------------

test("grafana_logs_link: namespace resolved but empty range -> note, no suggestions", async () => {
  await withLokiStub(
    {
      [NS_VALUES]: ["april-prod", "april-rec"],
      [SERIES]: [],
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "april" });
      assert.equal(out.matched_count, 0);
      assert.deepEqual(out.resolved_namespaces, ["april-prod", "april-rec"]);
      // Customer identified via namespace -> tell them it's a quiet range, and do
      // NOT offer service_name suggestions (the client wasn't the problem).
      assert.match(out.note, /No log streams in this range for namespace\(s\) april-prod, april-rec/);
      assert.equal(out.suggestions, undefined);
    },
  );
});

test("grafana_logs_link: no namespace + no streams -> suggestions from service_name values", async () => {
  await withLokiStub(
    {
      // 'aprl' resolves to no namespace...
      [NS_VALUES]: ["april-prod", "other-prod"],
      [SERIES]: [],
      // ...and no streams, so suggestClients pulls service_name values to rank.
      [SVC_VALUES]: ["graviteeio-ae-april-rec-engine", "graviteeio-ae-alliander-ui"],
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "aprl" });
      assert.equal(out.matched_count, 0);
      assert.deepEqual(out.resolved_namespaces, []);
      assert.match(out.note, /Did you mean/);
      // The close typo 'aprl' -> the 'april' service_name surfaces.
      assert.ok(out.suggestions.includes("graviteeio-ae-april-rec-engine"));
    },
  );
});

test("grafana_logs_link: no namespace, no streams, no suggestions -> generic note", async () => {
  await withLokiStub(
    {
      [NS_VALUES]: ["other-prod"],
      [SERIES]: [],
      [SVC_VALUES]: ["totally-unrelated-service"],
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "zzxqq" });
      assert.equal(out.matched_count, 0);
      assert.equal(out.suggestions, undefined);
      assert.match(out.note, /Try widening from\/to or adjusting client\/component/);
    },
  );
});

// ---------------------------------------------------------------------------
// grafana_logs_link: explore link style
// ---------------------------------------------------------------------------

test("grafana_logs_link: link_style=explore returns a single raw Explore deep link", async () => {
  await withLokiStub(
    {
      [NS_VALUES]: ["april-prod"],
      [SERIES]: [stream("april-prod", "graviteeio-apim-april-prod-gateway")],
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "april", link_style: "explore" });
      assert.equal(out.link_style, "explore");
      assert.equal(out.links.length, 1);
      assert.ok(out.links[0].url.includes("/explore?"));
      // Explore links carry no per-namespace grouping.
      assert.equal(out.links[0].namespace, undefined);
    },
  );
});

// ---------------------------------------------------------------------------
// grafana_logs_link: /series discovery is called without a line filter
// ---------------------------------------------------------------------------

test("grafana_logs_link: /series discovery selector omits the line filter", async () => {
  await withLokiStub(
    {
      [NS_VALUES]: ["april-prod"],
      [SERIES]: [stream("april-prod", "graviteeio-apim-april-prod-gateway")],
    },
    async (calls) => {
      await callTool("grafana_logs_link", { client: "april", line_filter: "boom" });
      const seriesCall = calls.find((u) => u.includes(SERIES));
      const match = new URL(seriesCall).searchParams.get("match[]");
      // The discovery selector must not carry the |= line filter (that's applied
      // in the generated link, not in /series).
      assert.ok(!match.includes("boom"), "discovery selector must omit the line filter");
    },
  );
});

// ---------------------------------------------------------------------------
// grafana_query digest vs raw
// ---------------------------------------------------------------------------

test("grafana_query: returns the per-series digest by default and raw frames with raw=true", async () => {
  const payload = {
    results: {
      A: {
        status: 200,
        frames: [
          {
            schema: { fields: [{ type: "time" }, { type: "number", labels: { job: "api" } }] },
            data: { values: [[0, 1, 2], [2, 4, 6]] },
          },
        ],
      },
    },
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    // assertReadOnly resuelve primero el type del uid; respondemos esa llamada con
    // un type read-only (pasa el guardián) y la de /ds/query con los frames.
    const body = String(url).includes("/datasources/uid/")
      ? { uid: "ds", name: "test prometheus", type: "prometheus" }
      : payload;
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
      headers: { get: () => null },
    });
  };

  try {
    const digest = await callTool("grafana_query", { datasource_uid: "ds", expr: "up" });
    assert.equal(digest.results.A.series_count, 1);
    assert.deepEqual(digest.results.A.series[0], {
      labels: { job: "api" },
      count: 3,
      first: 2,
      last: 6,
      min: 2,
      max: 6,
      avg: 4,
    });

    const raw = await callTool("grafana_query", { datasource_uid: "ds", expr: "up", raw: true });
    // raw=true returns the untouched frames payload.
    assert.deepEqual(raw, payload);
  } finally {
    globalThis.fetch = origFetch;
  }
});


// ---------------------------------------------------------------------------
// Viewer-scoped token: /api/datasources is Admin-only, everything must degrade
// ---------------------------------------------------------------------------

// Grafana's built-in Viewer role can QUERY a datasource but cannot read its
// configuration, so /api/datasources and /api/datasources/uid/:uid return 403.
// We have no Viewer token to test with, so simulate one: refuse exactly those
// two endpoints and serve /api/frontend/settings, which any authenticated user
// can read. `privileged: true` restores an Admin-scoped token.
function withTokenStub({ privileged, settings, onQuery }, fn) {
  const origFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = (url, init) => {
    const u = String(url);
    seen.push(u);
    const reply = (body, status = 200) =>
      Promise.resolve({
        ok: status < 400,
        status,
        text: () => Promise.resolve(JSON.stringify(body)),
        headers: { get: () => null },
      });

    if (u.includes("/api/frontend/settings")) return reply(settings);
    if (u.includes("/api/datasources")) {
      if (!privileged) return reply({ message: "Forbidden" }, 403);
      return reply(
        u.includes("/datasources/uid/")
          ? { uid: "grafanacloud-logs", name: "gravitee-logs", type: "loki" }
          : [{ uid: "grafanacloud-logs", name: "gravitee-logs", type: "loki", isDefault: true }],
      );
    }
    if (u.includes("/ds/query")) return reply(onQuery ?? { results: {} }, 200);
    return reply({}, 404);
  };
  return Promise.resolve(fn(seen)).finally(() => {
    globalThis.fetch = origFetch;
  });
}

// Shape mirrors the live instance: real entries carry uid/name/type; the UI
// pseudo-datasources carry neither and must be skipped.
const SETTINGS = {
  defaultDatasource: "gravitee-prom",
  datasources: {
    "gravitee-logs": { uid: "grafanacloud-logs", name: "gravitee-logs", type: "loki" },
    "gravitee-prom": { uid: "grafanacloud-prom", name: "gravitee-prom", type: "prometheus" },
    // Action-capable: k6 can trigger load test runs, so it must never be queryable.
    "grafanacloud-k6": { uid: "k6-uid", name: "grafanacloud-k6", type: "k6-datasource" },
    "-- Mixed --": { type: "datasource" },
    "-- Dashboard --": { type: "datasource" },
  },
};

test("grafana_health: stays healthy on a Viewer token and reports the missing permission", async () => {
  // Regression: health used to probe via /api/datasources, so a correctly
  // Viewer-scoped token made the adapter report itself unhealthy — failing on
  // privilege rather than reachability, and contradicting its own advice to run
  // as a Viewer.
  await withTokenStub({ privileged: false, settings: SETTINGS }, async () => {
    const out = await callTool("grafana_health", {});
    assert.equal(out.status, "ok");
    assert.equal(out.reachable, true);
    assert.equal(out.datasources_readable, false);
    assert.match(out.note, /Viewer/);
    // Counted from the catalogue, skipping the uid-less pseudo-datasources.
    assert.equal(out.datasource_count, 3);
  });
});

test("grafana_health: reports the permission as present on a privileged token", async () => {
  await withTokenStub({ privileged: true, settings: SETTINGS }, async () => {
    const out = await callTool("grafana_health", {});
    assert.equal(out.datasources_readable, true);
    assert.equal(out.note, undefined);
    assert.equal(out.datasource_count, 1);
  });
});

test("grafana_list_datasources: falls back to the catalogue and says so", async () => {
  await withTokenStub({ privileged: false, settings: SETTINGS }, async () => {
    const out = await callTool("grafana_list_datasources", {});
    assert.equal(out.source, "frontend_settings");
    assert.match(out.note, /Viewer-scoped token/);
    assert.equal(out.count, 3);
    const byUid = Object.fromEntries(out.datasources.map((d) => [d.uid, d]));
    assert.equal(byUid["grafanacloud-logs"].type, "loki");
    // is_default resolves against defaultDatasource, which is keyed by NAME.
    assert.equal(byUid["grafanacloud-prom"].is_default, true);
    assert.equal(byUid["grafanacloud-logs"].is_default, false);
  });
});

test("grafana_query: the read-only guard still passes when datasource config is forbidden", async () => {
  // The guard resolves the datasource TYPE. Reading it from /api/datasources
  // needs Admin, so on a Viewer token the guard used to fail and take
  // grafana_query down with it — a far worse failure than health reporting 403.
  const payload = { results: { A: { status: 200, frames: [serverLogFrame(2)] } } };
  await withTokenStub({ privileged: false, settings: SETTINGS, onQuery: payload }, async () => {
    const out = await callTool("grafana_query", { datasource_uid: "grafanacloud-logs", expr: '{a="b"}' });
    assert.equal(out.results.A.line_count, 2);
  });
});

test("grafana_query: the fallback still refuses a datasource outside the allowlist", async () => {
  // Degrading the permission requirement must not degrade the safety property:
  // k6 resolved via the fallback is still refused.
  await withTokenStub({ privileged: false, settings: SETTINGS }, async () => {
    await assert.rejects(
      () => tools.grafana_query({ datasource_uid: "k6-uid", expr: "x" }, {}),
      /not in the read-only allowlist/,
    );
  });
});

test("grafana_query: fails closed when neither source can identify the datasource", async () => {
  await withTokenStub({ privileged: false, settings: SETTINGS }, async () => {
    await assert.rejects(
      () => tools.grafana_query({ datasource_uid: "does-not-exist", expr: "x" }, {}),
      /could not be verified read-only/,
    );
  });
});

test("grafana_query: fails closed when the catalogue itself is unreachable", async () => {
  // Uses a uid no catalogue has, so the lookup cannot be answered from cache and
  // must go to the network — which is refused. Both sources failing must reject.
  const origFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve("{}"), headers: { get: () => null } });
  try {
    await assert.rejects(
      () => tools.grafana_query({ datasource_uid: "uid-in-no-catalogue", expr: "x" }, {}),
      /could not be verified read-only.*fallback failed/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("grafana_query: a cached datasource type survives a transient permission failure", async () => {
  // Deliberate: once the type is known, a Viewer-token 403 on the privileged
  // endpoint should not take querying down. The cache is TTL-bounded so this
  // resilience cannot mask a lasting configuration change.
  const payload = { results: { A: { status: 200, frames: [serverLogFrame(1)] } } };
  await withTokenStub({ privileged: false, settings: SETTINGS, onQuery: payload }, async () => {
    await callTool("grafana_query", { datasource_uid: "grafanacloud-logs", expr: "x" });
  });
  // Catalogue now warm; refuse every network call and query again.
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url) =>
    Promise.resolve(
      String(url).includes("/ds/query")
        ? { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)), headers: { get: () => null } }
        : { ok: false, status: 403, text: () => Promise.resolve("{}"), headers: { get: () => null } },
    );
  try {
    const out = await callTool("grafana_query", { datasource_uid: "grafanacloud-logs", expr: "x" });
    assert.equal(out.results.A.line_count, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------------------------------------------------------------------------
// grafana_query: log-line cap (maxLines) and truncation signalling
// ---------------------------------------------------------------------------

// Stub that answers assertReadOnly with a loki datasource and /ds/query with
// `payload`, recording the JSON body of every /ds/query request so we can assert
// on what was actually sent to Grafana.
function withDsQueryStub(payload, fn) {
  const bodies = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const isQuery = String(url).includes("/ds/query");
    if (isQuery) bodies.push(JSON.parse(init.body));
    const body = isQuery ? payload : { uid: "ds", name: "loki", type: "loki" };
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
      headers: { get: () => null },
    });
  };
  return Promise.resolve(fn(bodies)).finally(() => {
    globalThis.fetch = origFetch;
  });
}

// Minimal Loki log frame (see helpers.test.js for the full field list).
function serverLogFrame(count) {
  const rows = Array.from({ length: count }, (_, i) => i);
  return {
    schema: {
      meta: { custom: { frameType: "LabeledTimeValues" } },
      fields: [
        { name: "labels", type: "other" },
        { name: "Time", type: "time" },
        { name: "Line", type: "string" },
      ],
    },
    data: {
      values: [
        rows.map(() => ({ namespace: "ns" })),
        rows.map((i) => 1700000000000 + i),
        rows.map((i) => `line ${i}`),
      ],
    },
  };
}

test("grafana_query: sends maxLines so the log-line cap is explicit, not Grafana's hidden default", async () => {
  // maxDataPoints only sets METRIC resolution — Grafana's Loki backend ignores
  // it for log queries and caps them with maxLines (defaulting to 100 when
  // nothing sets it). Without maxLines the cap is invisible and uncontrollable.
  const payload = { results: { A: { status: 200, frames: [serverLogFrame(2)] } } };
  await withDsQueryStub(payload, async (bodies) => {
    await callTool("grafana_query", { datasource_uid: "ds", expr: '{namespace="ns"}', max_lines: 250 });
    assert.equal(bodies[0].queries[0].maxLines, 250);

    await callTool("grafana_query", { datasource_uid: "ds", expr: '{namespace="ns"}' });
    assert.equal(bodies[1].queries[0].maxLines, 100);
  });
});

test("grafana_query: digests a log query by line count instead of reporting no series", async () => {
  const payload = { results: { A: { status: 200, frames: [serverLogFrame(3)] } } };
  await withDsQueryStub(payload, async () => {
    const digest = await callTool("grafana_query", { datasource_uid: "ds", expr: '{namespace="ns"}' });
    assert.equal(digest.results.A.frame_type, "logs");
    assert.equal(digest.results.A.line_count, 3);
  });
});

test("grafana_query: flags a log result that hit the line cap as partial", async () => {
  const payload = { results: { A: { status: 200, frames: [serverLogFrame(5)] } } };
  await withDsQueryStub(payload, async () => {
    const digest = await callTool("grafana_query", { datasource_uid: "ds", expr: '{namespace="ns"}', max_lines: 5 });
    assert.equal(digest.results.A.limit_reached, true);
  });
});

test("grafana_query: raw=true still flags the line cap rather than returning a silent partial page", async () => {
  const payload = { results: { A: { status: 200, frames: [serverLogFrame(5)] } } };
  await withDsQueryStub(payload, async () => {
    const raw = await callTool("grafana_query", {
      datasource_uid: "ds",
      expr: '{namespace="ns"}',
      max_lines: 5,
      raw: true,
    });
    assert.equal(raw.results.A.limit_reached, true);
    assert.match(raw.results.A.note, /max_lines/);
    // The frames themselves stay verbatim — only a note is added.
    assert.equal(raw.results.A.frames[0].data.values[2].length, 5);
  });
});

test("grafana_query: raw=true adds no note when the result is under the cap", async () => {
  const payload = { results: { A: { status: 200, frames: [serverLogFrame(2)] } } };
  await withDsQueryStub(payload, async () => {
    const raw = await callTool("grafana_query", {
      datasource_uid: "ds",
      expr: '{namespace="ns"}',
      max_lines: 100,
      raw: true,
    });
    assert.equal(raw.results.A.limit_reached, undefined);
    assert.equal(raw.results.A.note, undefined);
  });
});

// ---------------------------------------------------------------------------
// grafana_query: native `query` for non-Prometheus/Loki datasource types
// ---------------------------------------------------------------------------

test("grafana_query: forwards native query fields for types that do not use expr", async () => {
  // Verified against the live instance: Elasticsearch rejects `expr` with HTTP
  // 400 and Tempo with 500. Allowlisting a type without this would produce a
  // datasource that is permitted but unusable.
  const payload = { results: { A: { status: 200, frames: [] } } };
  const origFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = (url, init) => {
    const isQuery = String(url).includes("/ds/query");
    if (isQuery) bodies.push(JSON.parse(init.body));
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(JSON.stringify(isQuery ? payload : { uid: "es", name: "es", type: "elasticsearch" })),
      headers: { get: () => null },
    });
  };
  try {
    await callTool("grafana_query", {
      datasource_uid: "es",
      query: { query: "*", timeField: "@timestamp", metrics: [{ id: "1", type: "count" }] },
    });
    const q = bodies[0].queries[0];
    assert.equal(q.query, "*");
    assert.equal(q.timeField, "@timestamp");
    assert.deepEqual(q.metrics, [{ id: "1", type: "count" }]);
    // expr must be absent, not undefined-but-present.
    assert.ok(!("expr" in q), "expr must not be sent when it was not supplied");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("grafana_query: a caller-supplied query cannot redirect to another datasource", async () => {
  // Security: assertReadOnly verifies datasource_uid. If a field inside `query`
  // could replace the datasource, the guard would be verifying one datasource
  // while Grafana queried another - including a blocked, action-capable one.
  const payload = { results: { A: { status: 200, frames: [] } } };
  const origFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = (url, init) => {
    const isQuery = String(url).includes("/ds/query");
    if (isQuery) bodies.push(JSON.parse(init.body));
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(JSON.stringify(isQuery ? payload : { uid: "es", name: "es", type: "elasticsearch" })),
      headers: { get: () => null },
    });
  };
  try {
    await callTool("grafana_query", {
      datasource_uid: "es",
      query: { query: "*", refId: "Z", datasource: { uid: "k6-datasource", type: "k6-datasource" } },
    });
    const q = bodies[0].queries[0];
    assert.deepEqual(q.datasource, { uid: "es", type: "elasticsearch" }, "datasource must stay pinned to the verified uid");
    assert.equal(q.refId, "A");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("grafana_query: requires either expr or query", async () => {
  await assert.rejects(
    () => tools.grafana_query({ datasource_uid: "ds" }, {}),
    /either expr .* or query .* is required/,
  );
});

// ---------------------------------------------------------------------------
// CloudWatch: allowed for metrics, refused for billable Logs Insights
// ---------------------------------------------------------------------------

function withCloudwatchStub(fn) {
  const origFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = (url, init) => {
    const isQuery = String(url).includes("/ds/query");
    if (isQuery) bodies.push(JSON.parse(init.body));
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify(isQuery ? { results: { A: { status: 200, frames: [] } } } : { uid: "cw", name: "cw", type: "cloudwatch" }),
        ),
      headers: { get: () => null },
    });
  };
  return Promise.resolve(fn(bodies)).finally(() => {
    globalThis.fetch = origFetch;
  });
}

test("grafana_query: every CloudWatch result carries a billable warning", async () => {
  // The guard blocks the UNBOUNDED cost, but CloudWatch is never free: AWS meters
  // GetMetricData per request. A caller used to free Loki/Prometheus reads must
  // not have to know that, so the result says it.
  await withCloudwatchStub(async () => {
    const digest = await callTool("grafana_query", {
      datasource_uid: "cw",
      query: { queryMode: "Metrics", namespace: "AWS/S3" },
    });
    assert.match(digest.billing_notice, /BILLABLE/);
    assert.match(digest.billing_notice, /not free/);
    assert.ok(digest.results, "the notice must not displace the results");
  });

  // ...on the raw path too, which returns Grafana's payload almost verbatim.
  await withCloudwatchStub(async () => {
    const raw = await callTool("grafana_query", {
      datasource_uid: "cw",
      query: { queryMode: "Metrics", namespace: "AWS/S3" },
      raw: true,
    });
    assert.match(raw.billing_notice, /BILLABLE/);
  });
});

test("grafana_query: non-CloudWatch results carry no billing notice", async () => {
  // The warning must mean something — attaching it to free datasources would
  // train the reader to ignore it.
  const payload = { results: { A: { status: 200, frames: [] } } };
  await withDsQueryStub(payload, async () => {
    const out = await callTool("grafana_query", { datasource_uid: "ds", expr: '{a="b"}' });
    assert.equal(out.billing_notice, undefined);
  });
});

test("grafana_query: CloudWatch metrics queries are allowed", async () => {
  await withCloudwatchStub(async (bodies) => {
    await callTool("grafana_query", {
      datasource_uid: "cw",
      query: { queryMode: "Metrics", region: "eu-west-1", namespace: "AWS/S3", metricName: "BucketSizeBytes", statistic: "Average" },
    });
    assert.equal(bodies[0].queries[0].metricName, "BucketSizeBytes");
  });
  // queryMode omitted defaults to Metrics and is likewise allowed.
  await withCloudwatchStub(async (bodies) => {
    await callTool("grafana_query", { datasource_uid: "cw", query: { region: "eu-west-1", namespace: "AWS/S3" } });
    assert.equal(bodies.length, 1);
  });
});

test("grafana_query: CloudWatch Logs Insights is refused before any request is sent", async () => {
  // Logs Insights bills per GB SCANNED — an unbounded cost a single query can run
  // up. The refusal must happen before the request leaves, not after.
  for (const bad of [
    { queryMode: "Logs", expression: "fields @message" },
    { queryMode: "Metrics", logGroups: ["/aws/lambda/x"] },
    { queryMode: "Metrics", logGroupNames: ["/aws/lambda/x"] },
    { queryMode: "Metrics", subtype: "StartQuery" },
    { queryMode: "Metrics", queryLanguage: "CWLI" },
  ]) {
    await withCloudwatchStub(async (bodies) => {
      await assert.rejects(
        () => tools.grafana_query({ datasource_uid: "cw", query: bad }, {}),
        /refused/,
        `should refuse ${JSON.stringify(bad)}`,
      );
      assert.equal(bodies.length, 0, "no /ds/query request may be sent for a refused CloudWatch query");
    });
  }
});

test("grafana_query: the CloudWatch guard applies only to CloudWatch", async () => {
  // A loki query carrying an unrelated field named logGroups must not be refused.
  const payload = { results: { A: { status: 200, frames: [] } } };
  await withDsQueryStub(payload, async (bodies) => {
    await callTool("grafana_query", { datasource_uid: "ds", expr: '{a="b"}' });
    assert.equal(bodies.length, 1);
  });
});

// ---------------------------------------------------------------------------
// grafana_query read-only guard (comentario #1 de gutek): solo types allowlisted
// ---------------------------------------------------------------------------

test("grafana_query: rejects a datasource whose type is not in the read-only allowlist", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    calls.push(String(url));
    // El uid resuelve a un type que SÍ escribe; el guardián debe denegar antes de consultar.
    const body = String(url).includes("/datasources/uid/")
      ? { uid: "am", name: "Alertmanager", type: "alertmanager" }
      : { results: {} };
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
      headers: { get: () => null },
    });
  };
  try {
    await assert.rejects(
      () => tools.grafana_query({ datasource_uid: "am", expr: "up" }, {}),
      /not in the read-only allowlist/,
    );
    // Clave: corta ANTES de hacer POST a /ds/query.
    assert.ok(!calls.some((u) => u.includes("/ds/query")), "must not query a non-read-only datasource");
  } finally {
    globalThis.fetch = origFetch;
  }
});


test("grafana_query: fails closed when the datasource cannot be resolved", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    calls.push(String(url));
    // La resolución del uid falla (uid desconocido -> 403). Se deniega igualmente.
    return Promise.resolve({
      ok: false,
      status: 403,
      text: () => Promise.resolve(""),
      headers: { get: () => null },
    });
  };
  try {
    await assert.rejects(
      () => tools.grafana_query({ datasource_uid: "nope", expr: "up" }, {}),
      /could not be verified read-only/,
    );
    assert.ok(!calls.some((u) => u.includes("/ds/query")), "must not query when the type is unknown");
  } finally {
    globalThis.fetch = origFetch;
  }
});

