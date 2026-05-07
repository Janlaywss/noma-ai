import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { featuredConnectorNames, CONNECTOR_REGISTRY } from "@noma/connector";
import { resolveCodexBinary } from "@noma/agent";
import { runAcpSmoke } from "./main/acp-smoke.js";
import { registerAcpSessionHandlers } from "./main/acp-session.js";
import { closeDb } from "./main/db/index.js";
import { registerTaskHandlers } from "./main/db/tasks.js";
import { registerSessionHandlers } from "./main/db/sessions.js";
import { initTaskManager } from "./main/task-manager.js";
import { registerConnectorConfigHandlers } from "./main/db/connector-config.js";
import { registerSettingsHandlers } from "./main/db/settings.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

function getMainWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows();
  return wins.length > 0 ? wins[0] : null;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "Noma AI",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: "#f7f8fb",
    webPreferences: {
      preload: path.join(currentDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(currentDir, "../dist/index.html"));
  }
}

ipcMain.handle("system:getBootstrap", () => {
  const acpBinary = resolveCodexBinary();
  return {
    acp: {
      available: Boolean(acpBinary),
      binary: acpBinary,
    },
    server: {
      defaultUrl: process.env.NOMA_SERVER_URL ?? "http://localhost:3677",
    },
    connectors: featuredConnectorNames().map((name) => {
      const descriptor = CONNECTOR_REGISTRY[name];
      return {
        name,
        label: descriptor?.label ?? name,
        description: descriptor?.description ?? "",
        configSchema: descriptor?.configSchema ?? [],
        tools: descriptor?.tools?.map((tool) => tool.schema.name) ?? [],
      };
    }),
  };
});

ipcMain.handle("acp:runSmoke", async () => runAcpSmoke());

// ── Initialize Task Manager ──────────────────────────────────
const taskManager = initTaskManager({ getMainWindow });

// Register ACP session IPC handlers (with MCP bridge for tool surface)
const acpBinary = resolveCodexBinary();
registerAcpSessionHandlers({
  acpBinary,
  serverUrl: process.env.NOMA_SERVER_URL ?? "http://localhost:3677",
});

// Register local SQLite task handlers
registerTaskHandlers();

// Register chat session persistence handlers
registerSessionHandlers();

// Register connector config handlers (OAuth + storage sync)
registerConnectorConfigHandlers();

// Register settings handlers
registerSettingsHandlers();

app.whenReady().then(async () => {
  createWindow();

  // Boot connector runtime for already-running tasks
  try {
    await taskManager.bootRunningTasks();
  } catch (err) {
    console.warn("[main] Failed to boot running tasks:", err);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  closeDb();
});
