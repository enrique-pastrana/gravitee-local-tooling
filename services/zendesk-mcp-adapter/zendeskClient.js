// Zendesk HTTP client: auth, API requests, and attachment download.

export const ENABLED = String(process.env.ZENDESK_ENABLED || "false").toLowerCase() === "true";
export const BASE_URL = (process.env.ZENDESK_BASE_URL || "").replace(/\/+$/, "");
const AUTH_MODE = (process.env.ZENDESK_AUTH_MODE || "oauth").toLowerCase();
const OAUTH_ACCESS_TOKEN = process.env.ZENDESK_OAUTH_ACCESS_TOKEN || "";
const EMAIL = process.env.ZENDESK_EMAIL || "";
const API_TOKEN = process.env.ZENDESK_API_TOKEN || "";
export const TIMEOUT_SECONDS = Number.parseInt(process.env.ZENDESK_TIMEOUT_SECONDS || "15", 10);

export function log(level, message, fields = {}) {
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service: "zendesk-mcp-adapter",
      message,
      ...fields,
    })}\n`,
  );
}

export function requireEnabled() {
  if (!ENABLED) {
    throw new Error("Zendesk is disabled. Set ZENDESK_ENABLED=true in .env and configure ZENDESK_* secrets.");
  }
}

export function requireConfig() {
  requireEnabled();
  if (!BASE_URL) {
    throw new Error("ZENDESK_BASE_URL is required when ZENDESK_ENABLED=true");
  }
  if (AUTH_MODE === "oauth" && !OAUTH_ACCESS_TOKEN) {
    throw new Error("ZENDESK_OAUTH_ACCESS_TOKEN is required for ZENDESK_AUTH_MODE=oauth");
  }
  if (AUTH_MODE === "api-token" && (!EMAIL || !API_TOKEN)) {
    throw new Error("ZENDESK_EMAIL and ZENDESK_API_TOKEN are required for ZENDESK_AUTH_MODE=api-token");
  }
  if (!["oauth", "api-token"].includes(AUTH_MODE)) {
    throw new Error("ZENDESK_AUTH_MODE must be oauth or api-token");
  }
}

export function authHeaders() {
  if (AUTH_MODE === "oauth") {
    return { Authorization: `Bearer ${OAUTH_ACCESS_TOKEN}` };
  }
  const raw = Buffer.from(`${EMAIL}/token:${API_TOKEN}`).toString("base64");
  return { Authorization: `Basic ${raw}` };
}

export function subdomain() {
  try {
    const host = new URL(BASE_URL).hostname;
    return host.split(".")[0] || "unknown";
  } catch (_err) {
    return "unknown";
  }
}

export async function zendeskGet(path, params = {}) {
  requireConfig();
  const query = new URLSearchParams(params);
  const url = `${BASE_URL}${path}${query.size ? `?${query.toString()}` : ""}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_SECONDS * 1000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...authHeaders() },
      signal: controller.signal,
    });
    const bodyText = await res.text();
    let body = {};
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch (_err) {
      body = { raw: bodyText };
    }
    if (!res.ok) {
      const retryAfter = res.headers.get("retry-after");
      const suffix = retryAfter ? `; retry-after=${retryAfter}` : "";
      throw new Error(`Zendesk GET failed with HTTP ${res.status}${suffix}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Validate that a URL is safe to fetch with Zendesk auth headers.
 *
 * Only permits:
 *  - The configured Zendesk base domain (ZENDESK_BASE_URL)
 *  - *.zendesk.com  (Zendesk-hosted attachments / CDN)
 *  - *.zdassets.com (Zendesk static asset CDN)
 *
 * This prevents SSRF: a malicious ticket body cannot trick the adapter into
 * forwarding the Zendesk API token to an attacker-controlled host.
 */
function validateAttachmentUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_err) {
    throw new Error(`Invalid attachment URL: ${url}`);
  }

  const configuredHost = BASE_URL ? new URL(BASE_URL).hostname : null;
  const host = parsed.hostname;

  const allowed =
    (configuredHost && host === configuredHost) ||
    host === "zendesk.com" ||
    host.endsWith(".zendesk.com") ||
    host === "zdassets.com" ||
    host.endsWith(".zdassets.com");

  if (!allowed) {
    throw new Error(
      `Attachment URL host "${host}" is not permitted. Only the configured Zendesk domain and ` +
        "known Zendesk CDN hosts (*.zendesk.com, *.zdassets.com) are allowed.",
    );
  }
}

export async function zendeskDownloadAttachment(contentUrl) {
  requireConfig();
  validateAttachmentUrl(contentUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_SECONDS * 1000);
  try {
    const res = await fetch(contentUrl, {
      method: "GET",
      headers: authHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Zendesk attachment download failed with HTTP ${res.status}`);
    }
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return { base64, contentType };
  } finally {
    clearTimeout(timeout);
  }
}
