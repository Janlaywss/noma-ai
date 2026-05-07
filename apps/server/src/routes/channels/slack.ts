import type { Context } from "hono";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { verifySlackSignature } from "@/lib/channels/slack";

/**
 * POST /api/channels/slack/webhook/:slug
 *
 * Slack Events API endpoint. Handles `url_verification` +
 * `event_callback`. Per-user slug routes to the right config row; the
 * row's `signingSecret` verifies the HMAC.
 */
export async function slackHandler(c: Context) {
  const slug = c.req.param("slug");
  if (!slug) return c.text("missing slug", 400);
  const raw = await c.req.text();

  const supabase = supabaseAdmin();
  const { data: row } = await supabase
    .from("channel_configs")
    .select("*")
    .eq("channel_name", "slack")
    .eq("webhook_slug", slug)
    .maybeSingle();
  if (!row) return c.text("unknown slug", 404);

  const cfg = (row.config ?? {}) as Record<string, unknown>;
  const signingSecret =
    typeof cfg.signingSecret === "string" ? cfg.signingSecret : "";
  if (signingSecret.length > 0) {
    const ok = verifySlackSignature({
      timestamp: c.req.header("x-slack-request-timestamp") ?? null,
      signature: c.req.header("x-slack-signature") ?? null,
      rawBody: raw,
      signingSecret,
    });
    if (!ok) return c.text("bad signature", 401);
  }

  const body = JSON.parse(raw) as SlackBody;
  if (body.type === "url_verification" && body.challenge) {
    return c.text(body.challenge);
  }

  if (body.type === "event_callback" && body.event?.type === "message") {
    const text = body.event.text ?? "";
    if (text.length > 0 && !body.event.bot_id) {
      await supabase.from("session_memory").insert({
        user_id: row.user_id,
        role: "user",
        content: text,
        meta: {
          channel: "slack",
          channel_id: body.event.channel,
          user: body.event.user,
        },
      });
      await supabase.from("events").insert({
        user_id: row.user_id,
        source: "slack",
        type: "on_message",
        payload: {
          title: `Slack · 新消息`,
          sub: text,
          channel_id: body.event.channel,
        },
      });
    }
  }

  return c.json({ ok: true });
}

interface SlackBody {
  type?: string;
  challenge?: string;
  event?: {
    type?: string;
    text?: string;
    channel?: string;
    user?: string;
    bot_id?: string;
  };
}
