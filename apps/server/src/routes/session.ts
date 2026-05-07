import { localUserRouter } from "@/middleware/local-user";

const session = localUserRouter();

session.get("/messages", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 400), 1000);
  const db = c.get("db");
  const userId = c.get("userId");

  const rows = db
    .prepare(
      "SELECT * FROM session_memory WHERE user_id = ? ORDER BY created_at ASC LIMIT ?"
    )
    .all(userId, limit) as Array<Record<string, unknown>>;

  return c.json(rows.map(parseSessionRow));
});

session.delete("/messages", async (c) => {
  const db = c.get("db");
  db.prepare("DELETE FROM session_memory WHERE user_id = ?").run(
    c.get("userId")
  );
  return c.body(null, 204);
});

function parseSessionRow(r: Record<string, unknown>) {
  return {
    ...r,
    meta: typeof r.meta === "string" ? JSON.parse(r.meta) : r.meta ?? null,
  };
}

export default session;
