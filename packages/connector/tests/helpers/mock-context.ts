import type {
  ConnectorContext,
  ConnectorStorage,
} from "../../src/types.js";

export interface CapturedEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export interface CapturedLog {
  level: "info" | "warn" | "error";
  message: string;
}

export interface MockContext {
  ctx: ConnectorContext;
  events: CapturedEvent[];
  logs: CapturedLog[];
  storage: ConnectorStorage;
  reset(): void;
}

export function createMemoryStorage(
  initial?: Record<string, string>
): ConnectorStorage {
  const data = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

export function createMockContext(opts?: {
  storage?: ConnectorStorage;
  silentLogs?: boolean;
}): MockContext {
  const events: CapturedEvent[] = [];
  const logs: CapturedLog[] = [];
  const storage = opts?.storage ?? createMemoryStorage();

  const ctx: ConnectorContext = {
    emitEvent(ev) {
      events.push({ type: ev.type, payload: ev.payload });
    },
    log(level, message) {
      logs.push({ level, message });
      if (!opts?.silentLogs && level !== "info") {
        // surface warns/errors to test output for debuggability
      }
    },
    storage,
  };

  return {
    ctx,
    events,
    logs,
    storage,
    reset() {
      events.length = 0;
      logs.length = 0;
    },
  };
}
