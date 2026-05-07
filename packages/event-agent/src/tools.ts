import { createRequire } from "node:module";
import type {
  AgentRunEvent,
  AgentToolCall,
  AgentToolSchema,
  AgentToolSet,
  Awaitable,
  TaskCompleteInput,
} from "./types.js";

export type ConfigFieldType = "string" | "number" | "boolean" | "string[]";

export interface ConfigField {
  key: string;
  type: ConfigFieldType;
  secret?: boolean;
  taskRequired?: boolean;
  min?: number;
  max?: number;
}

export type BuiltinConnector = {
  name: string;
  label: string;
  description: string;
  configSchema: ConfigField[];
  defaults: Record<string, unknown>;
};

export type NotifyInput = {
  message: string;
  level?: "info" | "nudge" | "alert";
};

/**
 * Per-task connector claim. `params` overrides the connector's defaults
 * (symbols for stock, city/country for weather, flightNumber for
 * flight, pollIntervalSec for any of them, etc.). The host validates
 * the keys against the connector's `configSchema` at usage start time
 * and merges defaults < cloud config < params.
 *
 * For connectors with `taskRequired` fields (the descriptor flag),
 * those fields MUST appear in `params` — the descriptor default is a
 * placeholder example, not a meaningful value.
 */
export type ScheduleTaskConnectorClaim = {
  name: string;
  params?: Record<string, unknown>;
};

export type ScheduleTaskInput = {
  title: string;
  prompt: string;
  kind: "event";
  connectors: ScheduleTaskConnectorClaim[];
};

export type CreateConnectorInput = {
  description: string;
};

export type AgentToolHandlers = {
  notify?: (input: NotifyInput) => Awaitable<string>;
  scheduleTask?: (input: ScheduleTaskInput) => Awaitable<string>;
  taskComplete?: (input: TaskCompleteInput) => Awaitable<string>;
  createConnector?: (
    input: CreateConnectorInput,
    publish?: (event: AgentRunEvent) => void
  ) => Awaitable<string>;
  connectors?:
    | ReadonlyArray<BuiltinConnector>
    | (() => ReadonlyArray<BuiltinConnector>);
  /** Forwarded to createConnector so the sub-agent can stream to the UI. */
  publish?: (event: AgentRunEvent) => void;
  /**
   * Tool names to hide from this tool set. Used to give event-driven
   * runs a strict surface — passing `["scheduleTask"]` here prevents
   * the agent from calling scheduleTask while reacting to a connector
   * emit, which is the loop guard for "task fires → agent thinks user
   * is asking for a watcher → calls scheduleTask → fires immediately
   * → repeat" runaway.
   */
  excludeToolNames?: ReadonlyArray<string>;
};

const requireShared = createRequire(import.meta.url);

const AGENT_TOOL_SCHEMAS = requireShared(
  "@noma/shared/agent/tool-schemas"
) as AgentToolSchema[];

const BUILTIN_CONNECTORS = requireShared(
  "@noma/shared/agent/builtin-connectors.json"
) as BuiltinConnector[];

export function listToolSchemas(): AgentToolSchema[] {
  return AGENT_TOOL_SCHEMAS;
}

export function builtinConnectors(): ReadonlyArray<BuiltinConnector> {
  return BUILTIN_CONNECTORS;
}

function resolveConnectors(
  handlers: AgentToolHandlers
): ReadonlyArray<BuiltinConnector> {
  const c = handlers.connectors;
  return typeof c === "function" ? c() : (c ?? BUILTIN_CONNECTORS);
}

/** @deprecated Use formatConnectorsList */
export const formatBuiltinConnectorsList = formatConnectorsList;

export function formatConnectorsList(
  connectors: ReadonlyArray<BuiltinConnector> = BUILTIN_CONNECTORS
): string {
  const items = connectors
    .map((c) => {
      const fields = c.configSchema
        .map((f) => {
          const flags = [
            f.taskRequired ? "taskRequired" : "",
            f.secret ? "secret" : "",
          ]
            .filter(Boolean)
            .join(",");
          const flagSuffix = flags ? ` [${flags}]` : "";
          const defaultValue =
            f.key in c.defaults ? `=${JSON.stringify(c.defaults[f.key])}` : "";
          return `      - ${f.key}: ${f.type}${defaultValue}${flagSuffix}`;
        })
        .join("\n");
      return `- \`${c.name}\` — ${c.label}: ${c.description}\n    params:\n${fields}`;
    })
    .join("\n");
  return `### Available connectors\n${items}`;
}

export function createAgentToolSet(
  handlers: AgentToolHandlers = {}
): AgentToolSet {
  const excluded = new Set(handlers.excludeToolNames ?? []);
  return {
    listSchemas: () =>
      excluded.size === 0
        ? listToolSchemas()
        : listToolSchemas().filter((s) => !excluded.has(s.name)),
    execute: (call) => {
      if (excluded.has(call.toolName)) {
        // Defense in depth: even if the model somehow sees a hidden
        // tool, refuse to execute it. The schema-list filter above
        // should be enough but a stale tool-call replay (resume-from-
        // crash) could theoretically reach here.
        return Promise.resolve(
          `tool '${call.toolName}' is not available in this context`
        );
      }
      return executeBuiltinTool(call, handlers);
    },
  };
}

export async function executeBuiltinTool(
  call: AgentToolCall,
  handlers: AgentToolHandlers = {}
): Promise<string> {
  try {
    switch (call.toolName) {
      case "notify":
        return await requireHandler(handlers.notify, "notify")(
          call.input as NotifyInput
        );
      case "scheduleTask":
        return await scheduleTask(call.input, handlers);
      case "createConnector":
        return await requireHandler(
          handlers.createConnector
            ? (input: CreateConnectorInput) =>
                handlers.createConnector!(input, handlers.publish)
            : undefined,
          "createConnector"
        )(call.input as CreateConnectorInput);
      case "list_connectors":
        return formatConnectorsList(resolveConnectors(handlers));
      case "task_complete": {
        const input = call.input as TaskCompleteInput;
        if (handlers.taskComplete) {
          return await handlers.taskComplete(input);
        }
        return `task completed: ${input.summary}`;
      }
      default:
        return `unknown tool: ${call.toolName}`;
    }
  } catch (err) {
    return `${call.toolName} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function requireHandler<TInput>(
  handler: ((input: TInput) => Awaitable<string>) | undefined,
  name: string
): (input: TInput) => Awaitable<string> {
  if (handler) return handler;
  return () => `${name} unavailable`;
}

async function scheduleTask(
  rawInput: unknown,
  handlers: AgentToolHandlers
): Promise<string> {
  const input = rawInput as {
    title?: string;
    prompt?: string;
    kind?: string;
    connectors?: unknown;
  };
  if (input.kind !== "event") {
    return `scheduleTask rejected: only kind='event' is supported right now.`;
  }
  const connectorCatalog = resolveConnectors(handlers);
  const known = new Set(connectorCatalog.map((c) => c.name));
  const claimed = normalizeConnectorClaims(input.connectors);
  if (claimed.length === 0) {
    return `scheduleTask rejected: at least one connector is required (use list_connectors to pick one).`;
  }
  const unknownNames = claimed
    .map((c) => c.name)
    .filter((n) => !known.has(n));
  if (unknownNames.length > 0) {
    return `scheduleTask rejected: unknown connector(s): ${unknownNames
      .map((n) => `'${n}'`)
      .join(", ")}. call list_connectors first.`;
  }
  if (!input.title || !input.prompt) {
    return "scheduleTask rejected: title and prompt are required.";
  }
  if (!handlers.scheduleTask) return "scheduleTask unavailable";
  return await handlers.scheduleTask({
    title: input.title,
    prompt: input.prompt,
    kind: "event",
    connectors: claimed,
  });
}

function normalizeConnectorClaims(raw: unknown): ScheduleTaskConnectorClaim[] {
  if (!Array.isArray(raw)) return [];
  const out: ScheduleTaskConnectorClaim[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    // Accept legacy bare-string form for backwards compat with older
    // prompts; modern shape is {name, params?}.
    if (typeof v === "string") {
      const name = v.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ name });
      continue;
    }
    if (!v || typeof v !== "object") continue;
    const obj = v as { name?: unknown; params?: unknown };
    if (typeof obj.name !== "string") continue;
    const name = obj.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const claim: ScheduleTaskConnectorClaim = { name };
    if (obj.params && typeof obj.params === "object") {
      claim.params = obj.params as Record<string, unknown>;
    }
    out.push(claim);
  }
  return out;
}
