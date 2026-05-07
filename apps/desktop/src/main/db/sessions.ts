/**
 * Chat session persistence — stores sessions and messages in SQLite
 * so conversations survive app restarts.
 *
 * IPC handlers:
 * - db:sessions:list      — all sessions ordered by updated_at DESC
 * - db:sessions:get       — single session by ID
 * - db:sessions:create    — create a new session
 * - db:sessions:update    — update title / codex_thread_id / updated_at
 * - db:sessions:delete    — delete session and cascade messages
 * - db:messages:list      — messages for a session ordered by created_at
 * - db:messages:append    — append one message (user/assistant/system)
 * - db:messages:updateLast — update the last assistant message (finalize streaming)
 */

import { ipcMain } from "electron";
import { getDb } from "./index.js";

export interface ChatSessionRow {
  id: string;
  title: string | null;
  codex_thread_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageRow {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  segments: string | null; // JSON
  tool_calls: string | null; // JSON
  created_at: string;
}

export function registerSessionHandlers(): void {
  // ── Sessions ────────────────────────────────────────────

  ipcMain.handle("db:sessions:list", () => {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM chat_sessions ORDER BY updated_at DESC")
      .all() as ChatSessionRow[];
    return rows.map((r) => ({
      sessionId: r.id,
      title: r.title,
      codexThreadId: r.codex_thread_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  });

  ipcMain.handle("db:sessions:get", (_event, id: string) => {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM chat_sessions WHERE id = ?")
      .get(id) as ChatSessionRow | undefined;
    if (!row) return null;
    return {
      sessionId: row.id,
      title: row.title,
      codexThreadId: row.codex_thread_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });

  ipcMain.handle(
    "db:sessions:create",
    (_event, input: { id: string; title?: string; codexThreadId?: string }) => {
      const db = getDb();
      db.prepare(
        `INSERT INTO chat_sessions (id, title, codex_thread_id)
         VALUES (?, ?, ?)`
      ).run(input.id, input.title ?? null, input.codexThreadId ?? null);
      return { ok: true, sessionId: input.id };
    }
  );

  ipcMain.handle(
    "db:sessions:update",
    (
      _event,
      id: string,
      updates: { title?: string; codexThreadId?: string }
    ) => {
      const db = getDb();
      const sets: string[] = ["updated_at = datetime('now')"];
      const params: unknown[] = [];

      if (updates.title !== undefined) {
        sets.push("title = ?");
        params.push(updates.title);
      }
      if (updates.codexThreadId !== undefined) {
        sets.push("codex_thread_id = ?");
        params.push(updates.codexThreadId);
      }

      params.push(id);
      db.prepare(
        `UPDATE chat_sessions SET ${sets.join(", ")} WHERE id = ?`
      ).run(...params);
      return { ok: true };
    }
  );

  ipcMain.handle("db:sessions:delete", (_event, id: string) => {
    const db = getDb();
    db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
    return { ok: true };
  });

  // ── Bulk data cleanup ────────────────────────────────────

  ipcMain.handle("db:clearData:counts", () => {
    const db = getDb();
    const tasks = (db.prepare("SELECT COUNT(*) as cnt FROM tasks").get() as { cnt: number }).cnt;
    const sessions = (db.prepare("SELECT COUNT(*) as cnt FROM chat_sessions").get() as { cnt: number }).cnt;
    const messages = (db.prepare("SELECT COUNT(*) as cnt FROM chat_messages").get() as { cnt: number }).cnt;
    const events = (db.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number }).cnt;
    return { tasks, sessions, messages, events };
  });

  ipcMain.handle(
    "db:clearData",
    (_event, opts: { tasks?: boolean; sessions?: boolean; events?: boolean }) => {
      const db = getDb();
      db.transaction(() => {
        if (opts.events || opts.tasks) {
          if (opts.events) {
            db.prepare("DELETE FROM events").run();
          } else if (opts.tasks) {
            // Only delete events linked to tasks (FK constraint)
            db.prepare("DELETE FROM events WHERE task_id IS NOT NULL").run();
          }
        }
        if (opts.tasks) {
          db.prepare("DELETE FROM connector_usages").run();
          db.prepare("DELETE FROM tasks").run();
        }
        if (opts.sessions) {
          // CASCADE deletes chat_messages
          db.prepare("DELETE FROM chat_sessions").run();
        }
      })();
      return { ok: true };
    }
  );

  // ── Messages ────────────────────────────────────────────

  ipcMain.handle("db:messages:list", (_event, sessionId: string) => {
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC"
      )
      .all(sessionId) as ChatMessageRow[];
    return rows.map(rowToMessage);
  });

  ipcMain.handle(
    "db:messages:append",
    (
      _event,
      input: {
        id: string;
        sessionId: string;
        role: string;
        content: string;
        segments?: unknown[];
        toolCalls?: unknown[];
      }
    ) => {
      const db = getDb();
      // Ensure session exists (auto-create if missing to prevent FK failures
      // from race conditions or stale session IDs after data resets)
      const exists = db
        .prepare("SELECT 1 FROM chat_sessions WHERE id = ?")
        .get(input.sessionId);
      if (!exists) {
        db.prepare(
          "INSERT INTO chat_sessions (id) VALUES (?)"
        ).run(input.sessionId);
      }
      db.prepare(
        `INSERT INTO chat_messages (id, session_id, role, content, segments, tool_calls)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        input.id,
        input.sessionId,
        input.role,
        input.content,
        input.segments ? JSON.stringify(input.segments) : null,
        input.toolCalls ? JSON.stringify(input.toolCalls) : null
      );
      // Touch session updated_at
      db.prepare(
        "UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?"
      ).run(input.sessionId);
      return { ok: true };
    }
  );

  ipcMain.handle(
    "db:messages:update",
    (
      _event,
      messageId: string,
      updates: {
        content?: string;
        segments?: unknown[];
        toolCalls?: unknown[];
      }
    ) => {
      const db = getDb();
      const sets: string[] = [];
      const params: unknown[] = [];

      if (updates.content !== undefined) {
        sets.push("content = ?");
        params.push(updates.content);
      }
      if (updates.segments !== undefined) {
        sets.push("segments = ?");
        params.push(JSON.stringify(updates.segments));
      }
      if (updates.toolCalls !== undefined) {
        sets.push("tool_calls = ?");
        params.push(JSON.stringify(updates.toolCalls));
      }

      if (sets.length === 0) return { ok: true };

      params.push(messageId);
      db.prepare(
        `UPDATE chat_messages SET ${sets.join(", ")} WHERE id = ?`
      ).run(...params);
      return { ok: true };
    }
  );
}

// ── Helpers ─────────────────────────────────────────────────

function rowToMessage(row: ChatMessageRow) {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    segments: row.segments ? JSON.parse(row.segments) : undefined,
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    createdAt: row.created_at,
  };
}
