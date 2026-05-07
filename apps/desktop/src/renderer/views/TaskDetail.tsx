import { useEffect, useState, useCallback } from "react";
import { ConnectorIcon, Badge, Tag, Button } from "@noma/ui";
import { useI18n } from "../i18n";

const STATUS_TAG: Record<string, { kind?: "ok" | "warn" | "accent" | "danger"; badge: "live" | "warn" | "idle"; key: string }> = {
  running: { kind: "ok", badge: "live", key: "taskDetail.statusRunning" },
  pending: { kind: "warn", badge: "warn", key: "taskDetail.statusPending" },
  done: { badge: "idle", key: "taskDetail.statusDone" },
  failed: { kind: "danger", badge: "idle", key: "taskDetail.statusFailed" },
  disabled: { badge: "idle", key: "taskDetail.statusDisabled" },
};

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatAge(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Extract human-readable text from connector event payload. */
function eventPreview(payload: unknown): string {
  if (payload == null) return "";
  if (typeof payload === "string") return payload.slice(0, 200);
  try {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.content === "string" && obj.content) return obj.content.slice(0, 200);
    if (typeof obj.title === "string" && obj.title) {
      const sub = typeof obj.sub === "string" ? ` · ${obj.sub}` : "";
      return (obj.title + sub).slice(0, 200);
    }
    if (typeof obj.message === "string" && obj.message) return obj.message.slice(0, 200);
    return JSON.stringify(payload).slice(0, 200);
  } catch {
    return String(payload).slice(0, 200);
  }
}

export default function TaskDetailScreen({
  taskId,
  onBack,
  onOpenSession,
}: {
  taskId: string;
  onBack?: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const [task, setTask] = useState<LocalTask | null>(null);
  const [events, setEvents] = useState<LocalEvent[]>([]);
  const [usages, setUsages] = useState<ConnectorUsage[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const db = window.noma?.db;
    if (!db) return;

    const [taskData, eventsData, usagesData] = await Promise.all([
      db.tasks.get(taskId),
      db.events.listByTask(taskId, { limit: 50 }),
      db.connectorUsages.listByTask(taskId),
    ]);

    setTask(taskData);
    setEvents(eventsData);
    setUsages(usagesData);
    setLoading(false);
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh on connector events
  useEffect(() => {
    const noma = window.noma;
    if (!noma?.onConnectorEvent) return;
    const unsub = noma.onConnectorEvent(() => {
      load();
    });
    return unsub;
  }, [load]);

  if (loading) {
    return (
      <div className="app-content">
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-muted)", fontSize: 13 }}>
          Loading...
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="app-content">
        <div className="app-header">
          <Button size="sm" kind="ghost" onClick={onBack}>
            {t("taskDetail.backToTasks")}
          </Button>
        </div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-muted)", fontSize: 13 }}>
          Task not found
        </div>
      </div>
    );
  }

  const statusInfo = STATUS_TAG[task.status] ?? STATUS_TAG.pending;

  return (
    <div className="app-content">
      {/* Header */}
      <div className="app-header">
        <Button size="sm" kind="ghost" onClick={onBack}>
          {t("taskDetail.backToTasks")}
        </Button>
        <div className="col flex-1">
          <div className="row gap-2">
            <span style={{ fontSize: 14, fontWeight: 600 }}>
              {task.title}
            </span>
            <Tag kind={statusInfo.kind}>
              <Badge kind={statusInfo.badge} /> {t(statusInfo.key)}
            </Tag>
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            {task.events_count} events
            {task.last_run_at && ` · last run ${formatAge(task.last_run_at)} ago`}
            {task.session_id && " · linked to session"}
          </div>
        </div>
        {task.session_id && (
          <Button
            size="sm"
            kind="ghost"
            onClick={() => onOpenSession?.(task.session_id!)}
          >
            {t("taskDetail.openSession")}
          </Button>
        )}
        <Button
          size="sm"
          kind="ghost"
          onClick={async () => {
            if (!confirm(t("taskDetail.deleteConfirm"))) return;
            await window.noma?.db.tasks.delete(task.id);
            onBack?.();
          }}
        >
          {t("common.delete")}
        </Button>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "24px 32px",
          display: "grid",
          gridTemplateColumns: "1fr 280px",
          gap: 24,
        }}
      >
        {/* Left: Events Timeline */}
        <div>
          <div className="row gap-2" style={{ marginBottom: 16 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>
              {t("taskDetail.eventsTimeline")}
            </span>
            <span className="muted" style={{ fontSize: 11 }}>
              {events.length} / {task.events_count} total
            </span>
          </div>

          {events.length === 0 ? (
            <div
              className="card"
              style={{
                padding: 32,
                textAlign: "center",
                color: "var(--ink-muted)",
              }}
            >
              <div style={{ fontSize: 24, marginBottom: 8 }}>
                {task.status === "running" ? "⏳" : "✨"}
              </div>
              <div style={{ fontSize: 13, marginBottom: 4 }}>
                {t("taskDetail.noEvents")}
              </div>
              <div style={{ fontSize: 11 }}>
                {t("taskDetail.noEventsHint")}
              </div>
            </div>
          ) : (
            <div style={{ position: "relative", paddingLeft: 28 }}>
              <div
                style={{
                  position: "absolute",
                  left: 12,
                  top: 12,
                  bottom: 12,
                  width: 2,
                  background: "var(--line)",
                }}
              />
              {events.map((ev) => (
                <div key={ev.id} style={{ position: "relative", paddingBottom: 12 }}>
                  <div
                    style={{
                      position: "absolute",
                      left: -28,
                      top: 6,
                      width: 24,
                      height: 24,
                      borderRadius: 999,
                      background: "var(--bg-card)",
                      border: "2px solid var(--accent)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                    }}
                  >
                    <ConnectorIcon name={ev.source} size={14} />
                  </div>
                  <div className="card" style={{ padding: 10 }}>
                    <div className="row gap-2" style={{ marginBottom: 4 }}>
                      <span className="mono" style={{ fontSize: 10, fontWeight: 600, color: "var(--accent)" }}>
                        {ev.source}
                      </span>
                      <span className="mono muted" style={{ fontSize: 10 }}>
                        {ev.type}
                      </span>
                      <span className="flex-1" />
                      <span className="mono muted" style={{ fontSize: 10 }}>
                        {formatTime(ev.created_at)}
                      </span>
                    </div>
                    {ev.payload != null && (
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--ink-soft)",
                          lineHeight: 1.5,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-all",
                          maxHeight: 80,
                          overflow: "hidden",
                        }}
                      >
                        {eventPreview(ev.payload)}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: Side panel */}
        <div className="col gap-3">
          {/* Task Info */}
          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>
              {t("taskDetail.taskInfo")}
            </div>
            <div className="col gap-2" style={{ fontSize: 11 }}>
              <InfoRow label={t("taskDetail.kind")} value={t(`taskDetail.kind${capitalize(task.kind)}`)} />
              <InfoRow label={t("taskDetail.origin")} value={t(`taskDetail.origin${capitalize(task.origin)}`)} />
              <InfoRow label={t("taskDetail.createdAt")} value={formatDateTime(task.created_at)} />
              {task.last_run_at && (
                <InfoRow label={t("taskDetail.lastRunAt")} value={formatDateTime(task.last_run_at)} />
              )}
            </div>
          </div>

          {/* Prompt */}
          {task.prompt && (
            <div className="card" style={{ padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
                {t("taskDetail.prompt")}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--ink-soft)",
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                }}
              >
                {task.prompt}
              </div>
            </div>
          )}

          {/* Connectors & Params */}
          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>
              {t("taskDetail.connectorParams")}
            </div>
            {usages.length > 0 ? (
              <div className="col gap-3">
                {usages.map((u) => (
                  <div key={u.id}>
                    <div className="row gap-2" style={{ marginBottom: 6 }}>
                      <ConnectorIcon name={u.connector_name} size={16} />
                      <span style={{ fontSize: 12, fontWeight: 500 }}>
                        {u.connector_name}
                      </span>
                    </div>
                    {Object.keys(u.params).length > 0 && (
                      <div
                        className="mono"
                        style={{
                          fontSize: 10,
                          color: "var(--ink-muted)",
                          lineHeight: 1.6,
                          paddingLeft: 8,
                          borderLeft: "2px solid var(--line)",
                        }}
                      >
                        {Object.entries(u.params).map(([k, v]) => (
                          <div key={k}>
                            {k}: {String(JSON.stringify(v))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="row gap-1" style={{ flexWrap: "wrap" }}>
                {task.connectors.map((name) => (
                  <div key={name} className="row gap-1" style={{ marginRight: 8 }}>
                    <ConnectorIcon name={name} size={16} />
                    <span style={{ fontSize: 11 }}>{name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row gap-2">
      <span className="muted">{label}</span>
      <span className="flex-1" />
      <span>{value}</span>
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
