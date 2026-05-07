import { getDb } from "@/db/index";
import {
  larkSendText,
  larkTenantAccessToken,
} from "./lark";
import { slackSendText } from "./slack";
import { telegramSendText } from "./telegram";

export async function fanOutToChannels(
  userId: string,
  text: string
): Promise<void> {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM channel_configs WHERE user_id = ? AND enabled = 1"
    )
    .all(userId) as Array<Record<string, unknown>>;

  for (const row of rows) {
    const cfg = (
      typeof row.config === "string"
        ? JSON.parse(row.config)
        : row.config ?? {}
    ) as Record<string, unknown>;
    try {
      if (row.channel_name === "lark") {
        const appId = str(cfg.appId);
        const appSecret = str(cfg.appSecret);
        const chatId = str(cfg.chatId);
        if (!appId || !appSecret || !chatId) continue;
        const token = await larkTenantAccessToken(appId, appSecret);
        await larkSendText({ token, chatId, text });
      } else if (row.channel_name === "slack") {
        const botToken = str(cfg.botToken);
        const channel = str(cfg.chatId) || str(cfg.channel);
        if (!botToken || !channel) continue;
        await slackSendText({ botToken, channel, text });
      } else if (row.channel_name === "telegram") {
        const botToken = str(cfg.botToken);
        const chatId = str(cfg.chatId);
        if (!botToken || !chatId) continue;
        await telegramSendText({ botToken, chatId, text });
      }
    } catch (e) {
      const status = typeof row.status === "string"
        ? JSON.parse(row.status)
        : row.status ?? {};
      db.prepare(
        "UPDATE channel_configs SET status = ? WHERE user_id = ? AND channel_name = ?"
      ).run(
        JSON.stringify({
          ...status,
          lastError: e instanceof Error ? e.message : String(e),
          lastErrorAt: new Date().toISOString(),
        }),
        userId,
        row.channel_name as string
      );
    }
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
