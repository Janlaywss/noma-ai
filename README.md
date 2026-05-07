# Noma

[中文](./README.zh-CN.md)

**Local-first desktop agent that watches your world and acts on what matters.**

Noma connects to data sources (Gmail, financial news, etc.), monitors them in the background, and proactively notifies you when something needs your attention — all running locally on your machine.

![Chat view — agent creates a Gmail monitoring task](docs/screenshots/chat.png)

![Inbox — events from connectors with detail view](docs/screenshots/inbox.png)

## Features

- **Conversational task creation** — Tell the agent what to watch in natural language. It picks the right connectors and parameters automatically.
- **Connector ecosystem** — Built-in connectors for Gmail and Jin10 (financial news). The agent can also create custom connectors on the fly for any public API.
- **Event-driven notifications** — Connector events are evaluated by a lightweight LLM call. Only events that match your task's focus lens trigger notifications — the rest stay in the inbox silently.
- **Local-first architecture** — Sessions, messages, tasks, and events are stored in local SQLite. The server only handles OAuth, LLM proxy, and cross-device sync.
- **Frameless native UI** — Clean Electron app with dark/light themes and i18n (English + Chinese).

## Architecture

```
User ──► Desktop (Electron + React + SQLite)
           ├── Agent Bridge (codex exec)
           │     └── MCP Tools (scheduleTask, list_connectors, notify)
           ├── Connector Runtime
           │     ├── jin10 (financial news)
           │     ├── gmail (email monitoring)
           │     └── custom connectors (agent-created)
           └── Event Agent (LLM evaluates events → notify or skip)

Desktop ──► Server (Hono + Supabase)
              ├── LLM Proxy (OpenRouter → Claude/GPT/Gemini)
              ├── OAuth (Google for Gmail)
              └── Connector config storage
```

## Monorepo Structure

```
apps/
  desktop/       Vite + React + Electron
  server/        Hono + Supabase backend
  eval/          Automated agent & connector evaluation
packages/
  agent/         CodexDirectBridge, MCP bridge
  event-agent/   Event analysis prompt, tool protocol, runtime
  connector/     Connector descriptors, runtime, built-in connectors
  shared/        Shared types, model config, tool schemas
  mcp-tools/     MCP stdio tool server for Codex
  ui/            Shared UI components (Button, Tag, ConnectorIcon, etc.)
```

## Quick Start

### Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9
- **[Codex CLI](https://github.com/openai/codex)** — `npm i -g @openai/codex`
- **[ngrok](https://ngrok.com/)** — for OAuth callbacks (free tier works)
- **Supabase** project — [create one](https://supabase.com/dashboard)

### 1. Install & Build

```bash
git clone https://github.com/Janlaywss/noma-ai.git
cd noma-ai
pnpm install
pnpm build
```

### 2. Configure the Server

```bash
cp apps/server/.env.example apps/server/.env
```

Edit `apps/server/.env` with your credentials:

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Your Supabase project URL |
| `SUPABASE_SECRET_KEY` | Yes | Supabase service role key (bypasses RLS) |
| `OPENROUTER_API_KEY` | Yes | [OpenRouter](https://openrouter.ai/) API key for LLM access |
| `NOMA_AGENT_MODEL` | Optional | Main agent model (default: `anthropic/claude-sonnet-4-20250514`) |
| `NOMA_EVENT_MODEL` | Optional | Event evaluation model (default: `anthropic/claude-sonnet-4-20250514`) |
| `GOOGLE_CLIENT_ID` | For Gmail | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | For Gmail | Google OAuth client secret |
| `PUBLIC_URL` | For Gmail | Your ngrok domain, e.g. `https://your-app.ngrok-free.dev` |

### 3. Set Up the Database

Run the schema in your Supabase SQL Editor:

```sql
-- File: supabase/migrations/00000000000000_init.sql
-- Copy and execute the contents in your Supabase Dashboard → SQL Editor
```

### 4. Run

Start the server and desktop app in separate terminals:

```bash
# Terminal 1: Server
pnpm --filter @noma/server dev

# Terminal 2: Desktop
pnpm --filter @noma/desktop dev
```

The server automatically starts an ngrok tunnel if `PUBLIC_URL` is set.

## Connectors

| Connector | Type | Description |
|-----------|------|-------------|
| **jin10** | Financial news | Real-time Chinese financial news and market data |
| **gmail** | Email | Gmail monitoring via Google OAuth |

The agent can also create **custom connectors** at runtime for any public API — just describe what you want to monitor.

## Data & Privacy

- All conversations, tasks, and events are stored in **local SQLite** — nothing leaves your machine unless you configure server sync.
- Connector events are evaluated locally; only the LLM call goes through the server proxy.
- OAuth tokens are stored in local connector storage, not sent to third parties.
- The server does not store conversations, event payloads, or task reasoning context.

## Tech Stack

- **Desktop**: Electron + Vite + React + better-sqlite3
- **Server**: Hono + Supabase (Postgres)
- **Agent**: OpenAI Codex CLI + MCP protocol
- **LLM**: OpenRouter (Claude, GPT, Gemini, etc.)
- **Language**: TypeScript throughout

## License

MIT
