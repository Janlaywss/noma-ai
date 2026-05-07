import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { AcpAgentBridge, type AcpMcpServerConfig } from "./acp-bridge.js";
import type { McpBridgeAddress } from "./mcp-bridge.js";

export type CodexConfig = {
  /** Absolute path to the codex-acp binary. */
  binary: string;
  /** Model id to write into config.toml (e.g. "google/gemini-3.1-flash-lite-preview"). */
  model: string;
  /** Directory to use as CODEX_HOME. Created if missing. */
  codexHome: string;
  /** Optional system instructions written as instructions.md in codexHome. */
  instructions?: string;
  /** URL the LLM proxy is listening on (e.g. "http://127.0.0.1:51234"). */
  llmProxyUrl: string;
  /** MCP bridge address (url + token) for tool invocation. */
  mcpBridge: McpBridgeAddress;
  /** Optional explicit path to @noma/mcp-tools dist/index.js. */
  mcpToolsBin?: string;
  /** Optional model metadata catalog for Codex context/tool behavior. */
  modelCatalog?: readonly CodexModelMetadata[];
};

export type CodexHandle = {
  bridge: AcpAgentBridge;
  stop: () => Promise<void>;
};

export type CodexModelMetadata = {
  id: string;
  label?: string;
  hint?: string;
  contextWindow?: number;
};

export async function startCodex(config: CodexConfig): Promise<CodexHandle> {
  const home = config.codexHome;
  mkdirSync(home, { recursive: true });

  const modelCatalogPath = writeModelCatalog(
    home,
    config.model,
    config.modelCatalog
  );
  const instructionsPath = config.instructions
    ? path.join(home, "instructions.md")
    : undefined;
  if (config.instructions) {
    writeFileSync(instructionsPath!, config.instructions);
  }
  writeConfigToml(
    home,
    config.model,
    config.llmProxyUrl,
    modelCatalogPath,
    instructionsPath
  );

  const mcpServerConfig = resolveMcpToolsConfig(
    config.mcpBridge,
    config.mcpToolsBin
  );
  console.log(home);
  const bridge = new AcpAgentBridge({
    command: config.binary,
    env: {
      CODEX_HOME: home,
      CODEX_API_KEY: "noma-bridge",
      OPENAI_API_KEY: "noma-bridge",
    },
    mcpServers: mcpServerConfig ? [mcpServerConfig] : [],
  });

  await bridge.start();

  return {
    bridge,
    stop: () => bridge.stop(),
  };
}

/**
 * Resolve the codex-acp binary. Checks:
 *   1. Explicit path (from caller)
 *   2. CODEX_BIN env var
 *   3. Optional packaged path (for Electron apps)
 *   4. npm-installed @zed-industries/codex-acp native binary
 *
 * Returns null if not found.
 */
export function resolveCodexBinary(
  explicitPath?: string,
  packagedPath?: string
): string | null {
  if (explicitPath && existsSync(explicitPath)) return explicitPath;
  const fromEnv = process.env.CODEX_BIN?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (packagedPath && existsSync(packagedPath)) return packagedPath;
  return resolveNpmBinary();
}

function resolveNpmBinary(): string | null {
  const platform = process.platform;
  const arch = process.arch;
  const binaryName = platform === "win32" ? "codex-acp.exe" : "codex-acp";
  const platformPkg = `@zed-industries/codex-acp-${platform}-${arch}`;
  try {
    const require = createRequire(import.meta.url);
    const mainPkgJson = require.resolve("@zed-industries/codex-acp/package.json");
    const require2 = createRequire(mainPkgJson);
    const platformPkgJson = require2.resolve(`${platformPkg}/package.json`);
    const bin = path.join(path.dirname(platformPkgJson), "bin", binaryName);
    if (existsSync(bin)) return bin;
  } catch {}
  return null;
}

/**
 * Locate the @noma/mcp-tools dist entry point relative to a reference
 * directory. Walks up to the workspace root looking for
 * packages/mcp-tools/dist/index.js.
 */
export function findMcpToolsBin(fromDir: string): string | null {
  let dir = path.resolve(fromDir);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "packages", "mcp-tools", "dist", "index.js");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function writeConfigToml(
  home: string,
  model: string,
  llmProxyUrl: string,
  modelCatalogPath: string,
  instructionsPath?: string
): void {
  const toml = `model = ${tomlString(model)}
model_provider = "noma"
model_catalog_json = ${tomlString(modelCatalogPath)}
${instructionsPath ? `model_instructions_file = ${tomlString(instructionsPath)}\n` : ""}

[model_providers.noma]
name = "Noma LLM Proxy"
base_url = ${tomlString(`${llmProxyUrl}/v1`)}
env_key = "OPENAI_API_KEY"
wire_api = "responses"
supports_websockets = false
`;
  writeFileSync(path.join(home, "config.toml"), toml);
}

function writeModelCatalog(
  home: string,
  selectedModel: string,
  modelCatalog?: readonly CodexModelMetadata[]
): string {
  const catalogPath = path.join(home, "model-catalog.json");
  const models = normalizeModelCatalog(selectedModel, modelCatalog);
  writeFileSync(
    catalogPath,
    `${JSON.stringify({ models: models.map(toCodexModelInfo) }, null, 2)}\n`
  );
  return catalogPath;
}

function normalizeModelCatalog(
  selectedModel: string,
  modelCatalog?: readonly CodexModelMetadata[]
): CodexModelMetadata[] {
  const byId = new Map<string, CodexModelMetadata>();
  for (const model of modelCatalog ?? []) {
    if (model.id) byId.set(model.id, model);
  }
  if (!byId.has(selectedModel)) {
    byId.set(selectedModel, {
      id: selectedModel,
      label: selectedModel,
      contextWindow: 1_000_000,
    });
  }
  return [...byId.values()];
}

function toCodexModelInfo(model: CodexModelMetadata): Record<string, unknown> {
  const contextWindow = model.contextWindow ?? 1_000_000;
  return {
    slug: model.id,
    display_name: model.label ?? model.id,
    description: model.hint ?? "Noma model",
    default_reasoning_level: "high",
    supported_reasoning_levels: [
      {
        effort: "low",
        description: "Fast responses with lighter reasoning",
      },
      {
        effort: "medium",
        description: "Balanced reasoning for general tasks",
      },
      {
        effort: "high",
        description: "Deeper reasoning for complex tasks",
      },
    ],
    shell_type: "default",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: "You are a helpful coding assistant.",
    model_messages: {
      instructions_template:
        "You are a helpful coding assistant.\n\n{{ personality }}",
      instructions_variables: {
        personality_default: "",
        personality_friendly: "Be friendly and concise.",
        personality_pragmatic: "Be direct, factual, and concise.",
      },
    },
    supports_reasoning_summaries: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    truncation_policy: {
      mode: "tokens",
      limit: contextWindow,
    },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    auto_compact_token_limit: Math.floor(contextWindow * 0.9),
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: false,
  };
}

function tomlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")}"`;
}

function resolveMcpToolsConfig(
  mcpAddr: McpBridgeAddress,
  explicitBin?: string
): AcpMcpServerConfig | null {
  const bin = explicitBin ?? process.env.NOMA_MCP_TOOLS_BIN?.trim();
  if (!bin || !existsSync(bin)) {
    console.warn(
      "[launcher] noma-mcp-tools not found; Codex will have no tool surface"
    );
    return null;
  }
  return {
    name: "noma",
    command: process.execPath,
    args: [bin],
    env: [
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      { name: "NOMA_BRIDGE_URL", value: mcpAddr.url },
      { name: "NOMA_BRIDGE_TOKEN", value: mcpAddr.token },
    ],
  };
}
