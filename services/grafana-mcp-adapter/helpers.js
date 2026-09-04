// Pure helpers shared by server.js. Kept in their own module (no MCP/transport
// side effects) so they can be imported and unit-tested directly.
import { BASE_URL } from "./grafanaClient.js";

// Loki log responses arrive as a `LabeledTimeValues` frame: one row per log
// line, with fields `labels` (object), `Time` (epoch ms), `Line` (string),
// `tsNs`, `labelTypes` and `id`. NONE of those is a `number` field, so the
// numeric digest below skips every one of them — a log query that matched
// thousands of lines would report `series_count: 0`, a false "no results" that
// reads as authoritative. Log frames therefore get their own digest.
const LOG_FRAME_TYPE = "LabeledTimeValues";

function findField(fields, name, type) {
  return fields.findIndex((f) => f?.name === name && (!type || f?.type === type));
}

// A frame is a log frame if Grafana stamped it as such, or — defensively, in
// case that meta is absent — if it carries the `Line` string field that makes
// it one.
export function isLogFrame(frame) {
  if (frame?.schema?.meta?.custom?.frameType === LOG_FRAME_TYPE) return true;
  return findField(frame?.schema?.fields || [], "Line", "string") !== -1;
}

// Loki reports per-query counters in `meta.stats` as a flat list of
// {displayName, value}. `total lines processed` is how many lines Loki read to
// answer the query; it is NOT the number of matches, so it must never be shown
// as a result count. We surface it only as context alongside the real count.
function frameStats(frame) {
  const stats = frame?.schema?.meta?.stats;
  if (!Array.isArray(stats)) return {};
  const value = (name) => stats.find((s) => s?.displayName === name)?.value;
  const out = {
    lines_processed: value("Summary: total lines processed"),
    bytes_processed: value("Summary: total bytes processed"),
    exec_time_seconds: value("Summary: exec time"),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// Collapse log frames to a digest: how many lines matched, over what window,
// from which streams, plus a capped sample of the lines themselves. `limit` is
// the line cap that was requested of Loki — when the returned count reaches it
// the result is partial, and we say so rather than letting the caller read a
// capped page as the whole story.
// Loki returns an empty result for several different reasons, and the raw API
// gives no way to tell them apart — so "no matching logs" gets reported when the
// truth is "I looked in the wrong place". `total bytes processed` separates them:
// zero means the selector matched no stream at all, so nothing was ever scanned.
//   NO_DATA_SCANNED    - looked nowhere. Wrong namespace/selector or window.
//   TRUNCATED          - hit the cap; older matches were never returned.
//   EMPTY_BUT_SCANNED  - a trustworthy negative for this filter and window.
//   OK                 - results, within the cap.
export function coverageVerdict({ lineCount, bytesProcessed, limitReached }) {
  if (limitReached) return "TRUNCATED";
  if (bytesProcessed === 0) return "NO_DATA_SCANNED";
  if (lineCount === 0) return bytesProcessed === undefined ? "UNKNOWN" : "EMPTY_BUT_SCANNED";
  return "OK";
}

function summarizeLogFrames(frames, { maxStreams, maxSampleLines, maxLineChars, limit, window }) {
  const streams = new Map();
  // shape -> { time, line, occurrences }, insertion-ordered, so the example kept
  // is the first (most recent) occurrence of each kind.
  const sampleShapes = new Map();
  const stats = {};
  let lineCount = 0;
  let earliest = null;
  let latest = null;

  for (const frame of frames) {
    const fields = frame?.schema?.fields || [];
    const values = frame?.data?.values || [];
    const lines = values[findField(fields, "Line", "string")] || [];
    const times = values[findField(fields, "Time", "time")] || [];
    const labelSets = values[findField(fields, "labels")] || [];
    Object.assign(stats, frameStats(frame));

    for (let i = 0; i < lines.length; i++) {
      lineCount++;

      const t = Number(times[i]);
      if (Number.isFinite(t)) {
        if (earliest === null || t < earliest) earliest = t;
        if (latest === null || t > latest) latest = t;
      }

      // Group by distinct label set so the caller sees which streams produced
      // the lines (a namespace usually spans several pods/containers).
      const labels = labelSets[i] && typeof labelSets[i] === "object" ? labelSets[i] : {};
      const key = JSON.stringify(Object.entries(labels).sort());
      const entry = streams.get(key);
      if (entry) entry.lines++;
      else streams.set(key, { labels, lines: 1 });

      // Sample by DISTINCT KIND, not by position. Taking the first N lines
      // routinely returned N byte-identical copies of one message — five copies
      // of the same exception says no more than one, while costing five times
      // the customer log content. Grouping by shape shows what KINDS of line are
      // present with a count each, which is strictly more information in less
      // text. The example keeps its own timestamp so it can be handed to
      // grafana_logs_context.
      if (typeof lines[i] === "string") {
        const shape = normaliseLogLine(lines[i]);
        const seen = sampleShapes.get(shape);
        if (seen) {
          seen.occurrences++;
        } else {
          const line = lines[i];
          sampleShapes.set(shape, {
            time: Number.isFinite(t) ? new Date(t).toISOString() : null,
            line: line.length > maxLineChars ? `${line.slice(0, maxLineChars)}…[truncated]` : line,
            occurrences: 1,
          });
        }
      }
    }
  }

  const all = [...streams.values()].sort((a, b) => b.lines - a.lines);
  const kinds = [...sampleShapes.values()].sort((a, b) => b.occurrences - a.occurrences);
  const digest = {
    frame_type: "logs",
    line_count: lineCount,
    time_range: { from: iso(earliest), to: iso(latest) },
    stream_count: all.length,
    streams: all.slice(0, maxStreams),
    streams_truncated: all.length > maxStreams ? all.length - maxStreams : 0,
    // Distinct kinds of line, commonest first, each with how many times it
    // occurred among the lines returned.
    sample_lines: kinds.slice(0, maxSampleLines),
    distinct_line_kinds: kinds.length,
    sample_kinds_truncated: kinds.length > maxSampleLines ? kinds.length - maxSampleLines : 0,
  };
  // Computed over ALL streams, not the reported slice — a sampled stream that
  // fell outside maxStreams is still dropping lines from the counts above.
  const sampling = detectSampling(all);
  if (sampling) digest.adaptive_logs_sampling = sampling;
  if (Object.keys(stats).length) digest.stats = stats;

  const limitReached = Number.isFinite(limit) && lineCount >= limit;
  if (limitReached) {
    digest.limit_reached = true;
    digest.note =
      `Returned ${lineCount} lines, the maximum requested — more lines almost certainly match. ` +
      `Raise max_lines, narrow the time range, or aggregate with count_over_time for a true total.`;

    // Loki fills the cap walking BACKWARDS from the end of the window, so hitting
    // it means the oldest part of the requested range was never looked at. A
    // 1-hour request can return only its last minute, and nothing in the response
    // says so — absence in the unseen part then reads as a finding.
    if (window && earliest !== null && latest !== null) {
      const coveredSeconds = Math.max(0, Math.round((latest - earliest) / 1000));
      const requestedSeconds = Math.max(0, Math.round((window.end_ms - window.start_ms) / 1000));
      digest.covered_window = {
        from: new Date(earliest).toISOString(),
        to: new Date(latest).toISOString(),
        covered_seconds: coveredSeconds,
        requested_seconds: requestedSeconds,
      };
      if (requestedSeconds > 0 && coveredSeconds < requestedSeconds * 0.9) {
        digest.covered_window.warning =
          `These ${lineCount} lines span only ${coveredSeconds}s of the ${requestedSeconds}s requested. ` +
          "Loki fills the cap from the END of the window backwards, so the earlier part of the range was " +
          "never returned — do NOT read an absence here as evidence it did not happen earlier in the window.";
      }
    }
  }

  digest.coverage = coverageVerdict({
    lineCount,
    bytesProcessed: stats.bytes_processed,
    limitReached,
  });
  if (digest.coverage === "NO_DATA_SCANNED") {
    digest.coverage_warning =
      "Loki scanned ZERO bytes: the selector matched no stream at all in this window, so this is not a " +
      "statement about whether the event happened. Check the namespace/labels (grafana_find_customer) and " +
      "the time range before concluding anything.";
  } else if (digest.coverage === "EMPTY_BUT_SCANNED") {
    digest.coverage_note =
      `No matching lines, but Loki scanned ${stats.bytes_processed} bytes — the streams exist and were ` +
      "searched, so this is a trustworthy negative for this filter and window.";
  }
  return digest;
}

// Not every datasource returns timeseries or logs — Elasticsearch raw_data returns
// documents, and other types return tables. Such frames still carry number fields
// (response times, durations), so the numeric path would happily digest them into
// a "series" that means nothing — the same class of silent wrongness as
// reporting 0 for a log frame. Anything not recognised gets a table digest
// instead: row count, the columns and their types, and a small sample. An
// unhandled shape is then visible rather than silently misreported.
function summarizeTableFrames(frames, { maxSampleRows, maxCellChars }) {
  let rowCount = 0;
  const columns = [];
  const sample = [];

  for (const frame of frames) {
    const fields = frame?.schema?.fields || [];
    const values = frame?.data?.values || [];
    const rows = values[0]?.length ?? 0;
    rowCount += rows;
    for (const f of fields) {
      if (!columns.some((c) => c.name === f?.name)) columns.push({ name: f?.name ?? null, type: f?.type ?? null });
    }
    for (let i = 0; i < rows && sample.length < maxSampleRows; i++) {
      const row = {};
      for (let c = 0; c < fields.length; c++) {
        const name = fields[c]?.name;
        if (!name) continue;
        const v = values[c]?.[i];
        // Objects (Tempo's `nested`, ES `_type`) are summarised, not inlined —
        // they can be arbitrarily large.
        if (v && typeof v === "object") {
          row[name] = Array.isArray(v) ? `[${v.length} items]` : "{object}";
        } else if (typeof v === "string" && v.length > maxCellChars) {
          row[name] = `${v.slice(0, maxCellChars)}\u2026[truncated]`;
        } else {
          row[name] = v ?? null;
        }
      }
      sample.push(row);
    }
  }

  return {
    frame_type: "table",
    row_count: rowCount,
    columns,
    sample_rows: sample,
    // Distinct from the log digest's sample_truncated so a result carrying both
    // kinds of frame does not clobber one with the other.
    sample_rows_truncated: rowCount > sample.length ? rowCount - sample.length : 0,
  };
}

// Decide how to digest a frame, from the signals Grafana actually sets (verified
// against this instance):
//   Loki logs        -> meta.custom.frameType = "LabeledTimeValues"
//   Prometheus       -> meta.type = "timeseries-multi", fields Time + number(labels)
//   Loki metrics     -> meta.type = "timeseries-multi"
//   Elasticsearch agg-> meta.type = "timeseries-multi", fields Time + Value
//   Elasticsearch raw-> no meta, many string columns
//   table-shaped     -> preferredVisualisationType = "table", string + number columns
// A string field is the discriminator for the last two: a timeseries frame has a
// time axis and numbers, never string columns.
export function classifyFrame(frame) {
  if (isLogFrame(frame)) return "logs";
  const meta = frame?.schema?.meta || {};
  if (typeof meta.type === "string" && meta.type.startsWith("timeseries")) return "timeseries";
  const fields = frame?.schema?.fields || [];
  if (fields.some((f) => f?.type === "string")) return "table";
  // A frame with no time axis is not a series over time, whatever its column
  // types. Elasticsearch terms aggregations return exactly this: `status` +
  // `Count`, both numeric. Digesting those as series produces min/max/avg OF
  // HTTP STATUS CODES — arithmetic on identifiers, presented as a measurement.
  if (!fields.some((f) => f?.type === "time")) return "table";
  return "timeseries";
}

// The raw /ds/query response is huge (one full timestamp+value array per series,
// and `up` alone can be thousands of series). For MCP use we collapse each
// numeric series to its labels + a digest (count, first/last/min/max/avg), and
// each set of log frames to a line-count/stream/sample digest. The caller can
// always re-query a narrower expression if it needs the full arrays.
export function summarizeQueryResult(
  payload = {},
  { maxSeries = 50, maxSampleLines = 5, maxLineChars = 500, maxSampleRows = 5, maxCellChars = 200, limit, window } = {},
) {
  const out = { results: {} };
  for (const [refId, res] of Object.entries(payload.results || {})) {
    const frames = Array.isArray(res?.frames) ? res.frames : [];
    const logFrames = [];
    const tableFrames = [];
    const seriesFrames = [];
    for (const frame of frames) {
      const kind = classifyFrame(frame);
      if (kind === "logs") logFrames.push(frame);
      else if (kind === "table") tableFrames.push(frame);
      else seriesFrames.push(frame);
    }
    const series = [];

    // Numeric path: wide-format frames -> { "field1": [v1, v2], ... }. Only
    // `number` fields carry series values; time/string/other fields are the
    // axis and metadata. Log frames are excluded — they have no number field
    // and are digested separately below.
    for (const frame of seriesFrames) {
      const fields = frame?.schema?.fields || [];
      for (let idx = 0; idx < fields.length; idx++) {
        if (fields[idx]?.type !== "number") continue;
        const labels = fields[idx]?.labels || {};
        const values = (frame?.data?.values?.[idx] || []).filter((v) => typeof v === "number");
        const count = values.length;
        // Computed in one pass rather than Math.min/max(...values): a wide
        // query can return 100k+ points and spreading that many args throws.
        let min = values[0];
        let max = values[0];
        let sum = 0;
        for (const v of values) {
          if (v < min) min = v;
          if (v > max) max = v;
          sum += v;
        }
        const digest = count
          ? { count, first: values[0], last: values[count - 1], min, max, avg: sum / count }
          : { count: 0 };
        series.push({ labels, ...digest });
      }
    }

    const entry = { status: res?.status ?? null };

    if (logFrames.length) {
      Object.assign(
        entry,
        summarizeLogFrames(logFrames, { maxStreams: maxSeries, maxSampleLines, maxLineChars, limit, window }),
      );
    }

    if (tableFrames.length) {
      Object.assign(entry, summarizeTableFrames(tableFrames, { maxSampleRows, maxCellChars }));
      // Both digests claim frame_type; say so rather than let one win silently.
      if (logFrames.length) entry.frame_type = "logs+table";
    }

    // Emit the numeric keys only when there is a numeric result to describe. On a
    // pure log/table result `series_count: 0` sits next to a real count and reads
    // as "nothing found" — the same misleading zero this digest exists to remove.
    // A query producing several kinds of frame keeps each digest.
    if ((!logFrames.length && !tableFrames.length) || series.length) {
      entry.series_count = series.length;
      entry.series = series.slice(0, maxSeries);
      entry.truncated = series.length > maxSeries ? series.length - maxSeries : 0;
    }

    out.results[refId] = entry;
  }
  return out;
}

// The Loki datasource uid has no safe default. Hardcoding one that happens to be
// right for a single Grafana org is worse than having none: it fails silently
// and plausibly everywhere else. Validated here so the failure is one clear
// message rather than an empty result set.
export function requireDatasourceUid(uid) {
  const value = String(uid ?? "").trim();
  if (!value) {
    throw new Error(
      "GRAFANA_LOGS_DATASOURCE_UID is not set. Set it to the uid of the Loki datasource " +
        "holding your logs (Grafana > Connections > Data sources; the uid is in the page " +
        "URL and is not always the same as the display name), then recreate the container: " +
        "docker compose up -d --force-recreate grafana-mcp-adapter",
    );
  }
  return value;
}

// Escape a free-text fragment for safe use inside a Loki regex matcher.
export function escapeRegex(s = "") {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Environment tokens that name a deployment stage. These are matched as whole
// `service_name` segments, not substrings, so "prod" doesn't also match the
// "prod" inside `nonprod`/`preprod` (a real source of false positives). Any word
// not in this set stays a plain substring (so partial customer names like
// "arcelor" still match "arcelor-mittal").
const ENV_TOKENS = new Set([
  "prod",
  "nonprod",
  "preprod",
  "rec",
  "dev",
  "int",
  "ppr",
  "sandbox",
  "val",
  "qc",
  "qa",
  "test",
  "demo",
  "stage",
  "uat",
  "plt",
]);

// Segment boundary in `service_name` (dash/underscore/dot, or start/end). Used to
// anchor an env token so it matches a whole segment, e.g. `prod` -> `prod-` /
// `-prod-` / `-prod` but not the `prod` inside `nonprod`.
const SEG_START = "(?:^|[-_.])";
const SEG_END = "(?:[-_.]|$)";

// Split a free-text client fragment into the customer "core" (the words that
// name the customer) and the env tokens (prod, stage, ...). The customer core
// is what we match against the `namespace` label — env tokens don't reliably
// live in the namespace (e.g. a customer whose prod namespace is `…-plt-live`),
// so they only ever narrow `service_name`, never the namespace.
//   splitClientEnv("blueyonder prod") -> { core: "blueyonder", envs: ["prod"] }
//   splitClientEnv("equigy")          -> { core: "equigy",     envs: [] }
export function splitClientEnv(client = "") {
  const words = String(client || "").trim().split(/\s+/).filter(Boolean);
  const core = [];
  const envs = [];
  for (const w of words) (ENV_TOKENS.has(w.toLowerCase()) ? envs : core).push(w);
  return { core: core.join(" "), envs };
}

// From the full list of `namespace` label values, pick the ones that belong to
// the customer named by `core`: every (non-env) word of `core` must appear as a
// substring (case-insensitive). Generic, name-agnostic — works for any customer
// that has its own namespace (`april-prod`, `blueyonder-plt-live`, …) and
// returns [] for customers that only live in a shared namespace (`prod`), which
// is the signal to fall back to a `service_name` match.
export function matchNamespaces(namespaceValues = [], core = "") {
  const words = String(core || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return [...new Set(namespaceValues.filter(Boolean))].filter((ns) => {
    const l = ns.toLowerCase();
    return words.every((w) => l.includes(w));
  });
}

// Build a LogQL selector from free-text client/component. Both are matched
// case-insensitively as substrings of `service_name` (which in this instance
// encodes both the customer and the component, e.g.
// `graviteeio-ae-april-rec-engine`, `dev-apim-cloudgate-1ca08d-gateway`).
// `lineFilter` becomes a `|= "..."` line filter on top. When `namespaces` is
// given, the selector is pinned to those namespaces (`namespace=~"a|b"`) — used
// when we've resolved the customer to its own namespace(s) and only need
// `service_name` to narrow by component/env within them.
export function buildLogsQuery({ client, component, lineFilter, namespaces, caseSensitive = false } = {}) {
  if (!client) throw new Error("client is required");
  // Whitespace inside a fragment means "these words, in order, with anything in
  // between" — `service_name` is dash-separated, so a literal space would never
  // match (e.g. "april prod" must become `april.*prod`, not `april prod`). Split
  // each fragment on whitespace; known env words are anchored to a whole segment,
  // everything else stays a plain (escaped) substring, joined with `.*`.
  const toWord = (w) =>
    ENV_TOKENS.has(w.toLowerCase()) ? `${SEG_START}${escapeRegex(w)}${SEG_END}` : escapeRegex(w);
  const toPattern = (s) =>
    String(s)
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(toWord)
      .join(".*");
  const ns = [...new Set((namespaces || []).filter(Boolean))];
  // When the customer is pinned to its own namespace(s), the namespace label
  // already isolates the customer — so `service_name` only needs the env/
  // component words, not the client core (which often isn't even in the
  // service_name for namespace-named customers). Without namespaces we keep the
  // original behaviour: match the client (+component) against service_name.
  const svcSource = ns.length ? splitClientEnv(client).envs.join(" ") : client;
  const parts = [toPattern(svcSource)].filter(Boolean);
  if (component) {
    const c = toPattern(component);
    if (c) parts.push(c);
  }
  const matchers = [];
  if (ns.length) {
    // Pin to the resolved customer namespace(s). Values are exact label values,
    // so anchor each and join with `|` (regex-escaped) for an exact alternation.
    matchers.push(`namespace=~"${ns.map((n) => `^${escapeRegex(n)}$`).join("|")}"`);
  }
  // (?i) = case-insensitive; .* between parts so order/extra segments are fine.
  // Omit the service_name matcher entirely when there's nothing left to narrow
  // by (namespace-pinned with no component/env) — an empty `.*.*` is noise.
  if (parts.length || !ns.length) {
    matchers.push(`service_name=~"(?i).*${parts.join(".*")}.*"`);
  }
  const selector = `{${matchers.join(", ")}}`;
  return lineFilter ? `${selector}${lineFilterExpr(lineFilter, { caseSensitive })}` : selector;
}

// Render a line filter as LogQL.
//
// `|=` is a case-SENSITIVE substring match, and getting the case wrong yields a
// clean, believable empty result — the failure mode this adapter keeps removing,
// in its most deniable form. So the default is case-insensitive: `|~ "(?i)term"`,
// with the term regex-escaped because `|~` takes a pattern, not a literal.
// Callers who know the casing (or want an exact match) can opt back in.
export function lineFilterExpr(lineFilter, { caseSensitive = false } = {}) {
  const text = String(lineFilter).replace(/`/g, "");
  if (!text) return "";
  return caseSensitive ? ` |= \`${text}\`` : ` |~ \`(?i)${escapeRegex(text)}\``;
}

// Build an EXACT LogQL query for one namespace scoped to the precise
// service_name values discovered via /series (not the free-text regex selector).
// Used for the Explore fallback attached to each drilldown link: Explore honours
// the `|=` line filter on load, whereas the Logs Drilldown app leaves a
// pre-filled var-lineFilters in the box without applying it. `=` for a single
// service_name, `=~` alternation (values regex-escaped) for several.
export function buildExactLogsQuery({ namespace, serviceNames = [], lineFilter, caseSensitive = false } = {}) {
  if (!namespace) throw new Error("namespace is required");
  const names = [...new Set((serviceNames || []).filter(Boolean))];
  const matchers = [`namespace="${namespace}"`];
  if (names.length === 1) {
    matchers.push(`service_name="${names[0]}"`);
  } else if (names.length > 1) {
    matchers.push(`service_name=~"${names.map(escapeRegex).join("|")}"`);
  }
  const selector = `{${matchers.join(", ")}}`;
  return lineFilter ? `${selector}${lineFilterExpr(lineFilter, { caseSensitive })}` : selector;
}

// Build a permanent Grafana Explore deep link for a Loki query + time range.
// Grafana 11+ (this instance is 13.x) reads a `panes` param: an object keyed by
// an arbitrary pane id, each holding the datasource, queries and range. The old
// `left=` array form is legacy (<=10) and is intentionally not emitted.
export function buildExploreUrl({ datasourceUid, query, from, to }) {
  const pane = {
    datasource: datasourceUid,
    queries: [{ refId: "A", datasource: { type: "loki", uid: datasourceUid }, expr: query, queryType: "range" }],
    range: { from, to },
  };
  const panes = encodeURIComponent(JSON.stringify({ logs: pane }));
  return `${BASE_URL}/explore?schemaVersion=1&orgId=1&panes=${panes}`;
}

// Build a deep link into the Grafana Logs Drilldown app (plugin
// `grafana-lokiexplore-app`, the "Logs" menu) instead of raw Explore. The app
// navigates per-namespace (`/explore/namespace/{ns}/logs`) and filters by
// individual labels via repeated `var-filters` (`label|operator|value`). We pin
// the namespace and add a `service_name` filter built from the EXACT service
// names matched in that namespace, so the user lands already scoped, then drills
// down by hand in the UI. Params mirror a link produced by the app itself.
//
// Note: this app does NOT evaluate a raw LogQL regex like `(?i).*x.*` in a
// filter value — it treats it as a literal and matches nothing. So we pass exact
// service_name values: one `=` filter for a single value, or a `=~` alternation
// (`a|b`, values regex-escaped) for several.
// The Logs Drilldown app stores committed line filters in the `var-lineFilters`
// ad-hoc variable as `key|operator|value`, NOT as the LogQL `|= "..."`. The app
// escapes the structural delimiters inside each part — `|` -> `__gfp__` and
// `,` -> `__gfc__` — because it uses `|` to separate parts and `,` to separate
// filters/labels (see grafana/logs-drilldown src/services/extensions/links.ts).
//   key      = `caseSensitive,<index>` (or `caseInsensitive` for a `(?i)` regex)
//   operator = the LogQL line-filter op with its pipe escaped: `|=` -> `__gfp__=`
//   value    = the raw substring, delimiters escaped
// We emit a single case-sensitive `|=` (contains) filter at index 0. Returning
// the literal `caseSensitive,0,match,<text>` form (a guess) leaves the field
// empty — this is the format the app itself round-trips.
const GFP = (s) => String(s).replace(/\|/g, "__gfp__").replace(/,/g, "__gfc__");

// Case-insensitive uses the app's `caseInsensitive` key with the regex operator
// `|~`; case-sensitive uses `caseSensitive` with `|=`. Both verified against the
// live app on data containing "GET": the token below with `get` returned 281
// lines case-insensitively and 0 case-sensitively, so the key genuinely drives
// matching rather than only labelling the input box.
export function buildLineFilterToken(text, { caseSensitive = false } = {}) {
  if (!text) return "";
  // key | operator | value, each part delimiter-escaped.
  return caseSensitive
    ? `caseSensitive,0|${GFP("|=")}|${GFP(text)}`
    : `caseInsensitive,0|${GFP("|~")}|${GFP(text)}`;
}

export function buildDrilldownUrl({ namespace, serviceNames = [], datasourceUid, from, to, lineFilter, caseSensitive = false } = {}) {
  if (!namespace) throw new Error("namespace is required");
  // No default: a uid that is merely plausible produces a link that loads and
  // silently shows the wrong (or no) data. Callers pass the configured uid.
  if (!datasourceUid) throw new Error("datasourceUid is required");
  const names = [...new Set((serviceNames || []).filter(Boolean))];
  const p = new URLSearchParams();
  p.set("patterns", "[]");
  p.set("from", from);
  p.set("to", to);
  p.set("var-lineFormat", "");
  p.set("var-ds", datasourceUid);
  // Each filter is `key|operator|value`; the app splits on `|`, so a pipe INSIDE
  // any part must be escaped as `__gfp__` (and a comma as `__gfc__`).
  //
  // A `=~` alternation does NOT work here, however it is escaped. Verified against
  // the live app: it treats a filter value as a LITERAL and regex-escapes it when
  // building the query, so `a|b` is sent to Loki as `service_name=~"a\\|b"` — a
  // literal pipe, matching nothing. That is the real bug behind the malformed
  // multi-service links: they matched zero lines, not merely the wrong ones.
  //
  // The app's own multi-value operator (`=|`, written `=__gfp__`, values joined by
  // `,`) does work — but only up to two values. With three or more the app
  // silently rewrites the URL down to the first two, consistently and regardless
  // of settle time (verified 1->1, 2->2, 3->2, 5->2). Emitting more would look
  // precise while quietly dropping services.
  //
  // So: pin the exact service_name when there is exactly one, and otherwise scope
  // the link to the namespace alone. Namespace-only is broader but never wrong,
  // and the caller still gets the exact set via `service_names` plus an
  // `explore_url` that carries the full LogQL.
  p.append("var-filters", `namespace|=|${GFP(namespace)}`);
  if (names.length === 1) {
    p.append("var-filters", `service_name|=|${GFP(names[0])}`);
  }
  for (const k of [
    "var-fields",
    "var-levels",
    "var-metadata",
    "var-jsonFields",
    "var-patterns",
    "var-lineFilterV2",
    "var-lineFilters",
    "var-all-fields",
  ]) {
    p.set(k, "");
  }
  // Apply the line filter to the committed filters var. The in-progress single
  // filter (`var-lineFilterV2`) stays empty — that's what the app's own deep
  // links do; committed filters live in `var-lineFilters`.
  if (lineFilter) p.set("var-lineFilters", buildLineFilterToken(lineFilter, { caseSensitive }));
  p.set("timezone", "browser");
  p.set("urlColumns", "[]");
  p.set("visualizationType", '"logs"');
  p.set("displayedFields", "[]");
  p.set("userDisplayedFields", "false");
  p.set("sortOrder", '"Descending"');
  p.set("wrapLogMessage", "false");
  p.set("prettifyLogMessage", "false");
  return `${BASE_URL}/a/grafana-lokiexplore-app/explore/namespace/${encodeURIComponent(namespace)}/logs?${p.toString()}`;
}

// An ISO 8601 timestamp is only unambiguous with an explicit offset.
const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const LOOKS_LIKE_DATE = /^\d{4}-\d{2}-\d{2}/;

// Resolve Grafana-style relative ranges ("now-15m") to ns epoch for Loki's
// query_range. Absolute epoch-ms values pass through, and ISO 8601 is accepted
// ONLY with an explicit offset.
//
// This used to fall back to the default window for anything it could not parse,
// which meant `2026-08-20T15:00:00Z` — a perfectly explicit instant — silently
// became "the last hour". A caller investigating a specific incident window got
// a confident answer about entirely different data. A naive timestamp is worse
// still: Grafana renders in the browser's timezone while log bodies are UTC, so
// "15:26" means two different instants depending on who is reading. Both are now
// refused loudly instead of guessed at.
export function toLokiNs(value, fallbackSecondsAgo, now = Date.now()) {
  if (value === undefined || value === null || value === "") return `${(now - fallbackSecondsAgo * 1000) * 1e6}`;
  const raw = String(value).trim();

  const m = /^now(?:-(\d+)([smhd]))?$/.exec(raw);
  if (m) {
    if (!m[1]) return `${now * 1e6}`;
    const n = Number(m[1]);
    const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
    return `${(now - n * unit) * 1e6}`;
  }

  if (/^\d+$/.test(raw)) {
    // Loki reports per-line timestamps in NANOseconds (~19 digits). Epoch ms is
    // ~13. Treating a ns value as ms lands in the year 58000 and silently
    // queries an empty future window, so the two are distinguished by width.
    return raw.length >= 16 ? raw : `${Number(raw) * 1e6}`;
  }

  if (LOOKS_LIKE_DATE.test(raw)) {
    if (!EXPLICIT_OFFSET.test(raw)) {
      throw new Error(
        `timestamp "${raw}" has no timezone. Grafana displays in the browser's local timezone while log ` +
          "bodies are UTC, so a bare timestamp is ambiguous and would silently select the wrong window. " +
          'Add an explicit offset, e.g. "' + raw.replace(" ", "T") + 'Z" for UTC.',
      );
    }
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) throw new Error(`timestamp "${raw}" could not be parsed as ISO 8601`);
    return `${ms * 1e6}`;
  }

  throw new Error(
    `unrecognised time "${raw}": use "now", a relative range like "now-15m", epoch milliseconds, or ` +
      'ISO 8601 with an explicit offset ("2026-08-20T15:00:00Z")',
  );
}

// Echo the window a query actually ran over. The caller asked in one vocabulary
// ("now-24h"); this is what it resolved to, in UTC, so a wrong window is visible
// in the answer rather than inferred from surprise at the results.
export function resolvedWindow(from, to, fallbackSecondsAgo, now = Date.now()) {
  const startMs = Number(toLokiNs(from, fallbackSecondsAgo, now)) / 1e6;
  const endMs = Number(toLokiNs(to, 0, now)) / 1e6;
  return {
    from_utc: new Date(startMs).toISOString(),
    to_utc: new Date(endMs).toISOString(),
    duration_seconds: Math.round((endMs - startMs) / 1000),
    start_ms: startMs,
    end_ms: endMs,
  };
}

// --------------------------------------------------------------------------
// Trend + pattern helpers
// --------------------------------------------------------------------------

const DURATION_UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

export function durationSeconds(value) {
  const m = /^(\d+)([smhd])$/.exec(String(value ?? "").trim());
  if (!m) throw new Error(`invalid interval "${value}": use forms like 30s, 5m, 1h, 1d`);
  return Number(m[1]) * DURATION_UNITS[m[2]];
}

// Pick a bucket size giving a readable number of buckets for the range asked for.
// "When did this start?" is answered by shape, not resolution: 48 buckets over a
// day is legible, 1440 one-minute buckets is a wall of numbers that costs tokens
// and hides the onset.
const INTERVAL_CANDIDATES = ["1m", "5m", "15m", "30m", "1h", "3h", "6h", "12h", "1d"];

export function chooseInterval(rangeSeconds, { maxBuckets = 48 } = {}) {
  for (const candidate of INTERVAL_CANDIDATES) {
    if (rangeSeconds / durationSeconds(candidate) <= maxBuckets) return candidate;
  }
  return INTERVAL_CANDIDATES[INTERVAL_CANDIDATES.length - 1];
}

// Loki omits empty steps, so a sparse result cannot be read as a shape — a gap
// and a zero look identical. Fill the grid so the series is continuous, which is
// what makes an onset visible.
export function buildTrendBuckets(points = [], { startSeconds, endSeconds, stepSeconds, maxBuckets = 400 }) {
  const counts = new Map();
  for (const point of points) {
    const t = Number(point?.[0]);
    const v = Number(point?.[1]);
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    // Snap to the grid rather than trusting Loki's alignment to match ours.
    const slot = Math.floor(t / stepSeconds) * stepSeconds;
    counts.set(slot, (counts.get(slot) || 0) + v);
  }
  const first = Math.floor(startSeconds / stepSeconds) * stepSeconds;
  const buckets = [];
  for (let t = first; t <= endSeconds && buckets.length < maxBuckets; t += stepSeconds) {
    buckets.push({ time: new Date(t * 1000).toISOString(), count: counts.get(t) || 0 });
  }
  return buckets;
}

// Reduce a filled series to the things the question is actually about: how much,
// when it started, and when it was worst.
export function summarizeTrend(buckets = []) {
  let total = 0;
  let peak = null;
  let onset = null;
  let last = null;
  for (const b of buckets) {
    total += b.count;
    if (b.count > 0) {
      if (onset === null) onset = b.time;
      last = b.time;
      if (!peak || b.count > peak.count) peak = { time: b.time, count: b.count };
    }
  }
  return { total, onset, last_seen: last, peak };
}

// Loki's /patterns returns one entry per detected pattern with [second, count]
// samples. Collapse to a ranked table.
//
// `lines_in_patterns` is the number of lines Loki ASSIGNED to a pattern, which is
// not the total number of lines in the range — unpatterned lines are absent. It is
// named for what it is so it cannot be read as a line count.
export function summarizePatterns(data = [], { maxPatterns = 20 } = {}) {
  const rows = [];
  let covered = 0;
  for (const entry of data) {
    const samples = Array.isArray(entry?.samples) ? entry.samples : [];
    let count = 0;
    let first = null;
    let last = null;
    for (const sample of samples) {
      const t = Number(sample?.[0]);
      const n = Number(sample?.[1]) || 0;
      if (!n) continue;
      count += n;
      if (Number.isFinite(t)) {
        if (first === null || t < first) first = t;
        if (last === null || t > last) last = t;
      }
    }
    if (!count) continue;
    covered += count;
    rows.push({
      pattern: entry?.pattern ?? null,
      level: entry?.level ?? null,
      count,
      first_seen: first === null ? null : new Date(first * 1000).toISOString(),
      last_seen: last === null ? null : new Date(last * 1000).toISOString(),
    });
  }
  rows.sort((a, b) => b.count - a.count);
  return {
    lines_in_patterns: covered,
    pattern_count: rows.length,
    // Loki's pattern detection has a volume floor: rare lines are not assigned a
    // pattern at all and are simply absent. Reporting the smallest pattern we got
    // back tells the caller, empirically, roughly what could be missing — a 1-line
    // exception will not be in here.
    smallest_pattern_count: rows.length ? rows[rows.length - 1].count : null,
    patterns: rows.slice(0, maxPatterns),
    patterns_truncated: rows.length > maxPatterns ? rows.length - maxPatterns : 0,
  };
}

// Flatten Loki's per-stream query_range response into ONE time-ordered sequence.
//
// Order is the whole point. A logger formatting with `\n` emits SEPARATE Loki
// entries: the first carries the searchable text, the second carries the actual
// reason and contains none of the filter's keywords. Stack traces and
// `Caused by:` chains behave the same way. Reading them in order, unfiltered, is
// the only way to see the detail a filtered query structurally hides.
export function mergeContextStreams(result = [], { maxLines = 200, maxLineChars = 2000 } = {}) {
  const rows = [];
  for (const stream of result) {
    const labels = stream?.stream || {};
    for (const [ts, line] of stream?.values || []) {
      const ns = Number(ts);
      if (!Number.isFinite(ns)) continue;
      rows.push({
        time: new Date(ns / 1e6).toISOString(),
        ts_ns: String(ts),
        service_name: labels.service_name ?? null,
        pod: labels.pod ?? null,
        line: typeof line === "string" && line.length > maxLineChars ? `${line.slice(0, maxLineChars)}…[truncated]` : line,
        _sort: ns,
      });
    }
  }
  rows.sort((a, b) => a._sort - b._sort);
  const total = rows.length;
  return {
    lines: rows.slice(0, maxLines).map(({ _sort, ...r }) => r),
    total,
    truncated: total > maxLines ? total - maxLines : 0,
  };
}

// --------------------------------------------------------------------------
// Noise profiling
// --------------------------------------------------------------------------

// Reduce a log line to its SHAPE, so lines that differ only in their variable
// parts count as one thing. Rules are ordered: the specific ones must run before
// the general ones, or a timestamp gets eaten by the number rule and two
// different shapes collapse into one.
//
// Designed against real lines from this instance — Java stack frames, "... 193
// common frames omitted", thread names carrying a counter, and Foo.java:5377.
const NOISE_RULES = [
  // A stack frame is pure noise: every frame differs by class, and keeping them
  // apart turns one exception into fifty "distinct" shapes.
  [/^\s*at [\w$.]+\(.*\)\s*$/, "at <stack frame>"],
  [/\.\.\.\s+\d+\s+common frames omitted/g, "... <n> common frames omitted"],
  // Timestamps, in the forms this instance actually emits.
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>"],
  [/\d{1,2}\/[A-Za-z]{3}\/\d{4}(?::\d{2}:\d{2}:\d{2})?/g, "<ts>"],
  [/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, "<ts>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/(?:::ffff:)?\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<ip>"],
  [/\b[0-9a-f]{8,}\b/gi, "<hex>"],
  [/\b\d+\b/g, "<n>"],
];

export function normaliseLogLine(line = "") {
  let s = String(line);
  for (const [re, replacement] of NOISE_RULES) {
    if (re.source.startsWith("^")) {
      if (re.test(s)) return replacement;
    } else {
      s = s.replace(re, replacement);
    }
  }
  return s.replace(/\s+/g, " ").trim();
}

// A ready-to-paste LogQL fragment that removes a shape from a query. The longest
// run of text carrying no placeholder is the most specific thing stable across
// every occurrence of that shape.
//
// Stack frames are special-cased: their only literal is "at", which is far too
// short to exclude on, yet they are the commonest thing anyone wants gone — so
// they get a line-start regex instead.
export function suggestExclusion(shape = "") {
  if (shape === "at <stack frame>") return '!~ `^\\s+at `';
  const literals = String(shape)
    .split(/<[a-z ]+>/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
  if (!literals.length) return null;
  const longest = literals.sort((a, b) => b.length - a.length)[0];
  // Backticks would terminate the LogQL string literal.
  return `!= \`${longest.replace(/`/g, "")}\``;
}

// Count shapes across a sample. Percentages describe THE SAMPLE, never the whole
// window: Loki fills a limit backwards from the window end, so a sample is both
// capped and time-biased. The caller is told what the sample actually covered so
// the numbers are not read as a property of the range asked for.
export function profileNoise(lines = [], { maxShapes = 10, dominantPct = 40 } = {}) {
  const counts = new Map();
  for (const line of lines) {
    if (typeof line !== "string") continue;
    const shape = normaliseLogLine(line);
    if (!shape) continue;
    const seen = counts.get(shape);
    if (seen) seen.count++;
    else counts.set(shape, { shape, count: 1, example: line.length > 300 ? `${line.slice(0, 300)}…` : line });
  }
  const sampled = [...counts.values()].reduce((n, s) => n + s.count, 0);
  const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
  const shapes = ranked.slice(0, maxShapes).map((s) => ({
    shape: s.shape,
    count: s.count,
    percent_of_sample: sampled ? Math.round((s.count / sampled) * 1000) / 10 : 0,
    example: s.example,
    ...(sampled && (s.count / sampled) * 100 >= dominantPct
      ? { dominant: true, suggested_exclusion: suggestExclusion(s.shape) }
      : {}),
  }));
  return {
    sampled_lines: sampled,
    distinct_shapes: ranked.length,
    shapes,
    shapes_truncated: ranked.length > maxShapes ? ranked.length - maxShapes : 0,
  };
}

// Classic Levenshtein edit distance (small strings; fine for label matching).
export function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

// Rank candidate service_name values against a free-text needle: substring
// containment first, then best (lowest) edit distance to any dash/underscore/dot
// segment. Pulled out of suggestClients so the ranking is testable without Loki.
export function rankClientSuggestions(values = [], client = "") {
  const needle = String(client || "").toLowerCase();
  if (!needle) return [];
  const scored = values
    .map((v) => {
      const lv = v.toLowerCase();
      const segments = lv.split(/[-_.]/).filter(Boolean);
      const contains = lv.includes(needle);
      const bestDist = Math.min(...segments.map((seg) => editDistance(needle, seg)), needle.length);
      return { v, contains, bestDist };
    })
    // Keep substring hits, or close typos (edit distance <= ~1/3 of the word).
    .filter((x) => x.contains || x.bestDist <= Math.max(1, Math.ceil(needle.length / 3)))
    .sort((a, b) => Number(b.contains) - Number(a.contains) || a.bestDist - b.bestDist);
  return [...new Set(scored.map((x) => x.v))].slice(0, 10);
}

// ---------------------------------------------------------------------------
// HTTP request logs
// ---------------------------------------------------------------------------

// Where a customer's HTTP request logs actually live.
//
// This is the single most costly gap the adapter had. Every customer-scoped tool
// resolves `client` to the customer's OWN namespaces (`acme-prod`,
// `apim-dp-<cp>-<dp>`), and those namespaces hold application logs only. The
// access logs — status code, request duration, upstream response time — are
// emitted by the shared ingress controller, which runs in the `ingress-nginx`
// namespace and is identified by the CLUSTER label. No namespace-scoped query
// can ever reach them.
//
// The consequence is not a missing feature but a wrong answer: an investigation
// asks "is the Management API slow for this customer", every namespace-scoped
// probe comes back empty, and the empty results read as evidence that the data
// does not exist. It does exist, one label away.
export const INGRESS_JOB = "flow/ingress-nginx-ingress-nginx";

// The ingress access-log line, as Loki's `pattern` parser.
//
// Verified against live lines on both cluster kinds. `pattern` is used rather
// than the fifteen-group `regexp` this is usually written with: it is markedly
// cheaper (no backtracking), and it is readable enough that the next person can
// see what is being extracted. `<_>` discards a field without naming it, so only
// the fields worth filtering or reporting on become labels — naming all fifteen
// would put the remote address and referer into every series key.
//
// Fields kept: method, path, status, user_agent, request_time, upstream,
// upstream_time, upstream_status.
//
// upstream_time earns its place: the gap between it and request_time is where
// the time actually went (backend versus ingress or client), and on a client
// timeout it is the only number that says how long the backend had got to. So
// does upstream_status, which is `-` exactly when the client hung up before the
// backend answered — the signature of a 499.
//
// The trailing `<_>` absorbs everything after upstream_status, which differs
// between clusters (some append scheme and forwarded addresses, some stop at the
// request id) — anchoring past it would silently match nothing on half the
// estate. Verified both shapes: this pattern and one truncated at `[<upstream>]`
// match exactly the same lines, so the extra fields cost no coverage.
export const NGINX_PATTERN =
  '<_> - <_> [<_>] "<method> <path> <_>" <status> <_> "<_>" "<user_agent>" <_> <request_time> ' +
  "[<upstream>] <_> <_> <_> <upstream_time> <upstream_status> <_>";

// Grafana Adaptive Logs marks a sampled stream with this label. Its presence
// means lines were DISCARDED before reaching Loki.
export const ADAPTIVE_LOGS_LABEL = "__adaptive_logs_sampled__";

// Translate a status filter into a LogQL label matcher.
// Accepts a code (`499`), a class (`5xx`), or a comma/space separated list of
// either. Label matchers are fully anchored in LogQL, so `5..` matches exactly a
// three-digit 5xx and cannot spill into other fields.
export function statusFilterExpr(statusFilter) {
  const terms = String(statusFilter || "")
    .split(/[,\s]+/)
    .filter(Boolean);
  if (!terms.length) return "";
  const patterns = terms.map((term) => {
    const klass = /^([1-5])xx$/i.exec(term);
    if (klass) return `${klass[1]}..`;
    if (/^[1-5]\d{2}$/.test(term)) return term;
    throw new Error(
      `Unrecognised status_filter "${term}". Use a status code (499), a class (5xx), or a list ("499, 5xx").`,
    );
  });
  return ` | status =~ \`${patterns.join("|")}\``;
}

// Build the LogQL for ingress access logs on one cluster.
//
// `upstreamNamespaces` scopes the result to one customer. It is REQUIRED on a
// cluster that hosts more than one tenant and pointless on a dedicated one, so
// the caller decides — see resolveIngressScope in server.js, which decides from
// what is actually deployed on the cluster rather than from a naming convention.
export function buildIngressQuery({
  cluster,
  upstreamNamespaces = [],
  pathFilter,
  statusFilter,
  method,
  minDurationSeconds,
} = {}) {
  if (!cluster) throw new Error("cluster is required");
  const ns = [...new Set((upstreamNamespaces || []).filter(Boolean))];
  const alternation = ns.map((n) => escapeRegex(n)).join("|");

  const parts = [`{cluster=\`${cluster}\`, job=\`${INGRESS_JOB}\`}`];
  // A line filter runs on raw bytes, before the parser, so this cuts the volume
  // the pattern parser has to touch. It is an optimisation only — the authority
  // is the `upstream` matcher below, which cannot be fooled by the namespace
  // name appearing somewhere else in the line.
  if (ns.length) parts.push(` |~ \`\\[(${alternation})-\``);
  parts.push(` | pattern \`${NGINX_PATTERN}\``);
  if (ns.length) parts.push(` | upstream =~ \`(${alternation})-.*\``);
  if (method) parts.push(` | method = \`${String(method).toUpperCase()}\``);
  if (statusFilter) parts.push(statusFilterExpr(statusFilter));
  // Case-insensitive for the same reason line filters are: a wrong-case path
  // fragment returns a clean, believable, empty result.
  if (pathFilter) parts.push(` | path =~ \`(?i).*${escapeRegex(pathFilter)}.*\``);
  if (Number.isFinite(minDurationSeconds) && minDurationSeconds > 0) {
    parts.push(` | request_time > ${minDurationSeconds}`);
  }
  return parts.join("");
}

// Report that Adaptive Logs is discarding lines from these streams.
//
// The label is already on every stream Loki returns; nothing read it, so a
// sampled stream was indistinguishable from a complete one. That matters most
// exactly where it is least visible: a stack trace arrives as separate Loki
// entries, so sampling can keep the exception header and drop its frames,
// producing a truncated trace that reads as "the log is incomplete" rather than
// "these lines were deliberately discarded, and an exemption can be requested".
export function detectSampling(streams = []) {
  const values = new Set();
  let sampled = 0;
  for (const s of streams) {
    const v = s?.labels?.[ADAPTIVE_LOGS_LABEL];
    if (v !== undefined && v !== null && String(v) !== "") {
      sampled++;
      values.add(String(v));
    }
  }
  if (!sampled) return null;
  return {
    sampled_streams: sampled,
    total_streams: streams.length,
    label_values: [...values].sort(),
    warning:
      `Grafana Adaptive Logs is sampling ${sampled} of ${streams.length} matched streams ` +
      `(${ADAPTIVE_LOGS_LABEL} = ${[...values].sort().join(", ")}), so lines were discarded before they ` +
      "reached Loki. Counts from this stream are LOWER BOUNDS, not totals. Multi-line content is affected " +
      "worst: an exception header can survive while its stack frames are dropped, which looks like a " +
      "truncated log rather than a sampling rule. A per-cluster/job exemption can be requested from the " +
      "Platform team.",
  };
}

// Describe what a query did and did not search.
//
// Derived from the selector actually sent, not from the caller's intent, so it
// cannot drift out of step with it. The point is narrow: a negative from a
// customer-scoped query and a negative from a cluster-wide one are reported
// identically today, and the difference between them is entire categories of
// infrastructure. Stating the scope alongside the verdict makes the premise
// visible at the moment it is being relied on, instead of leaving every caller
// to remember that `client` means "application logs only".
export function scopeNote(query = "") {
  const q = String(query || "");
  const namespaceScoped = /(^|[{,\s])namespace\s*=~?/.test(q);
  const clusterScoped = /(^|[{,\s])cluster\s*=~?/.test(q);
  if (clusterScoped) {
    return (
      "Scoped to the whole cluster, so shared infrastructure IS included — and on a multi-tenant cluster " +
      "that means other customers' traffic unless the query narrows it further."
    );
  }
  if (namespaceScoped) {
    return (
      "Scoped to customer namespaces: APPLICATION logs only. Shared cluster infrastructure was NOT " +
      "searched — ingress-nginx, cert-manager and other cluster-level namespaces are outside this scope. " +
      "HTTP request logs (status codes, request durations, upstream response times) live in the ingress " +
      "namespace and are NOT covered here; use grafana_http_requests for those."
    );
  }
  return null;
}
