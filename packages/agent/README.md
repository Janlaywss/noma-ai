# @noma/agent

`packages/agent` 是 Noma AI 的 ACP 桥接包，负责把桌面端和 `codex-acp` / Codex CLI 连接起来。当前代码来自既有 Noma AI 工程，并已接入本 monorepo。

## 职责

- 通过 `@agentclientprotocol/sdk` 驱动 ACP 子进程。
- 读取 ACP `session/list` 作为会话列表来源。
- 通过 ACP `session/load` 回放会话 transcript。
- 发送 prompt 时可捕获原始 `session/update` transcript。
- 启动和管理 `codex-acp`。
- 写入 Codex home 下的模型配置、模型目录和系统指令。
- 挂载 `@noma/mcp-tools` 作为 Codex 可调用的 MCP 工具服务。
- 提供 LLM proxy 与 MCP bridge 辅助能力。

## 主要文件

```text
src/acp-bridge.ts   # ACP SDK 封装：start/newSession/listSessions/loadSessionTranscript/prompt
src/launcher.ts     # codex-acp 启动器、Codex 配置写入、binary 解析
src/llm-proxy.ts    # LLM proxy
src/mcp-bridge.ts   # 桌面端本地 MCP bridge 地址和令牌
src/index.ts        # 公共导出
```

## 边界

- 不保存 ACP 会话正文。
- 不直接实现连接器。
- 不直接依赖 Electron renderer。
- 不直接访问 Supabase。
- 不决定连接器事件的业务动作；事件决策放在 `@noma/event-agent` 和桌面端任务策略中。

## 命令

```bash
pnpm --filter @noma/agent build
pnpm --filter @noma/agent typecheck
pnpm --filter @noma/agent lint
```
