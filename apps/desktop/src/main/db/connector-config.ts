/**
 * IPC handlers for connector configuration — reading/saving auth credentials,
 * initiating OAuth flows, and syncing config with the server.
 *
 * Config storage strategy:
 *   - Local: connector_storage table (same as ConnectorStorage used by the runtime)
 *   - Server: PUT /api/connectors/:name (upserts into connector_configs)
 *
 * For OAuth connectors (gmail), the flow is:
 *   1. Desktop calls `connector:oauth:init` → server returns Google consent URL
 *   2. Desktop opens the URL in the system browser
 *   3. User completes consent, callback saves tokens on the server
 *   4. Desktop polls `connector:oauth:status` → detects tokens are saved
 *   5. Desktop syncs tokens into local connector_storage for the runtime
 */

import { ipcMain, shell } from "electron";
import { getDb } from "./index.js";

// ── Helpers ──────────────────────────────────────────────

function ensureStorageTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS connector_storage (
      connector_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (connector_name, key)
    );
  `);
}

function getServerUrl(): string {
  return process.env.NOMA_SERVER_URL ?? "http://localhost:3677";
}

// ── IPC Handlers ────────────────────────────────────────

export function registerConnectorConfigHandlers(): void {
  ensureStorageTable();

  /**
   * Get all config fields for a connector from local storage.
   * Returns a Record<string, string> of key→value pairs.
   */
  ipcMain.handle(
    "connector:config:get",
    async (_event, connectorName: string) => {
      const db = getDb();
      const rows = db
        .prepare(
          "SELECT key, value FROM connector_storage WHERE connector_name = ?"
        )
        .all(connectorName) as Array<{ key: string; value: string }>;

      const config: Record<string, string> = {};
      for (const row of rows) {
        config[row.key] = row.value;
      }
      return config;
    }
  );

  /**
   * Save config fields for a connector. Writes to local storage AND pushes
   * to the server (if reachable). The runtime reads from local storage, so
   * local write is the source of truth for the connector instance.
   */
  ipcMain.handle(
    "connector:config:save",
    async (_event, connectorName: string, config: Record<string, string>) => {
      const db = getDb();

      // Local: upsert each key
      const upsert = db.prepare(
        `INSERT OR REPLACE INTO connector_storage (connector_name, key, value)
         VALUES (?, ?, ?)`
      );
      const transaction = db.transaction(() => {
        for (const [key, value] of Object.entries(config)) {
          upsert.run(connectorName, key, value);
        }
      });
      transaction();

      // Server: push config asynchronously (best-effort)
      try {
        const serverUrl = getServerUrl();
        await fetch(`${serverUrl}/api/connectors/${connectorName}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config, enabled: true }),
        });
      } catch (err) {
        console.warn(`[connector-config] server push failed for ${connectorName}:`, err);
      }

      return { ok: true };
    }
  );

  /**
   * Delete all config for a connector (local + server).
   */
  ipcMain.handle(
    "connector:config:delete",
    async (_event, connectorName: string) => {
      const db = getDb();
      db.prepare(
        "DELETE FROM connector_storage WHERE connector_name = ?"
      ).run(connectorName);
      return { ok: true };
    }
  );

  /**
   * Initiate OAuth flow for a connector. Opens the system browser with the
   * consent URL from the server. Returns the consent URL for the renderer
   * to track the flow state.
   */
  ipcMain.handle(
    "connector:oauth:init",
    async (_event, connectorName: string) => {
      const serverUrl = getServerUrl();

      try {
        const res = await fetch(
          `${serverUrl}/api/connectors/${connectorName}/oauth`
        );

        if (!res.ok) {
          const text = await res.text();
          return { ok: false, error: `Server returned ${res.status}: ${text}` };
        }

        const data = (await res.json()) as { url?: string };
        if (!data.url) {
          return { ok: false, error: "No consent URL returned" };
        }

        // Open in the system browser
        await shell.openExternal(data.url);
        return { ok: true, url: data.url };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    }
  );

  /**
   * Check OAuth status by reading connector config from the server.
   * Returns the config if OAuth tokens are stored, null if not yet authorized.
   * Also syncs tokens into local connector_storage on success.
   */
  ipcMain.handle(
    "connector:oauth:status",
    async (_event, connectorName: string) => {
      const serverUrl = getServerUrl();

      try {
        const res = await fetch(
          `${serverUrl}/api/connectors/${connectorName}`
        );

        if (!res.ok) {
          return { ok: false, authorized: false };
        }

        const data = (await res.json()) as {
          config?: Record<string, unknown>;
          enabled?: boolean;
        } | null;

        if (!data?.config) {
          return { ok: true, authorized: false };
        }

        // Sync tokens into local connector_storage so the runtime can use them
        const db = getDb();
        const upsert = db.prepare(
          `INSERT OR REPLACE INTO connector_storage (connector_name, key, value)
           VALUES (?, ?, ?)`
        );
        const transaction = db.transaction(() => {
          for (const [key, value] of Object.entries(data.config!)) {
            if (value != null) {
              upsert.run(connectorName, key, String(value));
            }
          }
        });
        transaction();

        return {
          ok: true,
          authorized: true,
          config: data.config,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, authorized: false, error: msg };
      }
    }
  );
}
