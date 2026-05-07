#!/usr/bin/env node
/**
 * CDP test for the Connector Config UI.
 *
 * Spawns the Noma server + Electron with remote debugging, navigates to the
 * connectors page, clicks into a connector detail, and asserts:
 *
 *   1. The connector grid renders with at least one connector card
 *   2. Clicking a connector shows the detail view with config section
 *   3. OAuth connectors (gmail) show a "Connect" button
 *   4. Credential connectors (github) show input fields + "Save" button
 *   5. No-auth connectors (weather) show "Ready to use" message
 *
 * Usage:
 *   node scripts/connector-config-cdp.mjs
 */

import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "../..");

const children = new Set();
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    testsPassed++;
    console.log(`  ✓ ${message}`);
  } else {
    testsFailed++;
    console.error(`  ✗ ${message}`);
  }
}

async function main() {
  const serverPort = await findFreePort(3681);
  const cdpPort = await findFreePort(9341);
  const serverUrl = `http://127.0.0.1:${serverPort}`;

  console.log(`[cdp-test] Starting server on :${serverPort}, CDP on :${cdpPort}`);

  const server = run("pnpm", ["--filter", "@noma/server", "start"], repoRoot, {
    NOMA_SERVER_PORT: String(serverPort),
    PORT: String(serverPort),
  });
  await waitForHttp(`${serverUrl}/healthz`, 45_000);
  console.log("[cdp-test] Server ready");

  const electron = run(
    "pnpm",
    ["exec", "electron", `--remote-debugging-port=${cdpPort}`, "."],
    desktopDir,
    {
      NOMA_SERVER_URL: serverUrl,
    }
  );

  const target = await waitForCdpTarget(cdpPort, 45_000);
  console.log("[cdp-test] Electron CDP target found");

  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  // Wait for the app to render
  await waitForExpression(cdp, `Boolean(document.querySelector('.app-shell'))`, 30_000);
  console.log("[cdp-test] App shell rendered\n");

  // ── Test 1: Navigate to connectors page ────────────────────

  console.log("Test suite: Connector Grid");

  // Navigate to connectors page (HashRouter: links are #/connectors)
  await evaluate(cdp, `window.location.hash = '#/connectors'`);

  // Wait for the connector grid to render (look for connector icons)
  await waitForExpression(
    cdp,
    `document.body.innerText.includes('GitHub') || document.body.innerText.includes('Weather')`,
    15_000
  );
  await delay(500);

  // Check that connector cards render
  const cardCount = await evaluate(cdp, `document.querySelectorAll('.card').length`);
  assert(cardCount > 0, `Connector grid renders cards (found ${cardCount})`);

  // Check for known connector names in the page text
  const pageText = await evaluate(cdp, `document.body.innerText`);
  assert(pageText.includes("GitHub"), "GitHub connector visible in grid");
  assert(pageText.includes("Gmail"), "Gmail connector visible in grid");

  // ── Test 2: Click into GitHub connector detail ─────────────

  console.log("\nTest suite: GitHub Connector (credential auth)");
  await evaluate(cdp, `
    const cards = [...document.querySelectorAll('.card')];
    const github = cards.find(c => c.innerText.includes('GitHub'));
    if (github) github.click();
  `);
  // Wait for detail to render (Back button appears)
  await waitForExpression(
    cdp,
    `[...document.querySelectorAll('button')].some(b => /Back|返回/.test(b.innerText))`,
    10_000
  );

  const detailText = await evaluate(cdp, `document.body.innerText`);
  assert(detailText.includes("GitHub"), "GitHub detail view renders");

  // Check for auth section with input fields
  const hasAuthSection = await evaluate(cdp, `
    document.body.innerText.includes('Authentication') || document.body.innerText.includes('认证授权')
  `);
  assert(hasAuthSection, "Auth section visible in detail view");

  // Check for credential input (token field)
  const inputCount = await evaluate(cdp, `
    document.querySelectorAll('.card input').length
  `);
  assert(inputCount > 0, `Credential input fields rendered (found ${inputCount})`);

  // Check for Save button
  const hasSaveBtn = await evaluate(cdp, `
    const btns = [...document.querySelectorAll('button')];
    btns.some(b => /Save|保存/.test(b.innerText));
  `);
  assert(hasSaveBtn, "Save button present for credential connector");

  // Go back to grid
  await evaluate(cdp, `
    const backBtn = [...document.querySelectorAll('button')].find(b => /Back|返回/.test(b.innerText));
    if (backBtn) backBtn.click();
  `);
  await waitForExpression(cdp, `document.body.innerText.includes('Gmail')`, 10_000);

  // ── Test 3: Click into Gmail connector detail ──────────────

  console.log("\nTest suite: Gmail Connector (OAuth auth)");
  try {
    // Go back to grid first
    await evaluate(cdp, `window.location.hash = '#/connectors'`);
    await waitForExpression(cdp, `document.body.innerText.includes('Gmail')`, 10_000);
    await delay(500);

    // Click Gmail card — must avoid matching text in other cards
    await evaluate(cdp, `
      void (() => {
        const cards = [...document.querySelectorAll('.card')];
        const gmail = cards.find(c => c.innerText.includes('Gmail'));
        if (gmail) gmail.click();
      })()
    `);
    await waitForExpression(
      cdp,
      `[...document.querySelectorAll('button')].some(b => /Back|返回/.test(b.innerText))`,
      10_000
    );

    const gmailText = await evaluate(cdp, `document.body.innerText`);
    assert(gmailText.includes("Gmail"), "Gmail detail view renders");

    // Check for Connect button (OAuth flow)
    const hasConnectBtn = await evaluate(cdp, `
      ([...document.querySelectorAll('button')].some(b => /Connect|连接/.test(b.innerText)))
    `);
    assert(hasConnectBtn, "Connect button present for OAuth connector");

    // Should NOT have text/password inputs (OAuth uses browser flow)
    const gmailInputs = await evaluate(cdp, `
      (() => {
        const cards = [...document.querySelectorAll('.card')];
        const authCard = cards.find(c =>
          c.innerText.includes('Authentication') || c.innerText.includes('认证授权')
        );
        return authCard ? authCard.querySelectorAll('input[type="text"], input[type="password"]').length : 0;
      })()
    `);
    assert(gmailInputs === 0, "No credential inputs for OAuth connector");
  } catch (err) {
    console.error(`  [gmail test error] ${err.message}`);
    testsFailed++;
  }

  // ── Test 4: Click into Weather connector (no auth) ─────────

  console.log("\nTest suite: Jin10 Connector (no auth required)");
  try {
    // Click the Back button to return to the grid
    await evaluate(cdp, `
      void (() => {
        const backBtn = [...document.querySelectorAll('button')].find(b => /Back|返回/.test(b.innerText));
        if (backBtn) backBtn.click();
      })()
    `);
    await waitForExpression(cdp, `document.body.innerText.includes('Jin10')`, 10_000);
    await delay(500);

    await evaluate(cdp, `
      void (() => {
        const cards = [...document.querySelectorAll('.card')];
        const jin10 = cards.find(c => c.innerText.includes('Jin10'));
        if (jin10) jin10.click();
      })()
    `);
    await waitForExpression(
      cdp,
      `[...document.querySelectorAll('button')].some(b => /Back|返回/.test(b.innerText))`,
      10_000
    );

    const jin10Text = await evaluate(cdp, `document.body.innerText`);
    const hasReadyMsg = jin10Text.includes("Ready to use") || jin10Text.includes("即开即用");
    assert(hasReadyMsg, "No-auth connector shows 'Ready to use' message");
  } catch (err) {
    console.error(`  [jin10 test error] ${err.message}`);
    testsFailed++;
  }

  // ── Summary ────────────────────────────────────────────────

  console.log(`\n─── Results: ${testsPassed} passed, ${testsFailed} failed ───`);
  await cdp.close();
  shutdown(testsFailed > 0 ? 1 : 0);
}

// ── Helpers (shared with acp-smoke-cdp.mjs) ─────────────────

function run(command, args, cwd, extraEnv) {
  const cmd = process.platform === "win32" ? `${command}.cmd` : command;
  const child = spawn(cmd, args, {
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

function shutdown(code) {
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
}

async function findFreePort(start) {
  for (let port = start; port < start + 100; port++) {
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
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForCdpTarget(port, timeoutMs) {
  const start = Date.now();
  const url = `http://127.0.0.1:${port}/json/list`;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const targets = await res.json();
        const page =
          targets.find(
            (t) =>
              t.type === "page" &&
              (t.title?.includes("Noma") ||
                t.url?.includes("index.html") ||
                t.url?.startsWith("http://127.0.0.1"))
          ) ??
          targets.find(
            (t) => t.type === "page" && !t.url?.startsWith("devtools://")
          );
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {}
    await delay(300);
  }
  throw new Error(`Timed out waiting for CDP target on port ${port}`);
}

async function waitForExpression(cdp, expression, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await evaluate(cdp, expression);
    if (value) return value;
    await delay(300);
  }
  const location = await evaluate(cdp, "window.location.href").catch(() => "?");
  const body = await evaluate(cdp, "document.body?.innerText?.slice(0, 800)").catch(() => "");
  throw new Error(
    `Timed out waiting for: ${expression}\nlocation=${location}\nbody=${body}`
  );
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const msg = details.exception?.description || details.text || "evaluate failed";
    throw new Error(`${msg}\n  expression: ${expression.slice(0, 120)}`);
  }
  return result.result?.value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CdpClient {
  static async connect(url) {
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
      const p = this.pending.get(payload.id);
      if (!p) return;
      this.pending.delete(payload.id);
      payload.error ? p.reject(new Error(payload.error.message ?? "CDP error")) : p.resolve(payload.result);
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
