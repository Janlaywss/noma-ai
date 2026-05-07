import { localUserRouter } from "@/middleware/local-user";

const settings = localUserRouter();

settings.get("/:key", async (c) => {
  const db = c.get("db");
  const row = db
    .prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = ?")
    .get(c.get("userId"), c.req.param("key")) as
    | { value: string }
    | undefined;

  if (!row) return c.json({ value: null });
  return c.json({ value: JSON.parse(row.value) });
});

settings.put("/:key", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    value?: unknown;
  } | null;
  if (!body || !("value" in body)) return c.text("missing value", 400);

  const db = c.get("db");
  const userId = c.get("userId");
  const key = c.req.param("key");
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(userId, key, JSON.stringify(body.value), now);

  const row = db
    .prepare("SELECT * FROM user_settings WHERE user_id = ? AND key = ?")
    .get(userId, key) as Record<string, unknown>;

  return c.json({ ...row, value: JSON.parse(row.value as string) });
});

export default settings;
