import type { ModelMessage } from "ai";
import type { AgentSystemPromptKind, AgentToolSchema, LlmStreamRequest } from "./types.js";

/**
 * Build the OpenAI Chat Completions request body for an `LlmStreamRequest`.
 *
 * The transport layer is responsible for sending this to the LLM endpoint
 * (`/api/v1/chat/completions` in the NOMA server) — this helper handles
 * the lossy translation between the agent's `ai` SDK message shapes and
 * the wire format OpenAI / OpenRouter / Codex-shared endpoint expects.
 *
 * Translation rules:
 *   - `assistant` messages with structured content (text + tool-call
 *     parts) collapse into one OpenAI assistant message: text parts are
 *     concatenated into `content`, tool-call parts become `tool_calls`.
 *   - `tool` messages with structured `tool-result` parts fan out into
 *     one OpenAI `role: "tool"` message per result (Chat Completions
 *     requires one message per `tool_call_id`).
 *   - `AgentToolSchema` becomes `{type: "function", function: {...}}`.
 *
 * NOMA-specific fields ride along:
 *   - `systemPromptKind` — server consults it to pick a prompt template
 *     and prepend the matching `system` message. When undefined, the
 *     server forwards messages unchanged so the calling agent (Codex)
 *     stays in charge of context.
 */

export type OpenAiChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenAiTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: AgentToolSchema["inputSchema"];
  };
};

export type OpenAiChatRequest = {
  model: string | undefined;
  messages: OpenAiChatMessage[];
  tools?: OpenAiTool[];
  stream: true;
  systemPromptKind?: AgentSystemPromptKind;
};

export function buildOpenAiChatRequest(
  request: LlmStreamRequest
): OpenAiChatRequest {
  return {
    model: request.model,
    messages: convertMessages(request.messages),
    tools: convertTools(request.toolSchemas),
    stream: true,
    systemPromptKind: request.systemPromptKind,
  };
}

function convertMessages(messages: ModelMessage[]): OpenAiChatMessage[] {
  const out: OpenAiChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "user") {
      out.push({ role: msg.role, content: stringifyContent(msg.content) });
      continue;
    }

    if (msg.role === "assistant") {
      const content = msg.content;
      if (typeof content === "string") {
        out.push({ role: "assistant", content });
        continue;
      }
      if (!Array.isArray(content)) {
        out.push({ role: "assistant", content: null });
        continue;
      }

      const textParts: string[] = [];
      const toolCalls: NonNullable<
        Extract<OpenAiChatMessage, { role: "assistant" }>["tool_calls"]
      > = [];

      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as { type?: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown };
        if (p.type === "text" && typeof p.text === "string") {
          textParts.push(p.text);
        } else if (p.type === "tool-call" && p.toolCallId && p.toolName) {
          toolCalls.push({
            id: p.toolCallId,
            type: "function",
            function: {
              name: p.toolName,
              arguments: JSON.stringify(p.input ?? {}),
            },
          });
        }
      }

      out.push({
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("") : null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
      continue;
    }

    if (msg.role === "tool") {
      const content = msg.content;
      if (typeof content === "string") {
        // Unlikely with our runtime but handle defensively. Use empty
        // tool_call_id rather than dropping; OpenAI will reject and we'd
        // rather see the error than silently lose context.
        out.push({ role: "tool", tool_call_id: "", content });
        continue;
      }
      if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          const p = part as {
            type?: string;
            toolCallId?: string;
            output?: unknown;
          };
          if (p.type === "tool-result" && p.toolCallId) {
            out.push({
              role: "tool",
              tool_call_id: p.toolCallId,
              content: stringifyToolOutput(p.output),
            });
          }
        }
      }
      continue;
    }
  }

  return out;
}

function convertTools(schemas: AgentToolSchema[]): OpenAiTool[] | undefined {
  if (!schemas.length) return undefined;
  return schemas.map((s) => ({
    type: "function",
    function: {
      name: s.name,
      description: s.description,
      parameters: s.inputSchema,
    },
  }));
}

function stringifyContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const p = part as { type?: string; text?: string };
      return p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .join("");
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  if (typeof output === "object") {
    // ai SDK wraps text outputs as `{ type: "text", value: "..." }`.
    const o = output as { type?: string; value?: unknown };
    if (o.type === "text" && typeof o.value === "string") return o.value;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}
