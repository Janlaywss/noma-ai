import type {
  ConnectorContext,
  ConnectorDescriptor,
  ConnectorRuntimeHost,
  ConnectorStorage,
} from "../../src/types.js";
import {
  createMemoryStorage,
  createMockContext,
  type MockContext,
} from "./mock-context.js";

export interface MockHost {
  host: ConnectorRuntimeHost;
  /** All log lines the runtime itself produced. */
  logs: Array<{ level: "info" | "warn" | "error"; message: string }>;
  /** ConnectorContext instances handed out by createContext, keyed by source. */
  contexts: Map<string, MockContext>;
  /** Override or add a descriptor at runtime. */
  setDescriptor(name: string, descriptor: ConnectorDescriptor<Record<string, unknown>>): void;
  /** Override the cloud config returned for a connector name. */
  setCloudConfig(name: string, config: Record<string, unknown>): void;
}

export function createMockHost(opts?: {
  descriptors?: Record<string, ConnectorDescriptor<Record<string, unknown>>>;
  cloud?: Record<string, Record<string, unknown>>;
}): MockHost {
  const descriptors = new Map(Object.entries(opts?.descriptors ?? {}));
  const cloud = new Map(Object.entries(opts?.cloud ?? {}));
  const logs: Array<{ level: "info" | "warn" | "error"; message: string }> = [];
  const contexts = new Map<string, MockContext>();
  const storages = new Map<string, ConnectorStorage>();

  const host: ConnectorRuntimeHost = {
    descriptorFor(name) {
      return descriptors.get(name) ?? null;
    },
    async fetchCloudConfig(name) {
      return cloud.get(name) ?? {};
    },
    createContext(source) {
      const existing = contexts.get(source);
      if (existing) return existing.ctx;
      const storage =
        storages.get(source) ??
        (() => {
          const s = createMemoryStorage();
          storages.set(source, s);
          return s;
        })();
      const mock = createMockContext({ storage, silentLogs: true });
      contexts.set(source, mock);
      return mock.ctx;
    },
    createStorage(name) {
      const existing = storages.get(name);
      if (existing) return existing;
      const s = createMemoryStorage();
      storages.set(name, s);
      return s;
    },
    log(level, message) {
      logs.push({ level, message });
    },
  };

  return {
    host,
    logs,
    contexts,
    setDescriptor(name, descriptor) {
      descriptors.set(name, descriptor);
    },
    setCloudConfig(name, config) {
      cloud.set(name, config);
    },
  };
}

/** Build a synthetic ConnectorUsageRow for runtime tests. */
export function makeUsage(opts: {
  id: string;
  task_id?: string;
  connector_name: string;
  params?: Record<string, unknown>;
  created_at?: string;
}) {
  return {
    id: opts.id,
    task_id: opts.task_id ?? `task-${opts.id}`,
    connector_name: opts.connector_name,
    params: JSON.stringify(opts.params ?? {}),
    created_at: opts.created_at ?? new Date(0).toISOString(),
  };
}

/**
 * Build a fake descriptor whose Connector instance just records lifecycle calls.
 * Useful for runtime tests where we don't care about real polling logic.
 */
export interface FakeConnectorRecord {
  startCount: number;
  stopCount: number;
  updateConfigCalls: Array<Record<string, unknown>>;
  configAtCreate: Record<string, unknown>;
  ctx: ConnectorContext;
  /** Toggle: when true, the next start() call rejects. */
  failNextStart: boolean;
  /** When true, omit updateConfig — runtime will fall back to stop+restart. */
  noHotReload: boolean;
}

export function makeFakeDescriptor(opts: {
  name: string;
  configSchema: ConnectorDescriptor<Record<string, unknown>>["configSchema"];
  defaults: Record<string, unknown>;
  noHotReload?: boolean;
}): {
  descriptor: ConnectorDescriptor<Record<string, unknown>>;
  records: FakeConnectorRecord[];
  latest(): FakeConnectorRecord | undefined;
} {
  const records: FakeConnectorRecord[] = [];
  const descriptor: ConnectorDescriptor<Record<string, unknown>> = {
    name: opts.name,
    label: opts.name,
    description: "fake",
    configSchema: opts.configSchema,
    defaults: opts.defaults,
    create(config, ctx) {
      const rec: FakeConnectorRecord = {
        startCount: 0,
        stopCount: 0,
        updateConfigCalls: [],
        configAtCreate: { ...config },
        ctx,
        failNextStart: false,
        noHotReload: !!opts.noHotReload,
      };
      records.push(rec);
      const conn = {
        async start() {
          if (rec.failNextStart) {
            rec.failNextStart = false;
            throw new Error("forced start failure");
          }
          rec.startCount++;
        },
        stop() {
          rec.stopCount++;
        },
        status() {
          return { startCount: rec.startCount, stopCount: rec.stopCount };
        },
      } as ReturnType<ConnectorDescriptor<Record<string, unknown>>["create"]>;
      if (!opts.noHotReload) {
        (conn as { updateConfig?: (c: Record<string, unknown>) => void }).updateConfig = (
          c
        ) => {
          rec.updateConfigCalls.push({ ...c });
        };
      }
      return conn;
    },
  };
  return {
    descriptor,
    records,
    latest: () => records[records.length - 1],
  };
}
