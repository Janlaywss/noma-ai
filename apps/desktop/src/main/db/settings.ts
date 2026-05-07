import { ipcMain } from "electron";
import { getDb } from "./index.js";

export function registerSettingsHandlers(): void {
  ipcMain.handle("db:settings:get", (_event, key: string) => {
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  });

  ipcMain.handle("db:settings:set", (_event, key: string, value: string) => {
    const db = getDb();
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(key, value);
    return { ok: true };
  });

  ipcMain.handle("db:settings:getAll", (_event, prefix: string) => {
    const db = getDb();
    const rows = db
      .prepare("SELECT key, value FROM settings WHERE key LIKE ?")
      .all(`${prefix}%`) as Array<{ key: string; value: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  });
}
