import { localUserRouter } from "@/middleware/local-user";
import { fanOutToChannels } from "@/lib/channels/outbound";

const notifications = localUserRouter();

type Level = "info" | "nudge" | "alert";

notifications.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const db = c.get("db");
  const rows = db
    .prepare(
      "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(c.get("userId"), limit) as Array<Record<string, unknown>>;
  return c.json(rows.map(parseNotificationRow));
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
  const db = c.get("db");

  const info = db
    .prepare(
      "INSERT INTO notifications (user_id, level, message, meta) VALUES (?, ?, ?, ?)"
    )
    .run(userId, level, body.message, JSON.stringify(body.meta ?? null));

  const row = db
    .prepare("SELECT * FROM notifications WHERE rowid = ?")
    .get(info.lastInsertRowid) as Record<string, unknown>;

  if (level === "alert") {
    try {
      await fanOutToChannels(userId, body.message);
    } catch {
      // per-channel errors are recorded on the channel row already
    }
  }

  return c.json(parseNotificationRow(row), 201);
});

notifications.patch("/:id/read", async (c) => {
  const db = c.get("db");
  db.prepare(
    "UPDATE notifications SET read = 1 WHERE user_id = ? AND id = ?"
  ).run(c.get("userId"), c.req.param("id"));
  return c.body(null, 204);
});

function parseNotificationRow(r: Record<string, unknown>) {
  return {
    ...r,
    meta: typeof r.meta === "string" ? JSON.parse(r.meta) : r.meta ?? null,
    read: r.read === 1 || r.read === true,
  };
}

export default notifications;
