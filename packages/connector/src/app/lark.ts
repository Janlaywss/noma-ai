import type { Connector, ConnectorContext, ConnectorDescriptor } from "../types.js";

/**
 * Lark / 飞书 — polls a bot's chat list and emits `on_chat_update` for any
 * chat whose `last_message_time` advanced past the cursor. Coarse but
 * stable signal; per-message subscriptions would need event mode (out of
 * scope here).
 */

interface LarkConfig extends Record<string, unknown> {
  appId: string;
  appSecret: string;
  pollIntervalSec: number;
}

interface LarkChat {
  chat_id: string;
  name?: string;
  description?: string;
  last_message_time?: string;
}

function createLarkConnector(cfg: LarkConfig, ctx: ConnectorContext): Connector {
  let pollIntervalSec = Math.max(60, Number(cfg.pollIntervalSec) || 120);
  const appId = String(cfg.appId ?? "");
  const appSecret = String(cfg.appSecret ?? "");
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let token = "";
  let tokenExp = 0;
  let lastSeen = 0;
  let lastPollAt: number | null = null;

  const refreshToken = async (): Promise<boolean> => {
    if (token && Date.now() < tokenExp - 60_000) return true;
    const res = await fetch(
      "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      }
    );
    if (!res.ok) {
      ctx.log("warn", `  lark: token HTTP ${res.status}`);
      return false;
    }
    const body = (await res.json()) as {
      tenant_access_token?: string;
      expire?: number;
    };
    if (!body.tenant_access_token) {
      ctx.log("warn", "  lark: missing tenant_access_token");
      return false;
    }
    token = body.tenant_access_token;
    tokenExp = Date.now() + (body.expire ?? 7000) * 1000;
    return true;
  };

  const poll = async () => {
    if (running) return;
    running = true;
    try {
      if (!appId || !appSecret) {
        ctx.log("info", "  lark: missing appId/appSecret — skip");
        return;
      }
      if (!(await refreshToken())) return;
      const res = await fetch(
        "https://open.larksuite.com/open-apis/im/v1/chats?page_size=50",
        { headers: { Authorization: `Bearer ${token}` } }
      );
      lastPollAt = Date.now();
      if (!res.ok) {
        ctx.log("warn", `  lark: chats HTTP ${res.status}`);
        return;
      }
      const chats =
        ((await res.json()) as { data?: { items?: LarkChat[] } }).data?.items ??
        [];
      let nextLastSeen = lastSeen;
      for (const c of chats) {
        const ts = Number(c.last_message_time ?? 0) * 1000;
        if (!ts || ts <= lastSeen) continue;
        ctx.emitEvent({
          type: "on_chat_update",
          payload: {
            title: `${c.name ?? c.chat_id} · 新活动`,
            sub: c.description ?? "",
            chat_id: c.chat_id,
            last_message_time: c.last_message_time,
          },
        });
        if (ts > nextLastSeen) nextLastSeen = ts;
      }
      lastSeen = nextLastSeen;
    } catch (err) {
      ctx.log(
        "warn",
        `  lark: poll failed — ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      running = false;
    }
  };

  return {
    async start() {
      ctx.log("info", `lark: started (every ${pollIntervalSec}s)`);
      await poll();
      timer = setInterval(() => void poll(), pollIntervalSec * 1000);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      ctx.log("info", "lark: stopped");
    },
    status() {
      return { pollIntervalSec, lastSeen, lastPollAt };
    },
    updateConfig(cfg: Record<string, unknown>) {
      const newInterval = Math.max(60, Number(cfg.pollIntervalSec) || 120);
      if (newInterval !== pollIntervalSec) {
        pollIntervalSec = newInterval;
        if (timer) {
          clearInterval(timer);
          timer = setInterval(() => void poll(), pollIntervalSec * 1000);
        }
      }
      ctx.log("info", `lark: config updated (every ${pollIntervalSec}s)`);
    },
  };
}

export const larkDescriptor: ConnectorDescriptor<LarkConfig> = {
  name: "lark",
  label: "飞书 Lark",
  description: "飞书消息、会议邀请、日程变更。需要 self-built app 的 appId 和 appSecret。",
  configSchema: [
    { key: "appId", type: "string", taskRequired: true },
    { key: "appSecret", type: "string", secret: true, taskRequired: true },
    { key: "pollIntervalSec", type: "number", min: 60 },
  ],
  defaults: { appId: "", appSecret: "", pollIntervalSec: 120 },
  create: createLarkConnector,
};
