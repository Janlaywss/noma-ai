import type { Connector, ConnectorContext, ConnectorDescriptor } from "../types.js";

/**
 * 金十 (Jin10) — Chinese financial-news flash stream. Polls the public
 * `flash_newest.js` (a `var newest = [...]` JSONP-flavoured file), diffs
 * by id, and emits every fresh item as `news`. We deliberately ignore
 * Jin10's upstream `important` flag: event importance is a user/task
 * decision made by the event agent with memory, not a feed-provided label.
 *
 * On the very first poll we seed the dedup set without emitting, so a
 * fresh task doesn't spam the user with backlog at start-up.
 */

interface Jin10Config extends Record<string, unknown> {
  pollIntervalSec: number;
}

interface Jin10Item {
  id: string;
  time?: string;
  type?: number;
  data?: { content?: string; title?: string; vip_title?: string };
  channel?: number[];
}

const ENDPOINT = "https://www.jin10.com/flash_newest.js";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

function parseFlashNews(raw: string): Jin10Item[] {
  const stripped = raw
    .replace(/^\s*var\s+newest\s*=\s*/, "")
    .replace(/;\s*$/, "")
    .trim();
  try {
    return JSON.parse(stripped) as Jin10Item[];
  } catch {
    return [];
  }
}

const stripHtml = (s: string): string => s.replace(/<[^>]+>/g, "").trim();

function summarize(item: Jin10Item): string {
  const raw =
    item.data?.content ?? item.data?.vip_title ?? item.data?.title ?? "";
  return stripHtml(raw).slice(0, 300);
}

function createJin10Connector(cfg: Jin10Config, ctx: ConnectorContext): Connector {
  let pollIntervalSec = Math.max(10, Number(cfg.pollIntervalSec) || 30);
  const seen = new Set<string>();
  let primed = false;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let lastPollAt: number | null = null;
  let lastItemCount = 0;

  const poll = async () => {
    if (running) return;
    running = true;
    try {
      const res = await fetch(`${ENDPOINT}?t=${Date.now()}`, {
        headers: { "User-Agent": UA, Accept: "*/*" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parseFlashNews(await res.text());
      lastPollAt = Date.now();
      lastItemCount = items.length;

      if (!primed) {
        for (const it of items) seen.add(it.id);
        primed = true;
        ctx.log(
          "info",
          `  jin10: primed ${items.length} item(s) — first poll suppressed`
        );
        return;
      }

      // Emit oldest-first so chronological reading makes sense.
      for (const it of items.slice().reverse()) {
        if (!it?.id || seen.has(it.id)) continue;
        seen.add(it.id);
        const content = summarize(it);
        if (!content) continue;
        ctx.emitEvent({
          type: "news",
          payload: {
            id: it.id,
            time: it.time,
            content,
            channel: it.channel,
          },
        });
      }

      // Bound memory — keep the last ~2000 ids.
      if (seen.size > 2000) {
        const keep = Array.from(seen).slice(-1500);
        seen.clear();
        for (const id of keep) seen.add(id);
      }
    } catch (err) {
      ctx.log(
        "warn",
        `  jin10: poll failed — ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      running = false;
    }
  };

  return {
    async start() {
      ctx.log("info", `jin10: started (every ${pollIntervalSec}s)`);
      await poll();
      timer = setInterval(() => void poll(), pollIntervalSec * 1000);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      ctx.log("info", "jin10: stopped");
    },
    status() {
      return { pollIntervalSec, primed, seenCount: seen.size, lastPollAt, lastItemCount };
    },
    updateConfig(cfg: Record<string, unknown>) {
      const newInterval = Math.max(10, Number(cfg.pollIntervalSec) || 30);
      if (newInterval !== pollIntervalSec) {
        pollIntervalSec = newInterval;
        if (timer) {
          clearInterval(timer);
          timer = setInterval(() => void poll(), pollIntervalSec * 1000);
        }
      }
      ctx.log("info", `jin10: config updated (every ${pollIntervalSec}s)`);
    },
  };
}

export const jin10Descriptor: ConnectorDescriptor<Jin10Config> = {
  name: "jin10",
  label: "金十 Jin10",
  description: "金十财经快讯流。每条新快讯都会触发 news，是否重要由用户任务和记忆判断。",
  configSchema: [
    { key: "pollIntervalSec", type: "number", min: 10 },
  ],
  defaults: { pollIntervalSec: 30 },
  create: createJin10Connector,
};
