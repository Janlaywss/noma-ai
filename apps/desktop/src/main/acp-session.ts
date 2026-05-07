/**
 * ACP session management IPC module.
 *
 * Registers IPC handlers for the renderer to drive the ACP agent bridge:
 * - acp:start — spawns the ACP agent subprocess WITH MCP tool surface
 * - acp:listSessions — returns all persisted sessions
 * - acp:newSession — creates a new session
 * - acp:loadTranscript — loads existing session transcript
 * - acp:prompt — sends a user message; streams AgentRunEvents back
 * - acp:cancel — cancels an in-flight prompt
 * - acp:stop — tears down the subprocess
 *
 * The key integration: this module starts a local MCP bridge that routes
 * tool calls (scheduleTask, notify, list_connectors, task_complete) back
 * to the TaskManager. This completes the loop:
 *
 *   user prompt → LLM decides to create task → scheduleTask tool →
 *   MCP bridge → TaskManager → create task + claim connectors →
 *   ConnectorRuntime hot-reload → connector events → proactive message
 *   back to the user's session
 */

import { ipcMain, BrowserWindow } from "electron";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  CodexDirectBridge,
  startMcpBridge,
  findMcpToolsBin,
  type McpBridgeHandle,
} from "@noma/agent";
import {
  createAgentToolSet,
  buildAgentPrompt,
  type ScheduleTaskInput,
  type NotifyInput,
  type TaskCompleteInput,
  type BuiltinConnector,
} from "@noma/event-agent";
import { featuredConnectorNames, CONNECTOR_REGISTRY } from "@noma/connector";
import { getTaskManager } from "./task-manager.js";

let bridge: CodexDirectBridge | null = null;
let mcpBridgeHandle: McpBridgeHandle | null = null;

/** Tracks which session is currently active (for tool calls). */
let activeSessionId: string | null = null;

function getMainWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows();
  return wins.length > 0 ? wins[0] : null;
}

export function registerAcpSessionHandlers(config: {
  acpBinary?: string | null;
  serverUrl: string;
}): void {
  ipcMain.handle("acp:start", async () => {
    if (bridge?.isRunning()) return { ok: true, already: true };

    const apiKey =
      process.env.OPENAI_API_KEY ??
      process.env.NOMA_API_KEY ??
      "sk-noma-local";

    const codexHome = path.join(os.homedir(), ".noma", "codex");

    // ── Start MCP bridge FIRST (we need the URL for config) ──
    const toolSet = createDesktopToolSet();
    mcpBridgeHandle = await startMcpBridge(toolSet, "desktop");
    const mcpAddr = mcpBridgeHandle.address;

    // ── Resolve mcp-tools binary ─────────────────────────────
    const mcpToolsBin =
      process.env.NOMA_MCP_TOOLS_BIN?.trim() ||
      findMcpToolsBin(path.resolve(codexHome, "../../..")) ||
      findMcpToolsBin(process.cwd());
    const nodeBin = findNodeBinary();

    // ── Write config.toml WITH MCP server (codex reads it at startup) ──
    const mcpServerConfig = mcpToolsBin && nodeBin && fs.existsSync(mcpToolsBin)
      ? { command: nodeBin, args: [mcpToolsBin], env: { NOMA_BRIDGE_URL: mcpAddr.url, NOMA_BRIDGE_TOKEN: mcpAddr.token } }
      : null;
    ensureCodexConfig(codexHome, config.serverUrl, apiKey, mcpServerConfig);

    if (mcpServerConfig) {
      console.log(`[acp] MCP tools wired: ${mcpToolsBin} (node: ${nodeBin})`);
    } else {
      console.warn("[acp] mcp-tools binary not found; agent will have no tool surface");
    }

    // ── Resolve system codex binary ─────────────────────────
    // We use the system codex CLI directly instead of codex-acp because
    // codex-acp 0.13.0 does not expose MCP-derived tools (scheduleTask,
    // list_connectors, etc.) through the ACP protocol. The codex CLI
    // properly registers MCP tools as callable functions.
    const codexBin = findCodexBinary();
    if (!codexBin) {
      if (mcpBridgeHandle) {
        await mcpBridgeHandle.stop();
        mcpBridgeHandle = null;
      }
      return { ok: false, error: "codex CLI not found (install: npm i -g @openai/codex)" };
    }

    // ── Create direct bridge ────────────────────────────────
    bridge = new CodexDirectBridge({
      codexBin,
      model: MODEL,
      env: {
        CODEX_HOME: codexHome,
        OPENAI_API_KEY: apiKey,
        CODEX_API_KEY: apiKey,
      },
      cwd: os.homedir(),
    });

    console.log(`[acp] Using codex CLI directly: ${codexBin}`);
    return { ok: true };
  });

  ipcMain.handle("acp:stop", async () => {
    if (bridge) {
      await bridge.stop();
      bridge = null;
    }
    if (mcpBridgeHandle) {
      await mcpBridgeHandle.stop();
      mcpBridgeHandle = null;
    }
    return { ok: true };
  });

  ipcMain.handle("acp:listSessions", async () => {
    if (!bridge?.isRunning()) return { ok: false, error: "Bridge not started" };
    try {
      const result = await bridge.listSessions();
      return { ok: true, sessions: result.sessions ?? [] };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle("acp:newSession", async (_event, cwd?: string) => {
    if (!bridge?.isRunning()) return { ok: false, error: "Bridge not started" };
    try {
      const sessionId = await bridge.newSession(cwd ?? os.homedir());
      return { ok: true, sessionId };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(
    "acp:loadTranscript",
    async (_event, sessionId: string, cwd?: string) => {
      if (!bridge?.isRunning())
        return { ok: false, error: "Bridge not started" };
      try {
        const loaded = await bridge.loadSessionTranscript(
          cwd ?? os.homedir(),
          sessionId
        );
        return { ok: true, transcript: loaded.transcript };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  );

  ipcMain.handle(
    "acp:prompt",
    async (_event, sessionId: string, text: string) => {
      if (!bridge?.isRunning())
        return { ok: false, error: "Bridge not started" };
      const win = getMainWindow();

      // Track active session so tool handlers know which session triggered them
      activeSessionId = sessionId;

      // Check if there's a stored codex thread ID to resume from
      try {
        const db = (await import("./db/index.js")).getDb();
        const row = db.prepare(
          "SELECT codex_thread_id FROM chat_sessions WHERE id = ?"
        ).get(sessionId) as { codex_thread_id: string | null } | undefined;
        if (row?.codex_thread_id && !bridge.hasThread(sessionId)) {
          bridge.setThread(sessionId, row.codex_thread_id);
        }
      } catch { /* ignore — DB might not have the session yet */ }

      try {
        const response = await bridge.prompt(sessionId, text, {
          onEvent: (evt) => {
            if (win && !win.isDestroyed()) {
              win.webContents.send("acp:streamEvent", {
                sessionId,
                event: evt,
              });
            }
          },
        });

        // Persist the codex thread ID back to the DB after prompt completes
        try {
          const threadId = bridge.getThread(sessionId);
          if (threadId) {
            const db = (await import("./db/index.js")).getDb();
            db.prepare(
              "UPDATE chat_sessions SET codex_thread_id = ? WHERE id = ?"
            ).run(threadId, sessionId);
          }
        } catch { /* best-effort persist */ }

        // Signal turn completion
        if (win && !win.isDestroyed()) {
          win.webContents.send("acp:streamEvent", {
            sessionId,
            event: { kind: "done", cumulative: "" },
          });
        }
        return { ok: true, stopReason: response.stopReason };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (win && !win.isDestroyed()) {
          win.webContents.send("acp:streamEvent", {
            sessionId,
            event: { kind: "error", message: errMsg },
          });
        }
        return { ok: false, error: errMsg };
      } finally {
        activeSessionId = null;
      }
    }
  );

  ipcMain.handle("acp:cancel", async (_event, sessionId: string) => {
    if (!bridge?.isRunning()) return { ok: false, error: "Bridge not started" };
    try {
      await bridge.cancel(sessionId);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // ── Test-only: direct tool invocation (bypasses LLM) ──────
  ipcMain.handle(
    "test:scheduleTask",
    async (
      _event,
      sessionId: string,
      input: { title: string; prompt: string; kind: string; connectors: Array<{ name: string; params?: Record<string, unknown> }> }
    ) => {
      try {
        const taskManager = getTaskManager();
        const result = await taskManager.createTaskFromSession(sessionId, {
          title: input.title,
          prompt: input.prompt,
          kind: input.kind as "event",
          connectors: input.connectors,
        });
        // Notify renderer
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send("task:created", {
            taskId: result.taskId,
            sessionId,
            title: input.title,
            connectors: input.connectors.map((c) => c.name),
          });
        }
        return { ok: true, taskId: result.taskId, usages: result.connectorUsages };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}

// ── Desktop tool set ─────────────────────────────────────

/**
 * Create the AgentToolSet that backs the MCP bridge. This is where the
 * full loop is wired:
 *
 *   LLM calls scheduleTask → tool handler here → TaskManager creates task
 *   + claims connectors → ConnectorRuntime hot-reloads → events flow back
 */
function createDesktopToolSet() {
  const connectorCatalog: BuiltinConnector[] = featuredConnectorNames().map((name: string) => {
    const d = CONNECTOR_REGISTRY[name];
    return {
      name,
      label: d.label,
      description: d.description,
      configSchema: d.configSchema.map((f) => ({
        key: f.key,
        type: f.type,
        secret: f.secret,
        taskRequired: f.taskRequired,
        min: f.min,
        max: f.max,
      })),
      defaults: d.defaults as Record<string, unknown>,
    };
  });

  return createAgentToolSet({
    connectors: connectorCatalog,

    scheduleTask: async (input: ScheduleTaskInput) => {
      const sessionId = activeSessionId;
      if (!sessionId) {
        return "scheduleTask failed: no active session context";
      }

      try {
        const taskManager = getTaskManager();
        const result = await taskManager.createTaskFromSession(sessionId, {
          title: input.title,
          prompt: input.prompt,
          kind: input.kind,
          connectors: input.connectors,
        });

        // Notify the renderer that a new task was created
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send("task:created", {
            taskId: result.taskId,
            sessionId,
            title: input.title,
            connectors: input.connectors.map((c: { name: string }) => c.name),
          });
        }

        return `Task created successfully: "${input.title}" (id: ${result.taskId}). ` +
          `Claimed connectors: ${input.connectors.map((c: { name: string }) => c.name).join(", ")}. ` +
          `The task is now running and will send you updates in this conversation.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `scheduleTask failed: ${msg}`;
      }
    },

    notify: (input: NotifyInput) => {
      const sessionId = activeSessionId;
      if (!sessionId) return "notify: no active session";

      const taskManager = getTaskManager();
      taskManager.sendProactiveMessage(sessionId, input.message, input.level);
      return `notification sent (level=${input.level ?? "info"})`;
    },

    taskComplete: (input: TaskCompleteInput) => {
      // For now just acknowledge — in the future this could mark the task as done
      console.log(`[task-complete] ${input.summary}`);
      return `task completed: ${input.summary}`;
    },
  });
}

// ── Codex config generation ─────────────────────────────────

const MODEL = process.env.NOMA_AGENT_MODEL ?? "anthropic/claude-sonnet-4-20250514";

function ensureCodexConfig(
  codexHome: string,
  serverUrl: string,
  _apiKey: string,
  mcpServer?: { command: string; args: string[]; env: Record<string, string> } | null
): void {
  fs.mkdirSync(codexHome, { recursive: true });

  const baseUrl = `${serverUrl}/api/v1`;
  const catalogPath = path.join(codexHome, "model-catalog.json");
  const instructionsPath = path.join(codexHome, "instructions.md");

  // Write system instructions so codex-acp knows about the Noma tool surface
  const instructions = buildAgentPrompt({ locale: "zh-CN" });
  fs.writeFileSync(instructionsPath, instructions);

  // Build MCP server TOML section (codex reads this at startup to register tools)
  let mcpSection = "";
  if (mcpServer) {
    const argsToml = mcpServer.args.map((a) => `"${a}"`).join(", ");
    mcpSection = `\n[mcp_servers.noma]\ncommand = "${mcpServer.command}"\nargs = [${argsToml}]\n`;
    const envEntries = Object.entries(mcpServer.env);
    if (envEntries.length > 0) {
      mcpSection += `\n[mcp_servers.noma.env]\n`;
      for (const [k, v] of envEntries) {
        mcpSection += `${k} = "${v}"\n`;
      }
    }
  }

  // Write config.toml
  const toml = `model = "${MODEL}"
model_provider = "noma"
model_catalog_json = "${catalogPath}"
model_instructions_file = "${instructionsPath}"

[model_providers.noma]
name = "Noma LLM Proxy"
base_url = "${baseUrl}"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
supports_websockets = false
${mcpSection}`;
  fs.writeFileSync(path.join(codexHome, "config.toml"), toml);

  // Write model-catalog.json
  const catalog = {
    models: [
      {
        slug: MODEL,
        display_name: "Claude Sonnet",
        description: "Noma model",
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast responses" },
          { effort: "medium", description: "Balanced reasoning" },
          { effort: "high", description: "Deep reasoning" },
        ],
        shell_type: "default",
        visibility: "list",
        supported_in_api: true,
        priority: 1,
        additional_speed_tiers: [],
        service_tiers: [],
        availability_nux: null,
        upgrade: null,
        base_instructions: "You are a helpful assistant.",
        model_messages: {
          instructions_template:
            "You are a helpful assistant.\n\n{{ personality }}",
          instructions_variables: {
            personality_default: "",
            personality_friendly: "Be friendly and concise.",
            personality_pragmatic: "Be direct and concise.",
          },
        },
        supports_reasoning_summaries: false,
        default_reasoning_summary: "none",
        support_verbosity: false,
        default_verbosity: null,
        apply_patch_tool_type: "freeform",
        truncation_policy: { mode: "tokens", limit: 200000 },
        supports_parallel_tool_calls: true,
        supports_image_detail_original: false,
        context_window: 200000,
        max_context_window: 200000,
        auto_compact_token_limit: 180000,
        effective_context_window_percent: 95,
        experimental_supported_tools: [],
        input_modalities: ["text", "image"],
        supports_search_tool: false,
      },
    ],
  };
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
}

/**
 * Find a usable Node.js binary. In Electron, process.execPath is the
 * Electron binary; we need a real node binary so codex-acp can spawn
 * the MCP tools subprocess independently.
 */
import { execSync } from "node:child_process";

function findNodeBinary(): string | null {
  // 1. Explicit env override
  const fromEnv = process.env.NOMA_NODE_BIN?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  // 2. If not running inside Electron, process.execPath is node itself
  if (!process.versions.electron) return process.execPath;

  // 3. Try `which node` from system PATH
  try {
    const nodePath = execSync("which node", { encoding: "utf8" }).trim();
    if (nodePath && fs.existsSync(nodePath)) return nodePath;
  } catch {}

  // 4. Common nvm/volta/brew locations
  const candidates = [
    path.join(os.homedir(), ".nvm/versions/node", `v${process.versions.node}`, "bin/node"),
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  console.warn("[acp] Could not find system node binary for MCP subprocess");
  return null;
}

/**
 * Find the system codex CLI binary. We need the REAL codex (not codex-acp)
 * because only the codex CLI properly exposes MCP-derived tools.
 */
function findCodexBinary(): string | null {
  // 1. Explicit env override
  const fromEnv = process.env.NOMA_CODEX_BIN?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  // 2. Try `which codex` from system PATH
  try {
    const codexPath = execSync("which codex", { encoding: "utf8" }).trim();
    if (codexPath && fs.existsSync(codexPath)) return codexPath;
  } catch {}

  // 3. Common global install locations
  const candidates = [
    path.join(os.homedir(), ".nvm/versions/node", `v${process.versions.node}`, "bin/codex"),
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  console.warn("[acp] Could not find system codex binary");
  return null;
}
