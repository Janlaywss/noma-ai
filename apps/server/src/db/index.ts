import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath =
    process.env.NOMA_DB_PATH ||
    path.join(process.cwd(), "data", "server.db");
  mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

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
    name: "001_init",
    sql: `
      CREATE TABLE IF NOT EXISTS session_memory (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','system','event')),
        content TEXT NOT NULL,
        meta TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_session_memory_user
        ON session_memory(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (user_id, slug)
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT,
        consumed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_events_user
        ON events(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS entity_memory (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id TEXT NOT NULL,
        entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        source_event_id TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_entity_memory_entity
        ON entity_memory(entity_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id TEXT NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('info','nudge','alert')),
        message TEXT NOT NULL,
        meta TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
        ON notifications(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS connector_configs (
        user_id TEXT NOT NULL,
        connector_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        config TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, connector_name)
      );

      CREATE TABLE IF NOT EXISTS connector_storage (
        user_id TEXT NOT NULL,
        connector_name TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, connector_name, key)
      );

      CREATE TABLE IF NOT EXISTS channel_configs (
        user_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        config TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT '{}',
        webhook_slug TEXT UNIQUE DEFAULT (lower(hex(randomblob(12)))),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, channel_name)
      );
      CREATE INDEX IF NOT EXISTS idx_channel_configs_slug
        ON channel_configs(webhook_slug);

      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, key)
      );
    `,
  },
];
