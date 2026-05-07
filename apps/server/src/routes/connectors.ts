import { Hono } from "hono";
import { withLocalUser, type LocalUserEnv } from "@/middleware/local-user";

// Local user context is applied per-route, NOT via `*`. The OAuth callback at
// /api/connectors/gmail/oauth/callback (registered in connectors-oauth.ts and
// also mounted at /api/connectors) must stay callable by Google.
const connectors = new Hono<LocalUserEnv>();

connectors.get("/", withLocalUser, async (c) => {
  const { data, error } = await c
    .get("supabase")
    .from("connector_configs")
    .select("*")
    .eq("user_id", c.get("userId"));
  if (error) return c.text(error.message, 500);
  return c.json(data ?? []);
});

/** Single-connector read. Used by the config form (needs the stored
 *  `config` JSON) and the detail view (needs only `enabled`). */
connectors.get("/:name", withLocalUser, async (c) => {
  const { data, error } = await c
    .get("supabase")
    .from("connector_configs")
    .select("*")
    .eq("user_id", c.get("userId"))
    .eq("connector_name", c.req.param("name"))
    .maybeSingle();
  if (error) return c.text(error.message, 500);
  return c.json(data ?? null);
});

connectors.put("/:name", withLocalUser, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    enabled?: boolean;
    config?: Record<string, unknown>;
    status?: Record<string, unknown>;
  } | null;
  if (!body) return c.text("missing body", 400);
  const patch: Record<string, unknown> = {
    user_id: c.get("userId"),
    connector_name: c.req.param("name"),
    updated_at: new Date().toISOString(),
  };
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if (body.config !== undefined) patch.config = body.config;
  // status writes come from the local tick runner persisting cursors
  // (lastModified, alertedAt, tokenExp…) — needed so a second Electron
  // instance on another device doesn't re-emit events the first one
  // already handled.
  if (body.status !== undefined) patch.status = body.status;
  const { data, error } = await c
    .get("supabase")
    .from("connector_configs")
    .upsert(patch, { onConflict: "user_id,connector_name" })
    .select("*")
    .single();
  if (error) return c.text(error.message, 500);
  return c.json(data);
});

// ─── per-connector key-value storage ───────────────────────────

connectors.get("/:name/storage/:key", withLocalUser, async (c) => {
  const { data, error } = await c
    .get("supabase")
    .from("connector_storage")
    .select("value")
    .eq("user_id", c.get("userId"))
    .eq("connector_name", c.req.param("name"))
    .eq("key", c.req.param("key"))
    .maybeSingle();
  if (error) return c.text(error.message, 500);
  return c.json({ value: data?.value ?? null });
});

connectors.put("/:name/storage/:key", withLocalUser, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    value?: string;
  } | null;
  if (!body || typeof body.value !== "string") {
    return c.text("missing string value", 400);
  }
  const { error } = await c
    .get("supabase")
    .from("connector_storage")
    .upsert(
      {
        user_id: c.get("userId"),
        connector_name: c.req.param("name"),
        key: c.req.param("key"),
        value: body.value,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,connector_name,key" }
    );
  if (error) return c.text(error.message, 500);
  return c.body(null, 204);
});

connectors.delete("/:name/storage/:key", withLocalUser, async (c) => {
  const { error } = await c
    .get("supabase")
    .from("connector_storage")
    .delete()
    .eq("user_id", c.get("userId"))
    .eq("connector_name", c.req.param("name"))
    .eq("key", c.req.param("key"));
  if (error) return c.text(error.message, 500);
  return c.body(null, 204);
});

export default connectors;
