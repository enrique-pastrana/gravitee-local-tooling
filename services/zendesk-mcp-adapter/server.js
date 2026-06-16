import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ENABLED,
  BASE_URL,
  log,
  requireConfig,
  subdomain,
  zendeskGet,
  zendeskDownloadAttachment,
} from "./zendeskClient.js";
import { extractFormalAttachments, extractInlineImages, decodeAsText } from "./attachments.js";

const PAGE_SIZE = Number.parseInt(process.env.ZENDESK_PAGE_SIZE || "50", 10);
const VDB_API_URL = (process.env.VDB_API_URL || "http://vectordb-api:8000").replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

async function vdbPost(path, payload) {
  const res = await fetch(`${VDB_API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const bodyText = await res.text();
  let body = {};
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch (_err) {
    body = { raw: bodyText };
  }
  if (!res.ok) {
    throw new Error(`vectordb ingest failed with HTTP ${res.status}`);
  }
  return body;
}

async function getTicket(ticketId) {
  const payload = await zendeskGet(`/api/v2/tickets/${encodeURIComponent(ticketId)}.json`);
  return payload.ticket;
}

async function getTicketComments(ticketId) {
  const payload = await zendeskGet(`/api/v2/tickets/${encodeURIComponent(ticketId)}/comments.json`);
  return payload.comments || [];
}

function ticketUrl(ticket) {
  if (!ticket || !ticket.id) return "";
  return `${BASE_URL}/agent/tickets/${ticket.id}`;
}

function ticketText(ticket, comments) {
  const parts = [
    `Ticket ${ticket.id}: ${ticket.subject || ""}`,
    "",
    "Description:",
    ticket.description || "",
    "",
    "Comments:",
  ];
  for (const comment of comments) {
    const body = comment.plain_body || comment.body || "";
    if (!body.trim()) continue;
    parts.push(`Comment ${comment.id || ""} by ${comment.author_id || "unknown"} (${comment.created_at || "unknown"}):`);
    parts.push(body);
    parts.push("");
  }
  return parts.join("\n").trim();
}

function ticketMetadata(ticket, query, comments) {
  return {
    kind: "zendesk-ticket",
    ticket_id: ticket.id,
    url: ticketUrl(ticket),
    status: ticket.status || null,
    priority: ticket.priority || null,
    tags: ticket.tags || [],
    requester_id: ticket.requester_id || null,
    organization_id: ticket.organization_id || null,
    created_at: ticket.created_at || null,
    updated_at: ticket.updated_at || null,
    indexed_at: new Date().toISOString(),
    query: query || null,
    comment_count: comments.length,
  };
}

async function ingestTicket(ticketId, query = "") {
  const ticket = await getTicket(ticketId);
  if (!ticket) throw new Error(`Zendesk ticket not found: ${ticketId}`);
  const comments = await getTicketComments(ticketId);
  const text = ticketText(ticket, comments);
  if (!text) throw new Error(`Zendesk ticket has no indexable text: ${ticketId}`);
  const payload = {
    source: `zendesk/${subdomain()}`,
    path: `tickets/${ticket.id}`,
    text,
    metadata: ticketMetadata(ticket, query, comments),
    chunk_size: 1200,
    chunk_overlap: 200,
  };
  const response = await vdbPost("/ingest", payload);
  return { ticket_id: ticket.id, source: payload.source, path: payload.path, ingest_response: response };
}

async function searchTickets(query, limit = PAGE_SIZE) {
  const payload = await zendeskGet("/api/v2/search.json", {
    query,
    per_page: String(Math.min(Math.max(limit, 1), PAGE_SIZE)),
  });
  const results = (payload.results || []).filter((item) => item.id && (item.result_type || "ticket") === "ticket");
  return { count: payload.count, next_page: payload.next_page, results: results.slice(0, limit) };
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
  name: "zendesk-mcp-adapter",
  version: "0.1.0",
});

server.tool("zendesk_health", "Read-only Zendesk health/config check.", {}, async () =>
  withToolLogging("zendesk_health", {}, async () => {
    requireConfig();
    const me = await zendeskGet("/api/v2/users/me.json");
    return textResult({
      status: "ok",
      enabled: ENABLED,
      base_url: BASE_URL,
      user_id: me.user ? me.user.id : null,
    });
  }),
);

server.tool(
  "zendesk_search_tickets",
  "Read-only search for Zendesk Support tickets.",
  {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).default(10),
  },
  async ({ query, limit = 10 }) =>
    withToolLogging("zendesk_search_tickets", { query_len: query.length, limit }, async () =>
      textResult(await searchTickets(query, limit)),
    ),
);

server.tool(
  "zendesk_get_ticket",
  "Read-only fetch of a Zendesk Support ticket.",
  { ticket_id: z.union([z.string(), z.number()]) },
  async ({ ticket_id }) =>
    withToolLogging("zendesk_get_ticket", { ticket_id: String(ticket_id) }, async () =>
      textResult(await getTicket(String(ticket_id))),
    ),
);

server.tool(
  "zendesk_get_ticket_comments",
  "Read-only fetch of Zendesk Support ticket comments.",
  { ticket_id: z.union([z.string(), z.number()]) },
  async ({ ticket_id }) =>
    withToolLogging("zendesk_get_ticket_comments", { ticket_id: String(ticket_id) }, async () =>
      textResult(await getTicketComments(String(ticket_id))),
    ),
);

server.tool(
  "zendesk_get_user",
  "Read-only fetch of a Zendesk user.",
  { user_id: z.union([z.string(), z.number()]) },
  async ({ user_id }) =>
    withToolLogging("zendesk_get_user", { user_id: String(user_id) }, async () => {
      const payload = await zendeskGet(`/api/v2/users/${encodeURIComponent(String(user_id))}.json`);
      return textResult(payload.user || payload);
    }),
);

server.tool(
  "zendesk_get_organization",
  "Read-only fetch of a Zendesk organization.",
  { organization_id: z.union([z.string(), z.number()]) },
  async ({ organization_id }) =>
    withToolLogging("zendesk_get_organization", { organization_id: String(organization_id) }, async () => {
      const payload = await zendeskGet(`/api/v2/organizations/${encodeURIComponent(String(organization_id))}.json`);
      return textResult(payload.organization || payload);
    }),
);

server.tool(
  "zendesk_get_ticket_attachments",
  "Read-only list of all attachments (images, files) found in a Zendesk ticket's comments. " +
    "Returns both formal attachments (uploaded files) and inline images pasted directly in comment bodies.",
  { ticket_id: z.union([z.string(), z.number()]) },
  async ({ ticket_id }) =>
    withToolLogging("zendesk_get_ticket_attachments", { ticket_id: String(ticket_id) }, async () => {
      const comments = await getTicketComments(String(ticket_id));
      const formal = extractFormalAttachments(comments);
      const inline = extractInlineImages(comments);
      const all = [...formal, ...inline];
      return textResult({
        ticket_id: String(ticket_id),
        count: all.length,
        formal_count: formal.length,
        inline_count: inline.length,
        attachments: all,
      });
    }),
);

server.tool(
  "zendesk_get_attachment",
  "Download a single Zendesk ticket attachment and return it as base64-encoded content. " +
    "Use zendesk_get_ticket_attachments first to list available attachments and get their content_url. " +
    "Images (PNG, JPEG, GIF, WEBP) are returned as MCP image blocks for native visual analysis. " +
    "Text files (JSON, YAML, logs) are returned as decoded text.",
  {
    content_url: z.string().url(),
    file_name: z.string().optional(),
    content_type: z.string().optional(),
  },
  async ({ content_url, file_name = "", content_type = "" }) =>
    withToolLogging("zendesk_get_attachment", { content_url, file_name }, async () => {
      const { base64, contentType: resolvedContentType } = await zendeskDownloadAttachment(content_url);
      const finalContentType = content_type || resolvedContentType;
      const isImage = finalContentType.startsWith("image/");

      if (isImage) {
        return {
          content: [
            { type: "image", data: base64, mimeType: finalContentType },
            {
              type: "text",
              text: `Attachment: ${file_name || content_url} (${finalContentType}, ${Math.round((base64.length * 0.75) / 1024)} KB)`,
            },
          ],
        };
      }

      const decoded = decodeAsText(base64);
      if (decoded !== null) {
        return textResult({ file_name, content_type: finalContentType, text: decoded });
      }

      return textResult({
        file_name,
        content_type: finalContentType,
        size_kb: Math.round((base64.length * 0.75) / 1024),
        note: "Binary file (not valid UTF-8) — download manually if needed.",
      });
    }),
);

server.tool(
  "zendesk_ingest_ticket",
  "Read-only fetch from Zendesk plus local vectordb ingest for one Support ticket.",
  {
    ticket_id: z.union([z.string(), z.number()]),
    query: z.string().optional(),
  },
  async ({ ticket_id, query = "" }) =>
    withToolLogging("zendesk_ingest_ticket", { ticket_id: String(ticket_id) }, async () =>
      textResult(await ingestTicket(String(ticket_id), query)),
    ),
);

server.tool(
  "zendesk_ingest_search_results",
  "Read-only fetch from Zendesk plus local vectordb ingest for tickets returned by a search query.",
  {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(25).default(10),
  },
  async ({ query, limit = 10 }) =>
    withToolLogging("zendesk_ingest_search_results", { query_len: query.length, limit }, async () => {
      const search = await searchTickets(query, limit);
      const ingested = [];
      for (const ticket of search.results.slice(0, limit)) {
        ingested.push(await ingestTicket(String(ticket.id), query));
      }
      return textResult({ query, requested: limit, ingested });
    }),
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  log("info", "Starting MCP adapter", { enabled: ENABLED, base_url: BASE_URL || null });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "MCP adapter connected", { transport: "stdio" });
}

main().catch((err) => {
  log("error", "MCP adapter failed to start", { error: err.message, stack: err.stack });
  process.exit(1);
});
