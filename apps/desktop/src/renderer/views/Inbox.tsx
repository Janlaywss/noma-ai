import { useEffect, useState, useCallback } from "react";
import { ConnectorIcon, Badge, Tag, Button } from "@noma/ui";
import { useI18n } from "../i18n";

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatAge(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Extract human-readable text from any connector payload.
 *
 * All connectors follow one of two conventions:
 *  - { content: string }            — jin10 news
 *  - { title: string, sub?: string } — stock, github, gmail, weather, lark, flight
 *
 * Fallbacks: message → stringified JSON.
 */
function payloadPreview(payload: unknown): string {
  if (payload == null) return "";
  if (typeof payload === "string") return payload.slice(0, 120);
  try {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.content === "string" && obj.content) return obj.content.slice(0, 120);
    if (typeof obj.title === "string" && obj.title) return obj.title.slice(0, 120);
    if (typeof obj.message === "string" && obj.message) return obj.message.slice(0, 120);
    return JSON.stringify(payload).slice(0, 120);
  } catch {
    return String(payload).slice(0, 120);
  }
}

/** Secondary line — e.g. the `sub` field connectors provide. */
function payloadSub(payload: unknown): string {
  if (payload == null || typeof payload !== "object") return "";
  const obj = payload as Record<string, unknown>;
  if (typeof obj.sub === "string" && obj.sub) return obj.sub;
  return "";
}

export default function InboxScreen() {
  const { t } = useI18n();
  const [events, setEvents] = useState<LocalEvent[]>([]);
  const [summary, setSummary] = useState<InboxSummary | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [filter, setFilter] = useState<string | null>(null); // null = all
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const db = window.noma?.db;
    if (!db) return;

    const [eventsData, summaryData] = await Promise.all([
      db.events.list({ source: filter ?? undefined, limit: 100 }),
      db.events.inboxSummary(),
    ]);

    setEvents(eventsData);
    setSummary(summaryData);
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  // Live-refresh on connector events
  useEffect(() => {
    const noma = window.noma;
    if (!noma?.onConnectorEvent) return;
    const unsub = noma.onConnectorEvent(() => {
      load();
    });
    return unsub;
  }, [load]);

  // Mark event as read when selected
  useEffect(() => {
    const ev = events[selectedIdx];
    if (ev && !ev.consumed_at) {
      window.noma?.db?.events.markConsumed([ev.id]).then(() => {
        setEvents((prev) =>
          prev.map((e, i) =>
            i === selectedIdx ? { ...e, consumed_at: new Date().toISOString() } : e
          )
        );
      });
    }
  }, [selectedIdx, events]);

  const selected = events[selectedIdx] ?? null;

  if (loading) {
    return (
      <div className="app-content">
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-muted)", fontSize: 13 }}>
          Loading...
        </div>
      </div>
    );
  }

  return (
    <div className="app-content" style={{ flexDirection: "row" }}>
      {/* List pane */}
      <div
        style={{
          width: 380,
          borderRight: "1px solid var(--line)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div className="app-header">
          <span style={{ fontSize: 13, fontWeight: 600 }}>{t("inbox.title")}</span>
          <span className="muted" style={{ fontSize: 11 }}>
            {summary ? `${summary.total} ${t("common.events")}` : ""}
          </span>
          <span className="flex-1" />
          {summary && summary.unread > 0 && (
            <Tag kind="accent" style={{ fontSize: 10 }}>
              {summary.unread} {t("inbox.unread")}
            </Tag>
          )}
        </div>

        {/* Source filter chips */}
        {summary && summary.sources.length > 0 && (
          <div
            className="row gap-1"
            style={{
              padding: "6px 12px",
              borderBottom: "1px solid var(--line-soft)",
              flexWrap: "wrap",
            }}
          >
            <Button
              size="sm"
              kind={filter === null ? "primary" : "ghost"}
              style={{ fontSize: 10, height: 22 }}
              onClick={() => setFilter(null)}
            >
              {t("inbox.all")} ({summary.total})
            </Button>
            {summary.sources.map((s) => (
              <Button
                key={s.source}
                size="sm"
                kind={filter === s.source ? "primary" : "ghost"}
                style={{ fontSize: 10, height: 22 }}
                onClick={() => setFilter(s.source)}
              >
                {s.source} ({s.cnt})
              </Button>
            ))}
          </div>
        )}

        {/* Events list */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {events.length === 0 ? (
            <div
              style={{
                padding: 32,
                textAlign: "center",
                color: "var(--ink-muted)",
                fontSize: 12,
              }}
            >
              <div style={{ fontSize: 24, marginBottom: 8 }}>📭</div>
              <div>{t("inbox.empty")}</div>
              <div style={{ fontSize: 11, marginTop: 4 }}>{t("inbox.emptyHint")}</div>
            </div>
          ) : (
            events.map((ev, i) => (
              <div
                key={ev.id}
                style={{
                  padding: "10px 14px",
                  borderBottom: "1px solid var(--line-soft)",
                  background: i === selectedIdx ? "var(--bg-active)" : "transparent",
                  cursor: "pointer",
                  position: "relative",
                }}
                onClick={() => setSelectedIdx(i)}
              >
                {!ev.consumed_at && (
                  <div
                    style={{
                      position: "absolute",
                      left: 5,
                      top: 16,
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background: "var(--accent)",
                    }}
                  />
                )}
                <div className="row gap-2" style={{ marginBottom: 3 }}>
                  <ConnectorIcon name={ev.source} size={16} />
                  <span className="mono" style={{ fontSize: 10, fontWeight: 600 }}>
                    {ev.source}
                  </span>
                  <span className="mono muted" style={{ fontSize: 10 }}>
                    {ev.type}
                  </span>
                  <span className="flex-1" />
                  <span className="muted" style={{ fontSize: 10 }}>
                    {formatAge(ev.created_at)}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: ev.consumed_at ? 400 : 600,
                    marginBottom: 2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {payloadPreview(ev.payload) || ev.type}
                </div>
                {(payloadSub(ev.payload) || ev.task_title) && (
                  <div className="muted truncate" style={{ fontSize: 10 }}>
                    {payloadSub(ev.payload)}
                    {payloadSub(ev.payload) && ev.task_title ? " · " : ""}
                    {ev.task_title ?? ""}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Reading pane */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "auto",
        }}
      >
        {selected ? (
          <>
            {/* Event header */}
            <div
              style={{
                padding: "16px 24px",
                borderBottom: "1px solid var(--line)",
              }}
            >
              <div className="row gap-2" style={{ marginBottom: 6 }}>
                <ConnectorIcon name={selected.source} size={24} />
                <div className="col flex-1">
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    {selected.source} / {selected.type}
                  </span>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {formatTime(selected.created_at)}
                    {selected.task_title && ` · ${selected.task_title}`}
                  </span>
                </div>
                {!selected.consumed_at && (
                  <Badge kind="live" />
                )}
              </div>
            </div>

            <div style={{ padding: "20px 24px", flex: 1, overflow: "auto" }}>
              {/* Raw payload */}
              <div className="card" style={{ padding: 14, marginBottom: 16 }}>
                <div
                  className="muted"
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    marginBottom: 8,
                  }}
                >
                  {t("inbox.rawPayload")}
                </div>
                <pre
                  className="mono"
                  style={{
                    fontSize: 11,
                    background: "var(--bg-sunken)",
                    padding: 12,
                    borderRadius: 6,
                    overflow: "auto",
                    margin: 0,
                    maxHeight: 300,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                  }}
                >
                  {selected.payload != null
                    ? JSON.stringify(selected.payload, null, 2)
                    : "(no payload)"}
                </pre>
              </div>

              {/* Event metadata */}
              <div className="card" style={{ padding: 14, marginBottom: 16 }}>
                <div
                  className="muted"
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    marginBottom: 8,
                  }}
                >
                  {t("inbox.eventMeta")}
                </div>
                <div className="col gap-2" style={{ fontSize: 11 }}>
                  <MetaRow label={t("inbox.source")} value={selected.source} />
                  <MetaRow label={t("inbox.eventType")} value={selected.type} />
                  <MetaRow label={t("inbox.time")} value={formatTime(selected.created_at)} />
                  {selected.task_title && (
                    <MetaRow label={t("inbox.task")} value={selected.task_title} />
                  )}
                  <MetaRow
                    label={t("inbox.status")}
                    value={selected.consumed_at ? t("inbox.read") : t("inbox.unreadLabel")}
                  />
                </div>
              </div>

              {/* Actions */}
              {selected.task_id && (
                <div className="row gap-2">
                  <Button size="sm">{t("inbox.openTask")}</Button>
                  <Button size="sm" kind="ghost">{t("inbox.muteConnector")}</Button>
                </div>
              )}
            </div>
          </>
        ) : (
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
            {t("inbox.selectEvent")}
          </div>
        )}
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row gap-2">
      <span className="muted" style={{ minWidth: 60 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
