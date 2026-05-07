import type { Context } from "hono";
import { getDb } from "@/db/index";

export async function telegramHandler(c: Context) {
  const slug = c.req.param("slug");
  if (!slug) return c.text("missing slug", 400);

  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM channel_configs WHERE channel_name = ? AND webhook_slug = ?"
    )
    .get("telegram", slug) as Record<string, unknown> | undefined;
  if (!row) return c.text("unknown slug", 404);

  const body = (await c.req.json()) as TgUpdate;
  const msg = body.message;
  if (msg?.text && typeof msg.chat?.id === "number") {
    db.prepare(
      "INSERT INTO session_memory (user_id, role, content, meta) VALUES (?, ?, ?, ?)"
    ).run(
      row.user_id as string,
      "user",
      msg.text,
      JSON.stringify({
        channel: "telegram",
        chat_id: msg.chat.id,
        from: msg.from?.username ?? msg.from?.id,
      })
    );
    db.prepare(
      "INSERT INTO events (user_id, source, type, payload) VALUES (?, ?, ?, ?)"
    ).run(
      row.user_id as string,
      "telegram",
      "on_message",
      JSON.stringify({
        title: `Telegram · 新消息`,
        sub: msg.text,
        chat_id: msg.chat.id,
      })
    );
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
