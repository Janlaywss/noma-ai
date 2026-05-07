import type { Connector, ConnectorContext } from "../types.js";

/**
 * Dynamic connector — runs user-supplied JS code as a connector. The code
 * must `return { configSchema?, defaults?, poll(config, ctx) }`. The
 * sandboxed `ctx` exposes `emitEvent`, `seen`, and `markSeen` helpers
 * scoped to this instance — events get bridged through the host-supplied
 * `ConnectorContext` so persistence and logging stay consistent with
 * built-in connectors.
 */

type PollContext = {
  emitEvent: (ev: { type: string; payload?: Record<string, unknown> }) => void;
  seen: (key: string) => boolean;
  markSeen: (key: string) => void;
};

type DynamicConnectorSpec = {
  configSchema?: unknown[];
  defaults?: Record<string, unknown>;
  poll: (config: Record<string, unknown>, ctx: PollContext) => Promise<void>;
};

const MAX_SEEN = 2000;
const KEEP_SEEN = 1500;

export function createDynamicConnector(
  name: string,
  code: string,
  mergedConfig: Record<string, unknown>,
  ctx: ConnectorContext
): Connector {
  const spec = evalConnectorCode(code, ctx);

  const pollIntervalSec = Math.max(
    30,
    Number(mergedConfig.pollIntervalSec) || 300
  );
  const seen = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let primed = false;
  let lastPollAt: number | null = null;

  const pollCtx: PollContext = {
    emitEvent(ev) {
      ctx.emitEvent({ type: ev.type, payload: ev.payload });
    },
    seen(key) {
      return seen.has(key);
    },
    markSeen(key) {
      seen.add(key);
      if (seen.size > MAX_SEEN) {
        const keep = Array.from(seen).slice(-KEEP_SEEN);
        seen.clear();
        for (const k of keep) seen.add(k);
      }
    },
  };

  const primingCtx: PollContext = {
    emitEvent() {},
    seen: () => false,
    markSeen(key) {
      seen.add(key);
    },
  };

  let emitCount = 0;
  let pollCount = 0;
  const countingCtx: PollContext = {
    emitEvent(ev) {
      emitCount++;
      pollCtx.emitEvent(ev);
    },
    seen: pollCtx.seen,
    markSeen: pollCtx.markSeen,
  };

  const poll = async () => {
    if (running) return;
    running = true;
    emitCount = 0;
    try {
      if (!primed) {
        await spec.poll(mergedConfig, primingCtx);
        primed = true;
        ctx.log(
          "info",
          `  ${name}: primed (${seen.size} key(s)) — first poll suppressed`
        );
      } else {
        pollCount++;
        await spec.poll(mergedConfig, countingCtx);
        ctx.log(
          "info",
          `  ${name}: poll #${pollCount} done — ${emitCount} event(s), ${seen.size} seen`
        );
      }
      lastPollAt = Date.now();
    } catch (err) {
      ctx.log(
        "warn",
        `  ${name}: poll failed — ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      running = false;
    }
  };

  return {
    async start() {
      ctx.log("info", `${name}: started (every ${pollIntervalSec}s)`);
      await poll();
      timer = setInterval(() => void poll(), pollIntervalSec * 1000);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      ctx.log("info", `${name}: stopped`);
    },
    status() {
      return { pollIntervalSec, primed, seenCount: seen.size, lastPollAt };
    },
  };
}

function evalConnectorCode(
  code: string,
  ctx: ConnectorContext
): DynamicConnectorSpec {
  const dynConsole = {
    log: (...args: unknown[]) => ctx.log("info", `  [dyn] ${args.join(" ")}`),
    warn: (...args: unknown[]) => ctx.log("warn", `  [dyn] ${args.join(" ")}`),
    error: (...args: unknown[]) => ctx.log("warn", `  [dyn] ${args.join(" ")}`),
  };
  const factory = new Function(
    "fetch",
    "console",
    "URL",
    "URLSearchParams",
    "TextEncoder",
    "TextDecoder",
    `"use strict"; return (${code})`
  );
  const result = factory(
    globalThis.fetch,
    dynConsole,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder
  ) as DynamicConnectorSpec;
  if (typeof result?.poll !== "function") {
    throw new Error(
      "dynamic connector code must return an object with a poll() function"
    );
  }
  return result;
}
