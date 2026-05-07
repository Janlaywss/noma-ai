# @noma/event-agent

`packages/event-agent` 是独立事件处理 Agent 的运行时基础。它定义 Agent 流事件、工具协议、prompt、ReAct 运行时和模型请求封装，供 server 的 OpenAI proxy 和后续 desktop 事件处理链路复用。

## 职责

- 定义 `AgentRunEvent`、`AgentToolSchema`、`AgentToolCall`、`AgentHooks` 等协议。
- 提供 prompt 组装能力。
- 处理 LLM streaming、SSE 解析和工具调用。
- 提供 ReAct/runtime 支撑事件分析与任务执行。
- 复用 `@noma/shared` 的模型、工具 schema 和共享类型。

## 非职责

- 不直接依赖 Electron renderer。
- 不直接启动连接器。
- 不保存 ACP 会话正文。
- 不直接写 Supabase 业务表。

## 主要文件

```text
src/types.ts          # Agent 事件、工具和 hook 协议
src/runtime.ts        # Agent runtime
src/llm-step.ts       # 单步 LLM 调用与工具协调
src/openai-request.ts # OpenAI-compatible 请求封装
src/sse-parser.ts     # SSE 解析
src/prompt/           # prompt 模块
```

## 命令

```bash
pnpm --filter @noma/event-agent build
pnpm --filter @noma/event-agent typecheck
pnpm --filter @noma/event-agent lint
```
