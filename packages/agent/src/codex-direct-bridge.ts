/**
 * CodexDirectBridge — drives the codex CLI directly (bypassing codex-acp).
 *
 * codex-acp 0.13.0 strips MCP-derived tools from the ACP protocol, so
 * the LLM never sees scheduleTask/list_connectors etc. This bridge uses
 * `codex exec --json` which DOES expose MCP tools as callable functions.
 *
 * JSONL event format from `codex exec --json`:
 *   { type: "thread.started", thread_id: "..." }
 *   { type: "turn.started" }
 *   { type: "item.started", item: { id, type, ... } }
 *   { type: "item.completed", item: { id, type, text?, result?, error?, ... } }
 *   { type: "turn.completed", usage: { ... } }
 *
 * Item types:
 *   - "agent_message"  → { text: string }
 *   - "mcp_tool_call"  → { server, tool, arguments, result, error, status }
 *   - "tool_call"      → { command, result, error, status }
 *   - "reasoning"      → { text: string }
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { AgentRunEvent, AgentToolCallSnapshot } from "@noma/event-agent";
import type { PromptCallbacks } from "./acp-bridge.js";
import crypto from "node:crypto";

export type CodexDirectConfig = {
  /** Path to the system codex binary (NOT codex-acp). */
  codexBin: string;
  /** Model slug to use. */
  model: string;
  /** Extra env vars for the codex subprocess. */
  env?: Record<string, string | undefined>;
  /** Default working directory. */
  cwd?: string;
};

export type CodexPromptResponse = {
  stopReason: string;
};

/**
 * Bridge that spawns `codex exec --json` for each prompt turn.
 *
 * For the first prompt in a session, it creates a new session.
 * For subsequent prompts, it uses `codex exec resume <sessionId>`.
 */
export class CodexDirectBridge {
  private currentProc: ChildProcess | null = null;
  /** Maps our session IDs to codex thread IDs (assigned by codex on first prompt). */
  private sessionThreads = new Map<string, string>();

  constructor(private readonly config: CodexDirectConfig) {}

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async start(): Promise<void> {}

  isRunning(): boolean {
    return true;
  }

  /** Check if a codex thread ID is stored for this session. */
  hasThread(sessionId: string): boolean {
    return this.sessionThreads.has(sessionId);
  }

  /** Get the codex thread ID for a session. */
  getThread(sessionId: string): string | undefined {
    return this.sessionThreads.get(sessionId);
  }

  /** Restore a codex thread ID (e.g. from persisted DB). */
  setThread(sessionId: string, threadId: string): void {
    this.sessionThreads.set(sessionId, threadId);
  }

  async newSession(_cwd?: string): Promise<string> {
    return crypto.randomUUID();
  }

  async listSessions(): Promise<{ sessions: Array<{ id: string }> }> {
    // codex exec doesn't have a list-sessions command in exec mode;
    // sessions are managed at the desktop app level.
    return { sessions: [] };
  }

  async loadSessionTranscript(
    _cwd: string,
    _sessionId: string
  ): Promise<{ transcript: unknown[] }> {
    // Not implemented for direct bridge — transcripts are managed by the desktop app.
    return { transcript: [] };
  }

  async prompt(
    sessionId: string,
    text: string,
    callbacks: { onEvent: (event: AgentRunEvent) => void }
  ): Promise<CodexPromptResponse> {
    const threadId = this.sessionThreads.get(sessionId);
    const isResume = threadId != null;

    const args: string[] = ["exec"];

    if (isResume) {
      // Resume existing session
      // Note: `codex exec resume` does NOT accept -C; spawn's cwd handles it.
      args.push("resume", "--json", "--dangerously-bypass-approvals-and-sandbox");
      args.push("--skip-git-repo-check");
      args.push(threadId, text);
    } else {
      // New session
      // Do NOT pass -m here — the model is set in config.toml along with
      // the custom model_provider. Passing -m causes codex to bypass
      // the custom provider and route the request to the default (ChatGPT).
      args.push("--json", "--dangerously-bypass-approvals-and-sandbox");
      args.push("--skip-git-repo-check");
      if (this.config.cwd) args.push("-C", this.config.cwd);
      args.push(text);
    }

    return new Promise<CodexPromptResponse>((resolve, reject) => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        ...this.config.env,
      };

      const proc = spawn(this.config.codexBin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: env as NodeJS.ProcessEnv,
        cwd: this.config.cwd,
      });
      proc.stdin?.end();
      this.currentProc = proc;

      let cumulativeText = "";
      let stopReason = "end_turn";
      let errOutput = "";

      // ── stderr → log ────────────────
      const STDERR_NOISE = [
        "TSM Adjust",
        "IMKCFRunLoop",
        "Reading additional input from stdin",
      ];
      proc.stderr?.on("data", (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line && !STDERR_NOISE.some((n) => line.includes(n))) {
          errOutput += line + "\n";
          console.log(`[codex:err] ${line}`);
        }
      });

      // ── stdout → JSONL parser ───────
      const rl: ReadlineInterface = createInterface({
        input: proc.stdout!,
        crlfDelay: Infinity,
      });

      rl.on("line", (line: string) => {
        if (!line.trim()) return;
        let evt: CodexJsonlEvent;
        try {
          evt = JSON.parse(line);
        } catch {
          return;
        }

        switch (evt.type) {
          case "thread.started": {
            // Capture the real thread ID for future resume
            if (evt.thread_id) {
              this.sessionThreads.set(sessionId, evt.thread_id);
            }
            break;
          }

          case "item.started": {
            const item = evt.item;
            if (!item) break;

            if (item.type === "mcp_tool_call" || item.type === "tool_call") {
              const toolName =
                item.type === "mcp_tool_call"
                  ? `mcp_${item.tool}`
                  : item.command?.join(" ") ?? "exec_command";
              const snapshot: AgentToolCallSnapshot = {
                toolCallId: item.id ?? `tool_${Date.now()}`,
                toolName,
                state: "input-available",
                input: item.arguments ?? {},
              };
              callbacks.onEvent({ kind: "tool", payload: snapshot });
            }
            break;
          }

          case "item.completed": {
            const item = evt.item;
            if (!item) break;

            if (item.type === "agent_message" && item.text) {
              cumulativeText += item.text;
              callbacks.onEvent({
                kind: "text",
                delta: item.text,
                cumulative: cumulativeText,
              });
            } else if (item.type === "reasoning" && item.text) {
              callbacks.onEvent({
                kind: "thought",
                content: item.text,
              });
            } else if (
              item.type === "mcp_tool_call" ||
              item.type === "tool_call"
            ) {
              const toolName =
                item.type === "mcp_tool_call"
                  ? `mcp_${item.tool}`
                  : item.command?.join(" ") ?? "exec_command";

              const hasError = item.error != null || item.status === "failed";
              const snapshot: AgentToolCallSnapshot = {
                toolCallId: item.id ?? `tool_${Date.now()}`,
                toolName,
                state: hasError ? "output-error" : "output-available",
                input: item.arguments ?? {},
                output: hasError ? item.error : item.result,
                errorText: hasError
                  ? item.error?.message ?? JSON.stringify(item.error)
                  : undefined,
              };
              callbacks.onEvent({ kind: "tool", payload: snapshot });
            }
            break;
          }

          case "turn.completed": {
            if (evt.usage) {
              // We could emit usage info here if needed
            }
            break;
          }
        }
      });

      proc.on("close", (code: number | null) => {
        this.currentProc = null;
        if (code !== 0 && code !== null) {
          stopReason = "error";
          // If we got no text at all, emit the error
          if (!cumulativeText) {
            callbacks.onEvent({
              kind: "error",
              message: errOutput || `codex exited with code ${code}`,
            });
          }
        }
        resolve({ stopReason });
      });

      proc.on("error", (err: Error) => {
        this.currentProc = null;
        reject(err);
      });
    });
  }

  async cancel(_sessionId: string): Promise<void> {
    if (this.currentProc) {
      this.currentProc.kill("SIGTERM");
      // Give it 2s, then force kill
      const proc = this.currentProc;
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, 2000);
    }
  }

  async stop(): Promise<void> {
    if (this.currentProc) {
      this.currentProc.kill("SIGTERM");
      this.currentProc = null;
    }
    this.sessionThreads.clear();
  }
}

// ── JSONL event types from `codex exec --json` ──────────

type CodexJsonlEvent =
  | { type: "thread.started"; thread_id?: string }
  | { type: "turn.started" }
  | { type: "item.started"; item?: CodexItemPayload }
  | { type: "item.completed"; item?: CodexItemPayload }
  | {
      type: "turn.completed";
      usage?: { input_tokens?: number; output_tokens?: number };
    };

type CodexItemPayload = {
  id?: string;
  type: string;
  // agent_message / reasoning
  text?: string;
  // mcp_tool_call
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  result?: { content?: Array<{ type: string; text: string }> } | null;
  error?: { message?: string } | null;
  status?: string;
  // tool_call (exec_command)
  command?: string[];
};
