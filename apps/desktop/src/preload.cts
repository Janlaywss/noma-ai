const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("noma", {
  getBootstrap: () => ipcRenderer.invoke("system:getBootstrap"),
  runAcpSmoke: () => ipcRenderer.invoke("acp:runSmoke"),

  // ACP session management
  acp: {
    start: () => ipcRenderer.invoke("acp:start"),
    stop: () => ipcRenderer.invoke("acp:stop"),
    listSessions: () => ipcRenderer.invoke("acp:listSessions"),
    newSession: (cwd?: string) => ipcRenderer.invoke("acp:newSession", cwd),
    loadTranscript: (sessionId: string, cwd?: string) =>
      ipcRenderer.invoke("acp:loadTranscript", sessionId, cwd),
    prompt: (sessionId: string, text: string) =>
      ipcRenderer.invoke("acp:prompt", sessionId, text),
    cancel: (sessionId: string) => ipcRenderer.invoke("acp:cancel", sessionId),

    /** Subscribe to streamed agent events. Returns an unsubscribe function. */
    onStreamEvent: (
      callback: (data: { sessionId: string; event: unknown }) => void
    ) => {
      const handler = (
        _event: unknown,
        data: { sessionId: string; event: unknown }
      ) => {
        callback(data);
      };
      ipcRenderer.on("acp:streamEvent", handler);
      return () => {
        ipcRenderer.removeListener("acp:streamEvent", handler);
      };
    },
  },

  // Test-only: direct tool invocation (bypasses codex-acp LLM)
  test: {
    scheduleTask: (sessionId: string, input: Record<string, unknown>) =>
      ipcRenderer.invoke("test:scheduleTask", sessionId, input),
  },

  // Local SQLite task database
  db: {
    tasks: {
      list: (filter?: { status?: string }) =>
        ipcRenderer.invoke("db:tasks:list", filter),
      get: (id: string) => ipcRenderer.invoke("db:tasks:get", id),
      create: (input: Record<string, unknown>) =>
        ipcRenderer.invoke("db:tasks:create", input),
      update: (id: string, updates: Record<string, unknown>) =>
        ipcRenderer.invoke("db:tasks:update", id, updates),
      delete: (id: string) => ipcRenderer.invoke("db:tasks:delete", id),
    },
    sessions: {
      list: () => ipcRenderer.invoke("db:sessions:list"),
      get: (id: string) => ipcRenderer.invoke("db:sessions:get", id),
      create: (input: { id: string; title?: string; codexThreadId?: string }) =>
        ipcRenderer.invoke("db:sessions:create", input),
      update: (id: string, updates: { title?: string; codexThreadId?: string }) =>
        ipcRenderer.invoke("db:sessions:update", id, updates),
      delete: (id: string) => ipcRenderer.invoke("db:sessions:delete", id),
    },
    messages: {
      list: (sessionId: string) => ipcRenderer.invoke("db:messages:list", sessionId),
      append: (input: {
        id: string;
        sessionId: string;
        role: string;
        content: string;
        segments?: unknown[];
        toolCalls?: unknown[];
      }) => ipcRenderer.invoke("db:messages:append", input),
      update: (messageId: string, updates: {
        content?: string;
        segments?: unknown[];
        toolCalls?: unknown[];
      }) => ipcRenderer.invoke("db:messages:update", messageId, updates),
    },
    events: {
      listByTask: (taskId: string, opts?: { limit?: number }) =>
        ipcRenderer.invoke("db:events:listByTask", taskId, opts),
      listBySource: (source: string, opts?: { limit?: number }) =>
        ipcRenderer.invoke("db:events:listBySource", source, opts),
      list: (opts?: { source?: string; unreadOnly?: boolean; limit?: number }) =>
        ipcRenderer.invoke("db:events:list", opts),
      markConsumed: (ids: string[]) =>
        ipcRenderer.invoke("db:events:markConsumed", ids),
      inboxSummary: () => ipcRenderer.invoke("db:events:inboxSummary"),
    },
    connectors: {
      summary: () => ipcRenderer.invoke("db:connectors:summary"),
      tasks: (connectorName: string) =>
        ipcRenderer.invoke("db:connectors:tasks", connectorName),
    },
    connectorUsages: {
      listByTask: (taskId: string) =>
        ipcRenderer.invoke("db:connectorUsages:listByTask", taskId),
    },
    connectorConfig: {
      get: (connectorName: string) =>
        ipcRenderer.invoke("connector:config:get", connectorName),
      save: (connectorName: string, config: Record<string, string>) =>
        ipcRenderer.invoke("connector:config:save", connectorName, config),
      delete: (connectorName: string) =>
        ipcRenderer.invoke("connector:config:delete", connectorName),
    },
    oauth: {
      init: (connectorName: string) =>
        ipcRenderer.invoke("connector:oauth:init", connectorName),
      status: (connectorName: string) =>
        ipcRenderer.invoke("connector:oauth:status", connectorName),
    },
    clearData: {
      counts: () => ipcRenderer.invoke("db:clearData:counts"),
      execute: (opts: { tasks?: boolean; sessions?: boolean; events?: boolean }) =>
        ipcRenderer.invoke("db:clearData", opts),
    },
  },

  // ── Task events (push from main → renderer) ────────────────

  /** Subscribe to proactive messages from task connectors. */
  onProactiveMessage: (
    callback: (data: {
      sessionId: string;
      message: string;
      level: "info" | "nudge" | "alert";
      timestamp: string;
    }) => void
  ) => {
    const handler = (_event: unknown, data: unknown) => {
      callback(
        data as {
          sessionId: string;
          message: string;
          level: "info" | "nudge" | "alert";
          timestamp: string;
        }
      );
    };
    ipcRenderer.on("task:proactiveMessage", handler);
    return () => {
      ipcRenderer.removeListener("task:proactiveMessage", handler);
    };
  },

  /** Subscribe to task creation events (from agent tool calls). */
  onTaskCreated: (
    callback: (data: {
      taskId: string;
      sessionId: string;
      title: string;
      connectors: string[];
    }) => void
  ) => {
    const handler = (_event: unknown, data: unknown) => {
      callback(
        data as {
          taskId: string;
          sessionId: string;
          title: string;
          connectors: string[];
        }
      );
    };
    ipcRenderer.on("task:created", handler);
    return () => {
      ipcRenderer.removeListener("task:created", handler);
    };
  },

  /** Subscribe to live connector events (for real-time UI updates). */
  onConnectorEvent: (
    callback: (data: {
      source: string;
      type: string;
      payload: unknown;
      timestamp: string;
    }) => void
  ) => {
    const handler = (_event: unknown, data: unknown) => {
      callback(
        data as {
          source: string;
          type: string;
          payload: unknown;
          timestamp: string;
        }
      );
    };
    ipcRenderer.on("task:connectorEvent", handler);
    return () => {
      ipcRenderer.removeListener("task:connectorEvent", handler);
    };
  },
});
