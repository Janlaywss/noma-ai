/**
 * ACP Chat Store — with SQLite persistence
 *
 * React context that manages the ACP agent bridge lifecycle, session list,
 * active session transcript, and streaming prompt state.
 *
 * Architecture:
 *  - SQLite is the source of truth for sessions and messages.
 *  - On app start, sessions are loaded from DB and the most recent is restored.
 *  - Each user message and finalized assistant message is persisted immediately.
 *  - The codex thread_id is stored per session so `codex exec resume` works
 *    across app restarts.
 *  - Streaming events (from IPC) are accumulated into a "streaming" message
 *    that becomes finalized + persisted when the agent turn completes.
 */

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

// ── Renderable message types (UI layer) ───────────────────

export type ChatToolCall = {
  toolCallId: string;
  toolName: string;
  state: "running" | "success" | "error";
  input?: Record<string, unknown>;
  output?: unknown;
};

/**
 * An ordered segment in a message. Segments preserve the streaming order
 * so tool calls render exactly where they appeared in the agent turn,
 * not lumped at the end.
 */
export type ChatSegment =
  | { kind: "text"; content: string }
  | { kind: "tool"; toolCallId: string };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: ChatToolCall[];
  /** Ordered segments — if present, used for rendering instead of content + toolCalls */
  segments?: ChatSegment[];
  timestamp?: number;
};

// ── Store state ───────────────────────────────────────────

type ChatState = {
  /** Whether the ACP bridge subprocess is running */
  bridgeReady: boolean;
  /** Session list from local DB */
  sessions: AcpSessionInfo[];
  /** Currently active session ID */
  activeSessionId: string | null;
  /** Messages in the active session */
  messages: ChatMessage[];
  /** Whether the agent is currently generating */
  isStreaming: boolean;
  /** Streaming message being built */
  streamingMessage: ChatMessage | null;
  /** Any error state */
  error: string | null;
};

type ChatActions = {
  /** Initialize the ACP bridge */
  init: () => Promise<void>;
  /** Refresh the session list */
  refreshSessions: () => Promise<void>;
  /** Create a new session and make it active */
  createSession: () => Promise<string | null>;
  /** Switch to and load an existing session */
  loadSession: (sessionId: string) => Promise<void>;
  /** Delete a session and switch to the next available one */
  deleteSession: (sessionId: string) => Promise<void>;
  /** Send a prompt to the active session */
  sendMessage: (text: string) => Promise<void>;
  /** Cancel the current agent turn */
  cancelStream: () => Promise<void>;
};

type ChatStore = ChatState & ChatActions;

const ChatContext = createContext<ChatStore | null>(null);

// ── Map stream event tool state → UI state ────────────────

function mapToolState(state: string): "running" | "success" | "error" {
  if (state === "output-available") return "success";
  if (state === "output-error") return "error";
  return "running";
}

// ── Persist a message to SQLite ─────────────────────────────

async function persistMessage(sessionId: string, msg: ChatMessage): Promise<void> {
  const noma = window.noma;
  if (!noma) return;
  try {
    await noma.db.messages.append({
      id: msg.id,
      sessionId,
      role: msg.role,
      content: msg.content,
      segments: msg.segments,
      toolCalls: msg.toolCalls,
    });
  } catch (err) {
    console.warn("[chat] Failed to persist message:", err);
  }
}

// ── Refresh session list from DB into state ─────────────────

async function refreshSessionList(
  setState: React.Dispatch<React.SetStateAction<ChatState>>
): Promise<void> {
  const noma = window.noma;
  if (!noma) return;
  try {
    const dbSessions = await noma.db.sessions.list();
    const sessions: AcpSessionInfo[] = dbSessions.map((s) => ({
      sessionId: s.sessionId,
      title: s.title,
      updatedAt: s.updatedAt,
    }));
    setState((s) => ({ ...s, sessions }));
  } catch {
    // best-effort
  }
}

// ── Convert persisted DB messages → ChatMessage[] ───────────

function dbMessagesToChat(rows: PersistedMessage[]): ChatMessage[] {
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    segments: r.segments as ChatSegment[] | undefined,
    toolCalls: r.toolCalls as ChatToolCall[] | undefined,
    timestamp: new Date(r.createdAt).getTime(),
  }));
}

// ── Provider ──────────────────────────────────────────────

export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ChatState>({
    bridgeReady: false,
    sessions: [],
    activeSessionId: null,
    messages: [],
    isStreaming: false,
    streamingMessage: null,
    error: null,
  });

  const streamingRef = useRef<ChatMessage | null>(null);
  const activeSessionRef = useRef<string | null>(null);

  // Keep ref in sync
  useEffect(() => {
    activeSessionRef.current = state.activeSessionId;
  }, [state.activeSessionId]);

  // ── Load sessions from DB on mount ──────────────────────
  useEffect(() => {
    const noma = window.noma;
    if (!noma) return;

    (async () => {
      try {
        const dbSessions = await noma.db.sessions.list();
        const sessions: AcpSessionInfo[] = dbSessions.map((s) => ({
          sessionId: s.sessionId,
          title: s.title,
          updatedAt: s.updatedAt,
        }));
        setState((s) => ({ ...s, sessions }));

        // Auto-restore the most recent session
        if (dbSessions.length > 0) {
          const latest = dbSessions[0]; // already sorted by updated_at DESC
          const msgs = await noma.db.messages.list(latest.sessionId);
          setState((s) => ({
            ...s,
            activeSessionId: latest.sessionId,
            messages: dbMessagesToChat(msgs),
          }));
        }
      } catch (err) {
        console.warn("[chat] Failed to load sessions from DB:", err);
      }
    })();
  }, []);

  // Subscribe to stream events from main process
  useEffect(() => {
    const noma = window.noma;
    if (!noma) return;

    const unsubscribe = noma.acp.onStreamEvent(({ sessionId, event }) => {
      // Only process events for the active session
      if (sessionId !== activeSessionRef.current) return;

      if (event.kind === "text") {
        const current = streamingRef.current ?? {
          id: `assistant-${Date.now()}`,
          role: "assistant" as const,
          content: "",
          toolCalls: [],
          segments: [],
        };
        const segments = [...(current.segments ?? [])];
        // Append to the last text segment or create a new one
        const last = segments[segments.length - 1];
        if (last && last.kind === "text") {
          segments[segments.length - 1] = { kind: "text", content: last.content + event.delta };
        } else {
          segments.push({ kind: "text", content: event.delta });
        }
        streamingRef.current = {
          ...current,
          content: (current.content ?? "") + event.delta,
          segments,
        } as ChatMessage;
        setState((s) => ({ ...s, streamingMessage: { ...streamingRef.current! } }));
      } else if (event.kind === "tool") {
        const payload = event.payload;
        const current = streamingRef.current ?? {
          id: `assistant-${Date.now()}`,
          role: "assistant" as const,
          content: "",
          toolCalls: [],
          segments: [],
        };
        const toolCalls = [...(current.toolCalls ?? [])];
        const segments = [...(current.segments ?? [])];
        const idx = toolCalls.findIndex(
          (t) => t.toolCallId === payload.toolCallId
        );
        const tc: ChatToolCall = {
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          state: mapToolState(payload.state),
          input: payload.input,
          output: payload.output,
        };
        if (idx >= 0) {
          toolCalls[idx] = tc;
        } else {
          toolCalls.push(tc);
          // New tool — add to segments in order
          segments.push({ kind: "tool", toolCallId: payload.toolCallId });
        }
        streamingRef.current = { ...current, toolCalls, segments };
        setState((s) => ({ ...s, streamingMessage: { ...streamingRef.current! } }));
      } else if (event.kind === "done") {
        // Finalize: move streaming message into messages array and persist
        const final = streamingRef.current;
        streamingRef.current = null;

        if (final && activeSessionRef.current) {
          // Persist the finalized assistant message
          persistMessage(activeSessionRef.current, final);
          // Update session title from first assistant response (if no title yet)
          // and refresh the session list so sidebar shows updated title
          updateSessionTitleIfNeeded(activeSessionRef.current, final.content).then(() => {
            refreshSessionList(setState);
          });
        }

        setState((s) => ({
          ...s,
          isStreaming: false,
          streamingMessage: null,
          messages: final ? [...s.messages, final] : s.messages,
        }));
      } else if (event.kind === "error") {
        streamingRef.current = null;
        setState((s) => ({
          ...s,
          isStreaming: false,
          streamingMessage: null,
          error: event.message,
        }));
      }
    });

    return unsubscribe;
  }, []);

  // Subscribe to proactive messages from connector events.
  useEffect(() => {
    const noma = window.noma;
    if (!noma?.onProactiveMessage) return;

    const unsubscribe = noma.onProactiveMessage((data) => {
      if (data.sessionId !== activeSessionRef.current) return;

      const proactiveMsg: ChatMessage = {
        id: `proactive-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: "system",
        content: data.message,
        timestamp: new Date(data.timestamp).getTime(),
      };
      // Persist proactive messages too
      persistMessage(data.sessionId, proactiveMsg);
      setState((s) => ({
        ...s,
        messages: [...s.messages, proactiveMsg],
      }));
    });

    return unsubscribe;
  }, []);

  // ── Actions ─────────────────────────────────────────────

  const init = useCallback(async () => {
    const noma = window.noma;
    if (!noma) {
      setState((s) => ({ ...s, error: "window.noma not available" }));
      return;
    }
    const result = await noma.acp.start();
    if (result.ok) {
      setState((s) => ({ ...s, bridgeReady: true, error: null }));
    } else {
      setState((s) => ({ ...s, error: result.error }));
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    const noma = window.noma;
    if (!noma) return;
    try {
      const dbSessions = await noma.db.sessions.list();
      const sessions: AcpSessionInfo[] = dbSessions.map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        updatedAt: s.updatedAt,
      }));
      setState((s) => ({ ...s, sessions }));
    } catch (err) {
      console.warn("[chat] Failed to refresh sessions:", err);
    }
  }, []);

  const createSession = useCallback(async (): Promise<string | null> => {
    const noma = window.noma;
    if (!noma) return null;

    // Create a new session in the codex bridge
    const result = await noma.acp.newSession();
    if (!result.ok) {
      setState((s) => ({ ...s, error: result.error }));
      return null;
    }

    const sessionId = result.sessionId;

    // Persist the session in SQLite
    await noma.db.sessions.create({ id: sessionId });

    setState((s) => ({
      ...s,
      activeSessionId: sessionId,
      messages: [],
      streamingMessage: null,
      error: null,
    }));

    // Refresh session list from DB
    const dbSessions = await noma.db.sessions.list();
    const sessions: AcpSessionInfo[] = dbSessions.map((s) => ({
      sessionId: s.sessionId,
      title: s.title,
      updatedAt: s.updatedAt,
    }));
    setState((s) => ({ ...s, sessions }));

    return sessionId;
  }, []);

  const loadSession = useCallback(async (sessionId: string) => {
    const noma = window.noma;
    if (!noma) return;

    setState((s) => ({
      ...s,
      activeSessionId: sessionId,
      messages: [],
      streamingMessage: null,
      isStreaming: false,
      error: null,
    }));

    // Load messages from local DB
    try {
      const msgs = await noma.db.messages.list(sessionId);
      const messages = dbMessagesToChat(msgs);
      setState((s) => ({ ...s, messages }));
    } catch (err) {
      console.warn("[chat] Failed to load messages:", err);
      setState((s) => ({ ...s, error: "Failed to load messages" }));
    }
  }, []);

  const deleteSession = useCallback(async (sessionId: string) => {
    const noma = window.noma;
    if (!noma) return;

    await noma.db.sessions.delete(sessionId);

    if (sessionId === activeSessionRef.current) {
      // Load remaining sessions and switch to the first one
      const dbSessions = await noma.db.sessions.list();
      const sessions: AcpSessionInfo[] = dbSessions.map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        updatedAt: s.updatedAt,
      }));

      if (dbSessions.length > 0) {
        const first = dbSessions[0];
        const msgs = await noma.db.messages.list(first.sessionId);
        setState((s) => ({
          ...s,
          activeSessionId: first.sessionId,
          messages: dbMessagesToChat(msgs),
          sessions,
        }));
      } else {
        setState((s) => ({
          ...s,
          activeSessionId: null,
          messages: [],
          sessions: [],
        }));
      }
    } else {
      await refreshSessionList(setState);
    }
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    const noma = window.noma;
    if (!noma) return;

    let sessionId = activeSessionRef.current;

    // Auto-create session if none active
    if (!sessionId) {
      const result = await noma.acp.newSession();
      if (!result.ok) {
        setState((s) => ({ ...s, error: result.error }));
        return;
      }
      sessionId = result.sessionId;

      // Persist new session to DB
      await noma.db.sessions.create({ id: sessionId });

      setState((s) => ({
        ...s,
        activeSessionId: sessionId,
      }));
      activeSessionRef.current = sessionId;

      // Refresh session list
      const dbSessions = await noma.db.sessions.list();
      const sessions: AcpSessionInfo[] = dbSessions.map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        updatedAt: s.updatedAt,
      }));
      setState((prev) => ({ ...prev, sessions }));
    }

    // Add user message optimistically
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
    };

    // Persist user message
    persistMessage(sessionId, userMsg);

    setState((s) => ({
      ...s,
      messages: [...s.messages, userMsg],
      isStreaming: true,
      error: null,
    }));

    // Fire the prompt — streaming events arrive via onStreamEvent
    await noma.acp.prompt(sessionId, text);
  }, []);

  const cancelStream = useCallback(async () => {
    const noma = window.noma;
    if (!noma || !activeSessionRef.current) return;
    await noma.acp.cancel(activeSessionRef.current);

    // If there's a partial streaming message, persist it
    const partial = streamingRef.current;
    if (partial && activeSessionRef.current) {
      persistMessage(activeSessionRef.current, partial);
      setState((s) => ({
        ...s,
        isStreaming: false,
        streamingMessage: null,
        messages: [...s.messages, partial],
      }));
    } else {
      setState((s) => ({
        ...s,
        isStreaming: false,
        streamingMessage: null,
      }));
    }
    streamingRef.current = null;
  }, []);

  const store: ChatStore = {
    ...state,
    init,
    refreshSessions,
    createSession,
    loadSession,
    deleteSession,
    sendMessage,
    cancelStream,
  };

  return <ChatContext.Provider value={store}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatStore {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within <ChatProvider>");
  return ctx;
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Auto-generate a session title from the first assistant reply.
 * Uses the first ~40 chars of text as a summary.
 */
async function updateSessionTitleIfNeeded(
  sessionId: string,
  content: string
): Promise<void> {
  const noma = window.noma;
  if (!noma) return;

  try {
    const session = await noma.db.sessions.get(sessionId);
    if (session?.title) return; // already has a title

    // Extract first meaningful line (skip empty, take first 40 chars)
    const firstLine = content
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!firstLine) return;

    const title = firstLine.length > 40 ? firstLine.slice(0, 40) + "…" : firstLine;
    await noma.db.sessions.update(sessionId, { title });
  } catch (err) {
    console.warn("[chat] Failed to update session title:", err);
  }
}
