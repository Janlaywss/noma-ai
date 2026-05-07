import { app } from "electron";
import os from "node:os";
import path from "node:path";
import {
  findMcpToolsBin,
  resolveCodexBinary,
  startCodex,
  startLlmProxy,
  type AcpTranscriptItem,
  type CodexHandle,
} from "@noma/agent";
import { MODELS } from "@noma/shared";
import { getAgentModel } from "./model-config.js";

export type AcpSmokeReport = {
  ok: boolean;
  serverUrl: string;
  model: string;
  cwd: string;
  sessionId?: string;
  sessionsBefore: SmokeSessionInfo[];
  sessionsAfterNew: SmokeSessionInfo[];
  sessionsAfterPrompt: SmokeSessionInfo[];
  promptTranscript: AcpTranscriptItem[];
  loadedTranscript: AcpTranscriptItem[];
  assistantText: string;
  stopReason?: string;
  error?: string;
};

export type SmokeSessionInfo = {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
};

type SmokeOptions = {
  prompt?: string;
  expectedText?: string;
  serverUrl?: string;
  model?: string;
  cwd?: string;
  codexHome?: string;
};

const DEFAULT_EXPECTED = "NOMA_ACP_SMOKE_OK";

export async function runAcpSmoke(options: SmokeOptions = {}): Promise<AcpSmokeReport> {
  const serverUrl = normalizeUrl(
    options.serverUrl ?? process.env.NOMA_SERVER_URL ?? "http://127.0.0.1:3677"
  );
  const model = options.model ?? getAgentModel();
  const cwd = path.resolve(
    options.cwd ?? process.env.NOMA_WORKSPACE_DIR ?? path.join(app.getAppPath(), "../..")
  );
  const expectedText =
    options.expectedText ?? process.env.NOMA_ACP_SMOKE_EXPECTED ?? DEFAULT_EXPECTED;
  const prompt =
    options.prompt ??
    process.env.NOMA_ACP_SMOKE_PROMPT ??
    `请只回复 ${expectedText}，不要解释，不要调用工具。`;

  const emptyReport = (): AcpSmokeReport => ({
    ok: false,
    serverUrl,
    model,
    cwd,
    sessionsBefore: [],
    sessionsAfterNew: [],
    sessionsAfterPrompt: [],
    promptTranscript: [],
    loadedTranscript: [],
    assistantText: "",
  });

  const binary = resolveCodexBinary();
  if (!binary) {
    return {
      ...emptyReport(),
      error: "未找到 codex-acp 二进制，请先安装 @zed-industries/codex-acp。",
    };
  }

  let llmProxy: Awaited<ReturnType<typeof startLlmProxy>> | undefined;
  let codex: CodexHandle | undefined;
  try {
    llmProxy = await startLlmProxy(async ({ method, path: upstreamPath, headers, body }) => {
      const url = `${serverUrl}/api${upstreamPath.startsWith("/v1/") ? upstreamPath : `/v1${upstreamPath}`}`;
      return fetch(url, {
        method,
        headers,
        body: body as BodyInit | undefined,
      });
    });

    codex = await startCodex({
      binary,
      model,
      codexHome:
        options.codexHome ??
        process.env.NOMA_ACP_SMOKE_CODEX_HOME ??
        path.join(app.getPath("userData"), "codex-acp-smoke"),
      instructions: `你正在执行 Noma AI 桌面端 ACP 对话 smoke test。除非用户另有要求，只输出 ${expectedText}。`,
      llmProxyUrl: llmProxy.url,
      mcpBridge: {
        url: "http://127.0.0.1:9",
        token: "acp-smoke",
      },
      mcpToolsBin: findMcpToolsBin(cwd) ?? undefined,
      modelCatalog: MODELS,
    });

    const sessionsBefore = await codex.bridge.listSessions({ cwd });
    const sessionId = await codex.bridge.newSession(cwd);
    const sessionsAfterNew = await codex.bridge.listSessions({ cwd });
    const promptResult = await codex.bridge.promptWithTranscript(sessionId, prompt, {
      onEvent: () => {},
      onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
    });
    const sessionsAfterPrompt = await codex.bridge.listSessions({ cwd });
    const loaded = await codex.bridge.loadSessionTranscript(cwd, sessionId);
    const assistantText = promptResult.transcript
      .filter((item) => item.kind === "agent")
      .map((item) => item.text)
      .join("");

    return {
      ok: assistantText.includes(expectedText),
      serverUrl,
      model,
      cwd,
      sessionId,
      sessionsBefore: sessionsBefore.sessions.map(toSmokeSession),
      sessionsAfterNew: sessionsAfterNew.sessions.map(toSmokeSession),
      sessionsAfterPrompt: sessionsAfterPrompt.sessions.map(toSmokeSession),
      promptTranscript: promptResult.transcript,
      loadedTranscript: loaded.transcript,
      assistantText,
      stopReason: promptResult.response.stopReason,
      error: assistantText.includes(expectedText)
        ? undefined
        : `回复中未包含期望文本 ${expectedText}`,
    };
  } catch (err) {
    return {
      ...emptyReport(),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await codex?.stop().catch(() => {});
    await llmProxy?.stop().catch(() => {});
  }
}

function normalizeUrl(value: string): string {
  return value.replace(/\/$/, "");
}

function toSmokeSession(session: {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
}): SmokeSessionInfo {
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    title: session.title,
    updatedAt: session.updatedAt,
  };
}

export function defaultSmokeCdpPort(): number {
  return Number(process.env.NOMA_ACP_SMOKE_CDP_PORT ?? 9339);
}

export function defaultSmokeServerPort(): number {
  return Number(process.env.NOMA_ACP_SMOKE_SERVER_PORT ?? 3679);
}

export function defaultSmokeCodexHome(): string {
  return path.join(os.tmpdir(), "noma-acp-smoke-codex-home");
}
