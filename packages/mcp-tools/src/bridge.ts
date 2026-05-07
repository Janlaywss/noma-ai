/**
 * Tiny HTTP client for the desktop's loopback "MCP bridge".
 *
 * The MCP server runs as a subprocess of Codex — it speaks the MCP wire
 * format on stdio and routes tool calls back to the Electron main
 * process via HTTP on a private localhost port. Authentication is a
 * shared-secret token set at spawn time so other processes on the
 * machine can't impersonate the MCP server.
 *
 * Configuration comes from environment variables that the desktop
 * injects when launching us:
 *
 *   - `NOMA_BRIDGE_URL`   — base URL, e.g. `http://127.0.0.1:51337`
 *   - `NOMA_BRIDGE_TOKEN` — opaque shared secret, sent as
 *                            `Authorization: Bearer <token>`
 *
 * If either var is missing, every call returns an error string. This
 * lets the MCP server start cleanly under tests/CI without crashing on
 * unconfigured environments.
 */

export type BridgeResult = { ok: true; output: string } | { ok: false; error: string };

export class NomaBridge {
  constructor(
    private readonly baseUrl: string | undefined,
    private readonly token: string | undefined
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): NomaBridge {
    return new NomaBridge(env.NOMA_BRIDGE_URL, env.NOMA_BRIDGE_TOKEN);
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  /**
   * Invoke a NOMA tool over the bridge.
   *
   * Returns a string output the MCP server forwards verbatim to the
   * model — same contract as `executeBuiltinTool` in `@noma/event-agent`.
   */
  async invoke(toolName: string, input: unknown): Promise<BridgeResult> {
    if (!this.baseUrl || !this.token) {
      return {
        ok: false,
        error: "NOMA bridge not configured (NOMA_BRIDGE_URL/TOKEN missing)",
      };
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/mcp-bridge/invoke`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ toolName, input }),
      });
    } catch (err) {
      return {
        ok: false,
        error: `bridge transport error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `bridge ${res.status}: ${text.slice(0, 200)}`,
      };
    }

    const data = (await res.json().catch(() => null)) as
      | { output?: unknown; error?: string }
      | null;

    if (data == null) {
      return { ok: false, error: "bridge returned non-JSON response" };
    }
    if (typeof data.error === "string" && data.error.length > 0) {
      return { ok: false, error: data.error };
    }
    if (typeof data.output === "string") {
      return { ok: true, output: data.output };
    }
    return {
      ok: true,
      output: data.output == null ? "" : JSON.stringify(data.output),
    };
  }
}
