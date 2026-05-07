import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { withLocalUser, type LocalUserEnv } from "@/middleware/local-user";
import { supabaseAdmin } from "@/lib/supabase/admin";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

function getGoogleEnv() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectBase = process.env.PUBLIC_URL ?? "http://localhost:3000";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectBase };
}

type OAuthState = {
  userId: string;
  iat: number;
};

const OAUTH_STATE_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * OAuth flow for connectors that use external identity providers.
 *
 * Currently supports Gmail (Google OAuth2). The flow:
 *   1. GET /connectors/gmail/oauth — returns the Google consent URL
 *   2. Google redirects to GET /connectors/gmail/oauth/callback?code=…
 *   3. Server exchanges code for tokens, stores in connector_configs,
 *      renders a small HTML page that notifies the opener and closes.
 */
const connectorsOAuth = new Hono<LocalUserEnv>();

// Init endpoint uses the configured local user id as OAuth state. Apply the
// local user context to THIS path only, never with `*`, because
// `/gmail/oauth/callback` lives under the same prefix and must stay callable
// by Google.
connectorsOAuth.get("/gmail/oauth", withLocalUser, async (c) => {
  const env = getGoogleEnv();
  if (!env) return c.text("Google OAuth not configured", 503);

  const state = encodeOAuthState(c.get("userId"), env.clientSecret);
  const redirectUri = `${env.redirectBase}/api/connectors/gmail/oauth/callback`;

  const params = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });

  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  return c.json({ url });
});

/**
 * OAuth callback — public because Google redirects here. We identify the
 * local user from the `state` param that was set during the initiation step.
 */
connectorsOAuth.get("/gmail/oauth/callback", async (c) => {
  const env = getGoogleEnv();
  if (!env) return c.text("Google OAuth not configured", 503);

  const code = c.req.query("code");
  const state = c.req.query("state");
  const userId = state ? decodeOAuthState(state, env.clientSecret) : null;
  const error = c.req.query("error");

  if (error) {
    return c.html(oauthResultPage(false, error));
  }

  if (!code || !userId) {
    return c.html(oauthResultPage(false, "Missing or invalid code/state"));
  }

  const redirectUri = `${env.redirectBase}/api/connectors/gmail/oauth/callback`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.clientId,
      client_secret: env.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    console.error("[gmail/oauth] token exchange failed:", text);
    return c.html(oauthResultPage(false, "Token exchange failed"));
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
  };

  let email: string | null = null;
  try {
    const infoRes = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      { headers: { Authorization: `Bearer ${tokens.access_token}` } }
    );
    if (infoRes.ok) {
      const info = (await infoRes.json()) as { email?: string };
      email = info.email ?? null;
    }
  } catch {}

  const admin = supabaseAdmin();

  const config = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
    expires_at: Date.now() + tokens.expires_in * 1000,
    email,
  };

  const { error: dbError } = await admin
    .from("connector_configs")
    .upsert(
      {
        user_id: userId,
        connector_name: "gmail",
        config,
        enabled: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,connector_name" }
    );

  if (dbError) {
    console.error("[gmail/oauth] db upsert failed:", dbError.message);
    return c.html(oauthResultPage(false, "Failed to save credentials"));
  }

  return c.html(oauthResultPage(true));
});

/**
 * Server-side token refresh proxy. The desktop / worker call this when an
 * access_token expires or 401s. The client_secret stays here — neither the
 * Electron main process nor the utility worker needs to ship with it.
 *
 * The new access_token is also written into `connector_storage` so any
 * other process reading via `/api/connectors/:name/storage/:key` (the
 * worker on its next poll, the desktop main on its next tool call) sees
 * the fresh value without an explicit refetch.
 */
connectorsOAuth.post("/gmail/oauth/refresh", withLocalUser, async (c) => {
  const env = getGoogleEnv();
  if (!env) return c.text("Google OAuth not configured", 503);

  const userId = c.get("userId");
  const supabase = c.get("supabase");

  const { data: row, error: readErr } = await supabase
    .from("connector_configs")
    .select("config")
    .eq("user_id", userId)
    .eq("connector_name", "gmail")
    .maybeSingle();
  if (readErr) return c.text(readErr.message, 500);

  const config = (row?.config ?? {}) as { refresh_token?: string | null };
  if (!config.refresh_token) {
    return c.text("Gmail not authorized — no refresh_token on file", 404);
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      refresh_token: config.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    console.error("[gmail/oauth/refresh] failed:", text);
    return c.text("Token refresh failed", 502);
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    expires_in: number;
  };
  const expires_at = Date.now() + tokens.expires_in * 1000;
  const updatedAt = new Date().toISOString();

  // Persist for other readers. Two upserts because the table is keyed on
  // (user_id, connector_name, key); a single bulk upsert with mixed keys
  // works too, but two clear writes are easier to reason about.
  const writes = await supabase.from("connector_storage").upsert(
    [
      {
        user_id: userId,
        connector_name: "gmail",
        key: "access_token",
        value: tokens.access_token,
        updated_at: updatedAt,
      },
      {
        user_id: userId,
        connector_name: "gmail",
        key: "expires_at",
        value: String(expires_at),
        updated_at: updatedAt,
      },
    ],
    { onConflict: "user_id,connector_name,key" }
  );
  if (writes.error) {
    console.error("[gmail/oauth/refresh] storage write failed:", writes.error.message);
    // Token is still usable by the caller even if persistence failed; the
    // storage write is a cache, not the source of truth.
  }

  return c.json({ access_token: tokens.access_token, expires_at });
});

function oauthResultPage(success: boolean, error?: string): string {
  const title = success ? "Authorization Successful" : "Authorization Failed";
  const message = success
    ? "You can close this window and return to the app."
    : `Error: ${error ?? "Unknown error"}. Please try again.`;

  return `<!DOCTYPE html>
<html><head><title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; align-items: center;
    justify-content: center; min-height: 100vh; margin: 0; background: #fafafa; }
  .card { text-align: center; padding: 2rem; border-radius: 12px;
    background: white; box-shadow: 0 1px 3px rgba(0,0,0,.1); max-width: 400px; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { color: #666; font-size: .875rem; margin: 0; }
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div>
<script>
  if (window.opener) {
    window.opener.postMessage({ type: "connector-oauth-success", connector: "gmail" }, "*");
  }
  setTimeout(() => window.close(), 2000);
</script></body></html>`;
}

function encodeOAuthState(userId: string, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ userId, iat: Date.now() } satisfies OAuthState)
  ).toString("base64url");
  return `${payload}.${signStatePayload(payload, secret)}`;
}

function decodeOAuthState(state: string, secret: string): string | null {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;
  if (!safeEqual(signature, signStatePayload(payload, secret))) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as Partial<OAuthState>;
    if (typeof parsed.userId !== "string" || typeof parsed.iat !== "number") {
      return null;
    }
    if (Date.now() - parsed.iat > OAUTH_STATE_MAX_AGE_MS) return null;
    return parsed.userId;
  } catch {
    return null;
  }
}

function signStatePayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export default connectorsOAuth;
