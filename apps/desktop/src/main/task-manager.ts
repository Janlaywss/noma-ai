/**
 * Task Manager — orchestrates the full task lifecycle:
 *
 *   prompt → intent (scheduleTask tool) → create task → bind session →
 *   claim connectors → hot-reload runtime → connector events →
 *   proactive messaging back to the user's session
 *
 * This module is the single source of truth for running tasks. It owns:
 *   - Task creation from chat sessions (with session_id binding)
 *   - Connector usage CRUD (connector_usages table)
 *   - ConnectorRuntime lifecycle (start/stop/hot-reload)
 *   - Event routing: connector emit → task's session → proactive message
 */

import { BrowserWindow } from "electron";
import {
  ConnectorRuntime,
  CONNECTOR_REGISTRY,
  type ConnectorRuntimeHost,
  type ConnectorContext,
  type ConnectorStorage,
  type ConnectorUsageRow,
  type ConnectorDescriptor,
} from "@noma/connector";
import { buildBatchEventAnalysisPrompt } from "@noma/event-agent";
import { getDb } from "./db/index.js";
import { getEventModel } from "./model-config.js";

// ── Types ───────────────────────────────────────────────────

export type ScheduleTaskInput = {
  title: string;
  prompt: string;
  kind: "event";
  connectors: Array<{ name: string; params?: Record<string, unknown> }>;
};

export type TaskManagerConfig = {
  /** Used by proactive messaging to send events back to the UI. */
  getMainWindow: () => BrowserWindow | null;
};

type QueuedEvent = {
  id: string;
  source: string;
  type: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

// ── Singleton ────────���────────────────────────────────────

let instance: TaskManager | null = null;

export function getTaskManager(): TaskManager {
  if (!instance) throw new Error("TaskManager not initialized");
  return instance;
}

export function initTaskManager(config: TaskManagerConfig): TaskManager {
  if (instance) return instance;
  instance = new TaskManager(config);
  return instance;
}

// ── TaskManager class ────────────────���────────────────────

export class TaskManager {
  private runtime: ConnectorRuntime;
  private config: TaskManagerConfig;
  private eventQueue = new Map<string, QueuedEvent[]>();
  private analysisTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: TaskManagerConfig) {
    this.config = config;
    this.runtime = new ConnectorRuntime(this.createRuntimeHost());
    this.startAnalysisLoop();
  }

  // ── Public API ────────────────────────────────────────

  /**
   * Create a task from a chat session. Called by the scheduleTask tool handler.
   * Binds the task to the session, claims connectors, and hot-reloads the runtime.
   */
  async createTaskFromSession(
    sessionId: string,
    input: ScheduleTaskInput
  ): Promise<{ taskId: string; connectorUsages: string[] }> {
    const db = getDb();

    // 1. Insert task with session binding
    const connectorNames = input.connectors.map((c) => c.name);
    const stmt = db.prepare(`
      INSERT INTO tasks (title, prompt, kind, status, origin, session_id, connectors)
      VALUES (?, ?, ?, 'running', 'agent', ?, ?)
    `);
    const info = stmt.run(
      input.title,
      input.prompt,
      input.kind,
      sessionId,
      JSON.stringify(connectorNames)
    );
    const taskRow = db
      .prepare("SELECT id FROM tasks WHERE rowid = ?")
      .get(info.lastInsertRowid) as { id: string };
    const taskId = taskRow.id;

    // 2. Create connector usages with per-task params
    const usageIds: string[] = [];
    const insertUsage = db.prepare(`
      INSERT INTO connector_usages (task_id, connector_name, params)
      VALUES (?, ?, ?)
    `);

    for (const claim of input.connectors) {
      const usageInfo = insertUsage.run(
        taskId,
        claim.name,
        JSON.stringify(claim.params ?? {})
      );
      const usageRow = db
        .prepare("SELECT id FROM connector_usages WHERE rowid = ?")
        .get(usageInfo.lastInsertRowid) as { id: string };
      usageIds.push(usageRow.id);
    }

    // 3. Feed usages to the ConnectorRuntime for hot-reload
    await this.activateUsages(taskId);

    console.log(
      `[task-manager] created task '${taskId}' (session=${sessionId}) with connectors: ${connectorNames.join(", ")}`
    );

    return { taskId, connectorUsages: usageIds };
  }

  /**
   * Boot connector runtime for all running tasks. Called on app start.
   */
  async bootRunningTasks(): Promise<void> {
    const db = getDb();
    const runningTasks = db
      .prepare("SELECT id FROM tasks WHERE status = 'running'")
      .all() as Array<{ id: string }>;

    for (const task of runningTasks) {
      await this.activateUsages(task.id);
    }

    if (runningTasks.length > 0) {
      console.log(
        `[task-manager] booted ${runningTasks.length} running tasks`
      );
    }
  }

  /**
   * Stop a task: remove its connector usages from the runtime.
   */
  async stopTask(taskId: string): Promise<void> {
    const db = getDb();
    const usages = db
      .prepare("SELECT id FROM connector_usages WHERE task_id = ?")
      .all(taskId) as Array<{ id: string }>;

    for (const usage of usages) {
      await this.runtime.removeUsage(usage.id);
    }

    this.eventQueue.delete(taskId);

    db.prepare(
      "UPDATE tasks SET status = 'done', updated_at = datetime('now') WHERE id = ?"
    ).run(taskId);

    console.log(`[task-manager] stopped task '${taskId}'`);
  }

  /**
   * Send a proactive message to the user through a task's associated session.
   * Used by the notify tool and by connector event routing.
   */
  sendProactiveMessage(
    sessionId: string,
    message: string,
    level: "info" | "nudge" | "alert" = "info"
  ): void {
    const win = this.config.getMainWindow();
    if (!win || win.isDestroyed()) return;

    win.webContents.send("task:proactiveMessage", {
      sessionId,
      message,
      level,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Look up the session_id for a given task.
   */
  getTaskSession(taskId: string): string | null {
    const db = getDb();
    const row = db
      .prepare("SELECT session_id FROM tasks WHERE id = ?")
      .get(taskId) as { session_id: string | null } | undefined;
    return row?.session_id ?? null;
  }

  destroy(): void {
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = null;
    }
  }

  // ── Internal ──────────────���───────────────────────────

  private async activateUsages(taskId: string): Promise<void> {
    const db = getDb();
    const usages = db
      .prepare(
        "SELECT id, task_id, connector_name, params, created_at FROM connector_usages WHERE task_id = ?"
      )
      .all(taskId) as Array<{
      id: string;
      task_id: string;
      connector_name: string;
      params: string;
      created_at: string;
    }>;

    for (const usage of usages) {
      const row: ConnectorUsageRow = {
        id: usage.id,
        task_id: usage.task_id,
        connector_name: usage.connector_name,
        params: usage.params,
        created_at: usage.created_at,
      };
      await this.runtime.addUsage(row);
    }
  }

  private createRuntimeHost(): ConnectorRuntimeHost {
    const self = this;
    return {
      descriptorFor(
        name: string
      ): ConnectorDescriptor<Record<string, unknown>> | null {
        return CONNECTOR_REGISTRY[name] ?? null;
      },

      async fetchCloudConfig(
        connectorName: string
      ): Promise<Record<string, unknown>> {
        // Read locally-stored config (synced from server after OAuth or manual entry)
        const db = getDb();
        db.exec(`
          CREATE TABLE IF NOT EXISTS connector_storage (
            connector_name TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (connector_name, key)
          );
        `);
        const rows = db
          .prepare(
            "SELECT key, value FROM connector_storage WHERE connector_name = ?"
          )
          .all(connectorName) as Array<{ key: string; value: string }>;

        const config: Record<string, unknown> = {};
        for (const row of rows) {
          // Try to parse numbers and booleans
          if (/^\d+(\.\d+)?$/.test(row.value)) {
            config[row.key] = Number(row.value);
          } else if (row.value === "true" || row.value === "false") {
            config[row.key] = row.value === "true";
          } else {
            config[row.key] = row.value;
          }
        }
        return config;
      },

      createContext(source: string): ConnectorContext {
        const ctx: ConnectorContext = {
          emitEvent(ev) {
            self.handleConnectorEvent(source, ev);
          },
          log(level, message) {
            console.log(`[connector:${source}] [${level}] ${message}`);
          },
          storage: self.createLocalStorage(source),
        };

        // Add OAuth refresh proxy for connectors that need it (e.g. gmail).
        // Routes through the server so the client_secret stays server-side.
        ctx.refreshOAuth = async () => {
          const serverUrl =
            process.env.NOMA_SERVER_URL ?? "http://localhost:3677";

          try {
            const res = await fetch(
              `${serverUrl}/api/connectors/${source}/oauth/refresh`,
              { method: "POST" }
            );
            if (!res.ok) return null;
            const data = (await res.json()) as {
              access_token: string;
              expires_at: number;
            };
            // Also update local storage so next restart picks up fresh token
            const storage = self.createLocalStorage(source);
            await storage.set("access_token", data.access_token);
            await storage.set("expires_at", String(data.expires_at));
            return data;
          } catch {
            return null;
          }
        };

        return ctx;
      },

      createStorage(connectorName: string): ConnectorStorage {
        return self.createLocalStorage(connectorName);
      },

      log(level, message) {
        console.log(`[connector-runtime] [${level}] ${message}`);
      },
    };
  }

  /**
   * Handle a connector event emission. Routes to the right task/session.
   *
   * Events are always persisted and broadcast to the UI (for inbox/task detail).
   * But proactive user notifications are only sent when the event-agent LLM
   * decides the event is worth the user's attention — reducing noise.
   */
  private handleConnectorEvent(
    source: string,
    ev: { type: string; payload?: Record<string, unknown> }
  ): void {
    const db = getDb();

    // Find all running tasks that claim this connector
    const tasks = db
      .prepare(
        `SELECT t.id, t.title, t.prompt, t.session_id
         FROM tasks t
         JOIN connector_usages cu ON cu.task_id = t.id
         WHERE cu.connector_name = ? AND t.status = 'running'`
      )
      .all(source) as Array<{
      id: string;
      title: string;
      prompt: string;
      session_id: string | null;
    }>;

    for (const task of tasks) {
      // Increment events_count
      db.prepare(
        "UPDATE tasks SET events_count = events_count + 1, last_run_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
      ).run(task.id);

      // Persist event
      const insertResult = db.prepare(
        "INSERT INTO events (task_id, source, type, payload) VALUES (?, ?, ?, ?)"
      ).run(task.id, source, ev.type, JSON.stringify(ev.payload ?? {}));

      const eventRow = db
        .prepare("SELECT id, created_at FROM events WHERE rowid = ?")
        .get(insertResult.lastInsertRowid) as { id: string; created_at: string };

      // Queue for batch analysis (60-second cycle)
      if (task.session_id) {
        const queue = this.eventQueue.get(task.id) ?? [];
        queue.push({
          id: eventRow.id,
          source,
          type: ev.type,
          payload: ev.payload ?? null,
          createdAt: eventRow.created_at,
        });
        this.eventQueue.set(task.id, queue);
      }
    }

    // Also broadcast to the renderer for live UI updates (inbox, connectors page)
    const win = this.config.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send("task:connectorEvent", {
        source,
        type: ev.type,
        payload: ev.payload,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private startAnalysisLoop(): void {
    this.analysisTimer = setInterval(() => {
      this.runBatchAnalysis().catch((err) => {
        console.warn("[task-manager] batch analysis failed:", err);
      });
    }, 60_000);
  }

  private async runBatchAnalysis(): Promise<void> {
    const snapshot = new Map(this.eventQueue);
    this.eventQueue.clear();

    this.pruneOldSummaries();

    const db = getDb();
    for (const [taskId, events] of snapshot) {
      if (events.length === 0) continue;

      const task = db
        .prepare(
          "SELECT id, title, prompt, session_id FROM tasks WHERE id = ? AND status = 'running'"
        )
        .get(taskId) as
        | {
            id: string;
            title: string;
            prompt: string;
            session_id: string | null;
          }
        | undefined;

      if (!task?.session_id) continue;

      const recentSummaries = this.getRecentSummaries(taskId);

      try {
        await this.evaluateBatchEvents(task, events, recentSummaries);
      } catch (err) {
        console.warn(
          `[task-manager] batch evaluation failed for task ${taskId}:`,
          err
        );
      }
    }
  }

  private async evaluateBatchEvents(
    task: {
      id: string;
      title: string;
      prompt: string;
      session_id: string | null;
    },
    events: QueuedEvent[],
    recentSummaries: Array<{ summary: string; createdAt: string }>
  ): Promise<void> {
    if (!task.session_id) return;

    const serverUrl =
      process.env.NOMA_SERVER_URL ?? "http://localhost:3677";
    const userPrompt = buildBatchEventAnalysisPrompt({
      task,
      events,
      recentSummaries,
    });

    const body = {
      model: getEventModel(),
      messages: [{ role: "user", content: userPrompt }],
      tools: [
        {
          type: "function",
          function: {
            name: "notify",
            description: "Send a proactive notification to the user.",
            parameters: {
              type: "object",
              properties: {
                message: {
                  type: "string",
                  description: "The notification message.",
                },
                level: {
                  type: "string",
                  enum: ["info", "nudge", "alert"],
                  description: "Urgency level.",
                },
              },
              required: ["message"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "summary",
            description:
              "Summarize this batch of events for the timeline. Must be called exactly once.",
            parameters: {
              type: "object",
              properties: {
                text: {
                  type: "string",
                  description:
                    "1-2 sentence summary capturing key values and trends.",
                },
              },
              required: ["text"],
            },
          },
        },
      ],
      stream: false,
    };

    try {
      const resp = await fetch(`${serverUrl}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        console.warn(`[event-agent] LLM returned ${resp.status}`);
        return;
      }

      const result = (await resp.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };

      const choice = result.choices?.[0]?.message;
      if (!choice) return;

      const notifyCalls =
        choice.tool_calls?.filter(
          (tc) => tc.function?.name === "notify"
        ) ?? [];
      for (const call of notifyCalls) {
        if (call.function?.arguments) {
          try {
            const args = JSON.parse(call.function.arguments) as {
              message?: string;
              level?: "info" | "nudge" | "alert";
            };
            if (args.message) {
              this.sendProactiveMessage(
                task.session_id!,
                args.message,
                args.level ?? "nudge"
              );
              console.log(
                `[event-agent] notify → ${task.title}: ${args.message.slice(0, 60)}`
              );
            }
          } catch {
            // malformed tool call args
          }
        }
      }

      const summaryCall = choice.tool_calls?.find(
        (tc) => tc.function?.name === "summary"
      );
      if (summaryCall?.function?.arguments) {
        try {
          const args = JSON.parse(summaryCall.function.arguments) as {
            text?: string;
          };
          if (args.text) {
            this.saveSummary(task.id, args.text, events.length);
            console.log(
              `[event-agent] summary → ${task.title}: ${args.text.slice(0, 80)}`
            );
          }
        } catch {
          // malformed tool call args
        }
      }
    } catch (err) {
      console.warn(
        `[event-agent] fetch failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  private saveSummary(
    taskId: string,
    summary: string,
    eventsCount: number
  ): void {
    const db = getDb();
    db.prepare(
      "INSERT INTO task_summaries (task_id, summary, events_analyzed) VALUES (?, ?, ?)"
    ).run(taskId, summary, eventsCount);
  }

  private getRecentSummaries(
    taskId: string
  ): Array<{ summary: string; createdAt: string }> {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT summary, created_at FROM task_summaries
         WHERE task_id = ? AND created_at > datetime('now', '-6 hours')
         ORDER BY created_at ASC`
      )
      .all(taskId) as Array<{ summary: string; created_at: string }>;
    return rows.map((r) => ({
      summary: r.summary,
      createdAt: r.created_at,
    }));
  }

  private pruneOldSummaries(): void {
    const db = getDb();
    db.prepare(
      "DELETE FROM task_summaries WHERE created_at < datetime('now', '-6 hours')"
    ).run();
  }

  /**
   * Simple SQLite-backed connector storage.
   */
  private createLocalStorage(connectorName: string): ConnectorStorage {
    const db = getDb();

    // Ensure storage table exists (idempotent)
    db.exec(`
      CREATE TABLE IF NOT EXISTS connector_storage (
        connector_name TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (connector_name, key)
      );
    `);

    return {
      async get(key: string): Promise<string | null> {
        const row = db
          .prepare(
            "SELECT value FROM connector_storage WHERE connector_name = ? AND key = ?"
          )
          .get(connectorName, key) as { value: string } | undefined;
        return row?.value ?? null;
      },
      async set(key: string, value: string): Promise<void> {
        db.prepare(
          `INSERT OR REPLACE INTO connector_storage (connector_name, key, value)
           VALUES (?, ?, ?)`
        ).run(connectorName, key, value);
      },
      async delete(key: string): Promise<void> {
        db.prepare(
          "DELETE FROM connector_storage WHERE connector_name = ? AND key = ?"
        ).run(connectorName, key);
      },
    };
  }
}
