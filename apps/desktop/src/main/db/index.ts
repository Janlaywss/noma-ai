/**
 * Local SQLite database module for the Noma desktop app.
 *
 * Provides a per-user SQLite database stored in the app's userData directory.
 * Tables mirror the relevant subset of the Supabase schema that was migrated
 * to local-first (see migration 20260423000000_local_first.sql).
 */

import Database from "better-sqlite3";
import path from "node:path";
import { app } from "electron";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = path.join(app.getPath("userData"), "noma.db");
  db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Run migrations
  migrate(db);

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ── Migrations ─────────────────────────────────────────────

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    database
      .prepare("SELECT name FROM _migrations")
      .all()
      .map((row: unknown) => (row as { name: string }).name)
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    database.exec(migration.sql);
    database
      .prepare("INSERT INTO _migrations (name) VALUES (?)")
      .run(migration.name);
  }
}

const MIGRATIONS = [
  {
    name: "001_tasks",
    sql: `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        title TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'event' CHECK (kind IN ('event','once','cron')),
        schedule TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','disabled')),
        origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','agent')),
        parent_id TEXT REFERENCES tasks(id),
        slug TEXT,
        connectors TEXT DEFAULT '[]',
        events_count INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT,
        next_run_at TEXT,
        last_result TEXT,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(kind);
    `,
  },
  {
    name: "002_events",
    sql: `
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        task_id TEXT REFERENCES tasks(id),
        source TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'generic',
        payload TEXT,
        consumed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
      CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
    `,
  },
  {
    name: "003_task_session_and_usages",
    sql: `
      -- Bind tasks to chat sessions so proactive messages route correctly
      ALTER TABLE tasks ADD COLUMN session_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);

      -- Per-task connector claims with task-specific parameters.
      -- Global connectors are shared instances; different tasks provide
      -- different params which the runtime merges via aggregateConfigs().
      CREATE TABLE IF NOT EXISTS connector_usages (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        connector_name TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_usages_task ON connector_usages(task_id);
      CREATE INDEX IF NOT EXISTS idx_usages_connector ON connector_usages(connector_name);
    `,
  },
  {
    name: "005_task_summaries",
    sql: `
      CREATE TABLE IF NOT EXISTS task_summaries (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        summary TEXT NOT NULL,
        events_analyzed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_task_summaries_task ON task_summaries(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_summaries_created ON task_summaries(created_at);
    `,
  },
  {
    name: "004_chat_sessions",
    sql: `
      -- Chat sessions persist across app restarts
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        codex_thread_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC);

      -- Chat messages with full tool call history
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
        content TEXT NOT NULL DEFAULT '',
        segments TEXT,
        tool_calls TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at ASC);
    `,
  },
  {
    name: "006_settings",
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];
