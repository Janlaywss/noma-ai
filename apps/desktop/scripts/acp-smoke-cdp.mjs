import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "../..");

const children = new Set();

async function main() {
  const serverPort = await findFreePort(Number(process.env.NOMA_ACP_SMOKE_SERVER_PORT ?? 3679));
  const cdpPort = await findFreePort(Number(process.env.NOMA_ACP_SMOKE_CDP_PORT ?? 9339));
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const codexHome =
    process.env.NOMA_ACP_SMOKE_CODEX_HOME ??
    path.join(os.tmpdir(), "noma-acp-smoke-codex-home");

  const server = run("pnpm", ["--filter", "@noma/server", "start"], repoRoot, {
    NOMA_SERVER_PORT: String(serverPort),
    PORT: String(serverPort),
  });
  await waitForHttp(`${serverUrl}/healthz`, 45_000);

  const electron = run(
    "pnpm",
    ["exec", "electron", `--remote-debugging-port=${cdpPort}`, "."],
    desktopDir,
    {
      NOMA_SERVER_URL: serverUrl,
      NOMA_WORKSPACE_DIR: repoRoot,
      NOMA_ACP_SMOKE_CODEX_HOME: codexHome,
    }
  );

  const target = await waitForCdpTarget(cdpPort, 45_000);
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  await waitForExpression(
    cdp,
    `Boolean(document.querySelector('[data-testid="run-acp-smoke"]'))`,
    45_000
  );
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-testid="run-acp-smoke"]').click()`,
    awaitPromise: true,
  });

  const status = await waitForSmokeStatus(cdp, 240_000);
  const report = await evaluate(cdp, "window.__NOMA_ACP_SMOKE_REPORT__");

  console.log(JSON.stringify({ status, report }, null, 2));
  if (status !== "passed") {
    throw new Error(report?.error ?? `ACP smoke failed with status ${status}`);
  }

  await cdp.close();
  shutdown(0);
}

function run(command, args, cwd, extraEnv) {
  const child = spawn(commandForPlatform(command), args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
  children.add(child);
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("exit", () => children.delete(child));
  return child;
}

function commandForPlatform(command) {
  return process.platform === "win32" ? `${command}.cmd` : command;
}

function shutdown(code) {
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250).unref();
}

async function findFreePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No free port found from ${start}`);
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function waitForHttp(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForCdpTarget(port, timeoutMs) {
  const startedAt = Date.now();
  const url = `http://127.0.0.1:${port}/json/list`;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const targets = await res.json();
        const page =
          targets.find(
            (target) =>
              target.type === "page" &&
              (target.title?.includes("Noma") ||
                target.url?.includes("index.html") ||
                target.url?.startsWith("http://127.0.0.1"))
          ) ??
          targets.find(
            (target) =>
              target.type === "page" && !target.url?.startsWith("devtools://")
          );
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {}
    await delay(300);
  }
  throw new Error(`Timed out waiting for CDP target on port ${port}`);
}

async function waitForExpression(cdp, expression, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await evaluate(cdp, expression);
    if (value) return value;
    await delay(300);
  }
  const location = await evaluate(cdp, "window.location.href").catch(() => "");
  const body = await evaluate(cdp, "document.body?.innerText?.slice(0, 1000)").catch(
    () => ""
  );
  throw new Error(
    `Timed out waiting for expression: ${expression}\nlocation=${location}\nbody=${body}`
  );
}

async function waitForSmokeStatus(cdp, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await evaluate(
      cdp,
      `document.querySelector('[data-testid="acp-smoke-root"]')?.getAttribute('data-smoke-status')`
    );
    if (status === "passed" || status === "failed") return status;
    await delay(500);
  }
  throw new Error("Timed out waiting for ACP smoke result");
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate failed");
  }
  return result.result?.value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CdpClient {
  static async connect(url) {
    if (typeof WebSocket !== "function") {
      throw new Error("This Node.js runtime does not provide global WebSocket");
    }
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new CdpClient(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      if (!payload.id) return;
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      this.pending.delete(payload.id);
      if (payload.error) {
        pending.reject(new Error(payload.error.message ?? "CDP error"));
      } else {
        pending.resolve(payload.result);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.ws.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  shutdown(1);
});
