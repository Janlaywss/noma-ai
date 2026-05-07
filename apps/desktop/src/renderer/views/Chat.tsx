import { useState, useRef, useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Tag, Button, Avatar } from "@noma/ui";
import { useI18n } from "../i18n";
import { useChat, type ChatMessage, type ChatToolCall, type ChatSegment } from "../store/chat";

// ── Tool call display names ─────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  list_connectors: "查询可用连接器",
  createConnector: "创建连接器",
  scheduleTask: "创建监听任务",
  notify: "发送通知",
  web_search: "联网检索",
  web_fetch: "获取网页内容",
  testConnectorCode: "测试连接器代码",
  saveConnector: "保存连接器",
};

// ── Tool call card ──────────────────────────────────────

function ToolCallCard({ tool }: { tool: ChatToolCall }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const label = TOOL_LABELS[tool.toolName] ?? tool.toolName;
  const statusText =
    tool.state === "success"
      ? t("common.done")
      : tool.state === "running"
      ? t("common.thinking")
      : t("common.error");
  const badgeKind =
    tool.state === "success"
      ? "live"
      : tool.state === "running"
      ? "think"
      : "idle";

  return (
    <div className="card" style={{ padding: 10, marginTop: 8 }}>
      <div
        className="row gap-2"
        style={{ cursor: "pointer" }}
        onClick={() => setExpanded(!expanded)}
      >
        <Badge kind={badgeKind} />
        <span style={{ fontSize: 11, fontWeight: 600, flex: 1 }}>
          {label}
        </span>
        <span className="muted" style={{ fontSize: 11 }}>
          {statusText}
        </span>
        <span className="muted" style={{ fontSize: 10 }}>
          {expanded ? "▲" : "▼"}
        </span>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, fontSize: 11 }}>
          {tool.input && (
            <div className="terminal" style={{ marginBottom: 6 }}>
              <div className="terminal-info" style={{ marginBottom: 4 }}>
                input:
              </div>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {tool.output !== undefined && (
            <div className="terminal">
              <div className="terminal-ok" style={{ marginBottom: 4 }}>
                output:
              </div>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                {typeof tool.output === "string"
                  ? tool.output
                  : JSON.stringify(tool.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Task created card ───────────────────────────────────

function TaskCreatedCard({ taskId, title }: { taskId: string; title: string }) {
  const navigate = useNavigate();
  const { t } = useI18n();

  return (
    <div
      className="card"
      style={{
        padding: "10px 14px",
        marginTop: 10,
        cursor: "pointer",
        border: "1px solid oklch(0.85 0.06 150)",
        background: "oklch(0.97 0.01 150)",
        borderRadius: 8,
        transition: "background 0.15s",
      }}
      onClick={() => navigate(`/tasks/${taskId}`)}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = "oklch(0.94 0.02 150)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "oklch(0.97 0.01 150)";
      }}
    >
      <div className="row gap-2" style={{ alignItems: "center" }}>
        <span style={{ fontSize: 14 }}>✓</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "oklch(0.35 0.08 150)" }}>
            {t("chat.taskCreated")}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink)", marginTop: 2 }}>
            {title}
          </div>
        </div>
        <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>→</span>
      </div>
    </div>
  );
}

/**
 * Extract task creation info from a scheduleTask tool call output.
 * The output format is: "Task created successfully: "title" (id: xxx). ..."
 */
function extractTaskFromToolCall(tool: ChatToolCall): { taskId: string; title: string } | null {
  if (!tool.toolName.includes("scheduleTask")) return null;
  if (tool.state !== "success" || !tool.output) return null;

  const text = typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output);

  // Parse: Task created successfully: "title" (id: xxx).
  const idMatch = text.match(/\(id:\s*([^)]+)\)/);
  const titleMatch = text.match(/Task created successfully:\s*"([^"]+)"/);

  if (!idMatch) return null;
  return {
    taskId: idMatch[1].trim(),
    title: titleMatch ? titleMatch[1] : "Task",
  };
}

// ── Chat message bubble ─────────────────────────────────

function MessageBubble({
  message,
  children,
}: {
  message: ChatMessage;
  children?: ReactNode;
}) {
  const { t } = useI18n();

  if (message.role === "system") {
    // Proactive messages from connector events
    const isProactive = message.id.startsWith("proactive-");
    return (
      <div
        style={{
          margin: "10px 0",
          padding: "10px 14px",
          borderRadius: 8,
          fontSize: 12,
          lineHeight: 1.5,
          background: isProactive
            ? "oklch(0.95 0.02 250)"
            : "var(--surface-subtle)",
          borderLeft: isProactive
            ? "3px solid oklch(0.6 0.15 250)"
            : "3px solid var(--ink-muted)",
        }}
      >
        {isProactive && (
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: "oklch(0.5 0.15 250)",
              marginBottom: 4,
            }}
          >
            ⚡ {t("chat.connectorEvent")}
          </div>
        )}
        <span style={{ whiteSpace: "pre-wrap" }}>{message.content}</span>
      </div>
    );
  }

  const isAssistant = message.role === "assistant";

  return (
    <div
      className="row gap-2"
      style={{ alignItems: "flex-start", margin: "12px 0" }}
    >
      {isAssistant ? (
        <div
          className="sb-logo"
          style={{ width: 26, height: 26, fontSize: 13 }}
        >
          ◆
        </div>
      ) : (
        <Avatar initials="Y" color="oklch(0.85 0.05 250)" />
      )}
      <div className="flex-1">
        <div className="row gap-2" style={{ marginBottom: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>
            {isAssistant ? "Noma" : t("common.you")}
          </span>
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.55 }}>
          {message.segments && message.segments.length > 0 ? (
            // Render in streaming order
            message.segments.map((seg, i) =>
              seg.kind === "text" ? (
                <div key={`text-${i}`} style={{ whiteSpace: "pre-wrap" }}>
                  {seg.content}
                </div>
              ) : (
                (() => {
                  const tc = message.toolCalls?.find(
                    (t) => t.toolCallId === seg.toolCallId
                  );
                  return tc ? (
                    <ToolCallCard key={tc.toolCallId} tool={tc} />
                  ) : null;
                })()
              )
            )
          ) : (
            // Fallback for messages without segments (user messages, old data)
            <>
              {message.content && (
                <div style={{ whiteSpace: "pre-wrap" }}>{message.content}</div>
              )}
              {message.toolCalls?.map((tc) => (
                <ToolCallCard key={tc.toolCallId} tool={tc} />
              ))}
            </>
          )}
          {/* Task creation cards — shown at bottom of assistant messages */}
          {message.role === "assistant" && message.toolCalls?.map((tc) => {
            const taskInfo = extractTaskFromToolCall(tc);
            return taskInfo ? (
              <TaskCreatedCard
                key={`task-${taskInfo.taskId}`}
                taskId={taskInfo.taskId}
                title={taskInfo.title}
              />
            ) : null;
          })}
          {children}
        </div>
      </div>
    </div>
  );
}

// ── Streaming indicator ─────────────────────────────────

function StreamingDots() {
  return (
    <span className="muted" style={{ fontSize: 18, letterSpacing: 2 }}>
      <span className="signal-cursor" style={{ display: "inline-block", width: 6, height: 6, background: "var(--ink-muted)", borderRadius: "50%", marginRight: 3 }} />
      <span className="signal-cursor" style={{ display: "inline-block", width: 6, height: 6, background: "var(--ink-muted)", borderRadius: "50%", marginRight: 3, animationDelay: "0.2s" }} />
      <span className="signal-cursor" style={{ display: "inline-block", width: 6, height: 6, background: "var(--ink-muted)", borderRadius: "50%", animationDelay: "0.4s" }} />
    </span>
  );
}

// ── Composer ────────────────────────────────────────────

function Composer({
  onSend,
  isStreaming,
  onCancel,
}: {
  onSend: (text: string) => void;
  isStreaming: boolean;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    onSend(trimmed);
    setText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div style={{ padding: 16, borderTop: "1px solid var(--line)" }}>
      <div
        className="card"
        style={{
          padding: 10,
          display: "flex",
          alignItems: "flex-end",
          gap: 8,
        }}
      >
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("chat.replyPlaceholder")}
          rows={1}
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            background: "transparent",
            resize: "none",
            font: "inherit",
            fontSize: 13,
            color: "var(--ink)",
            minHeight: 36,
            padding: "8px 0",
            lineHeight: 1.5,
          }}
        />
        {isStreaming ? (
          <Button size="sm" kind="ghost" onClick={onCancel}>
            {t("chat.stop")}
          </Button>
        ) : (
          <Button size="sm" kind="primary" onClick={handleSend} disabled={!text.trim()}>
            {t("chat.send")}
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Empty state ─────────────────────────────────────────

function EmptyState() {
  const { t } = useI18n();
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--ink-muted)",
        gap: 12,
      }}
    >
      <div
        className="sb-logo"
        style={{ width: 48, height: 48, fontSize: 22 }}
      >
        ◆
      </div>
      <div style={{ fontSize: 14, fontWeight: 500 }}>
        {t("chat.emptyTitle")}
      </div>
      <div style={{ fontSize: 12 }}>
        {t("chat.emptyHint")}
      </div>
    </div>
  );
}

// ── Chat screen ─────────────────────────────────────────

export default function ChatScreen() {
  const { t } = useI18n();
  const {
    messages,
    streamingMessage,
    isStreaming,
    activeSessionId,
    sessions,
    sendMessage,
    cancelStream,
    error,
  } = useChat();

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages / streaming
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingMessage]);

  // Resolve session title
  const activeSession = sessions.find(
    (s) => s.sessionId === activeSessionId
  );
  const sessionTitle = activeSession?.title ?? t("chat.newConversation");

  const allMessages = [
    ...messages,
    ...(streamingMessage ? [streamingMessage] : []),
  ];

  return (
    <div className="app-content">
      {/* Header */}
      <div className="app-header">
        <div className="col" style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {sessionTitle}
          </div>
          {activeSessionId && (
            <div className="muted" style={{ fontSize: 11 }}>
              {isStreaming ? t("chat.agentThinking") : t("chat.ready")}
            </div>
          )}
        </div>
        {isStreaming && (
          <Tag kind="accent">
            <Badge kind="think" /> {t("common.thinking")}
          </Tag>
        )}
      </div>

      {/* Messages area */}
      {allMessages.length === 0 && !isStreaming ? (
        <EmptyState />
      ) : (
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflow: "auto",
            padding: "20px 32px",
            maxWidth: 760,
            width: "100%",
            alignSelf: "center",
            boxSizing: "border-box",
          }}
        >
          {allMessages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          {isStreaming && !streamingMessage && (
            <div className="row gap-2" style={{ alignItems: "flex-start", margin: "12px 0" }}>
              <div
                className="sb-logo"
                style={{ width: 26, height: 26, fontSize: 13 }}
              >
                ◆
              </div>
              <div style={{ paddingTop: 6 }}>
                <StreamingDots />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div
          style={{
            padding: "8px 16px",
            background: "var(--danger-soft)",
            color: "var(--danger)",
            fontSize: 12,
            borderTop: "1px solid var(--danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* Composer */}
      <Composer
        onSend={sendMessage}
        isStreaming={isStreaming}
        onCancel={cancelStream}
      />
    </div>
  );
}
