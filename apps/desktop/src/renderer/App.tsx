import { useEffect, useState, useCallback } from "react";
import { Routes, Route, Navigate, NavLink, useNavigate, useLocation, useParams } from "react-router-dom";
import { Logo, MenuItem, Button } from "@noma/ui";
import { useI18n } from "./i18n";
import { useChat } from "./store/chat";
import ChatView from "./views/Chat";
import ConnectorsView from "./views/Connectors";
import TasksView from "./views/Tasks";
import TaskDetailView from "./views/TaskDetail";
import InboxView from "./views/Inbox";
import SettingsView from "./views/Settings";
import NewChatView from "./views/NewChat";

function NavItem({
  to,
  icon,
  label,
  badge,
}: {
  to: string;
  icon: string;
  label: string;
  badge?: string;
}) {
  return (
    <NavLink to={to} style={{ textDecoration: "none" }}>
      {({ isActive }) => (
        <MenuItem icon={icon} label={label} active={isActive} badge={badge} />
      )}
    </NavLink>
  );
}

function ChatSidebar() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { sessions, activeSessionId, loadSession, createSession, deleteSession, bridgeReady } = useChat();
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);

  // Close context menu on outside click or scroll
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    document.addEventListener("click", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [ctxMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, sessionId });
  }, []);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    setCtxMenu(null);
    if (!confirm(t("chat.deleteSessionConfirm"))) return;
    await deleteSession(sessionId);
    // If we deleted the active session and none remain, go to new-chat
    const noma = window.noma;
    if (noma) {
      const remaining = await noma.db.sessions.list();
      if (remaining.length === 0) {
        navigate("/new-chat");
      }
    }
  }, [deleteSession, navigate, t]);

  const handleNewChat = async () => {
    const sessionId = await createSession();
    if (sessionId) {
      navigate("/chat");
    } else {
      navigate("/new-chat");
    }
  };

  // Group sessions by recency
  const now = Date.now();
  const DAY = 86_400_000;
  const todaySessions = sessions.filter((s) => {
    const ts = s.updatedAt ? Date.parse(s.updatedAt) : 0;
    return now - ts < DAY;
  });
  const olderSessions = sessions.filter((s) => {
    const ts = s.updatedAt ? Date.parse(s.updatedAt) : 0;
    return now - ts >= DAY;
  });

  const renderSession = (s: AcpSessionInfo) => (
    <div
      key={s.sessionId}
      onContextMenu={(e) => handleContextMenu(e, s.sessionId)}
    >
      <MenuItem
        icon={s.sessionId === activeSessionId ? "◆" : "◇"}
        label={s.title ?? t("chat.untitled")}
        active={s.sessionId === activeSessionId}
        onClick={() => {
          loadSession(s.sessionId);
          navigate("/chat");
        }}
      />
    </div>
  );

  return (
    <>
      <div style={{ padding: "0 4px 8px" }}>
        <Button
          kind="primary"
          style={{ width: "100%", justifyContent: "center" }}
          onClick={handleNewChat}
        >
          {t("nav.newChat")}
        </Button>
      </div>

      {!bridgeReady && sessions.length === 0 && (
        <div className="muted" style={{ fontSize: 11, padding: "8px 8px", textAlign: "center" }}>
          {t("chat.bridgeNotReady")}
        </div>
      )}

      {todaySessions.length > 0 && (
        <>
          <div className="sb-section-title">{t("nav.today")}</div>
          {todaySessions.map(renderSession)}
        </>
      )}

      {olderSessions.length > 0 && (
        <>
          <div className="sb-section-title">{t("nav.older")}</div>
          {olderSessions.map(renderSession)}
        </>
      )}

      {/* Context menu */}
      {ctxMenu && (
        <>
          {/* Invisible backdrop to catch outside clicks */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: 998 }}
            onClick={() => setCtxMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}
          />
          <div
            style={{
              position: "fixed",
              top: ctxMenu.y,
              left: ctxMenu.x,
              zIndex: 999,
              background: "var(--card-bg)",
              border: "1px solid var(--line)",
              borderRadius: 6,
              boxShadow: "var(--shadow-md)",
              padding: "4px 0",
              minWidth: 150,
            }}
          >
            <button
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "7px 14px",
                border: "none",
                background: "transparent",
                fontSize: 12,
                color: "var(--danger)",
                cursor: "pointer",
                textAlign: "left",
              }}
              onMouseOver={(e) => { e.currentTarget.style.background = "var(--hover)"; }}
              onMouseOut={(e) => { e.currentTarget.style.background = "transparent"; }}
              onClick={() => handleDeleteSession(ctxMenu.sessionId)}
            >
              {t("chat.deleteSession")}
            </button>
          </div>
        </>
      )}
    </>
  );
}

function InboxSidebar() {
  const { t } = useI18n();
  const [summary, setSummary] = useState<InboxSummary | null>(null);

  useEffect(() => {
    window.noma?.db?.events.inboxSummary().then(setSummary);
  }, []);

  // Refresh on connector events
  useEffect(() => {
    const noma = window.noma;
    if (!noma?.onConnectorEvent) return;
    const unsub = noma.onConnectorEvent(() => {
      noma.db?.events.inboxSummary().then(setSummary);
    });
    return unsub;
  }, []);

  return (
    <>
      <div className="sb-section-title">{t("common.filter")}</div>
      <MenuItem icon="📥" label={t("nav.all")} active badge={summary ? String(summary.total) : undefined} />
      {summary && summary.unread > 0 && (
        <MenuItem icon="●" label={t("nav.unread")} badge={String(summary.unread)} />
      )}
      {summary && summary.sources.length > 0 && (
        <>
          <div className="sb-section-title">{t("nav.connectors")}</div>
          {summary.sources.map((s) => (
            <MenuItem key={s.source} icon="◇" label={s.source} badge={String(s.cnt)} />
          ))}
        </>
      )}
    </>
  );
}

function TasksSidebar() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [tasks, setTasks] = useState<LocalTask[]>([]);

  useEffect(() => {
    window.noma?.db?.tasks.list({ status: "running" }).then((list) => {
      setTasks(list.slice(0, 8)); // Show up to 8 running tasks
    });
  }, []);

  // Refresh on task creation
  useEffect(() => {
    const noma = window.noma;
    if (!noma?.onTaskCreated) return;
    const unsub = noma.onTaskCreated(() => {
      noma.db?.tasks.list({ status: "running" }).then((list) => {
        setTasks(list.slice(0, 8));
      });
    });
    return unsub;
  }, []);

  return (
    <>
      {tasks.length > 0 && (
        <>
          <div className="sb-section-title">{t("nav.active")}</div>
          {tasks.map((task) => (
            <MenuItem
              key={task.id}
              icon="◆"
              label={task.title}
              badge="●"
              badgeKind="live"
              onClick={() => navigate(`/tasks/${task.id}`)}
            />
          ))}
        </>
      )}
    </>
  );
}

function SidebarContent() {
  return (
    <Routes>
      <Route path="/new-chat" element={<ChatSidebar />} />
      <Route path="/chat" element={<ChatSidebar />} />
      <Route path="/inbox" element={<InboxSidebar />} />
      <Route path="/tasks/*" element={<TasksSidebar />} />
      <Route path="*" element={null} />
    </Routes>
  );
}

function TasksViewWithNav() {
  const navigate = useNavigate();
  return (
    <TasksView
      onOpenTask={(taskId) => navigate(`/tasks/${taskId}`)}
      onOpenSession={(sessionId) => navigate(`/chat`)}
    />
  );
}

function TaskDetailViewWithNav() {
  const navigate = useNavigate();
  const { taskId } = useParams();
  return <TaskDetailView taskId={taskId!} onBack={() => navigate("/tasks")} />;
}

function AppShell() {
  const { t } = useI18n();
  const { init, bridgeReady } = useChat();
  const [taskCount, setTaskCount] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);

  // Auto-initialize ACP bridge on mount
  useEffect(() => {
    if (!bridgeReady) {
      init();
    }
  }, []);

  // Load live badge counts
  const refreshBadges = useCallback(() => {
    const noma = window.noma;
    if (!noma?.db) return;
    noma.db.tasks.list({ status: "running" }).then((list) => setTaskCount(list.length));
    noma.db.events.inboxSummary().then((s) => setUnreadCount(s.unread));
  }, []);

  useEffect(() => {
    refreshBadges();
  }, [refreshBadges]);

  // Refresh on task creation / connector events
  useEffect(() => {
    const noma = window.noma;
    if (!noma) return;
    const unsubs: Array<() => void> = [];
    if (noma.onTaskCreated) unsubs.push(noma.onTaskCreated(() => refreshBadges()));
    if (noma.onConnectorEvent) unsubs.push(noma.onConnectorEvent(() => refreshBadges()));
    return () => unsubs.forEach((u) => u());
  }, [refreshBadges]);

  return (
    <div className="app-shell">
      <div className="titlebar-drag" />
      <aside className="app-sidebar">
        <div className="sb-header">
          <Logo />
          <div className="flex-1">
            <div style={{ fontSize: 13, fontWeight: 600 }}>Noma</div>
          </div>
        </div>

        <NavItem to="/chat" icon="💬" label={t("nav.chats")} />
        <NavItem to="/tasks" icon="📋" label={t("nav.tasks")} badge={taskCount > 0 ? String(taskCount) : undefined} />
        <NavItem to="/connectors" icon="🔌" label={t("nav.connectors")} />
        <NavItem to="/inbox" icon="📥" label={t("nav.inbox")} badge={unreadCount > 0 ? String(unreadCount) : undefined} />

        <div className="sb-divider" />
        <SidebarContent />

        <span className="flex-1" />
        <NavItem to="/settings" icon="⚙" label={t("nav.settings")} />
      </aside>

      <Routes>
        <Route path="/new-chat" element={<NewChatView />} />
        <Route path="/chat" element={<ChatView />} />
        <Route path="/connectors" element={<ConnectorsView />} />
        <Route path="/tasks" element={<TasksViewWithNav />} />
        <Route path="/tasks/:taskId" element={<TaskDetailViewWithNav />} />
        <Route path="/inbox" element={<InboxView />} />
        <Route path="/settings" element={<SettingsView />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
    </div>
  );
}

export default function App() {
  return <AppShell />;
}
