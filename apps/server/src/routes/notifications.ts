import { localUserRouter } from "@/middleware/local-user";
import { fanOutToChannels } from "@/lib/channels/outbound";

/**
 * Server-owned notification sink. The local `notify` tool POSTs here
 * because:
 *   - notifications live in cloud Supabase (user sees them across
 *     devices) and
 *   - `alert`-level notifications fan out to IM channels whose tokens
 *     never touch the desktop.
 */
const notifications = localUserRouter();

type Level = "info" | "nudge" | "alert";

notifications.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const { data, error } = await c
    .get("supabase")
    .from("notifications")
    .select("*")
    .eq("user_id", c.get("userId"))
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return c.text(error.message, 500);
  return c.json(data ?? []);
});

notifications.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    message?: string;
    level?: Level;
    meta?: Record<string, unknown>;
  } | null;
  if (!body?.message) return c.text("missing message", 400);
  const level: Level = body.level ?? "info";
  const userId = c.get("userId");

  const { data, error } = await c
    .get("supabase")
    .from("notifications")
    .insert({
      user_id: userId,
      level,
      message: body.message,
      meta: body.meta ?? null,
    })
    .select("*")
    .single();
  if (error) return c.text(error.message, 500);

  // Only `alert` pierces the user's attention via IM. Nudges/info stay
  // in-app so we don't desensitize the escalation signal.
  if (level === "alert") {
    try {
      await fanOutToChannels(userId, body.message);
    } catch {
      // per-channel errors are recorded on the channel row already
    }
  }

  return c.json(data, 201);
});

notifications.patch("/:id/read", async (c) => {
  const { error } = await c
    .get("supabase")
    .from("notifications")
    .update({ read: true })
    .eq("user_id", c.get("userId"))
    .eq("id", c.req.param("id"));
  if (error) return c.text(error.message, 500);
  return c.body(null, 204);
});

export default notifications;
