import { localUserRouter } from "@/middleware/local-user";

const channelConfigs = localUserRouter();

channelConfigs.get("/", async (c) => {
  const db = c.get("db");
  const rows = db
    .prepare("SELECT * FROM channel_configs WHERE user_id = ?")
    .all(c.get("userId")) as Array<Record<string, unknown>>;
  return c.json(rows.map(parseRow));
});

channelConfigs.put("/:name", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    enabled?: boolean;
    config?: Record<string, unknown>;
  } | null;
  if (!body) return c.text("missing body", 400);

  const db = c.get("db");
  const userId = c.get("userId");
  const name = c.req.param("name");
  const now = new Date().toISOString();

  const existing = db
    .prepare(
      "SELECT * FROM channel_configs WHERE user_id = ? AND channel_name = ?"
    )
    .get(userId, name) as Record<string, unknown> | undefined;

  if (existing) {
    const sets: string[] = ["updated_at = ?"];
    const vals: unknown[] = [now];
    if (body.enabled !== undefined) {
      sets.push("enabled = ?");
      vals.push(body.enabled ? 1 : 0);
    }
    if (body.config !== undefined) {
      sets.push("config = ?");
      vals.push(JSON.stringify(body.config));
    }
    vals.push(userId, name);
    db.prepare(
      `UPDATE channel_configs SET ${sets.join(", ")} WHERE user_id = ? AND channel_name = ?`
    ).run(...vals);
  } else {
    db.prepare(
      `INSERT INTO channel_configs (user_id, channel_name, enabled, config, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      userId,
      name,
      body.enabled ? 1 : 0,
      JSON.stringify(body.config ?? {}),
      now
    );
  }

  const row = db
    .prepare(
      "SELECT * FROM channel_configs WHERE user_id = ? AND channel_name = ?"
    )
    .get(userId, name) as Record<string, unknown>;
  return c.json(parseRow(row));
});

function parseRow(r: Record<string, unknown>) {
  return {
    ...r,
    enabled: r.enabled === 1 || r.enabled === true,
    config:
      typeof r.config === "string"
        ? JSON.parse(r.config)
        : r.config ?? {},
    status:
      typeof r.status === "string"
        ? JSON.parse(r.status)
        : r.status ?? {},
  };
}

export default channelConfigs;
