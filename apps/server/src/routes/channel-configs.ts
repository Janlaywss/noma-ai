import { localUserRouter } from "@/middleware/local-user";

/**
 * User-scoped CRUD for `channel_configs` (one row per user × channel_name).
 * Kept separate from `/api/channels/:name/webhook/:slug`, which is a
 * public HMAC-verified inbound webhook.
 */
const channelConfigs = localUserRouter();

channelConfigs.get("/", async (c) => {
  const { data, error } = await c
    .get("supabase")
    .from("channel_configs")
    .select("*")
    .eq("user_id", c.get("userId"));
  if (error) return c.text(error.message, 500);
  return c.json(data ?? []);
});

channelConfigs.put("/:name", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    enabled?: boolean;
    config?: Record<string, unknown>;
  } | null;
  if (!body) return c.text("missing body", 400);
  const patch: Record<string, unknown> = {
    user_id: c.get("userId"),
    channel_name: c.req.param("name"),
    updated_at: new Date().toISOString(),
  };
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if (body.config !== undefined) patch.config = body.config;
  const { data, error } = await c
    .get("supabase")
    .from("channel_configs")
    .upsert(patch, { onConflict: "user_id,channel_name" })
    .select("*")
    .single();
  if (error) return c.text(error.message, 500);
  return c.json(data);
});

export default channelConfigs;
