import type {
  Connector,
  ConfigField,
  ConnectorDescriptor,
  ConnectorRuntimeHost,
  ConnectorUsageRow,
} from "./types.js";

/**
 * Host-agnostic connector execution runtime.
 *
 * Manages shared connector instances, config aggregation, hot-reload,
 * and lifecycle (start/stop). The host injects DB access, cloud config
 * fetch, event-bus wiring, and logging via `ConnectorRuntimeHost`.
 *
 * One Connector instance per (connector_name + identity params), shared
 * by all tasks that claim the same connector. Dynamic connectors (dyn_*)
 * are excluded from sharing — each usage gets its own instance.
 */

type InstanceEntry = {
  connector: Connector;
  connectorName: string;
  usageConfigs: Map<string, Record<string, unknown>>;
  baseConfig: Record<string, unknown>;
  config: Record<string, unknown>;
};

export class ConnectorRuntime {
  private host: ConnectorRuntimeHost;
  private instances = new Map<string, InstanceEntry>();
  private usageToInstanceKey = new Map<string, string>();

  constructor(host: ConnectorRuntimeHost) {
    this.host = host;
  }

  async addUsage(usage: ConnectorUsageRow): Promise<void> {
    const descriptor = this.host.descriptorFor(usage.connector_name);
    if (!descriptor) {
      this.host.log(
        "warn",
        `runtime: unknown connector '${usage.connector_name}' for usage ${usage.id} — skip`
      );
      return;
    }

    const usageParams = coerce(descriptor.configSchema, safeJson(usage.params));
    const instanceKey = computeInstanceKey(
      usage.connector_name,
      descriptor.configSchema,
      usageParams,
      usage.id
    );

    if (this.usageToInstanceKey.get(usage.id) === instanceKey) {
      const entry = this.instances.get(instanceKey);
      if (entry?.usageConfigs.has(usage.id)) {
        this.host.log(
          "info",
          `runtime: usage#${usage.id} already in instance '${instanceKey}' — skip`
        );
        return;
      }
    }

    const existing = this.instances.get(instanceKey);

    if (existing) {
      existing.usageConfigs.set(usage.id, usageParams);
      this.usageToInstanceKey.set(usage.id, instanceKey);

      const newConfig = aggregateConfigs(
        descriptor.configSchema,
        existing.baseConfig,
        [...existing.usageConfigs.values()]
      );

      if (configChanged(existing.config, newConfig)) {
        if (existing.connector.updateConfig) {
          existing.connector.updateConfig(newConfig);
          existing.config = newConfig;
          this.host.log(
            "info",
            `runtime: usage#${usage.id} joined instance '${instanceKey}' — hot-reloaded`
          );
        } else {
          try { await existing.connector.stop(); } catch {}
          const ctx = this.host.createContext(usage.connector_name);
          const inst = descriptor.create(newConfig, ctx);
          existing.connector = inst;
          existing.config = newConfig;
          await inst.start();
          this.host.log(
            "info",
            `runtime: usage#${usage.id} joined instance '${instanceKey}' — restarted`
          );
        }
      } else {
        this.host.log(
          "info",
          `runtime: usage#${usage.id} joined instance '${instanceKey}' — config unchanged`
        );
      }
      return;
    }

    // Create new instance
    const cloudParams = coerce(
      descriptor.configSchema,
      await this.host.fetchCloudConfig(usage.connector_name)
    );
    const baseConfig = { ...descriptor.defaults, ...cloudParams };
    const config = aggregateConfigs(
      descriptor.configSchema,
      baseConfig,
      [usageParams]
    );

    this.host.log(
      "info",
      `runtime: creating instance '${instanceKey}' for '${usage.connector_name}'`
    );
    try {
      const ctx = this.host.createContext(usage.connector_name);
      const inst = descriptor.create(config, ctx);
      const entry: InstanceEntry = {
        connector: inst,
        connectorName: usage.connector_name,
        usageConfigs: new Map([[usage.id, usageParams]]),
        baseConfig,
        config,
      };
      this.instances.set(instanceKey, entry);
      this.usageToInstanceKey.set(usage.id, instanceKey);
      await inst.start();
      this.host.log("info", `runtime: instance '${instanceKey}' started OK`);
    } catch (err) {
      this.host.log(
        "warn",
        `runtime: instance '${instanceKey}' failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}`
      );
      this.instances.delete(instanceKey);
      this.usageToInstanceKey.delete(usage.id);
    }
  }

  async removeUsage(usageId: string): Promise<void> {
    const instanceKey = this.usageToInstanceKey.get(usageId);
    if (!instanceKey) return;

    const entry = this.instances.get(instanceKey);
    if (!entry) {
      this.usageToInstanceKey.delete(usageId);
      return;
    }

    entry.usageConfigs.delete(usageId);
    this.usageToInstanceKey.delete(usageId);

    if (entry.usageConfigs.size === 0) {
      try { await entry.connector.stop(); } catch (err) {
        this.host.log(
          "warn",
          `runtime: instance '${instanceKey}' stop failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      this.instances.delete(instanceKey);
      this.host.log(
        "info",
        `runtime: instance '${instanceKey}' stopped (last usage removed)`
      );
      return;
    }

    const descriptor = this.host.descriptorFor(entry.connectorName);
    if (!descriptor) return;

    const newConfig = aggregateConfigs(
      descriptor.configSchema,
      entry.baseConfig,
      [...entry.usageConfigs.values()]
    );

    if (configChanged(entry.config, newConfig)) {
      if (entry.connector.updateConfig) {
        entry.connector.updateConfig(newConfig);
        entry.config = newConfig;
        this.host.log(
          "info",
          `runtime: usage#${usageId} removed from '${instanceKey}' — hot-reloaded`
        );
      } else {
        try { await entry.connector.stop(); } catch {}
        const ctx = this.host.createContext(entry.connectorName);
        const inst = descriptor.create(newConfig, ctx);
        entry.connector = inst;
        entry.config = newConfig;
        await inst.start();
        this.host.log(
          "info",
          `runtime: usage#${usageId} removed from '${instanceKey}' — restarted`
        );
      }
    } else {
      this.host.log(
        "info",
        `runtime: usage#${usageId} removed from '${instanceKey}' — config unchanged`
      );
    }
  }

  async addUsages(usages: ConnectorUsageRow[]): Promise<void> {
    for (const u of usages) await this.addUsage(u);
  }

  async stopAll(): Promise<void> {
    for (const [key, entry] of this.instances) {
      try { await entry.connector.stop(); } catch (err) {
        this.host.log(
          "warn",
          `runtime: stop instance '${key}' failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    this.instances.clear();
    this.usageToInstanceKey.clear();
  }

  listInstances(): Array<{
    instanceKey: string;
    connectorName: string;
    usageCount: number;
  }> {
    return [...this.instances.entries()].map(([key, entry]) => ({
      instanceKey: key,
      connectorName: entry.connectorName,
      usageCount: entry.usageConfigs.size,
    }));
  }

  hasUsage(usageId: string): boolean {
    return this.usageToInstanceKey.has(usageId);
  }
}

// ─── Utility functions ───────────────────────────────────────────

function safeJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function coerce(
  schema: ConfigField[],
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of schema) {
    if (!(field.key in patch)) continue;
    const raw = patch[field.key];
    switch (field.type) {
      case "number": {
        const n = typeof raw === "number" ? raw : Number(raw);
        if (Number.isFinite(n)) out[field.key] = n;
        break;
      }
      case "boolean": {
        out[field.key] =
          raw === true || raw === "true" || raw === 1 || raw === "1";
        break;
      }
      case "string[]": {
        if (Array.isArray(raw)) out[field.key] = raw.map(String);
        else if (typeof raw === "string")
          out[field.key] = raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        break;
      }
      case "string":
      default: {
        if (raw === "" && field.secret) break;
        out[field.key] = String(raw ?? "");
      }
    }
  }
  return out;
}

export function aggregateConfigs(
  schema: ConfigField[],
  baseConfig: Record<string, unknown>,
  usageConfigs: Record<string, unknown>[]
): Record<string, unknown> {
  const result = { ...baseConfig };

  for (const field of schema) {
    switch (field.type) {
      case "string[]": {
        const merged = new Set<string>();
        for (const cfg of usageConfigs) {
          const arr = cfg[field.key];
          if (Array.isArray(arr))
            arr.forEach((v) => merged.add(String(v)));
        }
        if (merged.size > 0) result[field.key] = [...merged];
        break;
      }
      case "number": {
        const values = usageConfigs
          .map((cfg) => cfg[field.key])
          .filter(
            (v): v is number => typeof v === "number" && Number.isFinite(v)
          );
        if (values.length > 0) {
          let min = Math.min(...values);
          if (field.min !== undefined) min = Math.max(min, field.min);
          result[field.key] = min;
        }
        break;
      }
      case "boolean": {
        if (usageConfigs.some((cfg) => field.key in cfg)) {
          result[field.key] = usageConfigs.some(
            (cfg) => cfg[field.key] === true
          );
        }
        break;
      }
      case "string":
      default: {
        for (const cfg of usageConfigs) {
          const v = cfg[field.key];
          if (typeof v === "string" && v) {
            result[field.key] = v;
            break;
          }
        }
        break;
      }
    }
  }

  return result;
}

function computeInstanceKey(
  connectorName: string,
  schema: ConfigField[],
  usageConfig: Record<string, unknown>,
  usageId: string
): string {
  if (connectorName.startsWith("dyn_")) return `${connectorName}:${usageId}`;

  const identityFields = schema.filter(
    (f) => f.taskRequired && f.type === "string" && !f.secret
  );
  if (identityFields.length === 0) return connectorName;

  const parts = identityFields
    .map((f) => String(usageConfig[f.key] ?? ""))
    .join(":");
  return `${connectorName}:${parts}`;
}

function configChanged(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}
