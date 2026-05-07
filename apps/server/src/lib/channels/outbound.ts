import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  larkSendText,
  larkTenantAccessToken,
} from "./lark";
import { slackSendText } from "./slack";
import { telegramSendText } from "./telegram";

/**
 * Fan out a message to every channel the user has enabled + configured.
 * Call this from server-side code (notify tool, agent loop) whenever the
 * user should see something in their IM as well as in the web UI.
 *
 * Errors per channel are swallowed (logged) so a misconfigured Slack token
 * can't block a successful Lark delivery.
 */
export async function fanOutToChannels(
  userId: string,
  text: string
): Promise<void> {
  const supabase = supabaseAdmin();
  const { data: rows } = await supabase
    .from("channel_configs")
    .select("*")
    .eq("user_id", userId)
    .eq("enabled", true);
  if (!rows) return;

  for (const row of rows) {
    const cfg = (row.config ?? {}) as Record<string, unknown>;
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
      await supabase
        .from("channel_configs")
        .update({
          status: {
            ...(row.status ?? {}),
            lastError: e instanceof Error ? e.message : String(e),
            lastErrorAt: new Date().toISOString(),
          },
        })
        .eq("user_id", userId)
        .eq("channel_name", row.channel_name);
    }
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
