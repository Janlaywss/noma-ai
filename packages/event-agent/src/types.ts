import type { ModelMessage } from "ai";

export type Awaitable<T> = T | Promise<T>;
export type AgentSystemPromptKind = "connector-builder";

export type AgentToolSchema = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: false;
  };
};

export type AgentToolCall = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};

export type AgentToolResult = {
  toolCallId: string;
  toolName: string;
  output: string;
};

export type AgentToolCallSnapshot = {
  toolCallId: string;
  toolName: string;
  state: "input-available" | "output-available" | "output-error";
  input?: Record<string, unknown>;
  output?: unknown;
  errorText?: string;
};

export type AgentMessagePart =
  | { type: "text"; text: string }
  | { type: "tool"; toolCallId: string };

export type AgentRunEvent =
  | { kind: "text"; delta: string; cumulative: string }
  | { kind: "tool"; payload: AgentToolCallSnapshot }
  | { kind: "thought"; content: string }
  | { kind: "reflection"; content: string; isComplete: boolean }
  | { kind: "done"; cumulative: string }
  | { kind: "error"; message: string };

export type AgentRunStatus =
  | "running"
  | "done"
  | "error"
  | "canceled"
  | "aborted";

export type AgentRunContext = {
  runId: string;
  model: string;
};

export type AgentConversationHooks = {
  appendUserMessage?: (
    input: AgentRunContext & { content: string }
  ) => Awaitable<void>;
  loadMessages: (input: AgentRunContext) => Awaitable<ModelMessage[]>;
  finalizeAssistantMessage?: (
    input: AgentRunContext & { content: string }
  ) => Awaitable<void>;
};

export type AgentStreamHooks = {
  publish?: (
    input: AgentRunContext & { event: AgentRunEvent }
  ) => Awaitable<void>;
};

export type AgentLifecycleHooks = {
  getAbortSignal?: (input: AgentRunContext) => AbortSignal | undefined;
  onError?: (
    input: AgentRunContext & { message: string }
  ) => Awaitable<void>;
  onFinish?: (
    input: AgentRunContext & { cumulative: string }
  ) => Awaitable<void>;
};

export type AgentHooks = AgentConversationHooks &
  AgentStreamHooks &
  AgentLifecycleHooks;

export type AgentToolSet = {
  listSchemas: () => AgentToolSchema[];
  execute: (call: AgentToolCall) => Awaitable<string>;
};

export type LlmStreamRequest = {
  model?: string;
  systemPromptKind?: AgentSystemPromptKind;
  messages: ModelMessage[];
  toolSchemas: AgentToolSchema[];
};

export type LlmStreamTransport = (
  request: LlmStreamRequest,
  init?: { signal?: AbortSignal }
) => Promise<Response>;

// ReAct types

export type ReactLoopMode = "react";

export type TaskCompleteInput = {
  summary: string;
  result?: string;
};

export type ReactStepPhase = "thought" | "action" | "observation" | "reflection";
