import { useEffect, useState, useCallback, useRef } from "react";
import { ConnectorIcon, Badge, Tag, Button, Input } from "@noma/ui";
import { useI18n } from "../i18n";

type ConfigField = {
  key: string;
  label?: string;
  type: "string" | "number" | "boolean" | "string[]";
  taskRequired?: boolean;
  secret?: boolean;
  min?: number;
  max?: number;
};

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatAge(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

type ConnectorInfo = {
  name: string;
  label: string;
  description: string;
  /** From runtime summary — 0 if never used */
  taskCount: number;
  runningCount: number;
  eventCount: number;
  lastEventAt: string | null;
};

// ── Grid view ──────────────────────────────────────────────

function ConnectorGrid({
  onSelect,
}: {
  onSelect: (name: string) => void;
}) {
  const { t } = useI18n();
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const noma = window.noma;
      if (!noma) return;

      // Get catalog from bootstrap + runtime summary from DB
      const [bootstrap, summaries] = await Promise.all([
        noma.getBootstrap(),
        noma.db.connectors.summary(),
      ]);

      const summaryMap = new Map(summaries.map((s) => [s.name, s]));

      const list: ConnectorInfo[] = bootstrap.connectors.map((c) => {
        const s = summaryMap.get(c.name);
        return {
          name: c.name,
          label: c.label,
          description: c.description,
          taskCount: s?.taskCount ?? 0,
          runningCount: s?.runningCount ?? 0,
          eventCount: s?.eventCount ?? 0,
          lastEventAt: s?.lastEventAt ?? null,
        };
      });

      setConnectors(list);
      setLoading(false);
    })();
  }, []);

  // Refresh on connector events
  useEffect(() => {
    const noma = window.noma;
    if (!noma?.onConnectorEvent) return;
    const unsub = noma.onConnectorEvent(() => {
      noma.db.connectors.summary().then((summaries) => {
        setConnectors((prev) =>
          prev.map((c) => {
            const s = summaries.find((su) => su.name === c.name);
            if (!s) return c;
            return { ...c, taskCount: s.taskCount, runningCount: s.runningCount, eventCount: s.eventCount, lastEventAt: s.lastEventAt };
          })
        );
      });
    });
    return unsub;
  }, []);

  if (loading) {
    return (
      <div className="app-content">
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-muted)", fontSize: 13 }}>
          Loading...
        </div>
      </div>
    );
  }

  const installed = connectors.filter((c) => c.runningCount > 0 || c.taskCount > 0);
  const available = connectors.filter((c) => c.runningCount === 0 && c.taskCount === 0);

  return (
    <div className="app-content">
      <div className="app-header">
        <div className="col flex-1">
          <div style={{ fontSize: 14, fontWeight: 600 }}>{t("connectors.title")}</div>
          <div className="muted" style={{ fontSize: 11 }}>
            {connectors.length} {t("connectors.total")} · {installed.length} {t("connectors.inUse")}
          </div>
        </div>
        <Input
          prefix={<span className="muted">⌕</span>}
          placeholder={t("common.search")}
          readOnly
          style={{ width: 220 }}
        />
        <Button size="sm" kind="primary" icon="+">
          {t("connectors.addCustom")}
        </Button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
        {/* In-use connectors */}
        {installed.length > 0 && (
          <>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--ink-muted)",
                marginBottom: 12,
              }}
            >
              {t("connectors.installed")}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
                gap: 12,
                marginBottom: 24,
              }}
            >
              {installed.map((c) => (
                <div
                  key={c.name}
                  className="card"
                  style={{ padding: 14, cursor: "pointer" }}
                  onClick={() => onSelect(c.name)}
                >
                  <div className="row gap-2" style={{ marginBottom: 10 }}>
                    <ConnectorIcon name={c.name} size={36} />
                    <span className="flex-1" />
                    {c.runningCount > 0 && <Badge kind="live" />}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{c.label}</div>
                  <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>
                    {c.runningCount > 0
                      ? `${c.runningCount} ${t("connectors.tasksRunning")}` + (c.lastEventAt ? ` · ${formatAge(c.lastEventAt)}` : "")
                      : `${c.taskCount} ${t("connectors.tasksClaimed")}`}
                  </div>
                  {c.eventCount > 0 && (
                    <div className="muted" style={{ fontSize: 10 }}>
                      {c.eventCount} {t("common.events")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {/* Available connectors */}
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--ink-muted)",
            marginBottom: 12,
          }}
        >
          {t("connectors.available")}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
            gap: 12,
          }}
        >
          {available.map((c) => (
            <div
              key={c.name}
              className="card"
              style={{ padding: 14, opacity: 0.7, cursor: "pointer" }}
              onClick={() => onSelect(c.name)}
            >
              <ConnectorIcon name={c.name} size={36} />
              <div style={{ fontSize: 13, fontWeight: 600, marginTop: 10 }}>{c.label}</div>
              {c.description && (
                <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>
                  {c.description}
                </div>
              )}
            </div>
          ))}
          <div className="drop-zone" style={{ padding: 14, minHeight: 110 }}>
            <div style={{ fontSize: 24, color: "var(--ink-muted)" }}>+</div>
            <div className="muted" style={{ fontSize: 11, textAlign: "center", marginTop: 4 }}>
              {t("connectors.dropFile")}
              <br />
              {t("connectors.toAddCustom")}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Detail view ─────────────────────────────────────────────

function ConnectorDetail({
  name,
  onBack,
}: {
  name: string;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [events, setEvents] = useState<LocalEvent[]>([]);
  const [tasks, setTasks] = useState<LocalTask[]>([]);
  const [connectorInfo, setConnectorInfo] = useState<{ label: string; description: string; configSchema: ConfigField[] } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const noma = window.noma;
    if (!noma) return;

    const [eventsData, tasksData, bootstrap] = await Promise.all([
      noma.db.events.listBySource(name, { limit: 20 }),
      noma.db.connectors.tasks(name),
      noma.getBootstrap(),
    ]);

    const catalog = bootstrap.connectors.find((c) => c.name === name);
    setConnectorInfo(
      catalog
        ? { label: catalog.label, description: catalog.description, configSchema: catalog.configSchema }
        : { label: name, description: "", configSchema: [] }
    );
    setEvents(eventsData);
    setTasks(tasksData);
    setLoading(false);
  }, [name]);

  useEffect(() => {
    load();
  }, [load]);

  // Live refresh
  useEffect(() => {
    const noma = window.noma;
    if (!noma?.onConnectorEvent) return;
    const unsub = noma.onConnectorEvent((ev) => {
      if (ev.source === name) load();
    });
    return unsub;
  }, [load, name]);

  if (loading || !connectorInfo) {
    return (
      <div className="app-content">
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-muted)", fontSize: 13 }}>
          Loading...
        </div>
      </div>
    );
  }

  const runningTasks = tasks.filter((t) => t.status === "running");

  return (
    <div className="app-content">
      <div className="app-header">
        <Button size="sm" kind="ghost" onClick={onBack}>
          {t("common.back")}
        </Button>
        <ConnectorIcon name={name} size={28} />
        <div className="col flex-1">
          <span style={{ fontSize: 14, fontWeight: 600 }}>{connectorInfo.label}</span>
          <span className="muted" style={{ fontSize: 11 }}>
            {connectorInfo.description || name}
          </span>
        </div>
        {runningTasks.length > 0 ? (
          <Tag kind="ok">
            <Badge kind="live" /> {t("common.running")}
          </Tag>
        ) : (
          <Tag>
            <Badge kind="idle" /> {t("connectors.idle")}
          </Tag>
        )}
      </div>

      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: 24,
          display: "grid",
          gridTemplateColumns: "1fr 280px",
          gap: 24,
        }}
      >
        <div className="col gap-3">
          {/* Emit history */}
          <div className="card" style={{ padding: 16 }}>
            <div className="row gap-2" style={{ marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                {t("connectors.emitHistory")}
              </span>
              <span className="flex-1" />
              <span className="muted" style={{ fontSize: 11 }}>
                {events.length} {t("common.events")}
              </span>
            </div>
            {events.length === 0 ? (
              <div className="muted" style={{ fontSize: 12, textAlign: "center", padding: 16 }}>
                {t("connectors.noEvents")}
              </div>
            ) : (
              events.map((ev, i) => (
                <div
                  key={ev.id}
                  className="row gap-2"
                  style={{
                    padding: "6px 0",
                    borderBottom: i < events.length - 1 ? "1px solid var(--line-soft)" : "none",
                    fontSize: 12,
                  }}
                >
                  <span className="mono muted" style={{ width: 65, flexShrink: 0 }}>
                    {formatTime(ev.created_at)}
                  </span>
                  <span className="mono" style={{ width: 90, flexShrink: 0, color: "var(--accent)" }}>
                    {ev.type}
                  </span>
                  <span className="flex-1" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {payloadOneLine(ev.payload)}
                  </span>
                  {ev.task_title && (
                    <span className="mono muted" style={{ fontSize: 10, flexShrink: 0 }}>
                      → {ev.task_title.slice(0, 20)}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right rail */}
        <div className="col gap-3">
          {/* Config / Auth */}
          <ConnectorConfigCard name={name} schema={connectorInfo.configSchema} />

          {/* Claimed by tasks */}
          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
              {t("connectors.claimedBy")}
            </div>
            {tasks.length === 0 ? (
              <div className="muted" style={{ fontSize: 11 }}>
                {t("connectors.notClaimed")}
              </div>
            ) : (
              tasks.map((task) => (
                <div key={task.id} className="row gap-2" style={{ padding: "5px 0" }}>
                  <Badge kind={task.status === "running" ? "live" : "idle"} />
                  <span style={{ fontSize: 12 }}>{task.title}</span>
                </div>
              ))
            )}
          </div>

          {/* Sandbox info */}
          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
              {t("connectors.sandbox")}
            </div>
            <div className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>
              {t("connectors.injected")} <span className="mono">fetch</span>,{" "}
              <span className="mono">storage</span>,{" "}
              <span className="mono">emit()</span>
              <br />
              {t("connectors.noFsAccess")}
              <br />
              {t("connectors.noCrossRead")}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── OAuth connectors (gmail) ──────────────────────────────

const OAUTH_CONNECTORS = new Set(["gmail"]);

function OAuthConfigSection({ name }: { name: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check existing auth on mount
  useEffect(() => {
    window.noma?.db.oauth.status(name).then((res) => {
      if (res.authorized && res.config) {
        setState("connected");
        if (res.config.email) setEmail(String(res.config.email));
      }
    });
  }, [name]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleConnect = async () => {
    setState("connecting");
    setError(null);
    const noma = window.noma;
    if (!noma) return;

    const res = await noma.db.oauth.init(name);
    if (!res.ok) {
      setState("error");
      setError(res.error ?? "Unknown error");
      return;
    }

    // Poll for completion (user is in the browser authorizing)
    pollRef.current = setInterval(async () => {
      const status = await noma.db.oauth.status(name);
      if (status.authorized) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setState("connected");
        if (status.config?.email) setEmail(String(status.config.email));
      }
    }, 3000);

    // Stop polling after 5 minutes
    setTimeout(() => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        if (state === "connecting") {
          setState("idle");
        }
      }
    }, 300_000);
  };

  const handleDisconnect = async () => {
    await window.noma?.db.connectorConfig.delete(name);
    setState("idle");
    setEmail(null);
  };

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>
        {t("connectorConfig.authTitle")}
      </div>

      {state === "connected" ? (
        <div className="col gap-2">
          <div className="row gap-2" style={{ alignItems: "center" }}>
            <span style={{ color: "var(--ok)", fontSize: 12 }}>●</span>
            <span style={{ fontSize: 12, fontWeight: 500 }}>{t("connectorConfig.oauthConnected")}</span>
          </div>
          {email && (
            <div className="muted" style={{ fontSize: 11 }}>
              {t("connectorConfig.oauthAccount")}: {email}
            </div>
          )}
          <Button size="sm" kind="ghost" onClick={handleDisconnect} style={{ alignSelf: "flex-start", marginTop: 4 }}>
            {t("connectorConfig.disconnectBtn")}
          </Button>
        </div>
      ) : state === "connecting" ? (
        <div className="col gap-2">
          <div className="muted" style={{ fontSize: 11 }}>
            {t("connectorConfig.oauthConnecting")}
          </div>
          <div className="muted" style={{ fontSize: 10 }}>
            {t("connectorConfig.oauthHint")}
          </div>
        </div>
      ) : (
        <div className="col gap-2">
          {error && (
            <div style={{ fontSize: 11, color: "var(--danger)" }}>
              {t("connectorConfig.oauthError")}: {error}
            </div>
          )}
          <div className="muted" style={{ fontSize: 11 }}>
            {t("connectorConfig.oauthHint")}
          </div>
          <Button size="sm" kind="primary" onClick={handleConnect} style={{ alignSelf: "flex-start" }}>
            {t("connectorConfig.connectBtn")}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Manual credential connectors (github, lark) ──────────

function CredentialConfigSection({
  name,
  schema,
}: {
  name: string;
  schema: ConfigField[];
}) {
  const { t } = useI18n();
  const [values, setValues] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  // Only show auth-relevant fields (secret or taskRequired)
  const authFields = schema.filter((f) => f.secret || f.taskRequired);
  if (authFields.length === 0) return null;

  // Load stored config on mount
  useEffect(() => {
    window.noma?.db.connectorConfig.get(name).then((config) => {
      setValues(config);
    });
  }, [name]);

  const handleSave = async () => {
    setSaveState("saving");
    // Only save fields that have values
    const toSave: Record<string, string> = {};
    for (const field of authFields) {
      const v = values[field.key];
      if (v !== undefined && v !== "") {
        toSave[field.key] = v;
      }
    }
    await window.noma?.db.connectorConfig.save(name, toSave);
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 2000);
  };

  const hasValues = authFields.some((f) => values[f.key]);
  const allFilled = authFields.filter((f) => f.taskRequired).every((f) => values[f.key]);

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
        {t("connectorConfig.authTitle")}
      </div>
      <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>
        {t("connectorConfig.credentialHint")}
      </div>

      <div className="col gap-3">
        {authFields.map((field) => {
          const isSecret = field.secret;
          const showing = showSecrets[field.key];
          return (
            <div key={field.key}>
              <div className="row gap-2" style={{ marginBottom: 4, alignItems: "center" }}>
                <span style={{ fontSize: 11, fontWeight: 500 }}>
                  {field.label ?? field.key}
                </span>
                {field.taskRequired && (
                  <span style={{ fontSize: 9, color: "var(--danger)", fontWeight: 600 }}>
                    {t("connectorConfig.fieldRequired")}
                  </span>
                )}
                {isSecret && (
                  <span style={{ fontSize: 9, color: "var(--ink-muted)" }}>
                    {t("connectorConfig.fieldSecret")}
                  </span>
                )}
              </div>
              <Input
                type={isSecret && !showing ? "password" : "text"}
                value={values[field.key] ?? ""}
                onChange={(e) =>
                  setValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                }
                placeholder={field.label ?? field.key}
                suffix={
                  isSecret ? (
                    <button
                      onClick={() =>
                        setShowSecrets((prev) => ({
                          ...prev,
                          [field.key]: !prev[field.key],
                        }))
                      }
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        fontSize: 10,
                        color: "var(--ink-muted)",
                        padding: "0 2px",
                      }}
                    >
                      {showing ? "hide" : "show"}
                    </button>
                  ) : undefined
                }
              />
            </div>
          );
        })}
      </div>

      <div className="row gap-2" style={{ marginTop: 12 }}>
        <Button
          size="sm"
          kind="primary"
          onClick={handleSave}
          disabled={saveState === "saving" || !allFilled}
        >
          {saveState === "saving"
            ? t("connectorConfig.saving")
            : saveState === "saved"
              ? t("connectorConfig.saved")
              : t("connectorConfig.saveBtn")}
        </Button>
        {hasValues && (
          <Button
            size="sm"
            kind="ghost"
            onClick={async () => {
              await window.noma?.db.connectorConfig.delete(name);
              setValues({});
            }}
          >
            {t("connectorConfig.disconnectBtn")}
          </Button>
        )}
      </div>
    </div>
  );
}

// ── No-auth connectors ───────────────────────────────────

function NoAuthConfigSection() {
  const { t } = useI18n();
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
        {t("connectorConfig.authTitle")}
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        {t("connectorConfig.readyToUse")}
      </div>
    </div>
  );
}

// ── Config section router ────────────────────────────────

function ConnectorConfigCard({
  name,
  schema,
}: {
  name: string;
  schema: ConfigField[];
}) {
  if (OAUTH_CONNECTORS.has(name)) {
    return <OAuthConfigSection name={name} />;
  }

  const authFields = schema.filter((f) => f.secret || f.taskRequired);
  if (authFields.length > 0) {
    return <CredentialConfigSection name={name} schema={schema} />;
  }

  return <NoAuthConfigSection />;
}

function payloadOneLine(payload: unknown): string {
  if (payload == null) return "";
  if (typeof payload === "string") return payload.slice(0, 60);
  try {
    const obj = payload as Record<string, unknown>;
    if (obj.symbol && obj.price) return `${obj.symbol} $${obj.price}`;
    if (obj.title) return String(obj.title).slice(0, 60);
    return JSON.stringify(payload).slice(0, 60);
  } catch {
    return String(payload).slice(0, 60);
  }
}

// ── Connectors screen ──────────────────────────────────────

export default function ConnectorsScreen() {
  const [selected, setSelected] = useState<string | null>(null);

  if (selected) {
    return <ConnectorDetail name={selected} onBack={() => setSelected(null)} />;
  }
  return <ConnectorGrid onSelect={setSelected} />;
}
