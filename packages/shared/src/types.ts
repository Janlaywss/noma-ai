export type MessageRole = "user" | "assistant";

export type ToolCallStatus = "running" | "success" | "error";

export type ToolCall = {
  id: string;
  /** Which connector this tool belongs to — drives the icon + tile color. */
  connectorId: string;
  /** Server-defined tool identifier. Shown in mono font. */
  toolName: string;
  /** Short label to show inline. Omitted → fall back to tool name. */
  label?: string;
  status: ToolCallStatus;
  /** Optional request input shown when expanded. */
  input?: Record<string, unknown>;
  /** Optional rendered output shown when expanded (plain text / lightly formatted). */
  output?: string;
  /** Milliseconds spent. Displayed as e.g. "0.8s". */
  durationMs?: number;
  /** Sub-agent tool calls nested inside this parent tool (e.g. createConnector's children). */
  children?: ToolCall[];
};

/**
 * One ordered segment of an assistant message. The renderer walks `parts`
 * in array order so a tool that fires between two text spans appears
 * between them — not stacked above the whole reply.
 *
 * `tool` parts are pointers, not snapshots: the toolCallId resolves into
 * the message's `toolCalls[]` so the latest status (running → success)
 * keeps flowing without rewriting the parts list.
 */
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "tool"; toolCallId: string };

export type Message = {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  /** Assistant-only. Snapshots referenced by `parts` of type `tool`. */
  toolCalls?: ToolCall[];
  /** Assistant-only. Ordered text/tool segments in the order the model
   *  emitted them. Older messages may lack this — fall back to
   *  toolCalls-then-content rendering. */
  parts?: MessagePart[];
};
