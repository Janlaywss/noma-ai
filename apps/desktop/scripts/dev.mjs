import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    if (!(key in process.env)) process.env[key] = trimmed.slice(eq + 1);
  }
}

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const explicitUrl = process.env.VITE_DEV_SERVER_URL;
const port = explicitUrl ? Number(new URL(explicitUrl).port) : await findFreePort(5173);
const url = explicitUrl ?? `http://127.0.0.1:${port}`;

const children = new Set();

function run(args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Vite dev server did not become ready: ${url}`);
}

function shutdown(code = 0) {
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

try {
  const vite = run([
    "exec",
    "vite",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ]);
  console.log(`[desktop] waiting for Vite at ${url}`);
  await waitForServer();
  const electron = run(["exec", "electron", ".", "--remote-debugging-port=9222"], {
    VITE_DEV_SERVER_URL: url,
    // Server manages its own ngrok tunnel now; desktop just needs the address.
    NOMA_SERVER_URL: process.env.NOMA_SERVER_URL ?? "http://localhost:3677",
  });
  electron.on("exit", (code) => {
    vite.kill("SIGTERM");
    process.exit(code ?? 0);
  });
} catch (err) {
  console.error(err);
  shutdown(1);
}

async function findFreePort(start) {
  for (let candidate = start; candidate < start + 100; candidate += 1) {
    if (await canListen(candidate)) return candidate;
  }
  throw new Error(`No free Vite port found from ${start}`);
}

function canListen(candidate) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(candidate, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}
