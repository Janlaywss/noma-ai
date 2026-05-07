import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  type Agent,
  type Client,
  type ContentBlock,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentRunEvent } from "@noma/event-agent";

export type AcpMcpServerConfig = {
  name: string;
  command: string;
  args: string[];
  env?: Array<{ name: string; value: string }>;
};

export type AcpBridgeConfig = {
  /** Path to the codex-acp binary (or any ACP server). */
  command: string;
  args?: string[];
  /** Extra env vars to merge into the subprocess. */
  env?: Record<string, string | undefined>;
  /** Working directory for the subprocess. */
  cwd?: string;
  /** Optional MCP servers to wire into every new session. */
  mcpServers?: AcpMcpServerConfig[];
};

export type PromptCallbacks = {
  /** Called for each agent-emitted update during the prompt turn. */
  onEvent: (event: AgentRunEvent) => void;
  /** Optional permission request handler — defaults to `allow_always`. */
  onPermissionRequest?: (
    params: RequestPermissionRequest
  ) => Promise<RequestPermissionResponse>;
};

export type AcpTranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "thought"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      state: "input-available" | "output-available" | "output-error";
      input?: Record<string, unknown>;
      output?: unknown;
    }
  | {
      kind: "session_info";
      title?: string | null;
      updatedAt?: string | null;
    }
  | { kind: "usage"; usage: unknown };

export type AcpPromptTranscript = {
  response: PromptResponse;
  transcript: AcpTranscriptItem[];
};

export type AcpLoadedSession = {
  response: LoadSessionResponse;
  transcript: AcpTranscriptItem[];
};

/**
 * Thin wrapper around the official ACP TypeScript SDK that drives a
 * Codex-style ACP agent over a child-process stdio pipe.
 *
 * Lifecycle:
 *   - `start()` spawns the agent and finishes the ACP `initialize`
 *     handshake.
 *   - `newSession(cwd)` opens a session, optionally attaching the MCP
 *     servers configured on the bridge.
 *   - `prompt(sessionId, text, callbacks)` sends a user prompt and
 *     pumps the agent's `session/update` notifications back through
 *     `callbacks.onEvent` translated into `AgentRunEvent`s. Resolves
 *     with the agent's `stopReason` once the turn ends.
 *   - `cancel(sessionId)` aborts an in-flight prompt.
 *   - `stop()` tears down the subprocess.
 *
 * Bridge defers UI/persistence concerns to the caller. Coordinator,
 * SQLite, and SSE plumbing all live one level up in the desktop app.
 */
export class AcpAgentBridge {
  private proc: ChildProcess | undefined;
  private conn: ClientSideConnection | undefined;
  private readonly handlers = new Map<
    string,
    PromptCallbacks
  >();
  private readonly transcriptHandlers = new Map<
    string,
    (update: SessionUpdate) => void
  >();
  private readonly mcpServers: AcpMcpServerConfig[];

  constructor(private readonly config: AcpBridgeConfig) {
    this.mcpServers = config.mcpServers ?? [];
  }

  async start(): Promise<InitializeResponse> {
    if (this.proc) throw new Error("ACP bridge already started");

    const proc = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.config.env },
      cwd: this.config.cwd,
    });
    this.proc = proc;

    proc.stderr?.on("data", (chunk: Buffer) => {
      // Forward stderr verbatim — Codex routes all logs there and we
      // want them visible while debugging.
      process.stderr.write(`[acp] ${chunk}`);
    });

    proc.on("exit", (code, signal) => {
      console.error(`[acp] subprocess exited code=${code} signal=${signal}`);
      this.proc = undefined;
      this.conn = undefined;
    });

    if (!proc.stdout || !proc.stdin) {
      throw new Error("ACP subprocess stdout/stdin unavailable");
    }

    const stream = ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
    );

    this.conn = new ClientSideConnection(
      (_agent: Agent): Client => this.makeClient(),
      stream
    );

    const initResult = await this.conn.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });

    if (initResult.authMethods && initResult.authMethods.length > 0) {
      const envVarMethod = initResult.authMethods.find(
        (m) => "vars" in m
      );
      const methodId = envVarMethod?.id ?? initResult.authMethods[0].id;
      await this.conn.authenticate({ methodId });
    }

    return initResult;
  }

  async newSession(cwd: string): Promise<string> {
    const conn = this.requireConn();
    const res = await conn.newSession({
      cwd,
      mcpServers: this.mcpServers.map((s) => ({
        type: "stdio",
        name: s.name,
        command: s.command,
        args: s.args,
        env: s.env ?? [],
      })),
    });
    return res.sessionId;
  }

  async listSessions(
    params: ListSessionsRequest = {}
  ): Promise<ListSessionsResponse> {
    const conn = this.requireConn();
    return conn.listSessions(params);
  }

  /**
   * Reattach to an existing session the agent persisted across
   * subprocess restarts. Returns `false` when the agent reports the
   * session is gone (the caller should fall back to `newSession`).
   */
  async loadSession(cwd: string, sessionId: string): Promise<boolean> {
    const conn = this.requireConn();
    try {
      await conn.loadSession({
        cwd,
        sessionId,
        mcpServers: this.mcpServers.map((s) => ({
          type: "stdio",
          name: s.name,
          command: s.command,
          args: s.args,
          env: s.env ?? [],
        })),
      });
      return true;
    } catch (err) {
      console.warn(
        `[acp] loadSession(${sessionId}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  async loadSessionTranscript(
    cwd: string,
    sessionId: string
  ): Promise<AcpLoadedSession> {
    const conn = this.requireConn();
    const transcript: AcpTranscriptItem[] = [];
    this.transcriptHandlers.set(sessionId, (update) => {
      const item = transcriptItemOf(update);
      if (item) transcript.push(item);
    });
    try {
      const response = await conn.loadSession({
        cwd,
        sessionId,
        mcpServers: this.mcpServers.map((s) => ({
          type: "stdio",
          name: s.name,
          command: s.command,
          args: s.args,
          env: s.env ?? [],
        })),
      });
      return { response, transcript };
    } finally {
      this.transcriptHandlers.delete(sessionId);
    }
  }

  async prompt(
    sessionId: string,
    text: string,
    callbacks: PromptCallbacks
  ): Promise<PromptResponse> {
    const conn = this.requireConn();
    this.handlers.set(sessionId, callbacks);
    try {
      return await conn.prompt({
        sessionId,
        prompt: [{ type: "text", text }],
      });
    } finally {
      this.handlers.delete(sessionId);
    }
  }

  async promptWithTranscript(
    sessionId: string,
    text: string,
    callbacks: PromptCallbacks
  ): Promise<AcpPromptTranscript> {
    const transcript: AcpTranscriptItem[] = [];
    this.transcriptHandlers.set(sessionId, (update) => {
      const item = transcriptItemOf(update);
      if (item) transcript.push(item);
    });
    try {
      const response = await this.prompt(sessionId, text, callbacks);
      return { response, transcript };
    } finally {
      this.transcriptHandlers.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const conn = this.requireConn();
    await conn.cancel({ sessionId });
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 2000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.proc = undefined;
    this.conn = undefined;
  }

  isRunning(): boolean {
    return Boolean(this.proc && this.conn);
  }

  private requireConn(): ClientSideConnection {
    if (!this.conn) throw new Error("ACP bridge not started");
    return this.conn;
  }

  private readonly toolStates = new Map<
    string,
    {
      toolCallId: string;
      toolName: string;
      state: "input-available" | "output-available" | "output-error";
      input?: Record<string, unknown>;
      output?: unknown;
      errorText?: string;
    }
  >();

  private makeClient(): Client {
    return {
      sessionUpdate: async (params: SessionNotification) => {
        this.transcriptHandlers.get(params.sessionId)?.(params.update);
        const handler = this.handlers.get(params.sessionId);
        if (!handler) return;
        const event = this.translateUpdate(params.update);
        if (event) handler.onEvent(event);
      },
      requestPermission: async (params: RequestPermissionRequest) => {
        const handler = this.handlers.get(params.sessionId);
        if (handler?.onPermissionRequest) {
          return handler.onPermissionRequest(params);
        }
        // Default policy: allow once. Codex uses this to gate terminal
        // and other sensitive operations — for the NOMA chat path we
        // don't expose those, so this branch should rarely fire. If it
        // does, the bridge stays permissive rather than deadlocking.
        const allowOption = params.options.find(
          (o: { kind?: string; optionId: string }) =>
            o.kind === "allow_once" || o.kind === "allow_always"
        );
        return {
          outcome: allowOption
            ? { outcome: "selected", optionId: allowOption.optionId }
            : { outcome: "cancelled" },
        };
      },
    };
  }

  /**
   * Translate an ACP `session/update` payload into the NOMA
   * `AgentRunEvent` shape the coordinator already speaks.
   *
   * Tool-call snapshots are accumulated across multiple ACP events:
   *   - `tool_call` initialises the entry (toolName ← title, status,
   *     rawInput as input).
   *   - `tool_call_update` merges any non-null fields onto the stored
   *     snapshot — the agent only sends *changes*, so omitted fields
   *     keep their previous value.
   *
   * Without this stateful merge, intermediate updates ship empty
   * `toolName` strings and the renderer loses the human-readable label
   * after the first frame.
   */
  private translateUpdate(
    update: SessionNotification["update"]
  ): AgentRunEvent | null {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = textOf(update.content);
        if (!text) return null;
        return { kind: "text", delta: text, cumulative: text };
      }
      case "user_message_chunk": {
        return null;
      }
      case "agent_thought_chunk": {
        const text = textOf(update.content);
        if (!text) return null;
        return { kind: "thought", content: text };
      }
      case "tool_call": {
        const snap = {
          toolCallId: update.toolCallId,
          toolName: update.title || update.toolCallId,
          state: mapStatus(update.status),
          input: coerceInput(update.rawInput),
          output: coerceOutput(update.rawOutput, update.content),
        };
        this.toolStates.set(update.toolCallId, snap);
        return { kind: "tool", payload: { ...snap } };
      }
      case "tool_call_update": {
        const prev = this.toolStates.get(update.toolCallId) ?? {
          toolCallId: update.toolCallId,
          toolName: update.toolCallId,
          state: "input-available" as const,
        };
        const next = {
          toolCallId: update.toolCallId,
          toolName: typeof update.title === "string" && update.title.length > 0
            ? update.title
            : prev.toolName,
          state:
            update.status != null ? mapStatus(update.status) : prev.state,
          input: update.rawInput !== undefined
            ? coerceInput(update.rawInput)
            : prev.input,
          output:
            update.rawOutput !== undefined || update.content != null
              ? coerceOutput(update.rawOutput, update.content ?? undefined)
              : prev.output,
          errorText: prev.errorText,
        };
        this.toolStates.set(update.toolCallId, next);
        return { kind: "tool", payload: { ...next } };
      }
      default:
        return null;
    }
  }
}

function transcriptItemOf(update: SessionUpdate): AcpTranscriptItem | null {
  switch (update.sessionUpdate) {
    case "user_message_chunk": {
      const text = textOf(update.content);
      return text ? { kind: "user", text } : null;
    }
    case "agent_message_chunk": {
      const text = textOf(update.content);
      return text ? { kind: "agent", text } : null;
    }
    case "agent_thought_chunk": {
      const text = textOf(update.content);
      return text ? { kind: "thought", text } : null;
    }
    case "tool_call": {
      return {
        kind: "tool",
        toolCallId: update.toolCallId,
        toolName: update.title || update.toolCallId,
        state: mapStatus(update.status),
        input: coerceInput(update.rawInput),
        output: coerceOutput(update.rawOutput, update.content),
      };
    }
    case "tool_call_update": {
      return {
        kind: "tool",
        toolCallId: update.toolCallId,
        toolName: update.title || update.toolCallId,
        state: mapStatus(update.status),
        input: coerceInput(update.rawInput),
        output: coerceOutput(update.rawOutput, update.content ?? undefined),
      };
    }
    case "session_info_update": {
      return {
        kind: "session_info",
        title: update.title,
        updatedAt: update.updatedAt,
      };
    }
    case "usage_update": {
      return { kind: "usage", usage: update };
    }
    default:
      return null;
  }
}

function textOf(content: ContentBlock): string {
  if (content.type === "text") return content.text;
  return "";
}

function mapStatus(
  status: "pending" | "in_progress" | "completed" | "failed" | null | undefined
): "input-available" | "output-available" | "output-error" {
  if (status === "completed") return "output-available";
  if (status === "failed") return "output-error";
  return "input-available";
}

function coerceInput(raw: unknown): Record<string, unknown> | undefined {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return undefined;
}

function coerceOutput(
  raw: unknown,
  content?: ReadonlyArray<{ type?: string } & Record<string, unknown>>
): unknown {
  if (raw !== undefined) return raw;
  if (!content || content.length === 0) return undefined;
  // ACP `content` is an array of typed blocks; concatenate text blocks
  // for a flat preview, fall back to the raw structure for non-text.
  const textPieces: string[] = [];
  for (const block of content) {
    if (block.type === "content") {
      const inner = (block as { content?: { type?: string; text?: string } })
        .content;
      if (inner?.type === "text" && typeof inner.text === "string") {
        textPieces.push(inner.text);
      }
    }
  }
  return textPieces.length > 0 ? textPieces.join("\n") : content;
}
