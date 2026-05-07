import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ConnectorIcon } from "@noma/ui";
import { useI18n } from "../i18n";
import { useChat } from "../store/chat";

type SourceNode = {
  name: string;
  label: string;
  y: number;
  live: boolean;
  hot?: boolean;
};

const AGENT_X = 540;
const AGENT_Y = 290;

function sourcePath(sy: number): string {
  return `M 130 ${sy} Q 320 ${sy}, 380 ${(sy + AGENT_Y) / 2} T ${AGENT_X - 60} ${AGENT_Y}`;
}

function sinkPath(sy: number): string {
  return `M ${AGENT_X + 60} ${AGENT_Y} Q ${AGENT_X + 200} ${AGENT_Y}, ${AGENT_X + 260} ${(sy + AGENT_Y) / 2} T 980 ${sy}`;
}

export default function NewChatView() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { sendMessage } = useChat();
  const [sources, setSources] = useState<SourceNode[]>([]);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    navigate("/chat");
    sendMessage(text);
  };

  useEffect(() => {
    (async () => {
      const noma = window.noma;
      if (!noma) return;

      const [bootstrap, summaries] = await Promise.all([
        noma.getBootstrap(),
        noma.db.connectors.summary(),
      ]);

      const summaryMap = new Map(summaries.map((s) => [s.name, s]));

      // Distribute connectors vertically across the signal field
      const startY = 100;
      const gap = 80;
      const nodes: SourceNode[] = bootstrap.connectors.map((c, i) => {
        const s = summaryMap.get(c.name);
        const isLive = (s?.runningCount ?? 0) > 0;
        return {
          name: c.name,
          label: c.label ?? c.name,
          y: startY + i * gap,
          live: isLive,
          hot: isLive && (s?.eventCount ?? 0) > 0,
        };
      });

      setSources(nodes);
    })();
  }, []);

  // Keep static sinks (these are output targets, not data-driven)
  const sinks = [
    { name: "lark", label: "lark", y: 160 },
    { name: "cal", label: "calendar", y: 260 },
    { name: "notion", label: "notion", y: 360 },
  ];

  return (
    <div
      style={{
        flex: 1,
        position: "relative",
        overflow: "hidden",
        background: "var(--bg)",
      }}
    >
      {/* Dot grid background */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "radial-gradient(circle, var(--line) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          opacity: 0.5,
          pointerEvents: "none",
        }}
      />

      {/* Top meta */}
      <div
        className="mono"
        style={{
          position: "absolute",
          top: 14,
          left: 16,
          fontSize: 10,
          color: "var(--ink-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.1em",
        }}
      >
        {t("newChat.signalFieldMeta")}
      </div>

      {/* Column labels */}
      <div
        className="mono"
        style={{
          position: "absolute",
          top: 56,
          left: 70,
          fontSize: 10,
          color: "var(--ink-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.15em",
        }}
      >
        {t("newChat.sources")}
      </div>
      <div
        className="mono"
        style={{
          position: "absolute",
          top: 56,
          left: AGENT_X - 30,
          fontSize: 10,
          color: "var(--ink-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.15em",
        }}
      >
        {t("newChat.agent")}
      </div>
      <div
        className="mono"
        style={{
          position: "absolute",
          top: 56,
          right: 100,
          fontSize: 10,
          color: "var(--ink-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.15em",
        }}
      >
        {t("newChat.actions")}
      </div>

      {/* Flow lines SVG */}
      <svg
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      >
        {sources.map((s, i) => (
          <g key={`in-${i}`}>
            <path
              d={sourcePath(s.y)}
              stroke={s.hot ? "var(--accent)" : "var(--line-soft)"}
              strokeWidth={s.hot ? 1.5 : 1}
              strokeDasharray={s.live ? "0" : "3 4"}
              fill="none"
              opacity={s.live ? 0.7 : 0.3}
            />
            {s.live && (
              <circle
                r="3"
                fill={s.hot ? "var(--accent)" : "var(--ink-muted)"}
              >
                <animateMotion
                  dur={s.hot ? "2s" : "3.5s"}
                  repeatCount="indefinite"
                  path={sourcePath(s.y)}
                />
              </circle>
            )}
          </g>
        ))}
        {sinks.map((s, i) => (
          <path
            key={`out-${i}`}
            d={sinkPath(s.y)}
            stroke="var(--line-soft)"
            strokeWidth="1"
            strokeDasharray="2 5"
            fill="none"
            opacity={0.35}
          />
        ))}
      </svg>

      {/* Source nodes — left column */}
      {sources.map((s, i) => (
        <div
          key={`sn-${i}`}
          style={{
            position: "absolute",
            left: 70,
            top: s.y,
            transform: "translate(-50%, -50%)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            opacity: s.live ? 1 : 0.45,
          }}
        >
          <div style={{ position: "relative" }}>
            {s.live && (
              <div
                className="signal-pulse"
                style={{
                  position: "absolute",
                  inset: -4,
                  borderRadius: 12,
                  background: s.hot
                    ? "oklch(0.92 0.04 252)"
                    : "oklch(0.94 0.06 150)",
                  opacity: 0.5,
                }}
              />
            )}
            <ConnectorIcon name={s.name} size={36} />
          </div>
          <div
            style={{
              position: "absolute",
              left: 50,
              top: -8,
              whiteSpace: "nowrap",
            }}
          >
            <div
              className="mono"
              style={{ fontSize: 11, fontWeight: 600, color: "var(--ink)" }}
            >
              {s.label}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 9,
                color: "var(--ink-muted)",
                marginTop: 2,
              }}
            >
              {s.live ? "live" : "idle"}
            </div>
          </div>
        </div>
      ))}

      {/* Agent — center node */}
      <div
        style={{
          position: "absolute",
          left: AGENT_X,
          top: AGENT_Y,
          transform: "translate(-50%, -50%)",
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 999,
            background: "var(--ink)",
            color: "var(--bg)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 0 0 4px var(--bg), 0 0 0 5px var(--ink)",
            fontSize: 20,
            fontWeight: 700,
          }}
        >
          ◆
        </div>
        <div
          style={{
            position: "absolute",
            top: 68,
            left: "50%",
            transform: "translateX(-50%)",
            whiteSpace: "nowrap",
            textAlign: "center",
          }}
        >
          <div
            className="mono"
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: "var(--ink)",
              textTransform: "uppercase",
              letterSpacing: "0.12em",
            }}
          >
            {t("newChat.agentIdle")}
          </div>
        </div>
      </div>

      {/* Sink nodes — right column */}
      {sinks.map((s, i) => (
        <div
          key={`sk-${i}`}
          style={{
            position: "absolute",
            right: 80,
            top: s.y,
            transform: "translate(50%, -50%)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            opacity: 0.7,
          }}
        >
          <div
            style={{
              position: "absolute",
              right: 50,
              top: -8,
              whiteSpace: "nowrap",
              textAlign: "right",
            }}
          >
            <div
              className="mono"
              style={{ fontSize: 11, fontWeight: 600, color: "var(--ink)" }}
            >
              {s.label}
            </div>
          </div>
          <ConnectorIcon name={s.name} size={36} />
        </div>
      ))}

      {/* Hero text */}
      <div
        style={{
          position: "absolute",
          bottom: 130,
          left: 36,
          right: 36,
          pointerEvents: "none",
        }}
      >
        <div
          className="mono"
          style={{
            fontSize: 13,
            color: "var(--ink-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            marginBottom: 10,
          }}
        >
          {t("newChat.heroPrompt")}
        </div>
        <div
          style={{
            fontSize: 36,
            fontWeight: 500,
            letterSpacing: "-0.03em",
            lineHeight: 1.05,
            color: "var(--ink)",
            maxWidth: 680,
          }}
        >
          {t("newChat.heroTitle")}{" "}
          <span style={{ color: "var(--accent)", fontWeight: 600 }}>{t("newChat.heroYou")}</span>{" "}
          {t("newChat.heroMiddle")}{" "}
          <span style={{ fontStyle: "italic", fontWeight: 400 }}>{t("newChat.heroAction")}</span>
        </div>
      </div>

      {/* Command bar */}
      <div style={{ position: "absolute", left: 32, right: 32, bottom: 28 }}>
        <div
          style={{
            background: "oklch(0.13 0 0)",
            color: "oklch(0.96 0 0)",
            borderRadius: 10,
            padding: "14px 16px",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            gap: 12,
            boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          }}
        >
          <span style={{ color: "oklch(0.7 0.15 150)" }}>▸</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || !e.shiftKey)) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder={t("newChat.inputPlaceholder")}
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              font: "inherit",
              fontSize: 13,
              color: "oklch(0.96 0 0)",
              caretColor: "oklch(0.7 0.15 150)",
            }}
            autoFocus
          />
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: input.trim() ? "oklch(0.7 0.15 150)" : "var(--ink-muted)",
              cursor: input.trim() ? "pointer" : "default",
            }}
            onClick={handleSubmit}
          >
            {t("newChat.run")}
          </span>
        </div>
        <div
          className="row gap-2"
          style={{
            marginTop: 10,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--ink-muted)",
          }}
        >
          <span style={{ color: "var(--ink-soft)" }}>{t("newChat.try")}</span>
          <span className="signal-chip">watch stock price → lark</span>
          <span className="signal-chip">summarize gmail @ 9pm → notion</span>
          <span className="signal-chip">flight delay → notify</span>
          <span className="flex-1" />
          <span>noma · local · v0.4</span>
        </div>
      </div>
    </div>
  );
}
