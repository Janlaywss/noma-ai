import { Hono } from "hono";
import { logger } from "hono/logger";
import channels from "./routes/channels";
import entities from "./routes/entities";

import session from "./routes/session";
import connectors from "./routes/connectors";
import connectorsOAuth from "./routes/connectors-oauth";
import channelConfigs from "./routes/channel-configs";
import settings from "./routes/settings";
import openaiProxy from "./routes/openai-proxy";
import notifications from "./routes/notifications";

/**
 * Top-level Hono app. All routes live under `/api/*` so the Next
 * frontend's `rewrites` config can proxy them 1:1 without extra path
 * munging. Nothing outside `/api/*` is served here.
 *
 * In the local-first split (2026-04-23), the agent loop, tools, and
 * connector tick moved into the Electron process. The server is now a
 * thin backend that owns:
 *   - the LLM proxy (+ system-prompt assembly)
 *   - cross-device entities + observations
 *   - official-connector credentials and storage
 *   - notifications with IM fan-out (channel_configs + webhooks)
 *
 * Chat run tracking, task scheduling, events, and agent-authored
 * connectors all live in per-device SQLite. `chat_runs`, `tasks`,
 * `events`, `session_memory`, `connectors_dynamic` tables no longer
 * exist; their routes were dropped here.
 *
 * Auth model:
 *   - Login/signup and request-time user authentication are removed.
 *   - Routes run under `NOMA_LOCAL_USER_ID` and use server-side scoping.
 *   - Channel webhooks under /api/channels/<name>/webhook/<slug> remain
 *     public provider callbacks verified inside their handlers.
 */
const app = new Hono();

app.use("*", logger());

app.get("/healthz", (c) => c.text("ok"));

const api = new Hono();
api.route("/channels", channels);
api.route("/entities", entities);

api.route("/session", session);
api.route("/connectors", connectors);
api.route("/connectors", connectorsOAuth);
api.route("/channel-configs", channelConfigs);
api.route("/settings", settings);
api.route("/v1", openaiProxy);
api.route("/notifications", notifications);

app.route("/api", api);

app.notFound((c) => c.text("not found", 404));
app.onError((err, c) => {
  console.error("[server] unhandled:", err);
  return c.text("internal error", 500);
});

export default app;
