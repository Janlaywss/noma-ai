// ── Bootstrap ──────────────────────────────────────────

type NomaBootstrap = {
  acp: {
    available: boolean;
    binary: string | null;
  };
  server: {
    defaultUrl: string;
  };
  connectors: Array<{
    name: string;
    label: string;
    description: string;
    configSchema: Array<{
      key: string;
      label?: string;
      type: "string" | "number" | "boolean" | "string[]";
      taskRequired?: boolean;
      secret?: boolean;
      min?: number;
      max?: number;
    }>;
    tools: string[];
  }>;
};

type NomaAcpSmokeReport = {
  ok: boolean;
  serverUrl: string;
  model: string;
  cwd: string;
  sessionId?: string;
  sessionsBefore: Array<NomaSmokeSessionInfo>;
  sessionsAfterNew: Array<NomaSmokeSessionInfo>;
  sessionsAfterPrompt: Array<NomaSmokeSessionInfo>;
  promptTranscript: Array<Record<string, unknown>>;
  loadedTranscript: Array<Record<string, unknown>>;
  assistantText: string;
  stopReason?: string;
  error?: string;
};

type NomaSmokeSessionInfo = {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
};

// ── ACP session types ─────────────────────────────────────

type AcpIpcResult<T = unknown> = { ok: true } & T | { ok: false; error: string };

type AcpSessionInfo = {
  sessionId: string;
  cwd?: string;
  title?: string | null;
  updatedAt?: string | null;
};

type AcpTranscriptItem =
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
  | { kind: "session_info"; title?: string | null; updatedAt?: string | null }
  | { kind: "usage"; usage: unknown };

type AcpStreamEvent =
  | { kind: "text"; delta: string; cumulative: string }
  | { kind: "tool"; payload: { toolCallId: string; toolName: string; state: string; input?: Record<string, unknown>; output?: unknown } }
  | { kind: "thought"; content: string }
  | { kind: "done"; cumulative: string }
  | { kind: "error"; message: string };

type NomaAcpApi = {
  start(): Promise<AcpIpcResult>;
  stop(): Promise<AcpIpcResult>;
  listSessions(): Promise<AcpIpcResult<{ sessions: AcpSessionInfo[] }>>;
  newSession(cwd?: string): Promise<AcpIpcResult<{ sessionId: string }>>;
  loadTranscript(sessionId: string, cwd?: string): Promise<AcpIpcResult<{ transcript: AcpTranscriptItem[] }>>;
  prompt(sessionId: string, text: string): Promise<AcpIpcResult<{ stopReason?: string }>>;
  cancel(sessionId: string): Promise<AcpIpcResult>;
  onStreamEvent(callback: (data: { sessionId: string; event: AcpStreamEvent }) => void): () => void;
};

// ── Local DB types ────────────────────────────────────────

type LocalTask = {
  id: string;
  title: string;
  prompt: string;
  kind: "event" | "once" | "cron";
  schedule: string | null;
  status: "pending" | "running" | "done" | "failed" | "disabled";
  origin: "user" | "agent";
  parent_id: string | null;
  slug: string | null;
  session_id: string | null;
  connectors: string[];
  events_count: number;
  last_run_at: string | null;
  next_run_at: string | null;
  last_result: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

type LocalEvent = {
  id: string;
  task_id: string;
  task_title?: string | null;
  source: string;
  type: string;
  payload: unknown;
  consumed_at: string | null;
  created_at: string;
};

type InboxSummary = {
  total: number;
  unread: number;
  sources: Array<{ source: string; cnt: number }>;
};

type ConnectorSummary = {
  name: string;
  taskCount: number;
  runningCount: number;
  eventCount: number;
  lastEventAt: string | null;
};

type ConnectorUsage = {
  id: string;
  task_id: string;
  connector_name: string;
  params: Record<string, unknown>;
  created_at: string;
};

type PersistedSession = {
  sessionId: string;
  title: string | null;
  codexThreadId: string | null;
  createdAt: string;
  updatedAt: string;
};

type PersistedMessage = {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  segments?: unknown[];
  toolCalls?: unknown[];
  createdAt: string;
};

type NomaDbApi = {
  tasks: {
    list(filter?: { status?: string }): Promise<LocalTask[]>;
    get(id: string): Promise<LocalTask | null>;
    create(input: {
      title: string;
      prompt?: string;
      kind?: "event" | "once" | "cron";
      schedule?: string;
      status?: string;
      origin?: "user" | "agent";
      connectors?: string[];
      note?: string;
    }): Promise<LocalTask>;
    update(id: string, updates: Partial<Omit<LocalTask, "id" | "created_at">>): Promise<LocalTask | null>;
    delete(id: string): Promise<{ ok: boolean }>;
  };
  sessions: {
    list(): Promise<PersistedSession[]>;
    get(id: string): Promise<PersistedSession | null>;
    create(input: { id: string; title?: string; codexThreadId?: string }): Promise<{ ok: boolean; sessionId: string }>;
    update(id: string, updates: { title?: string; codexThreadId?: string }): Promise<{ ok: boolean }>;
    delete(id: string): Promise<{ ok: boolean }>;
  };
  messages: {
    list(sessionId: string): Promise<PersistedMessage[]>;
    append(input: {
      id: string;
      sessionId: string;
      role: string;
      content: string;
      segments?: unknown[];
      toolCalls?: unknown[];
    }): Promise<{ ok: boolean }>;
    update(messageId: string, updates: {
      content?: string;
      segments?: unknown[];
      toolCalls?: unknown[];
    }): Promise<{ ok: boolean }>;
  };
  events: {
    listByTask(taskId: string, opts?: { limit?: number }): Promise<LocalEvent[]>;
    listBySource(source: string, opts?: { limit?: number }): Promise<LocalEvent[]>;
    list(opts?: { source?: string; unreadOnly?: boolean; limit?: number }): Promise<LocalEvent[]>;
    markConsumed(ids: string[]): Promise<{ ok: boolean; count: number }>;
    inboxSummary(): Promise<InboxSummary>;
  };
  connectors: {
    summary(): Promise<ConnectorSummary[]>;
    tasks(connectorName: string): Promise<LocalTask[]>;
  };
  connectorUsages: {
    listByTask(taskId: string): Promise<ConnectorUsage[]>;
  };
  connectorConfig: {
    get(connectorName: string): Promise<Record<string, string>>;
    save(connectorName: string, config: Record<string, string>): Promise<{ ok: boolean }>;
    delete(connectorName: string): Promise<{ ok: boolean }>;
  };
  oauth: {
    init(connectorName: string): Promise<{ ok: boolean; url?: string; error?: string }>;
    status(connectorName: string): Promise<{ ok: boolean; authorized: boolean; config?: Record<string, unknown>; error?: string }>;
  };
  clearData: {
    counts(): Promise<{ tasks: number; sessions: number; messages: number; events: number }>;
    execute(opts: { tasks?: boolean; sessions?: boolean; events?: boolean }): Promise<{ ok: boolean }>;
  };
  settings: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<{ ok: boolean }>;
    getAll(prefix: string): Promise<Record<string, string>>;
  };
};

// ── Task event types ──────────────────────────────────────

type ProactiveMessageEvent = {
  sessionId: string;
  message: string;
  level: "info" | "nudge" | "alert";
  timestamp: string;
};

type TaskCreatedEvent = {
  taskId: string;
  sessionId: string;
  title: string;
  connectors: string[];
};

type ConnectorEventPayload = {
  source: string;
  type: string;
  payload: unknown;
  timestamp: string;
};

interface Window {
  noma?: {
    getBootstrap(): Promise<NomaBootstrap>;
    runAcpSmoke(): Promise<NomaAcpSmokeReport>;
    acp: NomaAcpApi;
    db: NomaDbApi;
    test?: {
      scheduleTask(sessionId: string, input: Record<string, unknown>): Promise<{ ok: boolean; taskId?: string; error?: string }>;
    };
    onProactiveMessage(callback: (data: ProactiveMessageEvent) => void): () => void;
    onTaskCreated(callback: (data: TaskCreatedEvent) => void): () => void;
    onConnectorEvent(callback: (data: ConnectorEventPayload) => void): () => void;
  };
  __NOMA_ACP_SMOKE_REPORT__?: NomaAcpSmokeReport;
}
