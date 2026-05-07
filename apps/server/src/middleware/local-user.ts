import { Hono, type MiddlewareHandler } from "hono";
import { supabaseAdmin } from "@/lib/supabase/admin";

type LocalSupabase = ReturnType<typeof supabaseAdmin>;

export type LocalUserEnv = {
  Variables: {
    userId: string;
    supabase: LocalSupabase;
  };
};

/**
 * Local-only user context for routes that operate on user-owned data.
 *
 * Login/signup and request-time user authentication have been removed. The
 * server now runs against one configured local user id and scopes all admin
 * Supabase queries with that id manually.
 *
 * Set `NOMA_LOCAL_USER_ID` for a stable local UUID. The fallback keeps local
 * smoke and type-only flows from crashing.
 */
export const withLocalUser: MiddlewareHandler<LocalUserEnv> = async (c, next) => {
  c.set("userId", localUserId());
  c.set("supabase", supabaseAdmin());
  await next();
};

/** Must be a valid UUID — Supabase columns are typed uuid. */
function localUserId(): string {
  return process.env.NOMA_LOCAL_USER_ID?.trim() || "00000000-0000-0000-0000-000000000000";
}

export function localUserRouter() {
  const r = new Hono<LocalUserEnv>();
  r.use("*", withLocalUser);
  return r;
}
