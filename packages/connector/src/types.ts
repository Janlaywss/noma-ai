/**
 * Connector descriptor — two pieces:
 *
 *   - **Descriptor** is the static plugin definition. One per connector kind.
 *     Owns the schema-driven config form, the defaults the UI/usages layer on
 *     top of, and the `create(config, ctx)` factory.
 *
 *   - **Connector** is one running instance, produced by `descriptor.create()`.
 *     It owns its own polling loop (`setInterval` inside `start()`), its own
 *     dedup state, and emits via the host-supplied `ctx.emitEvent(...)`. The
 *     descriptor never holds state — every fresh `create()` returns a clean
 *     instance.
 *
 * Global shared instances: one Connector per connector name (not per usage).
 * Multiple tasks share the instance, with parameters aggregated from all
 * active usages (e.g. stock symbols unioned). When a task joins or leaves,
 * the runtime calls `updateConfig()` to hot-reload the merged params.
 * Event routing filters per-task params in the event handler.
 *
 * Dynamic connectors (dyn_*) are excluded from sharing and remain per-usage.
 */
export interface Connector {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  /** Snapshot of current state for debugging / UI surfaces. */
  status(): Record<string, unknown>;
  /** Hot-reload config while running. Fallback to stop+restart if absent. */
  updateConfig?(config: Record<string, unknown>): void;
}

export type ConfigFieldType = "string" | "number" | "boolean" | "string[]";

export interface ConfigField {
  key: string;
  /** Human label key for the UI; the worker doesn't render — just records. */
  label?: string;
  type: ConfigFieldType;
  /** When true, the field MUST be supplied by every per-task usage — the
   *  descriptor default is a placeholder example, not a meaningful value
   *  (e.g. stock's `symbols`). The agent's `addConnectorUsage` enforces
   *  this so a task says "watch HSBC" doesn't quietly inherit the sample
   *  AAPL/NVDA/TSLA list. */
  taskRequired?: boolean;
  /** Marks the field as a credential — masked in UI responses. */
  secret?: boolean;
  min?: number;
  max?: number;
}

/**
 * Per-connector persistent key-value storage. Connectors use this to
 * persist tokens, cursors, and other state that must survive restarts.
 *
 * Official connectors store in Supabase (user-isolated via RLS).
 * Dynamic (dyn_*) connectors store in local SQLite.
 */
export interface ConnectorStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Host-supplied callbacks every connector instance needs.
 *
 * The host (typically the desktop worker) injects these at `create()` time.
 * The connector module never imports from the host — it only sees this
 * interface. That keeps `@noma/connector` reusable from non-Electron hosts
 * (eval harness, server-side worker, etc.).
 */
export interface OAuthRefreshResult {
  access_token: string;
  /** Absolute UNIX-ms expiry, NOT seconds-from-now. */
  expires_at: number;
}

export interface ConnectorContext {
  /** Publish an event into the host's bus / persistence layer. */
  emitEvent(ev: { type: string; payload?: Record<string, unknown> }): void;
  /** Structured logging hook — host decides where the line goes. */
  log(level: "info" | "warn" | "error", message: string): void;
  /** Persistent key-value storage scoped to this connector. */
  storage: ConnectorStorage;
  /**
   * Optional host-supplied OAuth refresh proxy. When present, OAuth-based
   * connectors call this instead of hitting the IdP directly — the
   * client_secret stays on whichever process the host points this at
   * (typically the cloud server). Returns null if refresh failed.
   *
   * Hosts that don't set this (eval harness, server-side worker with the
   * secret in env) leave the connector to call the IdP directly.
   */
  refreshOAuth?(): Promise<OAuthRefreshResult | null>;
}

/**
 * Schema for a connector-exposed tool — same shape as the agent's
 * AgentToolSchema (we don't import that to keep `@noma/connector`
 * free of `@noma/event-agent`). The host adapts between them.
 */
export interface ConnectorToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: false;
  };
}

/**
 * Subset of ConnectorContext available to a tool execution. Tools don't
 * emit events (the agent already has the result inline), but they share
 * the connector's persistent storage so token refreshes from the polling
 * loop and from tool calls converge on the same `access_token` row.
 */
export interface ConnectorToolContext {
  log: ConnectorContext["log"];
  storage: ConnectorStorage;
  refreshOAuth?: ConnectorContext["refreshOAuth"];
}

/**
 * Pull-style action exposed by a connector to the agent loop. Unlike the
 * connector's polling loop (push), tools are invoked on demand by the LLM.
 * They receive the same config the connector instance would (typically
 * including OAuth tokens), so they can hit the same APIs without a
 * separate auth path.
 *
 * The host namespaces these tools (e.g. `gmail_list_messages`) before
 * exposing them to the agent, so a connector author can pick a short
 * unqualified name here.
 */
export interface ConnectorTool<
  C extends Record<string, unknown> = Record<string, unknown>,
> {
  schema: ConnectorToolSchema;
  /** Returns a string for the LLM to read — typically JSON. */
  execute(
    input: Record<string, unknown>,
    config: C,
    ctx: ConnectorToolContext
  ): Promise<string>;
}

export interface ConnectorDescriptor<
  C extends Record<string, unknown> = Record<string, unknown>,
> {
  name: string;
  label: string;
  description: string;
  configSchema: ConfigField[];
  defaults: C;
  create(config: C, ctx: ConnectorContext): Connector;
  /** Pull-style actions the agent can call. Optional — not every
   *  connector has one (some are pure event sources). */
  tools?: ReadonlyArray<ConnectorTool<C>>;
}

/**
 * Row shape for a connector usage claim — the minimum fields the runtime
 * needs. The host reads these from whatever storage it owns (SQLite,
 * Postgres, in-memory mock) and hands them to the runtime.
 */
export interface ConnectorUsageRow {
  id: string;
  task_id: string;
  connector_name: string;
  params: string;
  created_at: string;
}

/**
 * Callbacks the runtime needs from its host. The runtime never imports
 * DB clients, HTTP helpers, or logging frameworks — the host injects
 * them here. That keeps the runtime reusable across desktop, server-side
 * workers, and the eval harness.
 */
export interface ConnectorRuntimeHost {
  /** Look up a descriptor by name (static registry or dynamic DB). */
  descriptorFor(name: string): ConnectorDescriptor<Record<string, unknown>> | null;
  /** Fetch user-level credentials from the cloud store. */
  fetchCloudConfig(connectorName: string): Promise<Record<string, unknown>>;
  /** Build a ConnectorContext wired to the host's event bus and logger. */
  createContext(source: string): ConnectorContext;
  /** Create a persistent storage backend for a connector. */
  createStorage(connectorName: string): ConnectorStorage;
  /** Structured logging — the runtime has no opinion on where lines go. */
  log(level: "info" | "warn" | "error", message: string): void;
}
