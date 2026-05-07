import { localUserRouter } from "@/middleware/local-user";

const entities = localUserRouter();

entities.get("/", async (c) => {
  const { data, error } = await c
    .get("supabase")
    .from("entities")
    .select("*")
    .eq("user_id", c.get("userId"))
    .order("created_at", { ascending: true });
  if (error) return c.text(error.message, 500);
  return c.json(data ?? []);
});

entities.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    slug?: string;
    label?: string;
    description?: string;
  } | null;
  if (!body?.slug || !body?.label) return c.text("missing slug/label", 400);
  const { data, error } = await c
    .get("supabase")
    .from("entities")
    .insert({
      user_id: c.get("userId"),
      slug: body.slug,
      label: body.label,
      description: body.description ?? null,
    })
    .select("*")
    .single();
  if (error) return c.text(error.message, 500);
  return c.json(data, 201);
});

entities.delete("/:id", async (c) => {
  const { error } = await c
    .get("supabase")
    .from("entities")
    .delete()
    .eq("user_id", c.get("userId"))
    .eq("id", c.req.param("id"));
  if (error) return c.text(error.message, 500);
  return c.body(null, 204);
});

entities.get("/:id/memory", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 200), 500);
  const { data, error } = await c
    .get("supabase")
    .from("entity_memory")
    .select("*")
    .eq("user_id", c.get("userId"))
    .eq("entity_id", c.req.param("id"))
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return c.text(error.message, 500);
  return c.json(data ?? []);
});

// Local ingest loop POSTs observations here after chewing through
// events. `source_event_id` is now an opaque string — the FK to events
// is gone (events moved to local SQLite), but keeping the id lets the
// client cross-reference back to its own DB if it needs to.
entities.post("/:id/memory", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    content?: string;
    tags?: string[];
    source_event_id?: string | null;
  } | null;
  if (!body?.content) return c.text("missing content", 400);
  const { data, error } = await c
    .get("supabase")
    .from("entity_memory")
    .insert({
      user_id: c.get("userId"),
      entity_id: c.req.param("id"),
      content: body.content,
      tags: body.tags ?? [],
      source_event_id: body.source_event_id ?? null,
    })
    .select("*")
    .single();
  if (error) return c.text(error.message, 500);
  return c.json(data, 201);
});

export default entities;
