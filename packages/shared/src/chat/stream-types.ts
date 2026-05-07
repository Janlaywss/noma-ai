/**
 * Shared vocabulary between the worker (writes Redis Stream entries),
 * the SSE endpoint (forwards Redis entries to the browser), and the
 * client hook (parses SSE events).
 *
 * Redis Stream field values are flat strings, so structured payloads
 * (tool calls) get JSON-serialized into a single `payload` field rather
 * than spread across multiple fields.
 */

export type ChatEventKind = "text" | "tool" | "done" | "error";

export interface ChatToolCallPayload {
  toolCallId: string;
  toolName: string;
  state:
    | "input-streaming"
    | "input-available"
    | "output-available"
    | "output-error";
  input?: Record<string, unknown>;
  output?: unknown;
  errorText?: string;
}

/** The typed shape of a ChatEventKind='text' event, post-decoding. */
export interface TextEvent {
  kind: "text";
  delta: string;
  cumulative: string;
}

/** The typed shape of a ChatEventKind='tool' event, post-decoding. */
export interface ToolEvent {
  kind: "tool";
  payload: ChatToolCallPayload;
}

export interface DoneEvent {
  kind: "done";
  cumulative: string;
}

export interface ErrorEvent {
  kind: "error";
  message: string;
}

export type ChatStreamEvent = TextEvent | ToolEvent | DoneEvent | ErrorEvent;

// ── Redis-side (flat-string fields) ──

/** Fields on a `kind='text'` Redis Stream entry. */
export interface RedisTextFields {
  kind: "text";
  delta: string;
  cumulative: string;
}

/** Fields on a `kind='tool'` entry. `payload` is JSON-stringified
 *  `ChatToolCallPayload`. */
export interface RedisToolFields {
  kind: "tool";
  payload: string;
}

export interface RedisDoneFields {
  kind: "done";
  cumulative: string;
}

export interface RedisErrorFields {
  kind: "error";
  message: string;
}

export type RedisEventFields =
  | RedisTextFields
  | RedisToolFields
  | RedisDoneFields
  | RedisErrorFields;

/** Decode a Redis Stream entry (flat field map) into a structured event. */
export function decodeRedisFields(
  fields: Record<string, string>
): ChatStreamEvent | null {
  const kind = fields.kind;
  if (kind === "text") {
    return {
      kind: "text",
      delta: fields.delta ?? "",
      cumulative: fields.cumulative ?? "",
    };
  }
  if (kind === "tool") {
    try {
      return { kind: "tool", payload: JSON.parse(fields.payload) };
    } catch {
      return null;
    }
  }
  if (kind === "done") {
    return { kind: "done", cumulative: fields.cumulative ?? "" };
  }
  if (kind === "error") {
    return { kind: "error", message: fields.message ?? "error" };
  }
  return null;
}

// ── SSE-side (text protocol) ──

const encoder = new TextEncoder();

/** Encode a single SSE event. Optional `id` becomes the `id:` field which
 *  the browser auto-replays on reconnect via `Last-Event-ID`. */
export function sseEvent(opts: {
  id?: string;
  event: string;
  data: unknown;
}): Uint8Array {
  const parts: string[] = [];
  if (opts.id) parts.push(`id: ${opts.id}`);
  parts.push(`event: ${opts.event}`);
  parts.push(`data: ${JSON.stringify(opts.data)}`);
  return encoder.encode(parts.join("\n") + "\n\n");
}

/** Comment-only SSE frame used as a heartbeat to keep the connection open
 *  through proxies that idle-kill silent sockets. */
export function sseHeartbeat(): Uint8Array {
  return encoder.encode(`: ping ${Date.now()}\n\n`);
}

/** A one-shot SSE body for routes that emit a single terminal event. */
export function sseOnce(opts: { event: string; data: unknown }): ReadableStream {
  return new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(sseEvent(opts));
      ctrl.close();
    },
  });
}

export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Disable Vercel / nginx response buffering so deltas flush immediately.
  "x-accel-buffering": "no",
};
