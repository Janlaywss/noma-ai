import type { Message, MessagePart, ToolCall, ToolCallStatus } from "../types.js";
import type { SessionMessageRow } from "../supabase/types.js";
import type { ChatStreamEvent, ChatToolCallPayload } from "./stream-types.js";

/** Flatten session_memory rows into `Message[]` for direct rendering.
 *  Hydrates `toolCalls` and `parts` from the row's `meta` bag so a
 *  refresh reconstructs the tool blocks AND their stream-order placement
 *  alongside the text. Older rows lacking `parts` render via the
 *  legacy tools-then-text path. */
export function rowsToMessages(rows: SessionMessageRow[]): Message[] {
  return rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => {
      const toolCalls =
        r.role === "assistant" ? extractStoredToolCalls(r.meta) : undefined;
      const parts =
        r.role === "assistant" ? extractStoredParts(r.meta) : undefined;
      return {
        id: r.id,
        role: r.role as "user" | "assistant",
        content: r.content,
        createdAt: Date.parse(r.created_at),
        toolCalls,
        parts,
      };
    });
}

function extractStoredParts(
  meta: Record<string, unknown> | null
): MessagePart[] | undefined {
  if (!meta) return undefined;
  const raw = (meta as { parts?: unknown }).parts;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: MessagePart[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const p = entry as { type?: unknown; text?: unknown; toolCallId?: unknown };
    if (p.type === "text" && typeof p.text === "string") {
      out.push({ type: "text", text: p.text });
    } else if (p.type === "tool" && typeof p.toolCallId === "string") {
      out.push({ type: "tool", toolCallId: p.toolCallId });
    }
  }
  return out.length > 0 ? out : undefined;
}

function extractStoredToolCalls(
  meta: Record<string, unknown> | null
): ToolCall[] | undefined {
  if (!meta) return undefined;
  const raw = (meta as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: ToolCall[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const p = entry as Partial<ChatToolCallPayload>;
    if (!p.toolCallId || !p.toolName || !p.state) continue;
    out.push({
      id: p.toolCallId,
      connectorId: "noma-agent",
      toolName: p.toolName,
      status: toolStatusOf(p.state),
      input: p.input,
      output:
        typeof p.output === "string"
          ? p.output
          : p.output !== undefined && p.output !== null
          ? JSON.stringify(p.output)
          : undefined,
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * In-flight assistant message reducer. The client keeps a running copy of
 * the "streaming" message and applies SSE events to it:
 *
 * - `text` with non-empty `delta`: append to the trailing text part (or
 *   start a new one if the previous part was a tool). This is what
 *   preserves the order the model emitted the segments — a tool that
 *   fires between two prose runs splits them into two text parts.
 * - `text` with empty `delta` but a non-empty `cumulative`: a catch-up
 *   snapshot from the SSE route. We can't reconstruct interleaving from
 *   a single string, so we collapse to a single text part. Tools that
 *   already streamed before this snapshot are missed (a pre-existing
 *   limitation of the catch-up path).
 * - `tool`: upsert the snapshot in `toolCalls` and ensure the part
 *   list contains a tool reference at the position it was first seen.
 *   Subsequent state updates (input-available → output-available) reuse
 *   the existing part.
 *
 * Terminal events (`done`, `error`) are handled outside the reducer —
 * they switch the UI out of streaming mode rather than update the
 * message in place.
 */
function hasRunningSubAgentParent(toolCalls: ToolCall[] | undefined): boolean {
  return (
    toolCalls?.some(
      (t) => t.toolName === SUB_AGENT_PARENT && t.status === "running"
    ) ?? false
  );
}

export function reduceStreamingMessage(
  prev: Message | null,
  runId: string,
  event: ChatStreamEvent
): Message {
  const base: Message = prev ?? {
    id: runId,
    role: "assistant",
    content: "",
    createdAt: Date.now(),
    parts: [],
  };
  const parts = base.parts ?? [];
  const inSubAgent = hasRunningSubAgentParent(base.toolCalls);

  if (event.kind === "text") {
    if (inSubAgent) return base;
    if (event.delta) {
      const lastIdx = parts.length - 1;
      const last = parts[lastIdx];
      let nextParts: MessagePart[];
      if (last && last.type === "text") {
        nextParts = parts.slice();
        nextParts[lastIdx] = { type: "text", text: last.text + event.delta };
      } else {
        nextParts = [...parts, { type: "text", text: event.delta }];
      }
      return {
        ...base,
        content: base.content + event.delta,
        parts: nextParts,
      };
    }
    if (event.cumulative && event.cumulative !== base.content) {
      return {
        ...base,
        content: event.cumulative,
        parts: [{ type: "text", text: event.cumulative }],
      };
    }
    return base;
  }

  if (event.kind === "tool") {
    const isChild =
      isSubAgentTool(event.payload.toolName) ||
      (inSubAgent && event.payload.toolName !== SUB_AGENT_PARENT);
    const toolCalls = isChild
      ? nestUnderParent(base.toolCalls ?? [], {
          id: event.payload.toolCallId,
          connectorId: "noma-agent",
          toolName: event.payload.toolName,
          label: TOOL_LABELS[event.payload.toolName],
          status: toolStatusOf(event.payload.state),
          input: event.payload.input,
          output:
            typeof event.payload.output === "string"
              ? event.payload.output
              : event.payload.output !== undefined &&
                  event.payload.output !== null
                ? JSON.stringify(event.payload.output)
                : undefined,
        })
      : mergeToolCall(base.toolCalls ?? [], event.payload);
    const skipPart =
      isChild ||
      parts.some(
        (p) => p.type === "tool" && p.toolCallId === event.payload.toolCallId
      );
    const nextParts: MessagePart[] = skipPart
      ? parts
      : [...parts, { type: "tool", toolCallId: event.payload.toolCallId }];
    return { ...base, toolCalls, parts: nextParts };
  }

  // `done` / `error` terminals: the caller should stop streaming; we
  // just reflect the latest content the event carries (if any).
  if (event.kind === "done") {
    return { ...base, content: event.cumulative || base.content };
  }

  return base;
}

const TOOL_LABELS: Record<string, string> = {
  list_connectors: "查询可用连接器",
  createConnector: "创建连接器",
  scheduleTask: "创建监听任务",
  notify: "发送通知",
  testConnectorCode: "测试连接器代码",
  saveConnector: "保存连接器",
};

const SUB_AGENT_TOOLS: ReadonlySet<string> = new Set([
  "testConnectorCode",
  "saveConnector",
]);

const SUB_AGENT_PARENT = "createConnector";

function isSubAgentTool(name: string): boolean {
  return SUB_AGENT_TOOLS.has(name);
}

function mergeToolCall(
  existing: ToolCall[],
  payload: ChatToolCallPayload
): ToolCall[] {
  const next: ToolCall = {
    id: payload.toolCallId,
    connectorId: "noma-agent",
    toolName: payload.toolName,
    label: TOOL_LABELS[payload.toolName],
    status: toolStatusOf(payload.state),
    input: payload.input,
    output:
      typeof payload.output === "string"
        ? payload.output
        : payload.output !== undefined && payload.output !== null
        ? JSON.stringify(payload.output)
        : undefined,
  };

  if (isSubAgentTool(payload.toolName)) {
    return nestUnderParent(existing, next);
  }

  const idx = existing.findIndex((t) => t.id === next.id);
  if (idx === -1) return [...existing, next];
  const copy = existing.slice();
  copy[idx] = { ...copy[idx], ...next, children: copy[idx].children };
  return copy;
}

function nestUnderParent(existing: ToolCall[], child: ToolCall): ToolCall[] {
  const parentIdx = existing.findIndex(
    (t) => t.toolName === SUB_AGENT_PARENT && t.status === "running"
  );
  if (parentIdx === -1) {
    const idx = existing.findIndex((t) => t.id === child.id);
    if (idx === -1) return [...existing, child];
    const copy = existing.slice();
    copy[idx] = child;
    return copy;
  }
  const parent = existing[parentIdx];
  const children = parent.children ?? [];
  const childIdx = children.findIndex((c) => c.id === child.id);
  const nextChildren =
    childIdx === -1
      ? [...children, child]
      : children.map((c, i) => (i === childIdx ? child : c));
  const copy = existing.slice();
  copy[parentIdx] = { ...parent, children: nextChildren };
  return copy;
}

function toolStatusOf(state: ChatToolCallPayload["state"]): ToolCallStatus {
  switch (state) {
    case "input-streaming":
    case "input-available":
      return "running";
    case "output-available":
      return "success";
    case "output-error":
      return "error";
  }
}
