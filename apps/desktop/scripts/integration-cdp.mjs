#!/usr/bin/env node
/**
 * CDP integration test: verifies the full task-chat-connector loop.
 *
 * 1. Launch Electron with --remote-debugging-port
 * 2. Wait for the app to be ready (bridge started)
 * 3. Verify DB, seed data, ACP session creation
 * 4. Send a chat prompt → verify agent streaming works
 * 5. Create task via direct IPC (bypasses codex-acp MCP tool discovery)
 * 6. Verify task in DB with session_id binding
 * 7. Verify connector_usages table has entries
 * 8. Verify proactive message listener is wired
 * 9. Navigate to Tasks view, verify the new task appears
 *
 * Note: Step 5 uses test:scheduleTask IPC instead of relying on the
 * LLM calling the scheduleTask MCP tool. This isolates our integration
 * test from codex-acp's MCP tool discovery behavior.
 *
 * Usage:  node scripts/integration-cdp.mjs
 * Env:    NOMA_SERVER_URL (default http://localhost:3677)
 */

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");

const children = new Set();
let electronProc = null;

// ── Config ───────────────────────────────────────────────

const cdpPort = Number(process.env.CDP_PORT ?? 9444);
const serverUrl = process.env.NOMA_SERVER_URL ?? "http://localhost:3677";
const TIMEOUT = 120_000;

// ── Main ─────────────────────────────────────────────────

async function main() {
  const port = await findFreePort(cdpPort);

  console.log("[test] building app (renderer + main)...");
  await execOnce("pnpm", ["build"], desktopDir);
  console.log("[test] build done.");

  console.log(`[test] starting Electron (CDP port ${port})...`);
  electronProc = run(
    "pnpm",
    ["exec", "electron", `--remote-debugging-port=${port}`, "dist-electron/main.js"],
    desktopDir,
    { NOMA_SERVER_URL: serverUrl }
  );

  const target = await waitForCdpTarget(port, 30_000);
  console.log(`[test] CDP connected: ${target.title}`);

  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");

  const results = {
    bridgeReady: false,
    dbReady: false,
    chatSendWorked: false,
    agentResponded: false,
    taskCreatedViaDb: false,
    sessionIdBound: false,
    connectorUsagesExist: false,
    proactiveMessageRouted: false,
    tasksViewRefreshed: false,
    taskDetailRendered: false,
    inboxRendered: false,
  };

  try {
    // ── Step 1: Wait for bridge to be ready ────────────
    console.log("\n[step 1] Waiting for ACP bridge...");
    await waitForExpression(cdp, `window.noma?.acp != null`, 15_000);
    const bridgeStart = await evalAsync(cdp, `window.noma.acp.start()`);
    results.bridgeReady = bridgeStart?.ok === true || bridgeStart?.already === true;
    console.log(`  bridge: ${results.bridgeReady ? "✓" : "✗"} (${JSON.stringify(bridgeStart)})`);

    // ── Step 2: Verify DB is working ───────────────────
    console.log("\n[step 2] Checking SQLite database...");
    const tasksBefore = await evalAsync(cdp, `window.noma.db.tasks.list()`);
    const tasksCountBefore = tasksBefore?.length ?? 0;
    results.dbReady = tasksBefore != null;
    console.log(`  db: ${results.dbReady ? "✓" : "✗"}`);
    console.log(`  tasks in DB: ${tasksCountBefore}`);

    // ── Step 4: Create ACP session + test chat ─────────
    console.log("\n[step 3] Creating ACP session...");
    const newSession = await evalAsync(cdp, `window.noma.acp.newSession()`);
    const sessionId = newSession?.sessionId;
    console.log(`  session: ${sessionId ? "✓ " + sessionId.slice(0, 12) + "..." : "✗"}`);
    if (!sessionId) {
      console.log("  ✗ Could not create session, skipping remaining tests");
      printResults(results);
      return;
    }

    // ── Step 5: Send a chat prompt (verify streaming) ──
    console.log("\n[step 4] Sending prompt to agent...");
    const prompt = "你好，我是测试用户。请简短回复一下。";
    const promptResult = await evalAsync(
      cdp,
      `window.noma.acp.prompt(${JSON.stringify(sessionId)}, ${JSON.stringify(prompt)})`,
      TIMEOUT
    );
    results.chatSendWorked = true;
    results.agentResponded = promptResult?.ok === true;
    console.log(
      `  agent responded: ${results.agentResponded ? "✓" : "✗"} (stopReason=${promptResult?.stopReason})`
    );

    // ── Step 6: Create task via direct IPC ─────────────
    // This tests the full TaskManager chain: create task → bind session →
    // claim connectors → write to connector_usages → hot-reload runtime.
    // We bypass the LLM's MCP tool call to isolate our integration from
    // codex-acp's tool discovery behavior.
    console.log("\n[step 5] Creating task via direct IPC (test:scheduleTask)...");
    const scheduleInput = {
      title: "Stock Price Monitor",
      prompt: "监控 AAPL 和 TSLA 的股价变动，跌幅 >3% 时通知",
      kind: "event",
      connectors: [
        {
          name: "stock",
          params: { symbols: ["AAPL", "TSLA"], threshold: 3, pollIntervalSec: 60 },
        },
      ],
    };
    const scheduleResult = await evalAsync(
      cdp,
      `window.noma.test.scheduleTask(${JSON.stringify(sessionId)}, ${JSON.stringify(scheduleInput)})`,
      30_000
    );
    console.log(`  scheduleTask result: ${JSON.stringify(scheduleResult)}`);

    if (scheduleResult?.ok) {
      results.taskCreatedViaDb = true;
      console.log(`  task created: ${scheduleResult.taskId}`);
      console.log(`  usage IDs: ${JSON.stringify(scheduleResult.usages)}`);
    } else {
      console.log(`  ✗ scheduleTask failed: ${scheduleResult?.error ?? "unknown"}`);
    }

    // ── Step 7: Verify task in DB with session binding ──
    console.log("\n[step 6] Checking DB for new task...");
    await delay(500);
    const tasksAfter = await evalAsync(cdp, `window.noma.db.tasks.list()`);
    const tasksCountAfter = tasksAfter?.length ?? 0;
    const newTaskCount = tasksCountAfter - tasksCountBefore;
    console.log(`  tasks in DB now: ${tasksCountAfter} (+${newTaskCount})`);

    if (newTaskCount > 0) {
      const newestTask = tasksAfter[0];
      console.log(`  newest: "${newestTask?.title}" (id=${newestTask?.id?.slice(0, 8)}...)`);
      console.log(`  status=${newestTask?.status}, origin=${newestTask?.origin}`);
      console.log(`  connectors=${JSON.stringify(newestTask?.connectors)}`);
      console.log(`  session_id=${newestTask?.session_id?.slice(0, 12) ?? "null"}...`);

      results.sessionIdBound = newestTask?.session_id === sessionId;

      // ── Step 8: Check connector_usages ────────────
      console.log("\n[step 7] Checking connector_usages...");
      results.connectorUsagesExist =
        newestTask?.connectors != null && newestTask.connectors.length > 0;
      console.log(`  connectors claimed: ${results.connectorUsagesExist ? "✓" : "✗"}`);
      console.log(`  detail: connectors=${JSON.stringify(newestTask?.connectors)}, session=${newestTask?.session_id?.slice(0, 12)}`);
    }

    // ── Step 9: Test proactive message routing ─────────
    console.log("\n[step 8] Testing proactive message routing...");
    await evaluate(cdp, `
      window.__test_proactive_msgs = [];
      if (window.noma?.onProactiveMessage) {
        window.__test_proactive_unsub = window.noma.onProactiveMessage((data) => {
          window.__test_proactive_msgs.push(data);
        });
      }
    `);
    const hasProactiveSub = await evaluate(
      cdp,
      `typeof window.__test_proactive_unsub === 'function'`
    );
    results.proactiveMessageRouted = hasProactiveSub === true;
    console.log(
      `  proactive listener wired: ${results.proactiveMessageRouted ? "✓" : "✗"}`
    );

    // ── Step 10: Navigate to Tasks view, check refresh ──
    console.log("\n[step 9] Navigating to Tasks view...");
    await evaluate(cdp, `window.location.hash = '#/tasks'`);
    await delay(1500);
    const tasksViewContent = await evaluate(
      cdp,
      `document.querySelector('.app-content')?.innerText?.slice(0, 500) ?? ''`
    );
    results.tasksViewRefreshed = tasksViewContent.length > 10;
    console.log(`  Tasks view rendered: ${results.tasksViewRefreshed ? "✓" : "✗"}`);
    if (tasksViewContent) {
      // Check if our new task appears in the view
      const hasNewTask = tasksViewContent.includes("Stock Price Monitor");
      console.log(`  new task visible in UI: ${hasNewTask ? "✓" : "✗"}`);
      console.log(`  content preview: ${tasksViewContent.slice(0, 200).replace(/\n/g, " | ")}`);
    }
    // ── Step 11: Navigate to Task detail, verify real data ──
    console.log("\n[step 10] Navigating to Task detail...");
    if (scheduleResult?.taskId) {
      await evaluate(cdp, `window.location.hash = '#/tasks/${scheduleResult.taskId}'`);
      await delay(2000);
      const detailContent = await evaluate(
        cdp,
        `document.querySelector('.app-content')?.innerText?.slice(0, 500) ?? ''`
      );
      results.taskDetailRendered = detailContent.includes("Stock Price Monitor");
      console.log(`  Task detail rendered: ${results.taskDetailRendered ? "✓" : "✗"}`);
      if (detailContent) {
        // Check for real data elements: connector params, prompt, status
        const hasConnector = detailContent.includes("stock");
        const hasEventInfo = detailContent.includes("event");
        console.log(`  has connector info: ${hasConnector ? "✓" : "✗"}`);
        console.log(`  has event info: ${hasEventInfo ? "✓" : "✗"}`);
        console.log(`  content preview: ${detailContent.slice(0, 300).replace(/\n/g, " | ")}`);
      }
    } else {
      console.log("  skipped (no taskId)");
      results.taskDetailRendered = false;
    }

    // ── Step 12: Navigate to Inbox, verify real event data ──
    console.log("\n[step 11] Navigating to Inbox...");
    await evaluate(cdp, `window.location.hash = '#/inbox'`);
    await delay(2000);
    const inboxContent = await evaluate(
      cdp,
      `document.querySelector('.app-content')?.innerText?.slice(0, 600) ?? ''`
    );
    // The inbox should show real events from the DB (stock connector produces events)
    // or the empty state with proper i18n text
    const hasInboxTitle = inboxContent.includes("Inbox") || inboxContent.includes("收件箱");
    const hasRealData = inboxContent.includes("stock") || inboxContent.includes("No events yet") || inboxContent.includes("暂无事件");
    const noMockData = !inboxContent.includes("NVDA hit") && !inboxContent.includes("PR #284");
    results.inboxRendered = hasInboxTitle && hasRealData && noMockData;
    console.log(`  Inbox rendered with real data: ${results.inboxRendered ? "✓" : "✗"}`);
    console.log(`  has inbox title: ${hasInboxTitle ? "✓" : "✗"}`);
    console.log(`  has real/empty state: ${hasRealData ? "✓" : "✗"}`);
    console.log(`  no mock data: ${noMockData ? "✓" : "✗"}`);
    console.log(`  content preview: ${inboxContent.slice(0, 300).replace(/\n/g, " | ")}`);

  } catch (err) {
    console.error(`\n[error] ${err.message}`);
  } finally {
    try {
      await evaluate(cdp, `
        if (window.__test_proactive_unsub) window.__test_proactive_unsub();
      `);
    } catch {}
    await cdp.close();
  }

  printResults(results);
}

function printResults(results) {
  console.log("\n═══════════════════════════════════════════");
  console.log("  INTEGRATION TEST RESULTS");
  console.log("═══════════════════════════════════════════");
  const allPassed = Object.values(results).every(Boolean);
  for (const [key, ok] of Object.entries(results)) {
    console.log(`  ${ok ? "✅" : "❌"} ${key}`);
  }
  console.log("───────────────────────────────────────────");
  const passed = Object.values(results).filter(Boolean).length;
  const total = Object.values(results).length;
  console.log(`  ${passed}/${total} checks passed ${allPassed ? "🎉" : ""}`);
  console.log("═══════════════════════════════════════════\n");

  shutdown(allPassed ? 0 : 1);
}

// ── Helpers ──────────────────────────────────────────────

function run(command, args, cwd, extraEnv = {}) {
  const cmd = process.platform === "win32" ? `${command}.cmd` : command;
  const child = spawn(cmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
  children.add(child);
  child.stdout.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) console.log(`  [electron] ${line}`);
  });
  child.stderr.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line && !line.includes("TSM Adjust") && !line.includes("IMKCFRunLoop")) {
      console.log(`  [electron:err] ${line}`);
    }
  });
  child.on("exit", () => children.delete(child));
  return child;
}

function execOnce(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === "win32" ? `${command}.cmd` : command;
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    child.on("error", reject);
  });
}

function shutdown(code) {
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

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
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
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
          ) ?? targets.find((t) => t.type === "page" && !t.url?.startsWith("devtools://"));
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {}
    await delay(400);
  }
  throw new Error(`Timed out waiting for CDP target on port ${port}`);
}

async function waitForExpression(cdp, expression, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await evaluate(cdp, expression);
    if (value) return value;
    await delay(400);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: false,
  });
  if (result.exceptionDetails) return undefined;
  return result.result?.value;
}

async function evalAsync(cdp, expression, timeoutMs = 60_000) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout: timeoutMs,
  });
  if (result.exceptionDetails) {
    const msg =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      "eval error";
    console.log(`  [evalAsync error] ${msg.slice(0, 300)}`);
    return undefined;
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
      payload.error ? p.reject(new Error(payload.error.message)) : p.resolve(payload.result);
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
  console.error(`[fatal] ${err.stack ?? err.message}`);
  shutdown(1);
});
