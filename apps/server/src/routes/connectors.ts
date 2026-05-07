import { Hono } from "hono";
import { withLocalUser, type LocalUserEnv } from "@/middleware/local-user";

const connectors = new Hono<LocalUserEnv>();

connectors.get("/", withLocalUser, async (c) => {
  const db = c.get("db");
  const rows = db
    .prepare("SELECT * FROM connector_configs WHERE user_id = ?")
    .all(c.get("userId")) as Array<Record<string, unknown>>;
  return c.json(rows.map(parseConfigRow));
});

connectors.get("/:name", withLocalUser, async (c) => {
  const db = c.get("db");
  const row = db
    .prepare(
      "SELECT * FROM connector_configs WHERE user_id = ? AND connector_name = ?"
    )
    .get(c.get("userId"), c.req.param("name")) as
    | Record<string, unknown>
    | undefined;
  return c.json(row ? parseConfigRow(row) : null);
});

connectors.put("/:name", withLocalUser, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    enabled?: boolean;
    config?: Record<string, unknown>;
    status?: Record<string, unknown>;
  } | null;
  if (!body) return c.text("missing body", 400);

  const db = c.get("db");
  const userId = c.get("userId");
  const name = c.req.param("name");
  const now = new Date().toISOString();

  const existing = db
    .prepare(
      "SELECT * FROM connector_configs WHERE user_id = ? AND connector_name = ?"
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
    if (body.status !== undefined) {
      sets.push("status = ?");
      vals.push(JSON.stringify(body.status));
    }
    vals.push(userId, name);
    db.prepare(
      `UPDATE connector_configs SET ${sets.join(", ")} WHERE user_id = ? AND connector_name = ?`
    ).run(...vals);
  } else {
    db.prepare(
      `INSERT INTO connector_configs (user_id, connector_name, enabled, config, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      name,
      body.enabled ? 1 : 0,
      JSON.stringify(body.config ?? {}),
      JSON.stringify(body.status ?? {}),
      now
    );
  }

  const row = db
    .prepare(
      "SELECT * FROM connector_configs WHERE user_id = ? AND connector_name = ?"
    )
    .get(userId, name) as Record<string, unknown>;
  return c.json(parseConfigRow(row));
});

// ─── per-connector key-value storage ───────────────────────────

connectors.get("/:name/storage/:key", withLocalUser, async (c) => {
  const db = c.get("db");
  const row = db
    .prepare(
      "SELECT value FROM connector_storage WHERE user_id = ? AND connector_name = ? AND key = ?"
    )
    .get(c.get("userId"), c.req.param("name"), c.req.param("key")) as
    | { value: string }
    | undefined;
  return c.json({ value: row?.value ?? null });
});

connectors.put("/:name/storage/:key", withLocalUser, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    value?: string;
  } | null;
  if (!body || typeof body.value !== "string") {
    return c.text("missing string value", 400);
  }

  const db = c.get("db");
  db.prepare(
    `INSERT INTO connector_storage (user_id, connector_name, key, value, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, connector_name, key)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(
    c.get("userId"),
    c.req.param("name"),
    c.req.param("key"),
    body.value,
    new Date().toISOString()
  );
  return c.body(null, 204);
});

connectors.delete("/:name/storage/:key", withLocalUser, async (c) => {
  const db = c.get("db");
  db.prepare(
    "DELETE FROM connector_storage WHERE user_id = ? AND connector_name = ? AND key = ?"
  ).run(c.get("userId"), c.req.param("name"), c.req.param("key"));
  return c.body(null, 204);
});

function parseConfigRow(r: Record<string, unknown>) {
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

export default connectors;
