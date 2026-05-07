import { localUserRouter } from "@/middleware/local-user";

const session = localUserRouter();

session.get("/messages", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 400), 1000);
  const { data, error } = await c
    .get("supabase")
    .from("session_memory")
    .select("*")
    .eq("user_id", c.get("userId"))
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) return c.text(error.message, 500);
  return c.json(data ?? []);
});

session.delete("/messages", async (c) => {
  const { error } = await c
    .get("supabase")
    .from("session_memory")
    .delete()
    .eq("user_id", c.get("userId"));
  if (error) return c.text(error.message, 500);
  return c.body(null, 204);
});

export default session;
