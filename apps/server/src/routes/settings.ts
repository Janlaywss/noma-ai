import { localUserRouter } from "@/middleware/local-user";

const settings = localUserRouter();

/** Returns `{ value }` rather than the whole row — callers only care
 *  about the stored JSON. 404 is distinct from a literal null value
 *  stored on the key. */
settings.get("/:key", async (c) => {
  const { data, error } = await c
    .get("supabase")
    .from("user_settings")
    .select("value")
    .eq("user_id", c.get("userId"))
    .eq("key", c.req.param("key"))
    .maybeSingle();
  if (error) return c.text(error.message, 500);
  if (!data) return c.json({ value: null });
  return c.json({ value: data.value });
});

settings.put("/:key", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    value?: unknown;
  } | null;
  if (!body || !("value" in body)) return c.text("missing value", 400);
  const { data, error } = await c
    .get("supabase")
    .from("user_settings")
    .upsert(
      {
        user_id: c.get("userId"),
        key: c.req.param("key"),
        value: body.value,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,key" }
    )
    .select("*")
    .single();
  if (error) return c.text(error.message, 500);
  return c.json(data);
});

export default settings;
