import { getDb } from "./db/index.js";

export function getAgentModel(): string {
  return getModelSetting("model.agent", "NOMA_AGENT_MODEL");
}

export function getEventModel(): string {
  return getModelSetting("model.event", "NOMA_EVENT_MODEL");
}

function getModelSetting(dbKey: string, envKey: string): string {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(dbKey) as { value: string } | undefined;
  if (row?.value) return row.value;

  const env = process.env[envKey];
  if (env) return env;

  throw new Error(
    `${envKey} is not configured. Set it in Settings or in the .env file.`
  );
}
