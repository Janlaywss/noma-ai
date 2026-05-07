import type { Context } from "hono";
import { getDb } from "@/db/index";
import { verifySlackSignature } from "@/lib/channels/slack";

export async function slackHandler(c: Context) {
  const slug = c.req.param("slug");
  if (!slug) return c.text("missing slug", 400);
  const raw = await c.req.text();

  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM channel_configs WHERE channel_name = ? AND webhook_slug = ?"
    )
    .get("slack", slug) as Record<string, unknown> | undefined;
  if (!row) return c.text("unknown slug", 404);

  const cfg = (
    typeof row.config === "string" ? JSON.parse(row.config) : row.config ?? {}
  ) as Record<string, unknown>;
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
      db.prepare(
        "INSERT INTO session_memory (user_id, role, content, meta) VALUES (?, ?, ?, ?)"
      ).run(
        row.user_id as string,
        "user",
        text,
        JSON.stringify({
          channel: "slack",
          channel_id: body.event.channel,
          user: body.event.user,
        })
      );
      db.prepare(
        "INSERT INTO events (user_id, source, type, payload) VALUES (?, ?, ?, ?)"
      ).run(
        row.user_id as string,
        "slack",
        "on_message",
        JSON.stringify({
          title: `Slack · 新消息`,
          sub: text,
          channel_id: body.event.channel,
        })
      );
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
