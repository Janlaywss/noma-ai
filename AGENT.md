# 全局 Agent 开发指南

本文档约束整个 Noma AI monorepo 的后续实现。所有子目录的 `agent.md` 可以补充本地规则，但不得违反本文件。

## 产品边界

- 这是一个桌面端 Agent，不是纯聊天客户端。用户对话、连接器事件、任务上下文都会驱动 Agent 决策。
- 事件处理 Agent 必须可以在用户不主动发消息时独立运行。
- 用户会话与多轮上下文由 ACP 托管，业务模块不得自建另一套会话消息存储。
- 会话内容、事件原文、任务推理上下文默认只保存在本地，不上传云端。
- 连接器是上下文输入和动作执行入口，不能把连接器逻辑散落在 UI 或事件 Agent 内部。

## 当前包边界

- `apps/desktop` 负责 Electron 桌面体验、本地宿主、IPC、通知、OAuth 接入和本地数据入口。
- `apps/server` 使用从 `/Users/janlay/noma-ai/apps/server` 拷贝的 Hono + Supabase 代码，负责 OAuth、OpenAI proxy 和通知通道，不成为会话数据中心。
- `apps/eval` 负责自动化评估和事件回放，不依赖真实用户数据。
- `packages/agent` 负责 ACP bridge、codex CLI 直接驱动（`CodexDirectBridge`）、LLM proxy 和 MCP bridge。
- `packages/event-agent` 负责事件 Agent 的运行时、prompt、工具协议和模型流处理。
- `packages/connector` 负责连接器 descriptor、runtime、调度、存储和内置连接器。
- `packages/shared` 负责共享模型、工具 schema、聊天协议和数据库类型。
- `packages/ui` 负责共享 UI 组件（Button、Tag、Badge、Switch 等），source-only 包，组件命名参照 Ant Design。
- `packages/mcp-tools` 负责以 MCP stdio 形式向 Codex 暴露桌面端工具。

## 数据规则

- 会话和消息持久化到本地 SQLite（`chat_sessions` / `chat_messages` 表），包括完整的 tool call 历史和 segment 顺序。Codex thread_id 也存在 session 记录里，用于跨重启 resume。
- ACP bridge 提供运行时能力（LLM 调用、MCP 工具），但不再是会话数据的唯一来源；本地 DB 是 UI 展示的 source of truth。
- 本地数据库只能保存实现任务所需的最小数据。敏感信息需要加密或使用系统 Keychain。
- 连接器存储必须按用户、连接器和任务隔离命名空间。
- 事件必须有去重键、来源、时间戳、任务绑定和权限上下文。
- 服务端不得持久化用户会话正文、事件原文或模型推理内容。

## Agent 决策规则

- 连接器事件**不直接推送**给用户。每条事件先经过 event-agent LLM 评估（`buildEventAnalysisPrompt`），只有 agent 调用 `notify` 时才发送 proactive message；agent 回复"忽略"则只入库、不打扰。
- 事件 Agent 输出必须是结构化决策，至少区分：忽略、通知、追问、执行动作、更新任务、升级到用户确认。
- 会造成外部副作用的动作需要经过权限策略；高风险动作默认要求用户确认。
- 事件分析要保留可审计摘要，但不能记录完整敏感载荷，除非用户明确允许。
- 对同一事件需要幂等处理，避免重复通知或重复执行。

## 实现约定

- 使用 TypeScript 作为主要实现语言。
- 使用 pnpm workspace 管理 app 与 package。
- 桌面端使用 Vite + React + Electron。
- 服务端使用 Hono + Supabase。
- 连接器运行时通过宿主注入的 `fetch`、`storage`、`emitEvent`、`log` 等能力与外部系统交互。
- 新增连接器前必须先定义 descriptor、权限范围、事件 schema、轮询/Webhook 策略和错误恢复策略。
- 新增跨包 API 时，优先放在领域所属包；只有被多个领域稳定复用时才放入 `packages/shared`。

## 验证规则

- 修改 workspace 结构或依赖后运行 `pnpm install`。
- 修改公共包后运行 `pnpm build`。
- 修改连接器后运行 `pnpm test:connector`。
- 修改桌面端后运行 `pnpm --filter @noma/desktop typecheck`。
- 修改服务端后运行 `pnpm --filter @noma/server typecheck`，必要时启动服务并访问 `/healthz`。
- 修改 ACP bridge、desktop 对话 UI、server OpenAI proxy 或 Electron 打包路径后运行 `pnpm smoke:desktop:acp`。

## 文档规则

- 重要架构变化必须同步更新根 `README.md`、[docs/architecture.md](/Users/janlay/noma-ai-repo/docs/architecture.md) 和相关子目录文档。
- 每个 app/package 的 README 说明用户视角和工程边界。
- 每个 app/package 的 `agent.md` 说明后续 Agent 在该目录内修改代码时必须遵守的规则。
