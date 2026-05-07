/**
 * Task CRUD operations backed by the local SQLite database.
 * Exposes IPC handlers for the renderer to list, create, update, and delete tasks.
 */

import { ipcMain } from "electron";
import { getDb } from "./index.js";

export interface LocalTask {
  id: string;
  title: string;
  prompt: string;
  kind: "event" | "once" | "cron";
  schedule: string | null;
  status: "pending" | "running" | "done" | "failed" | "disabled";
  origin: "user" | "agent";
  parent_id: string | null;
  slug: string | null;
  session_id: string | null;
  connectors: string[];
  events_count: number;
  last_run_at: string | null;
  next_run_at: string | null;
  last_result: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: Record<string, unknown>): LocalTask {
  return {
    id: row.id as string,
    title: row.title as string,
    prompt: row.prompt as string,
    kind: row.kind as LocalTask["kind"],
    schedule: row.schedule as string | null,
    status: row.status as LocalTask["status"],
    origin: row.origin as LocalTask["origin"],
    parent_id: row.parent_id as string | null,
    slug: row.slug as string | null,
    session_id: (row.session_id as string | null) ?? null,
    connectors: JSON.parse((row.connectors as string) || "[]"),
    events_count: row.events_count as number,
    last_run_at: row.last_run_at as string | null,
    next_run_at: row.next_run_at as string | null,
    last_result: row.last_result as string | null,
    note: row.note as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function registerTaskHandlers(): void {
  // List all tasks (optionally filter by status)
  ipcMain.handle("db:tasks:list", (_event, filter?: { status?: string }) => {
    const db = getDb();
    let sql = "SELECT * FROM tasks";
    const params: unknown[] = [];

    if (filter?.status) {
      sql += " WHERE status = ?";
      params.push(filter.status);
    }

    sql += " ORDER BY updated_at DESC";
    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToTask);
  });

  // Get a single task by ID
  ipcMain.handle("db:tasks:get", (_event, id: string) => {
    const db = getDb();
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToTask(row) : null;
  });

  // Create a new task
  ipcMain.handle(
    "db:tasks:create",
    (
      _event,
      input: {
        title: string;
        prompt?: string;
        kind?: "event" | "once" | "cron";
        schedule?: string;
        status?: string;
        origin?: "user" | "agent";
        connectors?: string[];
        note?: string;
      }
    ) => {
      const db = getDb();
      const stmt = db.prepare(`
        INSERT INTO tasks (title, prompt, kind, schedule, status, origin, connectors, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const info = stmt.run(
        input.title,
        input.prompt ?? "",
        input.kind ?? "event",
        input.schedule ?? null,
        input.status ?? "pending",
        input.origin ?? "user",
        JSON.stringify(input.connectors ?? []),
        input.note ?? null
      );
      // Return the created task
      const row = db
        .prepare("SELECT * FROM tasks WHERE rowid = ?")
        .get(info.lastInsertRowid) as Record<string, unknown>;
      return rowToTask(row);
    }
  );

  // Update an existing task
  ipcMain.handle(
    "db:tasks:update",
    (
      _event,
      id: string,
      updates: Partial<{
        title: string;
        prompt: string;
        kind: string;
        schedule: string | null;
        status: string;
        connectors: string[];
        events_count: number;
        last_run_at: string | null;
        last_result: string | null;
        note: string | null;
      }>
    ) => {
      const db = getDb();
      const fields: string[] = [];
      const values: unknown[] = [];

      for (const [key, value] of Object.entries(updates)) {
        if (key === "connectors") {
          fields.push("connectors = ?");
          values.push(JSON.stringify(value));
        } else {
          fields.push(`${key} = ?`);
          values.push(value);
        }
      }

      if (fields.length === 0) return null;

      fields.push("updated_at = datetime('now')");
      values.push(id);

      db.prepare(
        `UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`
      ).run(...values);

      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      return row ? rowToTask(row) : null;
    }
  );

  // Delete a task
  ipcMain.handle("db:tasks:delete", (_event, id: string) => {
    const db = getDb();
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return { ok: true };
  });

  // ── Events queries ──────────────────────────────────────

  // List events for a specific task (newest first)
  ipcMain.handle(
    "db:events:listByTask",
    (_event, taskId: string, opts?: { limit?: number }) => {
      const db = getDb();
      const limit = opts?.limit ?? 50;
      const rows = db
        .prepare(
          "SELECT * FROM events WHERE task_id = ? ORDER BY created_at DESC LIMIT ?"
        )
        .all(taskId, limit) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: r.id as string,
        task_id: r.task_id as string,
        source: r.source as string,
        type: r.type as string,
        payload: r.payload ? JSON.parse(r.payload as string) : null,
        consumed_at: r.consumed_at as string | null,
        created_at: r.created_at as string,
      }));
    }
  );

  // List all events across all tasks (newest first), with optional filters
  ipcMain.handle(
    "db:events:list",
    (
      _event,
      opts?: { source?: string; unreadOnly?: boolean; limit?: number }
    ) => {
      const db = getDb();
      const limit = opts?.limit ?? 100;
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (opts?.source) {
        conditions.push("e.source = ?");
        params.push(opts.source);
      }
      if (opts?.unreadOnly) {
        conditions.push("e.consumed_at IS NULL");
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const sql = `
        SELECT e.*, t.title as task_title
        FROM events e
        LEFT JOIN tasks t ON t.id = e.task_id
        ${where}
        ORDER BY e.created_at DESC
        LIMIT ?
      `;
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: r.id as string,
        task_id: r.task_id as string,
        task_title: (r.task_title as string) ?? null,
        source: r.source as string,
        type: r.type as string,
        payload: r.payload ? JSON.parse(r.payload as string) : null,
        consumed_at: r.consumed_at as string | null,
        created_at: r.created_at as string,
      }));
    }
  );

  // Mark events as consumed (read)
  ipcMain.handle("db:events:markConsumed", (_event, ids: string[]) => {
    const db = getDb();
    if (ids.length === 0) return { ok: true, count: 0 };
    const placeholders = ids.map(() => "?").join(",");
    const info = db
      .prepare(
        `UPDATE events SET consumed_at = datetime('now') WHERE id IN (${placeholders}) AND consumed_at IS NULL`
      )
      .run(...ids);
    return { ok: true, count: info.changes };
  });

  // Get inbox summary: total events, unread count, and per-source counts
  ipcMain.handle("db:events:inboxSummary", () => {
    const db = getDb();
    const total = (
      db.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number }
    ).cnt;
    const unread = (
      db
        .prepare("SELECT COUNT(*) as cnt FROM events WHERE consumed_at IS NULL")
        .get() as { cnt: number }
    ).cnt;
    const sources = db
      .prepare(
        "SELECT source, COUNT(*) as cnt FROM events GROUP BY source ORDER BY cnt DESC"
      )
      .all() as Array<{ source: string; cnt: number }>;
    return { total, unread, sources };
  });

  // ── Connector runtime queries ─────────────────────────────

  // List events by connector source (for connector detail emit history)
  ipcMain.handle(
    "db:events:listBySource",
    (_event, source: string, opts?: { limit?: number }) => {
      const db = getDb();
      const limit = opts?.limit ?? 20;
      const rows = db
        .prepare(
          `SELECT e.*, t.title as task_title
           FROM events e
           LEFT JOIN tasks t ON t.id = e.task_id
           WHERE e.source = ?
           ORDER BY e.created_at DESC LIMIT ?`
        )
        .all(source, limit) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: r.id as string,
        task_id: r.task_id as string,
        task_title: (r.task_title as string) ?? null,
        source: r.source as string,
        type: r.type as string,
        payload: r.payload ? JSON.parse(r.payload as string) : null,
        consumed_at: r.consumed_at as string | null,
        created_at: r.created_at as string,
      }));
    }
  );

  // Get per-connector summary: how many tasks use it, how many events, running status
  ipcMain.handle("db:connectors:summary", () => {
    const db = getDb();
    // Get all unique connectors from connector_usages with task status
    const rows = db
      .prepare(
        `SELECT cu.connector_name,
                COUNT(DISTINCT cu.task_id) as task_count,
                SUM(CASE WHEN t.status = 'running' THEN 1 ELSE 0 END) as running_count,
                (SELECT COUNT(*) FROM events e WHERE e.source = cu.connector_name) as event_count,
                MAX(e2.created_at) as last_event_at
         FROM connector_usages cu
         LEFT JOIN tasks t ON t.id = cu.task_id
         LEFT JOIN events e2 ON e2.source = cu.connector_name
         GROUP BY cu.connector_name
         ORDER BY running_count DESC, event_count DESC`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      name: r.connector_name as string,
      taskCount: r.task_count as number,
      runningCount: r.running_count as number,
      eventCount: r.event_count as number,
      lastEventAt: r.last_event_at as string | null,
    }));
  });

  // List tasks that use a specific connector
  ipcMain.handle("db:connectors:tasks", (_event, connectorName: string) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT t.*
         FROM tasks t
         JOIN connector_usages cu ON cu.task_id = t.id
         WHERE cu.connector_name = ?
         ORDER BY t.updated_at DESC`
      )
      .all(connectorName) as Array<Record<string, unknown>>;
    return rows.map(rowToTask);
  });

  // ── Connector usages queries ──────────────────────────────

  // List connector usages for a specific task
  ipcMain.handle("db:connectorUsages:listByTask", (_event, taskId: string) => {
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT * FROM connector_usages WHERE task_id = ? ORDER BY created_at DESC"
      )
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      task_id: r.task_id as string,
      connector_name: r.connector_name as string,
      params: JSON.parse((r.params as string) || "{}"),
      created_at: r.created_at as string,
    }));
  });

}
