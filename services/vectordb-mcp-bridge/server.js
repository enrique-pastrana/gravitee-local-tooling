import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.VDB_API_URL || "http://localhost:8000").replace(/\/+$/, "");
const DEBUG_LOGS = String(process.env.VDB_DEBUG || "").toLowerCase() === "true";

function log(level, message, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: "vectordb-mcp-bridge",
    message,
    ...fields,
  };
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

function info(message, fields) {
  log("info", message, fields);
}

function error(message, fields) {
  log("error", message, fields);
}

function debug(message, fields) {
  if (!DEBUG_LOGS) {
    return;
  }
  log("debug", message, fields);
}

process.on("unhandledRejection", (reason) => {
  error("Unhandled promise rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

process.on("uncaughtException", (err) => {
  error("Uncaught exception", {
    error: err.message,
    stack: err.stack,
  });
});

async function postJson(path, payload) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const bodyText = await res.text();
  let body = null;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch (_err) {
    body = { raw: bodyText };
  }

  if (!res.ok) {
    const detail = body && body.detail ? String(body.detail) : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return body;
}

async function getJson(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const bodyText = await res.text();
  let body = null;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch (_err) {
    body = { raw: bodyText };
  }
  if (!res.ok) {
    const detail = body && body.detail ? String(body.detail) : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return body;
}

function textResult(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

async function withToolLogging(toolName, callDetails, fn) {
  const start = Date.now();
  info("Tool call started", { tool: toolName, ...callDetails });
  try {
    const result = await fn();
    info("Tool call succeeded", {
      tool: toolName,
      duration_ms: Date.now() - start,
    });
    return result;
  } catch (err) {
    error("Tool call failed", {
      tool: toolName,
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

const server = new McpServer({
  name: "vectordb-mcp-bridge",
  version: "0.1.0",
});
info("Server object created", { base_url: BASE_URL, debug_logs: DEBUG_LOGS });

server.tool(
  "rag_health",
  "Check vectordb API/DB health and current document count.",
  {},
  async () => {
    return withToolLogging("rag_health", {}, async () => {
      const result = await getJson("/health");
      return textResult(result);
    });
  },
);

server.tool(
  "rag_search",
  "Search indexed chunks using vector or hybrid retrieval.",
  {
    query: z.string().min(1).describe("Question or search query"),
    limit: z.number().int().min(1).max(50).default(8),
    source: z.string().optional().describe("Optional source filter"),
    path: z.string().optional().describe("Optional path filter"),
    hybrid: z.boolean().default(true).describe("Use hybrid retrieval if true"),
  },
  async ({ query, limit = 8, source, path, hybrid = true }) => {
    return withToolLogging(
      "rag_search",
      { limit, source: source || null, path: path || null, hybrid, query_len: query.length },
      async () => {
        const result = await postJson("/search", { query, limit, source, path, hybrid });
        debug("Search response received", {
          tool: "rag_search",
          result_count: typeof result.count === "number" ? result.count : undefined,
        });
        return textResult(result);
      },
    );
  },
);

server.tool(
  "rag_ingest",
  "Ingest a document into vectordb (chunking + embeddings + upsert).",
  {
    source: z.string().min(1).describe("Source system, for example confluence or git"),
    path: z.string().min(1).describe("Document identifier or path"),
    text: z.string().min(1).describe("Raw document text"),
    metadata: z.record(z.any()).optional().describe("Optional metadata object"),
    chunk_size: z.number().int().min(200).max(8000).default(1200),
    chunk_overlap: z.number().int().min(0).max(2000).default(200),
  },
  async ({ source, path, text, metadata = {}, chunk_size = 1200, chunk_overlap = 200 }) => {
    return withToolLogging(
      "rag_ingest",
      {
        source,
        path,
        text_len: text.length,
        metadata_keys: Object.keys(metadata).length,
        chunk_size,
        chunk_overlap,
      },
      async () => {
        const result = await postJson("/ingest", {
          source,
          path,
          text,
          metadata,
          chunk_size,
          chunk_overlap,
        });
        debug("Ingest response received", {
          tool: "rag_ingest",
          chunks: result && typeof result.chunks === "number" ? result.chunks : undefined,
        });
        return textResult(result);
      },
    );
  },
);

async function main() {
  info("Starting MCP bridge", { base_url: BASE_URL });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  info("MCP bridge connected", { transport: "stdio" });
}

main().catch((err) => {
  error("MCP bridge failed to start", {
    error: err.message,
    stack: err.stack,
  });
  process.exit(1);
});
