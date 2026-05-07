import type {
  Connector,
  ConnectorContext,
  ConnectorDescriptor,
  ConnectorTool,
} from "../types.js";

interface GmailConfig extends Record<string, unknown> {
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  email: string | null;
  pollIntervalSec: number;
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{
      mimeType?: string;
      body?: { data?: string };
      parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
    }>;
  };
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  resultSizeEstimate?: number;
}

/** Subset of ConnectorContext both the polling loop and tools rely on. */
type TokenCtx = Pick<ConnectorContext, "log" | "storage" | "refreshOAuth">;

function getHeader(msg: GmailMessage, name: string): string | null {
  const h = msg.payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase()
  );
  return h?.value ?? null;
}

function decodeB64Url(b64?: string): string {
  if (!b64) return "";
  return Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function extractPlainBody(msg: GmailMessage): string {
  const direct = msg.payload?.body?.data;
  if (direct) return decodeB64Url(direct);
  const parts = msg.payload?.parts ?? [];
  const flat: Array<{ mimeType?: string; body?: { data?: string } }> = [];
  for (const p of parts) {
    flat.push(p);
    if (p.parts) flat.push(...p.parts);
  }
  const text = flat.find((p) => p.mimeType === "text/plain");
  return decodeB64Url(text?.body?.data);
}

/**
 * Pull stored tokens into `config`. Storage is the live source of truth
 * after the first refresh — `connector_configs.config` is only written
 * at OAuth time, so it goes stale. Both the polling loop (in `start()`)
 * and the on-demand tools call this so they share a single token view.
 */
async function loadStoredToken(
  config: GmailConfig,
  ctx: TokenCtx
): Promise<void> {
  const storedToken = await ctx.storage.get("access_token");
  const storedExpires = await ctx.storage.get("expires_at");
  if (!storedToken || !storedExpires) return;
  const exp = Number(storedExpires);
  if (exp <= Date.now()) return;
  config.access_token = storedToken;
  config.expires_at = exp;
}

async function refreshAccessToken(
  config: GmailConfig,
  ctx: TokenCtx
): Promise<string | null> {
  // Prefer the host's refresh proxy (typically the cloud server). Falls
  // back to a direct Google call when the host hasn't wired one up — that
  // path needs GOOGLE_CLIENT_ID/SECRET in process env, so it's mostly for
  // server-side / eval harness usage.
  if (ctx.refreshOAuth) {
    try {
      const result = await ctx.refreshOAuth();
      if (!result) {
        ctx.log("warn", "gmail: host refreshOAuth returned null");
        return null;
      }
      config.access_token = result.access_token;
      config.expires_at = result.expires_at;
      // Keep storage in sync. The server-side proxy already writes here,
      // but a direct-fallback host won't, and the polling loop reads
      // storage on start anyway.
      await ctx.storage.set("access_token", result.access_token);
      await ctx.storage.set("expires_at", String(result.expires_at));
      return result.access_token;
    } catch (err) {
      ctx.log(
        "warn",
        `gmail: host refreshOAuth failed — ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  if (!config.refresh_token) return null;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: config.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) {
      ctx.log("warn", `gmail: token refresh failed (HTTP ${res.status})`);
      return null;
    }
    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    config.access_token = data.access_token;
    config.expires_at = Date.now() + data.expires_in * 1000;

    await ctx.storage.set("access_token", data.access_token);
    await ctx.storage.set("expires_at", String(config.expires_at));

    return data.access_token;
  } catch (err) {
    ctx.log("warn", `gmail: token refresh error — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function getValidToken(
  config: GmailConfig,
  ctx: TokenCtx
): Promise<string | null> {
  if (config.expires_at > Date.now() + 60_000) {
    return config.access_token;
  }
  return refreshAccessToken(config, ctx);
}

async function gmailFetch(
  url: string,
  config: GmailConfig,
  ctx: TokenCtx
): Promise<Response | null> {
  const token = await getValidToken(config, ctx);
  if (!token) return null;
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    const refreshed = await refreshAccessToken(config, ctx);
    if (!refreshed) return res;
    res = await fetch(url, { headers: { Authorization: `Bearer ${refreshed}` } });
  }
  return res;
}

const METADATA_QS =
  "format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To";

async function fetchMessageMeta(
  id: string,
  config: GmailConfig,
  ctx: TokenCtx
): Promise<GmailMessage | null> {
  const res = await gmailFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?${METADATA_QS}`,
    config,
    ctx
  );
  if (!res || !res.ok) return null;
  return (await res.json()) as GmailMessage;
}

function createGmailConnector(cfg: GmailConfig, ctx: ConnectorContext): Connector {
  let pollIntervalSec = Math.max(60, Number(cfg.pollIntervalSec) || 120);
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let lastCheckMs = Date.now();
  let lastPollAt: number | null = null;

  const poll = async () => {
    if (running) return;
    running = true;
    try {
      const after = Math.floor(lastCheckMs / 1000);
      const query = `is:unread after:${after}`;
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=10`;

      const listRes = await gmailFetch(url, cfg, ctx);
      lastPollAt = Date.now();
      if (!listRes) {
        ctx.log("warn", "gmail: no valid token — skip");
        return;
      }
      if (!listRes.ok) {
        ctx.log("warn", `gmail: HTTP ${listRes.status}`);
        return;
      }

      const data = (await listRes.json()) as GmailListResponse;
      await processMessages(data);
      lastCheckMs = Date.now();
    } catch (err) {
      ctx.log("warn", `gmail: poll failed — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };

  async function processMessages(data: GmailListResponse) {
    if (!data.messages || data.messages.length === 0) return;
    for (const ref of data.messages.slice(0, 5)) {
      const msg = await fetchMessageMeta(ref.id, cfg, ctx);
      if (!msg) continue;
      ctx.emitEvent({
        type: "on_new_email",
        payload: {
          title: getHeader(msg, "Subject") ?? "(no subject)",
          sub: getHeader(msg, "From") ?? "unknown",
          message_id: msg.id,
          thread_id: msg.threadId,
          snippet: msg.snippet ?? "",
          date: getHeader(msg, "Date"),
        },
      });
    }
  }

  return {
    async start() {
      await loadStoredToken(cfg, ctx);
      ctx.log("info", `gmail: started (every ${pollIntervalSec}s)`);
      await poll();
      timer = setInterval(() => void poll(), pollIntervalSec * 1000);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      ctx.log("info", "gmail: stopped");
    },
    status() {
      return {
        pollIntervalSec,
        email: cfg.email,
        lastPollAt,
        tokenExpiresAt: cfg.expires_at,
      };
    },
    updateConfig(newCfg: Record<string, unknown>) {
      const newInterval = Math.max(60, Number(newCfg.pollIntervalSec) || 120);
      if (newInterval !== pollIntervalSec) {
        pollIntervalSec = newInterval;
        if (timer) {
          clearInterval(timer);
          timer = setInterval(() => void poll(), pollIntervalSec * 1000);
        }
      }
      if (typeof newCfg.access_token === "string") {
        cfg.access_token = newCfg.access_token;
      }
      if (typeof newCfg.refresh_token === "string") {
        cfg.refresh_token = newCfg.refresh_token;
      }
      if (typeof newCfg.expires_at === "number") {
        cfg.expires_at = newCfg.expires_at;
      }
      ctx.log("info", `gmail: config updated (every ${pollIntervalSec}s)`);
    },
  };
}

// ── pull-style tools ────────────────────────────────────────────
//
// Both tools share the connector's config + storage. `loadStoredToken`
// pulls the latest refreshed token before any API call, so the polling
// loop and on-demand tools converge on a single token view (the agent
// asking "what's in my inbox?" five minutes after a poll won't refresh
// a second time unnecessarily).

const gmailTools: ReadonlyArray<ConnectorTool<GmailConfig>> = [
  {
    schema: {
      name: "list_messages",
      description:
        "List Gmail messages matching a search query. Same syntax as Gmail's search box (e.g. 'from:foo@bar.com', 'is:unread', 'after:2026/04/01'). Returns id, subject, from, date, snippet. Requires the Gmail connector to be authorized.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Gmail search query. Empty string for the most recent messages.",
          },
          maxResults: {
            type: "number",
            description: "1–25, default 10.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    async execute(input, config, ctx) {
      await loadStoredToken(config, ctx);
      const query = String(input.query ?? "");
      const max = Math.min(25, Math.max(1, Number(input.maxResults) || 10));
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${max}`;
      const res = await gmailFetch(url, config, ctx);
      if (!res) return "Gmail authorization required — please connect Gmail in Settings.";
      if (!res.ok) return `Gmail list failed: HTTP ${res.status}`;

      const data = (await res.json()) as GmailListResponse;
      const refs = data.messages ?? [];
      const out: Array<Record<string, unknown>> = [];
      for (const ref of refs) {
        const msg = await fetchMessageMeta(ref.id, config, ctx);
        if (!msg) continue;
        out.push({
          id: msg.id,
          threadId: msg.threadId,
          subject: getHeader(msg, "Subject"),
          from: getHeader(msg, "From"),
          date: getHeader(msg, "Date"),
          snippet: msg.snippet ?? "",
        });
      }
      return JSON.stringify({ messages: out });
    },
  },
  {
    schema: {
      name: "get_message",
      description:
        "Fetch full details of a Gmail message by id, including the plain-text body (truncated to 8000 chars). Use list_messages first to obtain ids.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Gmail message id from list_messages.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    async execute(input, config, ctx) {
      await loadStoredToken(config, ctx);
      const id = String(input.id ?? "").trim();
      if (!id) return "id required";
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`;
      const res = await gmailFetch(url, config, ctx);
      if (!res) return "Gmail authorization required — please connect Gmail in Settings.";
      if (!res.ok) return `Gmail get failed: HTTP ${res.status}`;

      const msg = (await res.json()) as GmailMessage;
      const body = extractPlainBody(msg);
      return JSON.stringify({
        id: msg.id,
        threadId: msg.threadId,
        subject: getHeader(msg, "Subject"),
        from: getHeader(msg, "From"),
        to: getHeader(msg, "To"),
        date: getHeader(msg, "Date"),
        snippet: msg.snippet ?? "",
        body: body.slice(0, 8000),
      });
    },
  },
];

export const gmailDescriptor: ConnectorDescriptor<GmailConfig> = {
  name: "gmail",
  label: "Gmail",
  description: "监听 Gmail 新邮件通知。通过 Google OAuth 授权，无需手动填写密钥。",
  configSchema: [
    { key: "access_token", type: "string", secret: true, taskRequired: true },
    { key: "refresh_token", type: "string", secret: true },
    { key: "expires_at", type: "number" },
    { key: "pollIntervalSec", type: "number", min: 60 },
  ],
  defaults: {
    access_token: "",
    refresh_token: null,
    expires_at: 0,
    email: null,
    pollIntervalSec: 120,
  },
  create: createGmailConnector,
  tools: gmailTools,
};
