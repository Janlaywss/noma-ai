#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";
import { NomaBridge } from "./bridge.js";

/**
 * NOMA MCP server.
 *
 * Codex (the chat agent) launches us as a subprocess via the standard
 * MCP stdio transport. We expose NOMA's tool surface — `notify`,
 * `scheduleTask`, `list_connectors`, etc. — by routing every
 * `tools/call` back to the desktop process over a localhost HTTP
 * bridge. The desktop owns the actual side-effect implementations
 * (SQLite writes, notifications, worker host calls).
 *
 * Tool schemas are loaded from `@noma/shared/agent/tool-schemas` so the
 * single source of truth stays the JSON file the rest of the agent
 * runtime consumes.
 *
 * Tools intentionally NOT exposed:
 *   - `task_complete` — Codex manages its own turn termination, so a
 *     "I'm done" tool only confuses its loop.
 */

type ToolSchema = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: false;
  };
};

const requireShared = createRequire(import.meta.url);
const ALL_SCHEMAS = requireShared(
  "@noma/shared/agent/tool-schemas"
) as ToolSchema[];

const CODEX_HIDDEN = new Set(["task_complete"]);

const TOOL_FILTER = process.env.NOMA_TOOL_FILTER
  ? new Set(process.env.NOMA_TOOL_FILTER.split(",").map((s) => s.trim()).filter(Boolean))
  : null;

const TOOL_SCHEMAS = ALL_SCHEMAS
  .filter((s) => !CODEX_HIDDEN.has(s.name))
  .filter((s) => !TOOL_FILTER || TOOL_FILTER.has(s.name));

const bridge = NomaBridge.fromEnv();

const server = new Server(
  {
    name: "noma",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources: [] };
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return { resourceTemplates: [] };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOL_SCHEMAS.map((s) => ({
      name: s.name,
      description: s.description,
      inputSchema: s.inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (CODEX_HIDDEN.has(name)) {
    return {
      isError: true,
      content: [{ type: "text", text: `tool '${name}' is not exposed via MCP` }],
    };
  }

  const result = await bridge.invoke(name, args ?? {});
  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: result.error }],
    };
  }
  return {
    content: [{ type: "text", text: result.output }],
  };
});

async function main() {
  // Logs to stderr — stdout is reserved for MCP JSON-RPC.
  console.error(
    `[noma-mcp-tools] starting (${TOOL_SCHEMAS.length} tools, bridge ${bridge.isConfigured() ? "configured" : "MISSING — invocations will fail"})`
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[noma-mcp-tools] fatal:", err);
  process.exit(1);
});
