import type { Context } from "hono";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { verifyLarkSignature } from "@/lib/channels/lark";

/**
 * POST /api/channels/lark/webhook/:slug
 *
 * Per-user slug maps request to a `channel_configs` row; signature check
 * uses that row's `encryptKey`. Handles `url_verification` (reply with
 * challenge) and `event_callback` with `im.message.receive_v1`.
 */
export async function larkHandler(c: Context) {
  const slug = c.req.param("slug");
  if (!slug) return c.text("missing slug", 400);
  const raw = await c.req.text();

  const supabase = supabaseAdmin();
  const { data: row } = await supabase
    .from("channel_configs")
    .select("*")
    .eq("channel_name", "lark")
    .eq("webhook_slug", slug)
    .maybeSingle();
  if (!row) return c.text("unknown slug", 404);

  const cfg = (row.config ?? {}) as Record<string, unknown>;
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
        await supabase.from("session_memory").insert({
          user_id: row.user_id,
          role: "user",
          content: text,
          meta: { channel: "lark", chat_id: msg.chat_id },
        });
        await supabase.from("events").insert({
          user_id: row.user_id,
          source: "lark",
          type: "on_message",
          payload: {
            title: `Lark · 新消息`,
            sub: text,
            chat_id: msg.chat_id,
          },
        });
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
