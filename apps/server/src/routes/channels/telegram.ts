import type { Context } from "hono";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * POST /api/channels/telegram/webhook/:slug
 *
 * Auth is the slug itself — registered via setWebhook so only the bound
 * bot posts here. Text messages become session_memory user turns + an
 * event row; other update types are ignored.
 */
export async function telegramHandler(c: Context) {
  const slug = c.req.param("slug");
  if (!slug) return c.text("missing slug", 400);

  const supabase = supabaseAdmin();
  const { data: row } = await supabase
    .from("channel_configs")
    .select("*")
    .eq("channel_name", "telegram")
    .eq("webhook_slug", slug)
    .maybeSingle();
  if (!row) return c.text("unknown slug", 404);

  const body = (await c.req.json()) as TgUpdate;
  const msg = body.message;
  if (msg?.text && typeof msg.chat?.id === "number") {
    await supabase.from("session_memory").insert({
      user_id: row.user_id,
      role: "user",
      content: msg.text,
      meta: {
        channel: "telegram",
        chat_id: msg.chat.id,
        from: msg.from?.username ?? msg.from?.id,
      },
    });
    await supabase.from("events").insert({
      user_id: row.user_id,
      source: "telegram",
      type: "on_message",
      payload: {
        title: `Telegram · 新消息`,
        sub: msg.text,
        chat_id: msg.chat.id,
      },
    });
  }

  return c.json({ ok: true });
}

interface TgUpdate {
  update_id?: number;
  message?: {
    text?: string;
    chat?: { id?: number };
    from?: { username?: string; id?: number };
  };
}
