import { Hono } from "hono";
import {
  buildConnectorBuilderPrompt,
  type AgentSystemPromptKind,
} from "@noma/event-agent";
import { MODELS, resolveModelId } from "@noma/shared";

const VALID_PROMPT_KINDS: ReadonlySet<AgentSystemPromptKind> = new Set<AgentSystemPromptKind>([
  "connector-builder",
]);

/**
 * OpenAI-compatible `/v1/chat/completions` proxy + tool endpoints.
 *
 * LangChain's `ChatOpenAI` sends standard OpenAI requests here.
 * This endpoint:
 *   1. Injects the system prompt when requested
 *   2. Forwards to OpenRouter with the real API key
 *   3. Streams back in OpenAI SSE format
 *
 * The client never sees or needs the API key.
 */

const openaiProxy = new Hono();

// ── Chat Completions Proxy ──────────────────────────────────────

openaiProxy.post("/chat/completions", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.messages)) {
    return c.json({ error: { message: "bad request" } }, 400);
  }

  const requestedModel = body.model ?? "";
  const modelId = resolveModelId(requestedModel);
  if (!modelId) {
    return c.json({ error: { message: `invalid model: ${requestedModel}` } }, 400);
  }
  const stream = body.stream ?? false;

  const requestedKind: AgentSystemPromptKind | undefined =
    body.systemPromptKind && VALID_PROMPT_KINDS.has(body.systemPromptKind)
      ? body.systemPromptKind
      : undefined;

  const messages = [...body.messages];
  const hasSystem = messages.some((m: any) => m.role === "system");

  if (requestedKind && !hasSystem) {
    const systemPrompt = buildConnectorBuilderPrompt();
    messages.unshift({ role: "system", content: systemPrompt });
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY ?? "";
  const baseURL =
    process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

  const upstreamBody = {
    model: modelId,
    messages,
    stream,
    tools: body.tools,
    tool_choice: body.tool_choice,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
  };

  const upstreamRes = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openrouterKey}`,
    },
    body: JSON.stringify(upstreamBody),
  });

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text().catch(() => "");
    return c.json(
      {
        error: {
          message: `upstream ${upstreamRes.status}: ${errText.slice(0, 200)}`,
        },
      },
      upstreamRes.status as any
    );
  }

  if (!stream) {
    const result = await upstreamRes.json();
    return c.json(result);
  }

  return new Response(upstreamRes.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// ── Responses API Proxy ────────────────────────────────────────
//
// codex-acp uses the OpenAI Responses API exclusively. Forward to
// OpenRouter which supports it for compatible models.

openaiProxy.post("/responses", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ error: { message: "bad request" } }, 400);
  }

  const requestedModel = body.model ?? "";
  const modelId = resolveModelId(requestedModel);
  if (!modelId) {
    return c.json({ error: { message: `invalid model: ${requestedModel}` } }, 400);
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY ?? "";
  const baseURL =
    process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

  const upstreamBody = { ...body, model: modelId };

  const upstreamRes = await fetch(`${baseURL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openrouterKey}`,
    },
    body: JSON.stringify(upstreamBody),
  });

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text().catch(() => "");
    return c.json(
      {
        error: {
          message: `upstream ${upstreamRes.status}: ${errText.slice(0, 200)}`,
        },
      },
      upstreamRes.status as any
    );
  }

  if (!body.stream) {
    const result = await upstreamRes.json();
    return c.json(result);
  }

  return new Response(upstreamRes.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// ── Models (Codex startup probe) ───────────────────────────────
//
// Codex hits /v1/models on connect to discover capabilities. Without a
// real list it logs "Could not detect context length" and falls back to
// a hardcoded default — annoying noise, but harmless. Returning the
// shared model registry keeps the spam down and lets editors/agents pick
// IDs from the same set the desktop UI uses.

openaiProxy.get("/models", (c) => {
  return c.json({
    object: "list",
    data: MODELS.map((m) => ({
      id: m.id,
      object: "model",
      owned_by: "noma",
    })),
  });
});

export default openaiProxy;
