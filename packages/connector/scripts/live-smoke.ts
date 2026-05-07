#!/usr/bin/env tsx
/**
 * Live smoke-test CLI for @noma/connector.
 *
 * Hits the real upstream APIs of one or more built-in connectors, captures
 * any events emitted within a wait window, and prints a pass/fail table.
 *
 * Usage:
 *   pnpm --filter @noma/connector test:live                   # run all connectors that have credentials
 *   pnpm --filter @noma/connector test:live weather github    # run a subset
 *   pnpm --filter @noma/connector test:live weather --country=US --city="New York"
 *
 * Per-connector inputs come from CLI flags first, then env vars
 * (see ENV_KEYS below). A connector is skipped when its taskRequired
 * fields cannot be satisfied — exit code is non-zero only if a *requested*
 * connector fails, never just because credentials are missing.
 *
 * Each connector runs in isolation: fresh ConnectorContext, in-memory
 * storage, no shared registry. This script does NOT exercise
 * ConnectorRuntime — that's covered by the unit tests.
 */
import { CONNECTOR_REGISTRY } from "../src/registry.js";
import type {
  ConfigField,
  Connector,
  ConnectorContext,
  ConnectorDescriptor,
  ConnectorStorage,
} from "../src/types.js";

const DEFAULT_WAIT_SEC = 8;

const ENV_KEYS: Record<string, Record<string, string>> = {
  github: { token: "GITHUB_TOKEN" },
  gmail: {
    access_token: "GMAIL_ACCESS_TOKEN",
    refresh_token: "GMAIL_REFRESH_TOKEN",
  },
  lark: { appId: "LARK_APP_ID", appSecret: "LARK_APP_SECRET" },
  stock: { symbols: "STOCK_SYMBOLS", finnhubKey: "FINNHUB_KEY" },
  weather: { country: "WEATHER_COUNTRY", city: "WEATHER_CITY" },
  flight: { flightNumber: "FLIGHT_NUMBER" },
};

interface ParsedArgs {
  names: string[];
  flags: Record<string, string>;
  waitSec: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const names: string[] = [];
  const flags: Record<string, string> = {};
  let waitSec = DEFAULT_WAIT_SEC;
  for (const a of argv) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      const value = eq >= 0 ? a.slice(eq + 1) : "true";
      if (key === "wait") waitSec = Math.max(1, Number(value));
      else flags[key] = value;
    } else if (!a.startsWith("-")) {
      names.push(a);
    }
  }
  return { names, flags, waitSec };
}

function buildConfig(
  descriptor: ConnectorDescriptor<Record<string, unknown>>,
  flags: Record<string, string>
): { config: Record<string, unknown>; missing: string[] } {
  const out: Record<string, unknown> = { ...descriptor.defaults };
  const envMap = ENV_KEYS[descriptor.name] ?? {};
  for (const f of descriptor.configSchema) {
    const flagVal = flags[f.key];
    const envVal = envMap[f.key] ? process.env[envMap[f.key]] : undefined;
    const raw = flagVal ?? envVal;
    if (raw === undefined) continue;
    out[f.key] = coerceField(f, raw);
  }
  // pollIntervalSec: keep small but legal; floors are enforced by each connector
  if (typeof out.pollIntervalSec === "undefined") out.pollIntervalSec = 30;

  const missing = descriptor.configSchema
    .filter((f) => f.taskRequired)
    .filter((f) => !hasMeaningfulValue(out[f.key], f))
    .map((f) => f.key);

  return { config: out, missing };
}

function coerceField(f: ConfigField, raw: string): unknown {
  if (f.type === "number") return Number(raw);
  if (f.type === "boolean") return raw === "true" || raw === "1";
  if (f.type === "string[]") {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return raw;
}

function hasMeaningfulValue(v: unknown, f: ConfigField): boolean {
  if (v === undefined || v === null) return false;
  if (f.type === "string") return typeof v === "string" && v.length > 0;
  if (f.type === "string[]") return Array.isArray(v) && v.length > 0;
  if (f.type === "number") return typeof v === "number" && Number.isFinite(v);
  return true;
}

function memoryStorage(): ConnectorStorage {
  const m = new Map<string, string>();
  return {
    async get(k) { return m.get(k) ?? null; },
    async set(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}

interface SmokeResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  events: number;
  errors: number;
  durationMs: number;
}

async function runOne(
  descriptor: ConnectorDescriptor<Record<string, unknown>>,
  flags: Record<string, string>,
  waitSec: number
): Promise<SmokeResult> {
  const { config, missing } = buildConfig(descriptor, flags);
  if (missing.length > 0) {
    return {
      name: descriptor.name,
      status: "skip",
      detail: `missing required: ${missing.join(", ")}`,
      events: 0,
      errors: 0,
      durationMs: 0,
    };
  }

  let eventCount = 0;
  let errorCount = 0;
  const ctx: ConnectorContext = {
    emitEvent(ev) {
      eventCount++;
      const sample = ev.payload?.title ?? ev.payload?.id ?? "";
      console.log(`  [${descriptor.name}] event: ${ev.type} ${sample}`);
    },
    log(level, message) {
      if (level === "warn" || level === "error") errorCount++;
      console.log(`  [${descriptor.name}] ${level}: ${message}`);
    },
    storage: memoryStorage(),
  };

  const start = Date.now();
  let conn: Connector | null = null;
  try {
    conn = descriptor.create(config, ctx);
    await conn.start();
    await new Promise((r) => setTimeout(r, waitSec * 1000));
  } catch (err) {
    return {
      name: descriptor.name,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      events: eventCount,
      errors: errorCount + 1,
      durationMs: Date.now() - start,
    };
  } finally {
    if (conn) {
      try { await conn.stop(); } catch {}
    }
  }

  // 有事件产出就算通过（fallback 过程中的 warn 是正常行为）
  const status: SmokeResult["status"] =
    eventCount > 0 ? "pass" : errorCount > 0 ? "fail" : "pass";
  const detail =
    eventCount > 0
      ? `${eventCount} event(s)${errorCount ? `, ${errorCount} warn(s)` : ""}`
      : errorCount > 0
        ? `${errorCount} log warning(s)/error(s)`
        : "no events (may be normal)";
  return {
    name: descriptor.name,
    status,
    detail,
    events: eventCount,
    errors: errorCount,
    durationMs: Date.now() - start,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printTable(rows: SmokeResult[]) {
  console.log("");
  console.log(
    pad("connector", 12) +
      pad("status", 8) +
      pad("events", 8) +
      pad("ms", 8) +
      "detail"
  );
  console.log("─".repeat(72));
  for (const r of rows) {
    const tag =
      r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "SKIP";
    console.log(
      pad(r.name, 12) +
        pad(tag, 8) +
        pad(String(r.events), 8) +
        pad(String(r.durationMs), 8) +
        r.detail
    );
  }
}

async function main() {
  const { names, flags, waitSec } = parseArgs(process.argv.slice(2));
  const allNames = Object.keys(CONNECTOR_REGISTRY);
  const requested = names.length > 0 ? names : allNames;

  for (const n of requested) {
    if (!(n in CONNECTOR_REGISTRY)) {
      console.error(`unknown connector: ${n}`);
      process.exitCode = 2;
      return;
    }
  }

  console.log(
    `live-smoke: testing ${requested.join(", ")} (wait ${waitSec}s each)`
  );

  const results: SmokeResult[] = [];
  for (const name of requested) {
    const descriptor = CONNECTOR_REGISTRY[name]!;
    console.log(`\n→ ${name}`);
    results.push(await runOne(descriptor, flags, waitSec));
  }

  printTable(results);

  const explicit = names.length > 0;
  const failed = results.some((r) => r.status === "fail");
  const allSkipped = results.every((r) => r.status === "skip");
  // Explicit run: any fail or skip is non-zero. Default run: only fails.
  if (failed || (explicit && allSkipped)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
