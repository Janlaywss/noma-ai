import type { Connector, ConnectorContext, ConnectorDescriptor } from "../types.js";

interface LarkConfig extends Record<string, unknown> {
  appId: string;
  appSecret: string;
}

type LarkSDK = typeof import("@larksuiteoapi/node-sdk");
type LarkClient = InstanceType<LarkSDK["Client"]>;

const CACHE_TTL = 30 * 60_000;

class NameCache {
  private entries = new Map<string, { value: string; expiry: number }>();

  get(key: string): string | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiry) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: string) {
    this.entries.set(key, { value, expiry: Date.now() + CACHE_TTL });
  }

  clear() {
    this.entries.clear();
  }
}

async function resolveChatName(
  client: LarkClient,
  chatId: string,
  cache: NameCache,
): Promise<string> {
  const cached = cache.get(chatId);
  if (cached !== undefined) return cached;
  try {
    const res = await client.im.v1.chat.get({ path: { chat_id: chatId } });
    const name = res.data?.name ?? "";
    if (name) cache.set(chatId, name);
    return name;
  } catch {
    return "";
  }
}

async function resolveSenderName(
  client: LarkClient,
  openId: string,
  cache: NameCache,
): Promise<string> {
  const cached = cache.get(openId);
  if (cached !== undefined) return cached;
  try {
    const res = await client.contact.v3.user.get({
      path: { user_id: openId },
      params: { user_id_type: "open_id" },
    });
    const name = res.data?.user?.name ?? "";
    if (name) cache.set(openId, name);
    return name;
  } catch {
    return "";
  }
}

function createLarkConnector(cfg: LarkConfig, ctx: ConnectorContext): Connector {
  const appId = String(cfg.appId ?? "");
  const appSecret = String(cfg.appSecret ?? "");
  let wsClient: InstanceType<LarkSDK["WSClient"]> | null = null;
  const chatNames = new NameCache();
  const userNames = new NameCache();

  return {
    async start() {
      if (!appId || !appSecret) {
        ctx.log("info", "lark: missing appId/appSecret — skip");
        return;
      }

      const lark = await import("@larksuiteoapi/node-sdk");

      const client = new lark.Client({ appId, appSecret });

      const eventDispatcher = new lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data) => {
          const msg = data.message;
          const senderId = data.sender.sender_id?.open_id;

          let text = "";
          if (msg.message_type === "text") {
            try {
              text = (JSON.parse(msg.content) as { text?: string }).text ?? "";
            } catch {}
          }
          const body = text || `[${msg.message_type}]`;

          const [chatName, senderName] = await Promise.all([
            msg.chat_type === "group"
              ? resolveChatName(client, msg.chat_id, chatNames)
              : Promise.resolve(""),
            senderId
              ? resolveSenderName(client, senderId, userNames)
              : Promise.resolve(""),
          ]);

          ctx.emitEvent({
            type: "on_message",
            payload: {
              title: chatName || "飞书 · 新消息",
              sub: senderName ? `${senderName}: ${body}` : body,
              message_id: msg.message_id,
              chat_id: msg.chat_id,
              chat_type: msg.chat_type,
              chat_name: chatName,
              message_type: msg.message_type,
              content: msg.content,
              sender_id: senderId,
              sender_name: senderName,
            },
          });
        },
      });

      wsClient = new lark.WSClient({
        appId,
        appSecret,
        loggerLevel: lark.LoggerLevel.info,
        autoReconnect: true,
        onReady: () => ctx.log("info", "lark: ws connected"),
        onError: (err) => ctx.log("warn", `lark: ws error — ${err.message}`),
        onReconnecting: () => ctx.log("info", "lark: ws reconnecting"),
        onReconnected: () => ctx.log("info", "lark: ws reconnected"),
      });

      await wsClient.start({ eventDispatcher });
      ctx.log("info", "lark: started (WebSocket)");
    },

    stop() {
      if (wsClient) {
        wsClient.close();
        wsClient = null;
      }
      chatNames.clear();
      userNames.clear();
      ctx.log("info", "lark: stopped");
    },

    status() {
      return { connected: wsClient != null };
    },
  };
}

export const larkDescriptor: ConnectorDescriptor<LarkConfig> = {
  name: "lark",
  label: "飞书 Lark",
  description: "飞书消息推送。通过 WebSocket 长连接实时监听消息，需要 self-built app 的 appId 和 appSecret。",
  configSchema: [
    { key: "appId", type: "string", taskRequired: true },
    { key: "appSecret", type: "string", secret: true, taskRequired: true },
  ],
  defaults: { appId: "", appSecret: "" },
  create: createLarkConnector,
};
