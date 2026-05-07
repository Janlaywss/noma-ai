import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentToolSet } from "@noma/event-agent";

export type McpBridgeAddress = { url: string; token: string };

export type McpBridgeHandle = {
  address: McpBridgeAddress;
  stop: () => Promise<void>;
};

/**
 * Start a localhost HTTP server that routes tool calls from the
 * `@noma/mcp-tools` subprocess back to the provided `AgentToolSet`.
 *
 * Wire format (same contract the mcp-tools bridge.ts client speaks):
 *   POST /mcp-bridge/invoke
 *   Authorization: Bearer <token>
 *   { "toolName": string, "input": Record<string, unknown> }
 *   → 200 { "output": string }
 */
export async function startMcpBridge(
  toolSet: AgentToolSet,
  label = "mcp"
): Promise<McpBridgeHandle> {
  const token = randomBytes(24).toString("hex");

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp-bridge/invoke") {
      res.writeHead(404).end();
      return;
    }
    if ((req.headers.authorization ?? "") !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: { toolName?: unknown; input?: unknown };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }

    const toolName = typeof body.toolName === "string" ? body.toolName : "";
    if (!toolName) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "toolName required" }));
      return;
    }

    const input =
      body.input && typeof body.input === "object"
        ? (body.input as Record<string, unknown>)
        : {};

    try {
      const output = await toolSet.execute({
        toolCallId: randomUUID(),
        toolName,
        input,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: `${toolName} failed: ${msg}` }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  console.log(`[mcp-bridge:${label}] listening on http://127.0.0.1:${port}`);

  return {
    address: { url: `http://127.0.0.1:${port}`, token },
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
