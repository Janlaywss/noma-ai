import type { ReactNode } from "react";
import { useState, useEffect, useCallback, useRef } from "react";
import { Select, Button, Checkbox, Input } from "@noma/ui";
import { useI18n, type Locale } from "../i18n";
import { useTheme, type ThemeMode } from "../theme";
import { useChat } from "../store/chat";

function SettingsRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "220px 1fr",
        gap: 24,
        padding: "18px 0",
        borderBottom: "1px dashed var(--line-soft)",
        alignItems: "flex-start",
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
        {hint && (
          <div
            className="muted"
            style={{ fontSize: 11, marginTop: 4, lineHeight: 1.5 }}
          >
            {hint}
          </div>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

function SettingsGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--ink-muted)",
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}

// ── Theme preview tile ─────────────────────────────────────

function ThemePreview({
  kind,
  selected,
}: {
  kind: string;
  selected: boolean;
}) {
  const ringColor = selected ? "var(--accent)" : "var(--line)";
  const ringWidth = selected ? 2 : 1;

  const tile = (bg: string, sb: string, fg: string, line: string) => (
    <div style={{ width: "100%", height: "100%", display: "flex", background: bg }}>
      <div style={{ width: "32%", background: sb, borderRight: `1px solid ${line}` }}>
        <div style={{ height: 4, width: "60%", background: fg, opacity: 0.5, margin: "8px 6px 4px" }} />
        <div style={{ height: 3, width: "50%", background: fg, opacity: 0.3, margin: "4px 6px" }} />
        <div style={{ height: 3, width: "70%", background: fg, opacity: 0.3, margin: "4px 6px" }} />
      </div>
      <div style={{ flex: 1, padding: 6 }}>
        <div style={{ height: 4, width: "70%", background: fg, opacity: 0.7, marginBottom: 4 }} />
        <div style={{ height: 3, width: "90%", background: fg, opacity: 0.3, marginBottom: 2 }} />
        <div style={{ height: 3, width: "60%", background: fg, opacity: 0.3 }} />
      </div>
    </div>
  );

  let inner;
  if (kind === "light") {
    inner = tile("#fff", "#f7f7f7", "#1a1a1a", "#e5e5e5");
  } else if (kind === "dark") {
    inner = tile("#0a0a0a", "#171717", "#fafafa", "#262626");
  } else if (kind === "system") {
    inner = (
      <div style={{ position: "relative", width: "100%", height: "100%" }}>
        <div style={{ position: "absolute", inset: 0 }}>
          {tile("#fff", "#f7f7f7", "#1a1a1a", "#e5e5e5")}
        </div>
        <div
          style={{
            position: "absolute",
            inset: 0,
            clipPath: "polygon(50% 0, 100% 0, 100% 100%, 50% 100%)",
          }}
        >
          {tile("#0a0a0a", "#171717", "#fafafa", "#262626")}
        </div>
      </div>
    );
  } else {
    inner = (
      <div style={{ position: "relative", width: "100%", height: "100%" }}>
        <div style={{ position: "absolute", inset: 0 }}>
          {tile("#fff", "#f7f7f7", "#1a1a1a", "#e5e5e5")}
        </div>
        <div
          style={{
            position: "absolute",
            inset: 0,
            clipPath: "polygon(0 100%, 100% 0, 100% 100%)",
          }}
        >
          {tile("#0a0a0a", "#171717", "#fafafa", "#262626")}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        width: 110,
        height: 70,
        borderRadius: 6,
        overflow: "hidden",
        border: `${ringWidth}px solid ${ringColor}`,
        boxShadow: selected ? "0 0 0 3px var(--accent-soft)" : "none",
      }}
    >
      {inner}
    </div>
  );
}

// ── Clear data dialog ────────────────────────────────────

function ClearDataDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { refreshSessions } = useChat();
  const [counts, setCounts] = useState<{ tasks: number; sessions: number; messages: number; events: number } | null>(null);
  const [checkTasks, setCheckTasks] = useState(false);
  const [checkSessions, setCheckSessions] = useState(false);
  const [checkEvents, setCheckEvents] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.noma?.db.clearData.counts().then(setCounts);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!checkTasks && !checkSessions && !checkEvents) return;
    setBusy(true);
    try {
      await window.noma?.db.clearData.execute({
        tasks: checkTasks,
        sessions: checkSessions,
        events: checkEvents,
      });
      // Refresh chat store so sidebar/state reflect cleared sessions
      if (checkSessions) {
        await refreshSessions();
      }
      onClose();
    } catch (err) {
      console.warn("[settings] clear data failed:", err);
    } finally {
      setBusy(false);
    }
  }, [checkTasks, checkSessions, checkEvents, onClose, refreshSessions]);

  const noneSelected = !checkTasks && !checkSessions && !checkEvents;

  return (
    <>
      {/* Overlay */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.35)",
          zIndex: 1000,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        onClick={onClose}
      >
        {/* Dialog */}
        <div
          className="card"
          style={{
            width: 380,
            padding: 24,
            boxShadow: "var(--shadow-md)",
            background: "var(--card-bg)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            {t("settings.clearDialogTitle")}
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 20, lineHeight: 1.5 }}>
            {t("settings.clearDialogHint")}
          </div>

          <div className="col gap-3" style={{ marginBottom: 24 }}>
            {/* Tasks */}
            <label
              style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}
              onClick={() => setCheckTasks((v) => !v)}
            >
              <div style={{ paddingTop: 2 }}>
                <Checkbox on={checkTasks} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {t("settings.clearTasks")}
                  {counts && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>({counts.tasks})</span>}
                </div>
                <div className="muted" style={{ fontSize: 11, lineHeight: 1.4 }}>
                  {t("settings.clearTasksHint")}
                </div>
              </div>
            </label>

            {/* Sessions */}
            <label
              style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}
              onClick={() => setCheckSessions((v) => !v)}
            >
              <div style={{ paddingTop: 2 }}>
                <Checkbox on={checkSessions} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {t("settings.clearSessions")}
                  {counts && (
                    <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
                      ({counts.sessions} / {counts.messages} msgs)
                    </span>
                  )}
                </div>
                <div className="muted" style={{ fontSize: 11, lineHeight: 1.4 }}>
                  {t("settings.clearSessionsHint")}
                </div>
              </div>
            </label>

            {/* Events */}
            <label
              style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}
              onClick={() => setCheckEvents((v) => !v)}
            >
              <div style={{ paddingTop: 2 }}>
                <Checkbox on={checkEvents} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {t("settings.clearEvents")}
                  {counts && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>({counts.events})</span>}
                </div>
                <div className="muted" style={{ fontSize: 11, lineHeight: 1.4 }}>
                  {t("settings.clearEventsHint")}
                </div>
              </div>
            </label>
          </div>

          <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
            <Button kind="ghost" size="sm" onClick={onClose}>
              {t("settings.clearCancel")}
            </Button>
            <Button
              kind="primary"
              size="sm"
              disabled={noneSelected || busy}
              onClick={handleConfirm}
              style={noneSelected ? undefined : { background: "var(--danger)", borderColor: "var(--danger)" }}
            >
              {busy ? "…" : t("settings.clearConfirm")}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Settings content ──────────────────────────────────────

const LOCALE_MAP: Record<string, Locale> = {
  en: "en-US",
  "zh-CN": "zh-CN",
};
const REVERSE_LOCALE: Record<Locale, string> = {
  "en-US": "en",
  "zh-CN": "zh-CN",
};

const THEME_MAP: Record<string, ThemeMode> = {
  light: "light",
  dark: "dark",
  system: "system",
  auto: "system",
};

function SettingsContent() {
  const { t, locale, setLocale } = useI18n();
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const [theme, setThemeId] = useState(() => {
    if (themeMode === "light") return "light";
    if (themeMode === "dark") return "dark";
    return "system";
  });
  const setTheme = (id: string) => {
    setThemeId(id);
    const mapped = THEME_MAP[id];
    if (mapped) setThemeMode(mapped);
  };
  const lang = REVERSE_LOCALE[locale] ?? "en";
  const setLang = (id: string) => {
    const mapped = LOCALE_MAP[id];
    if (mapped) setLocale(mapped);
  };

  const langOptions = [
    { id: "en", label: "English", sublabel: "English" },
    { id: "zh-CN", label: "简体中文", sublabel: "Chinese (Simplified)" },
  ];

  return (
    <div style={{ maxWidth: 720 }}>
      <SettingsGroup title={t("settings.theme")}>
        <SettingsRow
          label={t("settings.colorMode")}
          hint={t("settings.colorModeHint")}
        >
          <div className="row gap-3" style={{ alignItems: "flex-start" }}>
            {[
              { id: "light", label: t("settings.light"), preview: "light" },
              { id: "dark", label: t("settings.dark"), preview: "dark" },
              { id: "system", label: t("settings.system"), preview: "system" },
              { id: "auto", label: t("settings.autoSunset"), preview: "auto" },
            ].map((t) => (
              <div
                key={t.id}
                onClick={() => setTheme(t.id)}
                style={{ cursor: "pointer", textAlign: "center" }}
              >
                <ThemePreview kind={t.preview} selected={theme === t.id} />
                <div
                  style={{
                    fontSize: 11,
                    marginTop: 8,
                    fontWeight: theme === t.id ? 600 : 400,
                  }}
                >
                  {t.label}
                </div>
              </div>
            ))}
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.language")}>
        <SettingsRow
          label={t("settings.displayLanguage")}
          hint={t("settings.displayLanguageHint")}
        >
          <Select
            value={lang}
            options={langOptions}
            onChange={setLang}
          />
        </SettingsRow>
      </SettingsGroup>

      <ModelSection />

      <DataSection />
    </div>
  );
}

// ── Model setting input ─────────────────────────────────

function ModelInput({
  dbKey,
  placeholder,
}: {
  dbKey: string;
  placeholder: string;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  const loaded = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    window.noma?.db.settings.get(dbKey).then((v) => {
      if (v) setValue(v);
      loaded.current = true;
    });
  }, [dbKey]);

  const persist = useCallback(
    (next: string) => {
      setValue(next);
      if (!loaded.current) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        const trimmed = next.trim();
        if (!trimmed) return;
        await window.noma?.db.settings.set(dbKey, trimmed);
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      }, 600);
    },
    [dbKey]
  );

  return (
    <div className="row gap-2" style={{ alignItems: "center" }}>
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(e) => persist(e.currentTarget.value)}
        style={{ maxWidth: 340 }}
      />
      {saved && (
        <span style={{ fontSize: 11, color: "var(--accent)" }}>
          {t("settings.modelSaved")}
        </span>
      )}
    </div>
  );
}

function ModelSection() {
  const { t } = useI18n();

  return (
    <SettingsGroup title={t("settings.models")}>
      <SettingsRow
        label={t("settings.agentModel")}
        hint={t("settings.agentModelHint")}
      >
        <ModelInput
          dbKey="model.agent"
          placeholder={t("settings.modelPlaceholder")}
        />
      </SettingsRow>
      <SettingsRow
        label={t("settings.eventModel")}
        hint={t("settings.eventModelHint")}
      >
        <ModelInput
          dbKey="model.event"
          placeholder={t("settings.modelPlaceholder")}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

// ── Data section ────────────────────────────────────────

function DataSection() {
  const { t } = useI18n();
  const [showDialog, setShowDialog] = useState(false);

  return (
    <>
      <SettingsGroup title={t("settings.data")}>
        <SettingsRow
          label={t("settings.clearData")}
          hint={t("settings.clearDataHint")}
        >
          <Button size="sm" onClick={() => setShowDialog(true)}>
            {t("settings.clearDataBtn")}
          </Button>
        </SettingsRow>
      </SettingsGroup>

      {showDialog && <ClearDataDialog onClose={() => setShowDialog(false)} />}
    </>
  );
}

export default function SettingsView() {
  const { t } = useI18n();
  return (
    <div className="app-content">
      <div className="app-header">
        <div className="col flex-1">
          <div style={{ fontSize: 13, fontWeight: 600 }}>{t("settings.title")}</div>
          <div className="muted" style={{ fontSize: 11 }}>
            {t("settings.subtitle")}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "24px 36px" }}>
        <SettingsContent />
      </div>
    </div>
  );
}
