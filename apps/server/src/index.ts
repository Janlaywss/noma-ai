import { spawn, type ChildProcess } from "node:child_process";
import { serve } from "@hono/node-server";
import app from "./app";

const port = Number(process.env.NOMA_SERVER_PORT ?? process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[server] listening on http://localhost:${info.port}`);
  startNgrok(info.port);
});

// ── ngrok tunnel ────────────────────────────────────────────

let ngrokProc: ChildProcess | null = null;

function startNgrok(port: number): void {
  const publicUrl = process.env.PUBLIC_URL;
  if (!publicUrl) {
    console.log("[ngrok] PUBLIC_URL not set, skipping tunnel");
    return;
  }

  let domain: string;
  try {
    domain = new URL(publicUrl).hostname;
  } catch {
    console.warn(`[ngrok] invalid PUBLIC_URL: ${publicUrl}`);
    return;
  }

  const args = ["http", String(port), "--domain", domain];
  console.log(`[ngrok] starting tunnel → ${publicUrl}`);

  ngrokProc = spawn("ngrok", args, { stdio: ["ignore", "pipe", "pipe"] });

  ngrokProc.stdout?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.log(`[ngrok] ${line}`);
  });
  ngrokProc.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.log(`[ngrok] ${line}`);
  });

  ngrokProc.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.warn(`[ngrok] exited with code ${code}`);
    }
    ngrokProc = null;
  });
}

function stopNgrok(): void {
  if (ngrokProc) {
    ngrokProc.kill("SIGTERM");
    ngrokProc = null;
  }
}

process.on("SIGINT", () => { stopNgrok(); process.exit(0); });
process.on("SIGTERM", () => { stopNgrok(); process.exit(0); });
