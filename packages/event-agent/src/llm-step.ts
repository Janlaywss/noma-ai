import { parseSseResponse } from "./sse-parser.js";
import type {
  AgentToolCall,
  AgentToolSchema,
  AgentSystemPromptKind,
  LlmStreamTransport,
} from "./types.js";
import type { ModelMessage } from "ai";

export type StepOutcome =
  | {
      kind: "done";
      text: string;
      toolCalls: AgentToolCall[];
      /** toolCallId -> output string. Reserved for cases where the LLM
       *  endpoint executes some tools server-side and inlines the result
       *  in the same response. The OpenAI Chat Completions wire format
       *  doesn't carry tool-results back; this map stays empty in
       *  practice. The runtime keeps the field around so a future custom
       *  endpoint that does inline server-tools can plug back in. */
      serverOutputs: Map<string, string>;
    }
  | { kind: "error"; message: string };

export type StepArgs = {
  transport: LlmStreamTransport;
  messages: ModelMessage[];
  toolSchemas: AgentToolSchema[];
  model?: string;
  systemPromptKind?: AgentSystemPromptKind;
  abortSignal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (call: AgentToolCall) => void;
  onToolResult?: (result: { toolCallId: string; output: string }) => void;
};

type ToolCallAccumulator = {
  toolCallId: string;
  toolName: string;
  argsBuffer: string;
};

/**
 * Run one LLM step against an OpenAI-compatible Chat Completions stream.
 *
 * The transport is expected to:
 *   - POST a Chat Completions request body (`model`, `messages`, `tools`,
 *     `stream: true`, plus the NOMA `systemPromptKind` extension)
 *   - return a `Response` whose body is the standard OpenAI SSE: each
 *     frame's `data` is a chunk JSON `{choices:[{delta:{...}}]}`, ending
 *     with the literal `data: [DONE]`
 *
 * We accumulate text deltas and tool-call arg fragments here, fire the
 * supplied callbacks for incremental progress, and return a `StepOutcome`
 * describing the completed step (or an error).
 */
export async function oneModelStep(args: StepArgs): Promise<StepOutcome> {
  const res = await args.transport(
    {
      model: args.model || undefined,
      systemPromptKind: args.systemPromptKind,
      messages: args.messages,
      toolSchemas: args.toolSchemas,
    },
    { signal: args.abortSignal }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      kind: "error",
      message: `llm ${res.status}: ${text.slice(0, 200)}`,
    };
  }

  let stepText = "";
  const toolCallsByIndex = new Map<number, ToolCallAccumulator>();
  let errorMsg: string | null = null;

  for await (const frame of parseSseResponse(res)) {
    const raw = frame.data?.trim();
    if (!raw) continue;
    if (raw === "[DONE]") break;

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      continue;
    }
    const chunk = payload as {
      choices?: Array<{
        delta?: {
          content?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
      error?: { message?: string } | string;
    };

    if (chunk.error) {
      errorMsg =
        typeof chunk.error === "string"
          ? chunk.error
          : (chunk.error.message ?? JSON.stringify(chunk.error));
      continue;
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};

    if (typeof delta.content === "string" && delta.content.length > 0) {
      stepText += delta.content;
      args.onTextDelta?.(delta.content);
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === "number" ? tc.index : 0;
        const acc = toolCallsByIndex.get(idx) ?? {
          toolCallId: "",
          toolName: "",
          argsBuffer: "",
        };
        if (tc.id) acc.toolCallId = tc.id;
        if (tc.function?.name) acc.toolName = tc.function.name;
        if (typeof tc.function?.arguments === "string") {
          acc.argsBuffer += tc.function.arguments;
        }
        toolCallsByIndex.set(idx, acc);
      }
    }
  }

  if (errorMsg) return { kind: "error", message: errorMsg };

  const toolCalls: AgentToolCall[] = [];
  for (const acc of toolCallsByIndex.values()) {
    if (!acc.toolCallId || !acc.toolName) continue;
    let input: Record<string, unknown> = {};
    if (acc.argsBuffer.length > 0) {
      try {
        const parsed = JSON.parse(acc.argsBuffer);
        if (parsed && typeof parsed === "object") {
          input = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed arguments — surface as an error so the runtime can
        // bail rather than passing garbage to the tool handler.
        return {
          kind: "error",
          message: `llm: tool '${acc.toolName}' arguments not valid JSON: ${acc.argsBuffer.slice(0, 120)}`,
        };
      }
    }
    const call: AgentToolCall = {
      toolCallId: acc.toolCallId,
      toolName: acc.toolName,
      input,
    };
    toolCalls.push(call);
    args.onToolCall?.(call);
  }

  return {
    kind: "done",
    text: stepText,
    toolCalls,
    serverOutputs: new Map<string, string>(),
  };
}
