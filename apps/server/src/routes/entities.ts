import { localUserRouter } from "@/middleware/local-user";

const entities = localUserRouter();

entities.get("/", async (c) => {
  const db = c.get("db");
  const rows = db
    .prepare(
      "SELECT * FROM entities WHERE user_id = ? ORDER BY created_at ASC"
    )
    .all(c.get("userId"));
  return c.json(rows);
});

entities.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    slug?: string;
    label?: string;
    description?: string;
  } | null;
  if (!body?.slug || !body?.label) return c.text("missing slug/label", 400);

  const db = c.get("db");
  const info = db
    .prepare(
      "INSERT INTO entities (user_id, slug, label, description) VALUES (?, ?, ?, ?)"
    )
    .run(c.get("userId"), body.slug, body.label, body.description ?? null);

  const row = db
    .prepare("SELECT * FROM entities WHERE rowid = ?")
    .get(info.lastInsertRowid);
  return c.json(row, 201);
});

entities.delete("/:id", async (c) => {
  const db = c.get("db");
  db.prepare("DELETE FROM entities WHERE user_id = ? AND id = ?").run(
    c.get("userId"),
    c.req.param("id")
  );
  return c.body(null, 204);
});

entities.get("/:id/memory", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 200), 500);
  const db = c.get("db");
  const rows = db
    .prepare(
      `SELECT * FROM entity_memory
       WHERE user_id = ? AND entity_id = ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(c.get("userId"), c.req.param("id"), limit) as Array<
    Record<string, unknown>
  >;

  return c.json(rows.map(parseMemoryRow));
});

entities.post("/:id/memory", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    content?: string;
    tags?: string[];
    source_event_id?: string | null;
  } | null;
  if (!body?.content) return c.text("missing content", 400);

  const db = c.get("db");
  const info = db
    .prepare(
      "INSERT INTO entity_memory (user_id, entity_id, content, tags, source_event_id) VALUES (?, ?, ?, ?, ?)"
    )
    .run(
      c.get("userId"),
      c.req.param("id"),
      body.content,
      JSON.stringify(body.tags ?? []),
      body.source_event_id ?? null
    );

  const row = db
    .prepare("SELECT * FROM entity_memory WHERE rowid = ?")
    .get(info.lastInsertRowid) as Record<string, unknown>;
  return c.json(parseMemoryRow(row), 201);
});

function parseMemoryRow(r: Record<string, unknown>) {
  return {
    ...r,
    tags:
      typeof r.tags === "string" ? JSON.parse(r.tags) : r.tags ?? [],
  };
}

export default entities;
