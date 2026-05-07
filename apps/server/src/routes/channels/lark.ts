import type { Context } from "hono";
import { getDb } from "@/db/index";
import { verifyLarkSignature } from "@/lib/channels/lark";

export async function larkHandler(c: Context) {
  const slug = c.req.param("slug");
  if (!slug) return c.text("missing slug", 400);
  const raw = await c.req.text();

  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM channel_configs WHERE channel_name = ? AND webhook_slug = ?"
    )
    .get("lark", slug) as Record<string, unknown> | undefined;
  if (!row) return c.text("unknown slug", 404);

  const cfg = (
    typeof row.config === "string" ? JSON.parse(row.config) : row.config ?? {}
  ) as Record<string, unknown>;
  const encryptKey = typeof cfg.encryptKey === "string" ? cfg.encryptKey : "";
  if (encryptKey.length > 0) {
    const ok = verifyLarkSignature({
      timestamp: c.req.header("x-lark-request-timestamp") ?? null,
      nonce: c.req.header("x-lark-request-nonce") ?? null,
      signature: c.req.header("x-lark-signature") ?? null,
      rawBody: raw,
      encryptKey,
    });
    if (!ok) return c.text("bad signature", 401);
  }

  const body = JSON.parse(raw) as LarkBody;
  if (body.type === "url_verification") {
    return c.json({ challenge: body.challenge });
  }

  if (body.header?.event_type === "im.message.receive_v1") {
    const msg = body.event?.message;
    if (msg?.message_type === "text" && typeof msg.content === "string") {
      const inner = safeJson<{ text?: string }>(msg.content);
      const text = inner?.text ?? "";
      if (text.length > 0) {
        db.prepare(
          "INSERT INTO session_memory (user_id, role, content, meta) VALUES (?, ?, ?, ?)"
        ).run(
          row.user_id as string,
          "user",
          text,
          JSON.stringify({ channel: "lark", chat_id: msg.chat_id })
        );
        db.prepare(
          "INSERT INTO events (user_id, source, type, payload) VALUES (?, ?, ?, ?)"
        ).run(
          row.user_id as string,
          "lark",
          "on_message",
          JSON.stringify({
            title: `Lark · 新消息`,
            sub: text,
            chat_id: msg.chat_id,
          })
        );
      }
    }
  }

  return c.json({ ok: true });
}

interface LarkBody {
  type?: string;
  challenge?: string;
  header?: { event_type?: string };
  event?: {
    message?: {
      message_id?: string;
      message_type?: string;
      content?: string;
      chat_id?: string;
    };
  };
}

function safeJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
