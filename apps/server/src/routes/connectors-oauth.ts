import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { withLocalUser, type LocalUserEnv } from "@/middleware/local-user";
import { getDb } from "@/db/index";

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

const connectorsOAuth = new Hono<LocalUserEnv>();

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

  const db = getDb();
  const config = JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
    expires_at: Date.now() + tokens.expires_in * 1000,
    email,
  });

  db.prepare(
    `INSERT INTO connector_configs (user_id, connector_name, config, enabled, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(user_id, connector_name)
     DO UPDATE SET config = excluded.config, enabled = excluded.enabled, updated_at = excluded.updated_at`
  ).run(userId, "gmail", config, new Date().toISOString());

  return c.html(oauthResultPage(true));
});

connectorsOAuth.post("/gmail/oauth/refresh", withLocalUser, async (c) => {
  const env = getGoogleEnv();
  if (!env) return c.text("Google OAuth not configured", 503);

  const userId = c.get("userId");
  const db = c.get("db");

  const row = db
    .prepare(
      "SELECT config FROM connector_configs WHERE user_id = ? AND connector_name = ?"
    )
    .get(userId, "gmail") as { config: string } | undefined;

  const config = row
    ? (JSON.parse(row.config) as { refresh_token?: string | null })
    : null;
  if (!config?.refresh_token) {
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
  const now = new Date().toISOString();

  const upsertStorage = db.prepare(
    `INSERT INTO connector_storage (user_id, connector_name, key, value, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, connector_name, key)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  upsertStorage.run(userId, "gmail", "access_token", tokens.access_token, now);
  upsertStorage.run(userId, "gmail", "expires_at", String(expires_at), now);

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
