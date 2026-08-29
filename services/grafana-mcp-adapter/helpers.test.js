import { test } from "node:test";
import assert from "node:assert/strict";

// helpers.js imports BASE_URL from grafanaClient.js, which reads env at import
// time. Set a deterministic base url before importing so buildExploreUrl is
// predictable.
process.env.GRAFANA_BASE_URL = "https://g.example.com";

const {
  summarizeQueryResult,
  isLogFrame,
  classifyFrame,
  requireDatasourceUid,
  durationSeconds,
  chooseInterval,
  buildTrendBuckets,
  summarizeTrend,
  summarizePatterns,
  escapeRegex,
  buildLogsQuery,
  buildExactLogsQuery,
  buildExploreUrl,
  buildDrilldownUrl,
  buildLineFilterToken,
  lineFilterExpr,
  toLokiNs,
  resolvedWindow,
  coverageVerdict,
  editDistance,
  rankClientSuggestions,
  splitClientEnv,
  matchNamespaces,
} = await import("./helpers.js");

// ---------------------------------------------------------------------------
// summarizeQueryResult
// ---------------------------------------------------------------------------

// A minimal /ds/query payload: one refId, one frame, a time field + a number
// field carrying labels and values.
function frame(labels, values) {
  return {
    schema: {
      fields: [
        { type: "time" },
        { type: "number", labels },
      ],
    },
    data: { values: [values.map((_, i) => i), values] },
  };
}

test("summarizeQueryResult: collapses each series to labels + numeric digest", () => {
  const payload = { results: { A: { status: 200, frames: [frame({ job: "api" }, [2, 4, 6])] } } };
  const out = summarizeQueryResult(payload);
  assert.equal(out.results.A.status, 200);
  assert.equal(out.results.A.series_count, 1);
  assert.equal(out.results.A.truncated, 0);
  assert.deepEqual(out.results.A.series[0], {
    labels: { job: "api" },
    count: 3,
    first: 2,
    last: 6,
    min: 2,
    max: 6,
    avg: 4,
  });
});

test("summarizeQueryResult: empty series reports count 0 and no digest stats", () => {
  const payload = { results: { A: { status: 200, frames: [frame({}, [])] } } };
  const out = summarizeQueryResult(payload);
  assert.deepEqual(out.results.A.series[0], { labels: {}, count: 0 });
});

test("summarizeQueryResult: slices to maxSeries and reports truncated count", () => {
  const frames = Array.from({ length: 5 }, (_, i) => frame({ i: String(i) }, [i]));
  const out = summarizeQueryResult({ results: { A: { frames } } }, { maxSeries: 2 });
  // series_count is the total before slicing; the array is capped to maxSeries
  // and `truncated` carries how many were dropped.
  assert.equal(out.results.A.series_count, 5);
  assert.equal(out.results.A.series.length, 2);
  assert.equal(out.results.A.truncated, 3);
});

test("summarizeQueryResult: digests a large series without overflowing the stack", () => {
  // A wide metric query can return 100k+ points. min/max must NOT be computed via
  // Math.min(...values) — spreading that many args throws a RangeError.
  const N = 200000;
  const values = Array.from({ length: N }, (_, i) => i);
  const out = summarizeQueryResult({ results: { A: { frames: [frame({}, values)] } } });
  const d = out.results.A.series[0];
  assert.equal(d.count, N);
  assert.equal(d.min, 0);
  assert.equal(d.max, N - 1);
  assert.equal(d.first, 0);
  assert.equal(d.last, N - 1);
  assert.equal(d.avg, (N - 1) / 2);
});

test("summarizeQueryResult: wide frame emits one digest per numeric field", () => {
  // A single Grafana frame can carry several numeric fields (one per series).
  // Every numeric field must produce its own digest — not just the first.
  const wide = {
    schema: {
      fields: [
        { type: "time" },
        { type: "number", labels: { series: "a" } },
        { type: "number", labels: { series: "b" } },
      ],
    },
    data: { values: [[0, 1, 2], [2, 4, 6], [10, 20, 30]] },
  };
  const out = summarizeQueryResult({ results: { A: { status: 200, frames: [wide] } } });
  assert.equal(out.results.A.series_count, 2);
  assert.deepEqual(out.results.A.series[0], {
    labels: { series: "a" }, count: 3, first: 2, last: 6, min: 2, max: 6, avg: 4,
  });
  assert.deepEqual(out.results.A.series[1], {
    labels: { series: "b" }, count: 3, first: 10, last: 30, min: 10, max: 30, avg: 20,
  });
});


test("summarizeQueryResult: tolerates missing results / frames", () => {
  assert.deepEqual(summarizeQueryResult(), { results: {} });
  assert.deepEqual(summarizeQueryResult({ results: { A: {} } }).results.A, {
    status: null,
    series_count: 0,
    series: [],
    truncated: 0,
  });
});

// ---------------------------------------------------------------------------
// summarizeQueryResult — Loki log frames
// ---------------------------------------------------------------------------

// A Loki log frame exactly as Grafana's /ds/query returns it: frameType
// `LabeledTimeValues`, and fields labels/Time/Line/tsNs/labelTypes/id. The
// point of this fixture is that NOT ONE of those fields has type "number" —
// the numeric digest path skips all of them, so without log handling this
// frame reports `series_count: 0` for a query that matched every line.
function logFrame(rows, { stats } = {}) {
  return {
    schema: {
      refId: "A",
      meta: {
        custom: { frameType: "LabeledTimeValues" },
        ...(stats ? { stats } : {}),
      },
      fields: [
        { name: "labels", type: "other" },
        { name: "Time", type: "time" },
        { name: "Line", type: "string" },
        { name: "tsNs", type: "string" },
        { name: "labelTypes", type: "other" },
        { name: "id", type: "string" },
      ],
    },
    data: {
      values: [
        rows.map((r) => r.labels),
        rows.map((r) => r.time),
        rows.map((r) => r.line),
        rows.map((r) => String(r.time * 1e6)),
        rows.map(() => ({})),
        rows.map((r) => `${r.time}_x`),
      ],
    },
  };
}

const NS = { namespace: "demo-qa", service_name: "apim-api" };

test("summarizeQueryResult: log frames are counted, not silently dropped", () => {
  // Regression: log fields are string/time/other, never number. The numeric
  // path skips every field, so this used to report series_count 0 — a false
  // "no matches" for a query that matched three lines.
  const payload = {
    results: {
      A: {
        status: 200,
        frames: [
          logFrame([
            { labels: NS, time: 1700000002000, line: "boom c" },
            { labels: NS, time: 1700000001000, line: "boom b" },
            { labels: NS, time: 1700000000000, line: "boom a" },
          ]),
        ],
      },
    },
  };
  const out = summarizeQueryResult(payload);
  assert.equal(out.results.A.frame_type, "logs");
  assert.equal(out.results.A.line_count, 3);
  assert.notEqual(out.results.A.line_count, 0);
});

test("summarizeQueryResult: log digest reports time range, streams and a sample", () => {
  const other = { namespace: "demo-qa", service_name: "apim-gateway" };
  const out = summarizeQueryResult({
    results: {
      A: {
        status: 200,
        frames: [
          logFrame([
            { labels: NS, time: 1700000002000, line: "newest" },
            { labels: other, time: 1700000001000, line: "middle" },
            { labels: NS, time: 1700000000000, line: "oldest" },
          ]),
        ],
      },
    },
  });
  const r = out.results.A;
  assert.equal(r.line_count, 3);
  // Range spans oldest..newest regardless of the order rows arrive in.
  assert.equal(r.time_range.from, "2023-11-14T22:13:20.000Z");
  assert.equal(r.time_range.to, "2023-11-14T22:13:22.000Z");
  // Two distinct label sets, ordered by line count (busiest stream first).
  assert.equal(r.stream_count, 2);
  assert.deepEqual(r.streams[0], { labels: NS, lines: 2 });
  assert.deepEqual(r.streams[1], { labels: other, lines: 1 });
  assert.equal(r.streams_truncated, 0);
  // Sample keeps frame order (Loki returns newest first).
  assert.deepEqual(r.sample_lines, ["newest", "middle", "oldest"]);
  assert.equal(r.sample_truncated, 0);
});

test("summarizeQueryResult: log sample is capped and reports how many were dropped", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ labels: NS, time: 1700000000000 + i, line: `line ${i}` }));
  const out = summarizeQueryResult({ results: { A: { frames: [logFrame(rows)] } } }, { maxSampleLines: 3 });
  assert.equal(out.results.A.line_count, 20);
  assert.equal(out.results.A.sample_lines.length, 3);
  assert.equal(out.results.A.sample_truncated, 17);
});

test("summarizeQueryResult: an over-long log line is clipped, not passed through whole", () => {
  const rows = [{ labels: NS, time: 1700000000000, line: "x".repeat(1000) }];
  const out = summarizeQueryResult({ results: { A: { frames: [logFrame(rows)] } } }, { maxLineChars: 10 });
  assert.equal(out.results.A.sample_lines[0], "xxxxxxxxxx\u2026[truncated]");
});

test("summarizeQueryResult: reaching the requested line cap is reported as partial", () => {
  // The cap is the whole reason a caller can be misled: 100 lines back from a
  // 100-line limit means "at least 100", never "exactly 100".
  const rows = Array.from({ length: 5 }, (_, i) => ({ labels: NS, time: 1700000000000 + i, line: `l${i}` }));
  const out = summarizeQueryResult({ results: { A: { frames: [logFrame(rows)] } } }, { limit: 5 });
  assert.equal(out.results.A.limit_reached, true);
  assert.match(out.results.A.note, /max_lines/);
});

test("summarizeQueryResult: staying under the line cap is not flagged as partial", () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({ labels: NS, time: 1700000000000 + i, line: `l${i}` }));
  const out = summarizeQueryResult({ results: { A: { frames: [logFrame(rows)] } } }, { limit: 5 });
  assert.equal(out.results.A.limit_reached, undefined);
  assert.equal(out.results.A.note, undefined);
});

test("summarizeQueryResult: surfaces Loki stats without passing them off as a match count", () => {
  const out = summarizeQueryResult({
    results: {
      A: {
        frames: [
          logFrame([{ labels: NS, time: 1700000000000, line: "one" }], {
            stats: [
              { displayName: "Summary: total lines processed", value: 70986 },
              { displayName: "Summary: total bytes processed", value: 14584743 },
              { displayName: "Summary: exec time", value: 0.021639 },
            ],
          }),
        ],
      },
    },
  });
  // lines_processed is how much Loki READ, not how much matched. The match
  // count stays line_count; conflating the two would overstate results ~70000x.
  assert.equal(out.results.A.stats.lines_processed, 70986);
  assert.equal(out.results.A.line_count, 1);
});

test("summarizeQueryResult: a pure log result omits the numeric keys entirely", () => {
  // `series_count: 0` next to a real line_count reads as "nothing found" — the
  // same misleading zero the log digest exists to remove.
  const out = summarizeQueryResult({
    results: { A: { frames: [logFrame([{ labels: NS, time: 1700000000000, line: "a" }])] } },
  });
  assert.equal(out.results.A.line_count, 1);
  assert.equal(out.results.A.series_count, undefined);
  assert.equal(out.results.A.series, undefined);
  assert.equal(out.results.A.truncated, undefined);
});

test("summarizeQueryResult: a result with both frame kinds keeps both digests", () => {
  const out = summarizeQueryResult({
    results: {
      A: {
        frames: [logFrame([{ labels: NS, time: 1700000000000, line: "a" }]), frame({ job: "api" }, [1, 3])],
      },
    },
  });
  assert.equal(out.results.A.line_count, 1);
  assert.equal(out.results.A.series_count, 1);
});

test("summarizeQueryResult: metric frames keep the numeric digest and gain no log keys", () => {
  const out = summarizeQueryResult({ results: { A: { status: 200, frames: [frame({ job: "api" }, [1, 3])] } } });
  assert.equal(out.results.A.series_count, 1);
  assert.equal(out.results.A.frame_type, undefined);
  assert.equal(out.results.A.line_count, undefined);
});

test("isLogFrame: detects by frameType, and falls back to the Line field", () => {
  assert.equal(isLogFrame(logFrame([])), true);
  // No frameType meta, but a Line string field -> still a log frame.
  assert.equal(
    isLogFrame({ schema: { fields: [{ name: "Time", type: "time" }, { name: "Line", type: "string" }] } }),
    true,
  );
  assert.equal(isLogFrame(frame({}, [1])), false);
  assert.equal(isLogFrame(undefined), false);
});

// ---------------------------------------------------------------------------
// classifyFrame / table digest (Tempo traces, Elasticsearch raw documents)
// ---------------------------------------------------------------------------

// Shapes captured from the live instance.
const PROM_FRAME = { schema: { meta: { type: "timeseries-multi" }, fields: [{ name: "Time", type: "time" }, { name: "up", type: "number", labels: { job: "api" } }] }, data: { values: [[0], [1]] } };
const ES_AGG_FRAME = { schema: { meta: { type: "timeseries-multi" }, fields: [{ name: "Time", type: "time" }, { name: "Value", type: "number" }] }, data: { values: [[0], [7]] } };

function tempoFrame(rows) {
  return {
    schema: {
      meta: { preferredVisualisationType: "table" },
      fields: [
        { name: "traceID", type: "string" },
        { name: "startTime", type: "time" },
        { name: "traceName", type: "string" },
        { name: "traceDuration", type: "number" },
        { name: "nested", type: "other" },
      ],
    },
    data: {
      values: [
        rows.map((r) => r.id),
        rows.map((r) => r.start),
        rows.map((r) => r.name),
        rows.map((r) => r.duration),
        rows.map(() => ({ deep: true })),
      ],
    },
  };
}

test("classifyFrame: a numeric table with no time axis is a table, not a series", () => {
  // Elasticsearch terms aggregations return `status` + `Count`, both numeric and
  // no time field. Treated as a series this yields the min/max/avg of HTTP status
  // codes — arithmetic over identifiers, reported as if it were a measurement.
  const termsFrame = {
    schema: { fields: [{ name: "status", type: "number" }, { name: "Count", type: "number" }] },
    data: { values: [[200, 401, 500], [3691597, 3019, 13]] },
  };
  assert.equal(classifyFrame(termsFrame), "table");

  const out = summarizeQueryResult({ results: { A: { status: 200, frames: [termsFrame] } } });
  assert.equal(out.results.A.frame_type, "table");
  assert.equal(out.results.A.row_count, 3);
  assert.equal(out.results.A.series_count, undefined, "status codes must not be digested as a series");
  // The term and its count stay paired, which is the entire content of the result.
  assert.deepEqual(out.results.A.sample_rows[0], { status: 200, Count: 3691597 });
  assert.deepEqual(out.results.A.columns.map((c) => c.name), ["status", "Count"]);
});

test("classifyFrame: recognises each shape this Grafana actually returns", () => {
  assert.equal(classifyFrame(PROM_FRAME), "timeseries");
  assert.equal(classifyFrame(ES_AGG_FRAME), "timeseries");
  assert.equal(classifyFrame(tempoFrame([])), "table");
  assert.equal(classifyFrame(logFrame([])), "logs");
  // A bare Time+number frame with no meta is still a timeseries (back-compat).
  assert.equal(classifyFrame(frame({}, [1, 2])), "timeseries");
});

test("summarizeQueryResult: Elasticsearch aggregations digest as an ordinary timeseries", () => {
  // ES returns meta.type timeseries-multi, so it needs no special handling —
  // this pins that, so a future change cannot quietly break it.
  const out = summarizeQueryResult({ results: { A: { status: 200, frames: [ES_AGG_FRAME] } } });
  assert.equal(out.results.A.series_count, 1);
  assert.equal(out.results.A.series[0].count, 1);
});

test("summarizeQueryResult: Tempo traces digest as a table, not as a bogus series", () => {
  // Regression: traceDuration is a `number` field, so the numeric path would
  // digest trace durations into a "series" with no labels — silently
  // meaningless output rather than an obvious failure.
  const out = summarizeQueryResult({
    results: {
      A: {
        status: 200,
        frames: [
          tempoFrame([
            { id: "abc", start: 1700000000000, name: "GET /x", duration: 12 },
            { id: "def", start: 1700000001000, name: "GET /y", duration: 34 },
          ]),
        ],
      },
    },
  });
  const r = out.results.A;
  assert.equal(r.frame_type, "table");
  assert.equal(r.row_count, 2);
  assert.equal(r.series_count, undefined, "trace durations must not be reported as a series");
  assert.deepEqual(
    r.columns.map((c) => c.name),
    ["traceID", "startTime", "traceName", "traceDuration", "nested"],
  );
  assert.equal(r.sample_rows[0].traceID, "abc");
  // Object columns are summarised, never inlined - they can be arbitrarily large.
  assert.equal(r.sample_rows[0].nested, "{object}");
});

test("summarizeQueryResult: table sample is capped and over-long cells clipped", () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: "x".repeat(50), start: i, name: `n${i}`, duration: i }));
  const out = summarizeQueryResult({ results: { A: { frames: [tempoFrame(rows)] } } }, { maxSampleRows: 2, maxCellChars: 10 });
  assert.equal(out.results.A.row_count, 9);
  assert.equal(out.results.A.sample_rows.length, 2);
  assert.equal(out.results.A.sample_rows_truncated, 7);
  assert.equal(out.results.A.sample_rows[0].traceID, "xxxxxxxxxx\u2026[truncated]");
});

test("summarizeQueryResult: an unrecognised frame is reported, never silently empty", () => {
  // The whole point: a shape nobody anticipated must still produce a visible
  // row count and column list rather than a confident zero.
  const odd = {
    schema: { fields: [{ name: "thing", type: "string" }, { name: "other", type: "other" }] },
    data: { values: [["a", "b", "c"], [1, 2, 3]] },
  };
  const out = summarizeQueryResult({ results: { A: { frames: [odd] } } });
  assert.equal(out.results.A.frame_type, "table");
  assert.equal(out.results.A.row_count, 3);
});

// ---------------------------------------------------------------------------
// trend helpers
// ---------------------------------------------------------------------------

test("durationSeconds: parses Loki-style durations and rejects junk", () => {
  assert.equal(durationSeconds("30s"), 30);
  assert.equal(durationSeconds("5m"), 300);
  assert.equal(durationSeconds("1h"), 3600);
  assert.equal(durationSeconds("2d"), 172800);
  for (const bad of ["", "5", "5x", "m", "-1m", "1.5h", undefined]) {
    assert.throws(() => durationSeconds(bad), /invalid interval/);
  }
});

test("chooseInterval: keeps the bucket count readable across ranges", () => {
  // A day of one-minute buckets is 1440 numbers - unreadable and expensive.
  assert.equal(chooseInterval(3600), "5m", "1h at 1m would be 60 buckets, over the cap");
  assert.equal(chooseInterval(6 * 3600), "15m");
  assert.equal(chooseInterval(24 * 3600), "30m");
  assert.equal(chooseInterval(7 * 24 * 3600), "6h");
  for (const range of [600, 3600, 6 * 3600, 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600]) {
    assert.ok(range / durationSeconds(chooseInterval(range)) <= 48, `too many buckets for ${range}s`);
  }
});

test("buildTrendBuckets: fills empty steps so a gap is not mistaken for a shape", () => {
  // Loki omits empty steps entirely. Without filling, a quiet hour and a missing
  // hour look identical, and the onset cannot be read off the series.
  const start = 1000, end = 1000 + 5 * 60;
  const points = [[1060, "3"], [1240, "7"]];
  const buckets = buildTrendBuckets(points, { startSeconds: start, endSeconds: end, stepSeconds: 60 });
  assert.deepEqual(buckets.map((b) => b.count), [0, 3, 0, 0, 7, 0]);
  assert.equal(buckets[0].time, new Date(960 * 1000).toISOString());
});

test("buildTrendBuckets: snaps off-grid points instead of dropping them", () => {
  // Loki's step alignment need not match ours; a point landing mid-bucket must
  // still be counted.
  const buckets = buildTrendBuckets([[1037, "2"], [1059, "1"]], {
    startSeconds: 1000,
    endSeconds: 1120,
    stepSeconds: 60,
  });
  assert.equal(buckets.reduce((n, b) => n + b.count, 0), 3);
});

test("buildTrendBuckets: is bounded so a tiny interval cannot flood the response", () => {
  const buckets = buildTrendBuckets([], { startSeconds: 0, endSeconds: 10_000_000, stepSeconds: 1, maxBuckets: 50 });
  assert.equal(buckets.length, 50);
});

test("summarizeTrend: reports total, onset, last and peak", () => {
  const buckets = [
    { time: "t0", count: 0 },
    { time: "t1", count: 2 },
    { time: "t2", count: 9 },
    { time: "t3", count: 1 },
    { time: "t4", count: 0 },
  ];
  const s = summarizeTrend(buckets);
  assert.equal(s.total, 12);
  assert.equal(s.onset, "t1", "onset is the FIRST non-empty bucket - the 'when did this start' answer");
  assert.equal(s.last_seen, "t3");
  assert.deepEqual(s.peak, { time: "t2", count: 9 });
});

test("summarizeTrend: an all-zero series has no onset rather than a false one", () => {
  const s = summarizeTrend([{ time: "t0", count: 0 }, { time: "t1", count: 0 }]);
  assert.equal(s.total, 0);
  assert.equal(s.onset, null);
  assert.equal(s.peak, null);
});

// ---------------------------------------------------------------------------
// summarizePatterns
// ---------------------------------------------------------------------------

// Shape captured from Loki: {pattern, level, samples: [[unixSeconds, count]]}.
const PATTERNS = [
  { pattern: "<_> INFO destroying service <_>", level: "info", samples: [[1000, 400], [1060, 172]] },
  { pattern: "GET / HTTP/1.1 200 <_>", level: "unknown", samples: [[1000, 408]] },
  { pattern: "rare deserialization failure <_>", level: "error", samples: [[1120, 1]] },
  { pattern: "never seen", level: "info", samples: [] },
];

test("summarizePatterns: ranks patterns by volume and keeps the rare one visible", () => {
  const out = summarizePatterns(PATTERNS);
  assert.equal(out.pattern_count, 3, "a pattern with no samples is not a pattern");
  assert.deepEqual(out.patterns.map((p) => p.count), [572, 408, 1]);
  // The point of the tool: the 1-line error survives next to the 572-line noise.
  const rare = out.patterns.find((p) => p.level === "error");
  assert.equal(rare.count, 1);
  assert.equal(rare.first_seen, new Date(1120 * 1000).toISOString());
});

test("summarizePatterns: lines_in_patterns is named for what it is, not a line total", () => {
  // Loki assigns only some lines to patterns, so this must never be presented as
  // the number of lines in the range.
  const out = summarizePatterns(PATTERNS);
  assert.equal(out.lines_in_patterns, 981);
  assert.equal(out.line_count, undefined);
  assert.equal(out.total, undefined);
});

test("summarizePatterns: reports the volume floor so absence is not read as zero", () => {
  // Loki does not rank rare lines last, it omits them. Surfacing the smallest
  // pattern we DID get tells the caller what could be missing.
  const out = summarizePatterns(PATTERNS);
  assert.equal(out.smallest_pattern_count, 1);
  assert.equal(summarizePatterns([]).smallest_pattern_count, null);
});

test("summarizePatterns: caps the list and reports how many were dropped", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ pattern: `p${i}`, samples: [[1000, i + 1]] }));
  const out = summarizePatterns(many, { maxPatterns: 5 });
  assert.equal(out.pattern_count, 30);
  assert.equal(out.patterns.length, 5);
  assert.equal(out.patterns_truncated, 25);
  assert.equal(out.patterns[0].count, 30, "capped list keeps the BIGGEST patterns");
});

// ---------------------------------------------------------------------------
// requireDatasourceUid
// ---------------------------------------------------------------------------

test("requireDatasourceUid: returns the configured uid", () => {
  assert.equal(requireDatasourceUid("grafanacloud-logs"), "grafanacloud-logs");
  assert.equal(requireDatasourceUid("  padded-uid  "), "padded-uid");
});

test("requireDatasourceUid: unset/blank fails with an actionable message", () => {
  for (const bad of [undefined, null, "", "   "]) {
    assert.throws(() => requireDatasourceUid(bad), /GRAFANA_LOGS_DATASOURCE_UID is not set/);
  }
  // The message must say the uid can differ from the display name — the exact
  // assumption that cost time on this instance.
  assert.throws(() => requireDatasourceUid(""), /not always the same as the display name/);
});

// ---------------------------------------------------------------------------
// escapeRegex
// ---------------------------------------------------------------------------

test("escapeRegex: escapes regex metacharacters", () => {
  assert.equal(escapeRegex("a.b*c+"), "a\\.b\\*c\\+");
  assert.equal(escapeRegex("plain"), "plain");
});

// ---------------------------------------------------------------------------
// buildLogsQuery
// ---------------------------------------------------------------------------

test("buildLogsQuery: client only -> case-insensitive substring selector", () => {
  assert.equal(buildLogsQuery({ client: "april" }), '{service_name=~"(?i).*april.*"}');
});

test("buildLogsQuery: client + component join with .*", () => {
  assert.equal(
    buildLogsQuery({ client: "april", component: "gateway" }),
    '{service_name=~"(?i).*april.*gateway.*"}',
  );
});

test("buildLogsQuery: multi-word fragment joins words with .* (not a literal space)", () => {
  // `service_name` is dash-separated, so "april prod" must become april.*prod —
  // a literal space would never match `…-april-prod-…`. Note "prod" is an env
  // token, so it is anchored to a whole segment (see env-token test below).
  assert.equal(
    buildLogsQuery({ client: "april prod", component: "gateway" }),
    '{service_name=~"(?i).*april.*(?:^|[-_.])prod(?:[-_.]|$).*gateway.*"}',
  );
});

test("buildLogsQuery: anchors env tokens so 'prod' doesn't match 'nonprod'/'preprod'", () => {
  // 'prod' is anchored to a whole segment; a non-env word like 'april' stays a
  // plain substring (so partial customer names keep matching).
  const q = buildLogsQuery({ client: "april prod" });
  assert.equal(q, '{service_name=~"(?i).*april.*(?:^|[-_.])prod(?:[-_.]|$).*"}');
  // (?i) is Loki/Go inline-flag syntax; JS RegExp needs the literal stripped and
  // the "i" flag passed instead.
  const re = new RegExp(q.match(/service_name=~"(?:\(\?i\))?([^"]*)"/)[1], "i");
  assert.ok(re.test("graviteeio-am-april-prod-gateway"));
  assert.equal(re.test("graviteeio-am-april-nonprod-gateway"), false);
  assert.equal(re.test("graviteeio-am-april-preprod-gateway"), false);
});

test("buildLogsQuery: non-env partial words stay substrings (arcelor matches arcelor-mittal)", () => {
  const q = buildLogsQuery({ client: "arcelor" });
  const re = new RegExp(q.match(/service_name=~"(?:\(\?i\))?([^"]*)"/)[1], "i");
  assert.ok(re.test("graviteeio-apim-arcelor-mittal-prod-gateway"));
});

test("buildLogsQuery: collapses extra/leading/trailing whitespace in a fragment", () => {
  assert.equal(buildLogsQuery({ client: "  am   prod  " }), '{service_name=~"(?i).*am.*(?:^|[-_.])prod(?:[-_.]|$).*"}');
});

test("buildLogsQuery: escapes regex metachars in client/component", () => {
  assert.equal(buildLogsQuery({ client: "a.b" }), '{service_name=~"(?i).*a\\.b.*"}');
});

test("buildLogsQuery: line_filter appends a backtick line filter, stripping backticks", () => {
  // Case-insensitive by default, so the term is regex-escaped for `|~`.
  assert.equal(
    buildLogsQuery({ client: "april", lineFilter: "error `x`" }),
    '{service_name=~"(?i).*april.*"} |~ `(?i)error x`',
  );
  assert.equal(
    buildLogsQuery({ client: "april", lineFilter: "error `x`", caseSensitive: true }),
    '{service_name=~"(?i).*april.*"} |= `error x`',
  );
});

test("buildLogsQuery: throws when client missing", () => {
  assert.throws(() => buildLogsQuery({}), /client is required/);
});

test("buildLogsQuery: namespaces pin the selector and drop client from service_name", () => {
  // Customer resolved to its own namespace: the namespace isolates the customer,
  // so service_name only carries env/component (not the client core).
  // Hyphens aren't regex metachars (outside a char class) so escapeRegex leaves
  // them as-is — same convention as the drilldown alternation test.
  assert.equal(
    buildLogsQuery({ client: "blueyonder prod", component: "gateway", namespaces: ["blueyonder-plt-live"] }),
    '{namespace=~"^blueyonder-plt-live$", service_name=~"(?i).*(?:^|[-_.])prod(?:[-_.]|$).*gateway.*"}',
  );
});

test("buildLogsQuery: multiple namespaces -> anchored alternation", () => {
  assert.equal(
    buildLogsQuery({ client: "april", namespaces: ["april-prod", "april-rec"] }),
    '{namespace=~"^april-prod$|^april-rec$"}',
  );
});

test("buildLogsQuery: namespace-pinned, no component/env -> service_name matcher omitted", () => {
  // Nothing left to narrow by inside the namespace: emit only the namespace pin,
  // not an empty `service_name=~"(?i).*.*"`.
  assert.equal(buildLogsQuery({ client: "april", namespaces: ["april-prod"] }), '{namespace=~"^april-prod$"}');
});

// ---------------------------------------------------------------------------
// buildExactLogsQuery
// ---------------------------------------------------------------------------

test("buildExactLogsQuery: single service_name -> exact `=` matchers", () => {
  assert.equal(
    buildExactLogsQuery({ namespace: "ghd-prod", serviceNames: ["graviteeio-apim3-gateway"] }),
    '{namespace="ghd-prod", service_name="graviteeio-apim3-gateway"}',
  );
});

test("buildExactLogsQuery: multiple service_names -> `=~` alternation, regex-escaped", () => {
  assert.equal(
    buildExactLogsQuery({
      namespace: "ghd-prod",
      serviceNames: ["graviteeio-apim-ghd-prod-apim3-gateway", "graviteeio-apim3-gateway"],
    }),
    '{namespace="ghd-prod", service_name=~"graviteeio-apim-ghd-prod-apim3-gateway|graviteeio-apim3-gateway"}',
  );
});

test("buildExactLogsQuery: line_filter is case-insensitive by default", () => {
  assert.equal(
    buildExactLogsQuery({
      namespace: "ghd-prod",
      serviceNames: ["graviteeio-apim3-gateway"],
      lineFilter: "ConnectTimeoutException",
    }),
    '{namespace="ghd-prod", service_name="graviteeio-apim3-gateway"} |~ `(?i)ConnectTimeoutException`',
  );
  assert.equal(
    buildExactLogsQuery({
      namespace: "ghd-prod",
      serviceNames: ["graviteeio-apim3-gateway"],
      lineFilter: "ConnectTimeoutException",
      caseSensitive: true,
    }),
    '{namespace="ghd-prod", service_name="graviteeio-apim3-gateway"} |= `ConnectTimeoutException`',
  );
});

test("buildExactLogsQuery: no service_names -> namespace-only selector", () => {
  assert.equal(buildExactLogsQuery({ namespace: "ghd-prod" }), '{namespace="ghd-prod"}');
});

test("buildExactLogsQuery: dedupes service_names", () => {
  assert.equal(
    buildExactLogsQuery({ namespace: "ghd-prod", serviceNames: ["a", "a"] }),
    '{namespace="ghd-prod", service_name="a"}',
  );
});

test("buildExactLogsQuery: throws when namespace missing", () => {
  assert.throws(() => buildExactLogsQuery({ serviceNames: ["a"] }), /namespace is required/);
});

// ---------------------------------------------------------------------------
// splitClientEnv
// ---------------------------------------------------------------------------

test("splitClientEnv: separates customer core from env tokens", () => {
  assert.deepEqual(splitClientEnv("blueyonder prod"), { core: "blueyonder", envs: ["prod"] });
  assert.deepEqual(splitClientEnv("equigy"), { core: "equigy", envs: [] });
  assert.deepEqual(splitClientEnv("  arcelor  nonprod "), { core: "arcelor", envs: ["nonprod"] });
  assert.deepEqual(splitClientEnv(""), { core: "", envs: [] });
});

// ---------------------------------------------------------------------------
// matchNamespaces
// ---------------------------------------------------------------------------

const NAMESPACES = [
  "prod",
  "nonprod",
  "april-prod",
  "april-rec",
  "blueyonder-plt-live",
  "blueyonder-multitenant",
  "skyport-prod",
];

test("matchNamespaces: returns the customer's own namespaces", () => {
  assert.deepEqual(matchNamespaces(NAMESPACES, "april"), ["april-prod", "april-rec"]);
  assert.deepEqual(matchNamespaces(NAMESPACES, "blueyonder"), ["blueyonder-plt-live", "blueyonder-multitenant"]);
});

test("matchNamespaces: customer with no dedicated namespace -> [] (fall back to service_name)", () => {
  // 'equigy' lives only in the shared `prod`/`nonprod` namespaces.
  assert.deepEqual(matchNamespaces(NAMESPACES, "equigy"), []);
});

test("matchNamespaces: empty core matches nothing (avoids matching every namespace)", () => {
  assert.deepEqual(matchNamespaces(NAMESPACES, ""), []);
  assert.deepEqual(matchNamespaces(NAMESPACES, "   "), []);
});

// ---------------------------------------------------------------------------
// buildExploreUrl
// ---------------------------------------------------------------------------

test("buildExploreUrl: builds a Grafana 11+ panes deep link", () => {
  const url = buildExploreUrl({
    datasourceUid: "grafanacloud-logs",
    query: '{service_name=~"(?i).*april.*"}',
    from: "now-1h",
    to: "now",
  });
  assert.ok(url.startsWith("https://g.example.com/explore?schemaVersion=1&orgId=1&panes="));
  // Legacy <=10 form must not be emitted.
  assert.equal(url.includes("left="), false);
  const panes = JSON.parse(decodeURIComponent(new URL(url).searchParams.get("panes")));
  assert.deepEqual(panes.logs.range, { from: "now-1h", to: "now" });
  assert.equal(panes.logs.datasource, "grafanacloud-logs");
  assert.equal(panes.logs.queries[0].datasource.type, "loki");
  assert.equal(panes.logs.queries[0].expr, '{service_name=~"(?i).*april.*"}');
});

// ---------------------------------------------------------------------------
// buildDrilldownUrl
// ---------------------------------------------------------------------------

// Deliberately NOT the uid used by the Gravitee instance: if a default is ever
// reintroduced, these assertions fail instead of passing by coincidence.
const DS_UID = "loki-test-uid";

test("buildDrilldownUrl: requires the datasource uid instead of assuming one", () => {
  assert.throws(
    () => buildDrilldownUrl({ namespace: "april-prod", from: "now-1h", to: "now" }),
    /datasourceUid is required/,
  );
});

test("buildDrilldownUrl: single service_name -> exact (=) filter", () => {
  const url = buildDrilldownUrl({
    namespace: "april-prod",
    serviceNames: ["graviteeio-apim-april-prod-gateway"],
    datasourceUid: DS_UID,
    from: "now-1h",
    to: "now",
  });
  assert.ok(url.startsWith("https://g.example.com/a/grafana-lokiexplore-app/explore/namespace/april-prod/logs?"));
  const params = new URL(url).searchParams;
  assert.equal(params.get("var-ds"), DS_UID);
  assert.equal(params.get("visualizationType"), '"logs"');
  // namespace pin + exact service_name match (NOT a raw LogQL regex, which the
  // app treats as a literal).
  assert.deepEqual(params.getAll("var-filters"), [
    "namespace|=|april-prod",
    "service_name|=|graviteeio-apim-april-prod-gateway",
  ]);
});

test("buildDrilldownUrl: several service_names -> namespace-only, never a regex alternation", () => {
  // Regression (B3). Verified against the live Logs Drilldown app:
  //   - it treats a filter value as a LITERAL and regex-escapes it, so a `=~`
  //     alternation reaches Loki as service_name=~"a\\|b" and matches NOTHING;
  //   - its own multi-value operator (`=|`) silently keeps only the first two
  //     values (1->1, 2->2, 3->2, 5->2).
  // Both roads mislead, so a multi-service link is scoped to the namespace:
  // broader, but never silently wrong. The exact set travels in service_names
  // and in the explore_url.
  const url = buildDrilldownUrl({
    namespace: "demo-qa",
    serviceNames: ["svc-a", "svc-b", "svc-c"],
    datasourceUid: DS_UID,
    from: "now-1h",
    to: "now",
  });
  const filters = new URL(url).searchParams.getAll("var-filters");
  assert.deepEqual(filters, ["namespace|=|demo-qa"]);
  assert.ok(!url.includes("=~"), "must not emit a regex alternation the app cannot honour");
  assert.ok(!url.includes("__gfp__|svc"), "must not emit a multi-value filter the app truncates");
});

test("buildDrilldownUrl: every filter has exactly three parts, for any service count", () => {
  for (const n of [0, 1, 2, 5]) {
    const url = buildDrilldownUrl({
      namespace: "demo-qa",
      serviceNames: Array.from({ length: n }, (_, i) => `svc-${i}`),
      datasourceUid: DS_UID,
      from: "now-1h",
      to: "now",
    });
    const filters = new URL(url).searchParams.getAll("var-filters");
    // Exactly one service pins service_name; zero or several stay namespace-only.
    assert.equal(filters.length, n === 1 ? 2 : 1, `n=${n}`);
    for (const f of filters) assert.equal(f.split("|").length, 3, `n=${n} malformed: ${f}`);
  }
});

test("buildDrilldownUrl: a delimiter inside a label value is escaped, not emitted raw", () => {
  const url = buildDrilldownUrl({
    namespace: "ns,with|delims",
    serviceNames: ["svc,a"],
    datasourceUid: DS_UID,
    from: "now-1h",
    to: "now",
  });
  assert.deepEqual(new URL(url).searchParams.getAll("var-filters"), [
    "namespace|=|ns__gfc__with__gfp__delims",
    "service_name|=|svc__gfc__a",
  ]);
});

test("buildDrilldownUrl: omits the service_name filter when none given", () => {
  const url = buildDrilldownUrl({ namespace: "apim-cp-cp2222", datasourceUid: DS_UID, from: "now-15m", to: "now" });
  assert.deepEqual(new URL(url).searchParams.getAll("var-filters"), ["namespace|=|apim-cp-cp2222"]);
});

test("buildDrilldownUrl: de-duplicates service_names", () => {
  const url = buildDrilldownUrl({
    namespace: "april-prod",
    serviceNames: ["svc-a", "svc-a"],
    datasourceUid: DS_UID,
    from: "now-1h",
    to: "now",
  });
  assert.deepEqual(new URL(url).searchParams.getAll("var-filters"), ["namespace|=|april-prod", "service_name|=|svc-a"]);
});

test("buildDrilldownUrl: throws when namespace missing", () => {
  assert.throws(() => buildDrilldownUrl({ datasourceUid: DS_UID, from: "now-1h", to: "now" }), /namespace is required/);
});

test("buildDrilldownUrl: line filter populates var-lineFilters, V2 stays empty", () => {
  const url = buildDrilldownUrl({
    namespace: "sedex-prod",
    serviceNames: ["sedex-prod-gateway"],
    datasourceUid: DS_UID,
    from: "now-7d",
    to: "now",
    lineFilter: "An error occurs during user authentication",
  });
  const params = new URL(url).searchParams;
  // key|operator|value, app's exact format. Case-insensitive by default, so the
  // key is caseInsensitive and the operator the escaped `|~`.
  assert.equal(
    params.get("var-lineFilters"),
    "caseInsensitive,0|__gfp__~|An error occurs during user authentication"
  );
  // The in-progress single-filter var stays empty (matches the app's own links).
  assert.equal(params.get("var-lineFilterV2"), "");
  // Spaces must be percent/plus-encoded in the raw URL, never literal.
  assert.ok(!/var-lineFilters=[^&]* /.test(url));
});

test("buildDrilldownUrl: no line filter leaves var-lineFilters empty", () => {
  const url = buildDrilldownUrl({ namespace: "sedex-prod", datasourceUid: DS_UID, from: "now-1h", to: "now" });
  assert.equal(new URL(url).searchParams.get("var-lineFilters"), "");
});

// ---------------------------------------------------------------------------
// buildLineFilterToken
// ---------------------------------------------------------------------------

test("lineFilterExpr: defaults to a case-insensitive regex, not a literal match", () => {
  // `|=` is case-sensitive. Verified live on data containing "GET":
  //   |= get      -> 0 lines (a clean, believable, WRONG negative)
  //   |~ (?i)get  -> matches
  // A wrong-case filter fails silently, so insensitive is the default.
  assert.equal(lineFilterExpr("get"), " |~ `(?i)get`");
  assert.equal(lineFilterExpr("get", { caseSensitive: true }), " |= `get`");
  assert.equal(lineFilterExpr(""), "");
});

test("lineFilterExpr: escapes regex metacharacters in the insensitive form", () => {
  // `|~` takes a pattern, so an unescaped term would be interpreted rather than
  // matched — "a.b" must not match "axb".
  assert.equal(lineFilterExpr("a.b(c)"), " |~ `(?i)a\\.b\\(c\\)`");
  // ...while the case-sensitive form is a literal and must NOT be escaped.
  assert.equal(lineFilterExpr("a.b(c)", { caseSensitive: true }), " |= `a.b(c)`");
});

test("buildLogsQuery: line filter is case-insensitive by default", () => {
  assert.match(buildLogsQuery({ client: "april", lineFilter: "Timeout" }), /\|~ `\(\?i\)Timeout`/);
  assert.match(buildLogsQuery({ client: "april", lineFilter: "Timeout", caseSensitive: true }), /\|= `Timeout`/);
});

test("buildLineFilterToken: case-insensitive by default, matching the app's own format", () => {
  // Verified against the live Logs Drilldown app on data containing "GET":
  //   caseInsensitive,0|__gfp__~|get -> 281 lines
  //   caseSensitive,0|__gfp__=|get   -> 0 lines
  // so the key drives matching, it does not merely label the input box.
  assert.equal(buildLineFilterToken("get"), "caseInsensitive,0|__gfp__~|get");
  assert.equal(buildLineFilterToken("get", { caseSensitive: true }), "caseSensitive,0|__gfp__=|get");
});

test("buildLineFilterToken: empty -> empty string", () => {
  assert.equal(buildLineFilterToken(""), "");
  assert.equal(buildLineFilterToken(undefined), "");
});

test("buildLineFilterToken: plain substring", () => {
  assert.equal(buildLineFilterToken("boom"), "caseInsensitive,0|__gfp__~|boom");
  assert.equal(buildLineFilterToken("boom", { caseSensitive: true }), "caseSensitive,0|__gfp__=|boom");
});

test("buildLineFilterToken: escapes structural delimiters in the value", () => {
  // A `|` or `,` in the text would otherwise be read as a part/filter separator.
  assert.equal(buildLineFilterToken("a|b,c"), "caseInsensitive,0|__gfp__~|a__gfp__b__gfc__c");
  assert.equal(buildLineFilterToken("a|b,c", { caseSensitive: true }), "caseSensitive,0|__gfp__=|a__gfp__b__gfc__c");
});

// ---------------------------------------------------------------------------
// toLokiNs
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000; // fixed epoch ms

test("toLokiNs: empty value falls back to now - fallbackSecondsAgo, in ns", () => {
  assert.equal(toLokiNs("", 3600, NOW), `${(NOW - 3600 * 1000) * 1e6}`);
  assert.equal(toLokiNs(undefined, 0, NOW), `${NOW * 1e6}`);
});

test("toLokiNs: 'now' resolves to now in ns", () => {
  assert.equal(toLokiNs("now", 0, NOW), `${NOW * 1e6}`);
});

test("toLokiNs: 'now-15m' subtracts the relative amount", () => {
  assert.equal(toLokiNs("now-15m", 0, NOW), `${(NOW - 15 * 60000) * 1e6}`);
  assert.equal(toLokiNs("now-2h", 0, NOW), `${(NOW - 2 * 3_600_000) * 1e6}`);
  assert.equal(toLokiNs("now-1d", 0, NOW), `${(NOW - 86_400_000) * 1e6}`);
});

test("toLokiNs: epoch ms passes through (converted to ns)", () => {
  assert.equal(toLokiNs(NOW, 0, NOW), `${NOW * 1e6}`);
  assert.equal(toLokiNs(String(NOW), 0, NOW), `${NOW * 1e6}`);
});

test("toLokiNs: an explicit ISO instant is honoured", () => {
  assert.equal(toLokiNs("2026-08-20T15:00:00Z", 60, NOW), `${Date.parse("2026-08-20T15:00:00Z") * 1e6}`);
  assert.equal(toLokiNs("2026-08-20T15:00:00+02:00", 60, NOW), `${Date.parse("2026-08-20T15:00:00+02:00") * 1e6}`);
});

test("toLokiNs: a timestamp without a timezone is REFUSED, not guessed", () => {
  // Regression: this used to fall back to the default window, so asking about a
  // specific incident window silently reported on the last hour instead. Grafana
  // renders in the browser's timezone while log bodies are UTC, so a bare
  // timestamp is genuinely ambiguous.
  for (const naive of ["2026-08-20T15:00:00", "2026-08-20 15:00:00", "2026-08-20"]) {
    assert.throws(() => toLokiNs(naive, 60, NOW), /has no timezone/, `should refuse ${naive}`);
  }
});

test("toLokiNs: unparseable value is refused rather than silently defaulted", () => {
  assert.throws(() => toLokiNs("garbage", 60, NOW), /unrecognised time/);
  assert.throws(() => toLokiNs("yesterday", 60, NOW), /unrecognised time/);
  // An absent value still means "unspecified" and keeps the caller's default.
  assert.equal(toLokiNs("", 60, NOW), `${(NOW - 60 * 1000) * 1e6}`);
});

test("resolvedWindow: reports the UTC window a relative range resolved to", () => {
  const w = resolvedWindow("now-1h", "now", 3600, NOW);
  assert.equal(w.from_utc, new Date(NOW - 3_600_000).toISOString());
  assert.equal(w.to_utc, new Date(NOW).toISOString());
  assert.equal(w.duration_seconds, 3600);
});

// ---------------------------------------------------------------------------
// coverageVerdict
// ---------------------------------------------------------------------------

test("coverageVerdict: zero bytes scanned is never a negative finding", () => {
  // The whole point: "no logs" and "I looked nowhere" are different answers, and
  // the raw API returns the same empty list for both.
  assert.equal(coverageVerdict({ lineCount: 0, bytesProcessed: 0 }), "NO_DATA_SCANNED");
  assert.equal(coverageVerdict({ lineCount: 0, bytesProcessed: 144752 }), "EMPTY_BUT_SCANNED");
  assert.equal(coverageVerdict({ lineCount: 12, bytesProcessed: 144752 }), "OK");
  assert.equal(coverageVerdict({ lineCount: 100, bytesProcessed: 1, limitReached: true }), "TRUNCATED");
  // Truncation outranks everything: the answer is incomplete whatever else holds.
  assert.equal(coverageVerdict({ lineCount: 100, bytesProcessed: 0, limitReached: true }), "TRUNCATED");
  // No stats at all -> say so rather than implying a trustworthy negative.
  assert.equal(coverageVerdict({ lineCount: 0, bytesProcessed: undefined }), "UNKNOWN");
});

test("summarizeQueryResult: a scanned-but-empty log result is marked trustworthy", () => {
  const empty = logFrame([], {
    stats: [{ displayName: "Summary: total bytes processed", value: 144752 }],
  });
  const out = summarizeQueryResult({ results: { A: { status: 200, frames: [empty] } } });
  assert.equal(out.results.A.line_count, 0);
  assert.equal(out.results.A.coverage, "EMPTY_BUT_SCANNED");
  assert.match(out.results.A.coverage_note, /trustworthy negative/);
});

test("summarizeQueryResult: scanning nothing is flagged, not reported as absence", () => {
  const nothing = logFrame([], { stats: [{ displayName: "Summary: total bytes processed", value: 0 }] });
  const out = summarizeQueryResult({ results: { A: { status: 200, frames: [nothing] } } });
  assert.equal(out.results.A.coverage, "NO_DATA_SCANNED");
  assert.match(out.results.A.coverage_warning, /not a statement about whether the event happened/);
});

test("summarizeQueryResult: a truncated result reports how little of the window it covers", () => {
  // Loki fills the cap walking backwards from the window END. 5 lines spanning
  // 4 seconds of a 1-hour request means the other 59 minutes were never returned,
  // and an absence there is an artifact, not a finding.
  const base = 1700000000000;
  const rows = Array.from({ length: 5 }, (_, i) => ({ labels: NS, time: base + i * 1000, line: `l${i}` }));
  const out = summarizeQueryResult(
    { results: { A: { frames: [logFrame(rows)] } } },
    { limit: 5, window: { start_ms: base - 3_600_000, end_ms: base + 4000 } },
  );
  const r = out.results.A;
  assert.equal(r.coverage, "TRUNCATED");
  assert.equal(r.covered_window.covered_seconds, 4);
  assert.equal(r.covered_window.requested_seconds, 3604);
  assert.match(r.covered_window.warning, /never returned/);
});

test("summarizeQueryResult: no truncation warning when the lines span the window", () => {
  const base = 1700000000000;
  const rows = [
    { labels: NS, time: base, line: "a" },
    { labels: NS, time: base + 3_600_000, line: "b" },
  ];
  const out = summarizeQueryResult(
    { results: { A: { frames: [logFrame(rows)] } } },
    { limit: 2, window: { start_ms: base, end_ms: base + 3_600_000 } },
  );
  assert.equal(out.results.A.covered_window.warning, undefined);
});

// ---------------------------------------------------------------------------
// editDistance
// ---------------------------------------------------------------------------

test("editDistance: basic Levenshtein cases", () => {
  assert.equal(editDistance("", "abc"), 3);
  assert.equal(editDistance("abc", ""), 3);
  assert.equal(editDistance("april", "april"), 0);
  assert.equal(editDistance("aprl", "april"), 1);
  assert.equal(editDistance("kitten", "sitting"), 3);
});

// ---------------------------------------------------------------------------
// rankClientSuggestions
// ---------------------------------------------------------------------------

const VALUES = [
  "graviteeio-ae-april-rec-engine",
  "dev-apim-cloudgate-1ca08d-gateway",
  "graviteeio-ae-alliander-ui",
];

test("rankClientSuggestions: substring matches rank first", () => {
  const out = rankClientSuggestions(VALUES, "april");
  assert.equal(out[0], "graviteeio-ae-april-rec-engine");
});

test("rankClientSuggestions: close typo surfaces via segment edit distance", () => {
  // 'aprl' is edit distance 1 from the 'april' segment.
  const out = rankClientSuggestions(VALUES, "aprl");
  assert.ok(out.includes("graviteeio-ae-april-rec-engine"));
});

test("rankClientSuggestions: empty needle returns nothing", () => {
  assert.deepEqual(rankClientSuggestions(VALUES, ""), []);
});

test("rankClientSuggestions: de-duplicates and caps at 10", () => {
  const many = Array.from({ length: 25 }, (_, i) => `svc-april-${i}`);
  const out = rankClientSuggestions([...many, ...many], "april");
  assert.equal(out.length, 10);
  assert.equal(new Set(out).size, out.length);
});
