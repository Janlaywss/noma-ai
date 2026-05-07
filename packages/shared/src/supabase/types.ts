// Hand-maintained row types. When the team starts running
// `supabase gen types typescript`, replace this file with the generated
// Database type and re-export from here.

export type Role = "user" | "assistant" | "system" | "event";
export type TaskKind = "event" | "once" | "cron";
export type TaskStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "disabled";
export type TaskOrigin = "user" | "agent";
export type NotificationLevel = "info" | "nudge" | "alert";
export type ModelRole = "main" | "event";
export type ModelKind = "openai" | "anthropic" | "openai-codex";

export interface SessionMessageRow {
  id: string;
  user_id: string;
  role: Role;
  content: string;
  meta: Record<string, unknown> | null;
  created_at: string;
}

export interface TaskRow {
  id: string;
  user_id: string;
  title: string;
  prompt: string;
  kind: TaskKind;
  schedule: string | null;
  status: TaskStatus;
  origin: TaskOrigin;
  parent_id: string | null;
  slug: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  last_result: string | null;
  created_at: string;
}

export interface EntityRow {
  id: string;
  user_id: string;
  slug: string;
  label: string;
  description: string | null;
  created_at: string;
}

export interface EntityMemoryRow {
  id: string;
  user_id: string;
  entity_id: string;
  content: string;
  source_event_id: string | null;
  tags: string[];
  created_at: string;
}

export interface EventRow {
  id: string;
  user_id: string;
  source: string;
  type: string;
  payload: Record<string, unknown> | null;
  consumed_at: string | null;
  created_at: string;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  level: NotificationLevel;
  message: string;
  meta: Record<string, unknown> | null;
  read: boolean;
  created_at: string;
}

export interface ConnectorConfigRow {
  user_id: string;
  connector_name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  status: Record<string, unknown>;
  updated_at: string;
}

export interface ConnectorUsageRow {
  id: string;
  user_id: string;
  task_id: string;
  connector_name: string;
  params: Record<string, unknown>;
  created_at: string;
}

export interface ChannelConfigRow {
  user_id: string;
  channel_name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  status: Record<string, unknown>;
  webhook_slug: string;
  updated_at: string;
}

export interface ModelConfigRow {
  user_id: string;
  role: ModelRole;
  kind: ModelKind;
  base_url: string;
  model: string;
  api_key: string | null;
  updated_at: string;
}

export interface UserSettingRow {
  user_id: string;
  key: string;
  value: unknown;
  updated_at: string;
}

// ─────────── resumable streaming chat ───────────

export type ChatRunStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "canceled";

export interface ChatRunRow {
  id: string;
  user_id: string;
  status: ChatRunStatus;
  model: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}
