# Noma

[English](./README.md)

**本地优先的桌面 Agent，帮你盯着世界，只在重要时刻打扰你。**

Noma 连接各类数据源（Gmail、财经快讯等），在后台持续监控，当有值得关注的事件时主动通知你——一切都在你的本地机器上运行。

![对话视图 — Agent 自动创建 Gmail 监控任务](docs/screenshots/chat.png)

![收件箱 — 连接器事件及详情](docs/screenshots/inbox.png)

## 核心功能

- **自然语言创建任务** — 用对话告诉 Agent 你想盯什么，它会自动选择合适的连接器和参数。
- **连接器生态** — 内置 Gmail 和 Jin10（财经快讯）连接器。Agent 还能为任意公开 API 自动编写自定义连接器。
- **事件驱动通知** — 连接器事件由轻量 LLM 调用评估。只有匹配任务关注点的事件才会触发通知，其余静默入库。
- **本地优先架构** — 会话、消息、任务、事件全部存储在本地 SQLite。服务端只负责 OAuth、LLM 代理和跨设备同步。
- **原生无边框 UI** — 干净的 Electron 应用，支持明暗主题和中英双语。

## 架构

```
用户 ──► 桌面端 (Electron + React + SQLite)
           ├── Agent Bridge (codex exec)
           │     └── MCP 工具 (scheduleTask, list_connectors, notify)
           ├── 连接器运行时
           │     ├── jin10 (财经快讯)
           │     ├── gmail (邮件监控)
           │     └── 自定义连接器 (Agent 创建)
           └── 事件 Agent (LLM 评估事件 → 通知或忽略)

桌面端 ──► 服务端 (Hono + Supabase)
              ├── LLM 代理 (OpenRouter → Claude/GPT/Gemini)
              ├── OAuth (Google for Gmail)
              └── 连接器配置存储
```

## 仓库结构

```
apps/
  desktop/       Vite + React + Electron 桌面壳
  server/        Hono + Supabase 服务端
  eval/          自动化 Agent 与连接器评估
packages/
  agent/         CodexDirectBridge、MCP bridge
  event-agent/   事件分析 prompt、工具协议、运行时
  connector/     连接器 descriptor、runtime、内置连接器
  shared/        共享类型、模型配置、工具 schema
  mcp-tools/     供 Codex 挂载的 MCP stdio 工具服务
  ui/            共享 UI 组件 (Button, Tag, ConnectorIcon 等)
```

## 快速开始

### 前置条件

- **Node.js** >= 20
- **pnpm** >= 9
- **[Codex CLI](https://github.com/openai/codex)** — `npm i -g @openai/codex`
- **[ngrok](https://ngrok.com/)** — 用于 OAuth 回调（免费版即可）
- **Supabase** 项目 — [创建一个](https://supabase.com/dashboard)

### 1. 安装与构建

```bash
git clone https://github.com/Janlaywss/noma-ai.git
cd noma-ai
pnpm install
pnpm build
```

### 2. 配置服务端

```bash
cp apps/server/.env.example apps/server/.env
```

编辑 `apps/server/.env`，填入你的凭据：

| 变量 | 必填 | 说明 |
|------|------|------|
| `SUPABASE_URL` | 是 | Supabase 项目 URL |
| `SUPABASE_SECRET_KEY` | 是 | Supabase service role key |
| `OPENROUTER_API_KEY` | 是 | [OpenRouter](https://openrouter.ai/) API key |
| `NOMA_AGENT_MODEL` | 可选 | 主 Agent 模型（默认 `anthropic/claude-sonnet-4-20250514`） |
| `NOMA_EVENT_MODEL` | 可选 | 事件评估模型（默认 `anthropic/claude-sonnet-4-20250514`） |
| `GOOGLE_CLIENT_ID` | Gmail 需要 | Google OAuth 客户端 ID |
| `GOOGLE_CLIENT_SECRET` | Gmail 需要 | Google OAuth 客户端密钥 |
| `PUBLIC_URL` | Gmail 需要 | 你的 ngrok 域名，如 `https://your-app.ngrok-free.dev` |

### 3. 初始化数据库

在 Supabase SQL Editor 中执行 schema：

```sql
-- 文件：supabase/migrations/00000000000000_init.sql
-- 复制文件内容到 Supabase Dashboard → SQL Editor 中执行
```

### 4. 运行

在两个终端中分别启动服务端和桌面端：

```bash
# 终端 1：服务端
pnpm --filter @noma/server dev

# 终端 2：桌面端
pnpm --filter @noma/desktop dev
```

服务端在 `PUBLIC_URL` 设置后会自动启动 ngrok tunnel。

## 连接器

| 连接器 | 类型 | 说明 |
|--------|------|------|
| **jin10** | 财经快讯 | 实时中文财经新闻和市场数据 |
| **gmail** | 邮件 | 通过 Google OAuth 监控 Gmail |

Agent 还能在运行时为任意公开 API **自动创建连接器**——只需描述你想监控什么。

## 数据与隐私

- 所有对话、任务和事件存储在**本地 SQLite**——不配置服务端同步时数据不会离开你的机器。
- 连接器事件在本地评估，只有 LLM 调用走服务端代理。
- OAuth token 存储在本地连接器存储中，不发送给第三方。
- 服务端不保存对话内容、事件原文或任务推理上下文。

## 技术栈

- **桌面端**：Electron + Vite + React + better-sqlite3
- **服务端**：Hono + Supabase (Postgres)
- **Agent**：OpenAI Codex CLI + MCP 协议
- **LLM**：OpenRouter (Claude, GPT, Gemini 等)
- **语言**：全栈 TypeScript

## 许可证

MIT
