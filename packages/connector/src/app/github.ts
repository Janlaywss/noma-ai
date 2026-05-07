import type { Connector, ConnectorContext, ConnectorDescriptor } from "../types.js";

/**
 * GitHub notifications watcher. Each instance polls
 * `/notifications` for one PAT (`config.token`); cursor is the
 * `Last-Modified` header so subsequent polls only see fresh activity.
 *
 * Docs:
 *   https://docs.github.com/en/rest/activity/notifications#list-notifications-for-the-authenticated-user
 */

interface GithubConfig extends Record<string, unknown> {
  token: string;
  pollIntervalSec: number;
}

interface GhNotification {
  id: string;
  reason: string;
  subject?: { title?: string; type?: string; url?: string };
  repository?: { full_name?: string };
}

function typeFor(reason: string): string {
  switch (reason) {
    case "review_requested":
      return "on_review_requested";
    case "mention":
      return "on_mention";
    case "assign":
      return "on_assign";
    case "team_mention":
      return "on_team_mention";
    default:
      return `on_${reason}`;
  }
}

function createGithubConnector(cfg: GithubConfig, ctx: ConnectorContext): Connector {
  let pollIntervalSec = Math.max(30, Number(cfg.pollIntervalSec) || 120);
  const token = String(cfg.token ?? "");
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let lastModified: string | null = null;
  let lastPollAt: number | null = null;

  const poll = async () => {
    if (running) return;
    running = true;
    try {
      if (!token) {
        ctx.log("info", "  github: no token configured — skip");
        return;
      }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (lastModified) headers["If-Modified-Since"] = lastModified;
      const url =
        "https://api.github.com/notifications?all=false&participating=true";
      const res = await fetch(url, { headers });
      lastPollAt = Date.now();
      if (res.status === 304) return;
      if (!res.ok) {
        ctx.log("warn", `  github: HTTP ${res.status}`);
        return;
      }
      const items = (await res.json()) as GhNotification[];
      for (const n of items) {
        const subject = n.subject?.type ?? "Notification";
        const title = n.subject?.title ?? n.reason;
        ctx.emitEvent({
          type: typeFor(n.reason),
          payload: {
            title: `${subject} · ${title}`,
            sub: `${n.repository?.full_name ?? ""} · ${n.reason}`,
            url: n.subject?.url ?? null,
            thread_id: n.id,
          },
        });
      }
      const next = res.headers.get("Last-Modified");
      if (next) lastModified = next;
    } catch (err) {
      ctx.log(
        "warn",
        `  github: poll failed — ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      running = false;
    }
  };

  return {
    async start() {
      ctx.log("info", `github: started (every ${pollIntervalSec}s)`);
      await poll();
      timer = setInterval(() => void poll(), pollIntervalSec * 1000);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      ctx.log("info", "github: stopped");
    },
    status() {
      return { pollIntervalSec, lastModified, lastPollAt };
    },
    updateConfig(cfg: Record<string, unknown>) {
      const newInterval = Math.max(30, Number(cfg.pollIntervalSec) || 120);
      if (newInterval !== pollIntervalSec) {
        pollIntervalSec = newInterval;
        if (timer) {
          clearInterval(timer);
          timer = setInterval(() => void poll(), pollIntervalSec * 1000);
        }
      }
      ctx.log("info", `github: config updated (every ${pollIntervalSec}s)`);
    },
  };
}

export const githubDescriptor: ConnectorDescriptor<GithubConfig> = {
  name: "github",
  label: "GitHub",
  description: "监听 GitHub PR/issue/review/mention 等通知。需要 PAT。",
  configSchema: [
    { key: "token", type: "string", secret: true, taskRequired: true },
    { key: "pollIntervalSec", type: "number", min: 30 },
  ],
  defaults: { token: "", pollIntervalSec: 120 },
  create: createGithubConnector,
};
