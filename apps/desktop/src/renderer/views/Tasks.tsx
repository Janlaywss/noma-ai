import { useEffect, useState, useCallback } from "react";
import { ConnectorIcon, Badge, Button } from "@noma/ui";
import { useI18n } from "../i18n";
import { useChat } from "../store/chat";

type Column = {
  title: string;
  kind: "live" | "warn" | "idle";
  tasks: LocalTask[];
};

function formatAge(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export default function TasksScreen({
  onOpenTask,
  onOpenSession,
}: {
  onOpenTask?: (taskId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const { loadSession } = useChat();
  const [tasks, setTasks] = useState<LocalTask[]>([]);
  const [loading, setLoading] = useState(true);

  const loadTasks = useCallback(async () => {
    const db = window.noma?.db;
    if (!db) return;

    const list = await db.tasks.list();
    setTasks(list);
    setLoading(false);
  }, []);

  // Listen for new tasks created by agent
  useEffect(() => {
    const noma = window.noma;
    if (!noma?.onTaskCreated) return;
    const unsub = noma.onTaskCreated(() => {
      // Refresh task list when a new task is created from chat
      loadTasks();
    });
    return unsub;
  }, [loadTasks]);

  // Refresh on connector events (events_count changes)
  useEffect(() => {
    const noma = window.noma;
    if (!noma?.onConnectorEvent) return;
    const unsub = noma.onConnectorEvent(() => {
      loadTasks();
    });
    return unsub;
  }, [loadTasks]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // Group tasks into columns by status
  const columns: Column[] = [
    {
      title: "tasks.running",
      kind: "live",
      tasks: tasks.filter((t) => t.status === "running"),
    },
    {
      title: "tasks.waitingOnYou",
      kind: "warn",
      tasks: tasks.filter((t) => t.status === "pending"),
    },
    {
      title: "tasks.doneToday",
      kind: "idle",
      tasks: tasks.filter(
        (t) => t.status === "done" || t.status === "failed"
      ),
    },
  ];

  const activeCount = columns[0].tasks.length;
  const needYouCount = columns[1].tasks.length;
  const doneCount = columns[2].tasks.length;

  if (loading) {
    return (
      <div className="app-content">
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--ink-muted)",
            fontSize: 13,
          }}
        >
          Loading tasks…
        </div>
      </div>
    );
  }

  return (
    <div className="app-content">
      <div className="app-header">
        <span style={{ fontSize: 14, fontWeight: 600 }}>{t("tasks.title")}</span>
        <span className="muted" style={{ fontSize: 11 }}>
          {activeCount} active · {needYouCount} need you · {doneCount} done today
        </span>
        <span className="flex-1" />
        <Button size="sm" kind="ghost">
          {t("common.filter")}
        </Button>
        <Button size="sm" kind="primary" icon="+">
          {t("tasks.newTask")}
        </Button>
      </div>

      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: 24,
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 16,
        }}
      >
        {columns.map((col, i) => (
          <div key={i} className="col gap-2">
            <div className="row gap-2" style={{ marginBottom: 4 }}>
              <Badge kind={col.kind} />
              <span style={{ fontSize: 12, fontWeight: 600 }}>
                {t(col.title)}
              </span>
              <span className="muted" style={{ fontSize: 11 }}>
                {col.tasks.length}
              </span>
            </div>

            {col.tasks.map((task, j) => (
              <div
                key={task.id}
                className="card"
                style={{ padding: 12, cursor: "pointer" }}
                onClick={() => onOpenTask?.(task.id)}
              >
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>
                  {task.title}
                </div>
                <div className="row gap-1" style={{ marginBottom: 8 }}>
                  {task.connectors.map((n) => (
                    <ConnectorIcon key={n} name={n} size={20} />
                  ))}
                </div>
                {task.note && (
                  <div
                    style={{
                      fontSize: 11,
                      color: "oklch(0.45 0.15 70)",
                      marginBottom: 6,
                    }}
                  >
                    ↳ {task.note}
                  </div>
                )}
                <div
                  className="row gap-2"
                  style={{ fontSize: 10, color: "var(--ink-muted)" }}
                >
                  {task.events_count > 0 && (
                    <span>{task.events_count} events</span>
                  )}
                  {task.session_id && (
                    <span
                      style={{
                        color: "var(--accent)",
                        cursor: "pointer",
                        textDecoration: "underline",
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (task.session_id) {
                          loadSession(task.session_id);
                          onOpenSession?.(task.session_id);
                        }
                      }}
                    >
                      💬
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  <span>{formatAge(task.updated_at)}</span>
                </div>
              </div>
            ))}

            {i === 0 && (
              <div
                className="drop-zone"
                style={{ padding: 16, fontSize: 12, textAlign: "center" }}
              >
                {t("tasks.dropConnector")}
                <br />
                <span style={{ fontSize: 13, color: "var(--accent)" }}>
                  {t("tasks.toSpinUp")}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
