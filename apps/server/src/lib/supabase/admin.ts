import { createClient } from "@supabase/supabase-js";

/**
 * Secret-key client — bypasses RLS. Use ONLY from trusted server code.
 *
 * Always scope queries by user_id manually when using this client.
 */
export function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url) throw new Error("SUPABASE_URL is not set");
  if (!key) throw new Error("SUPABASE_SECRET_KEY is not set");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
