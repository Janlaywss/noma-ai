# @noma/mcp-tools

`packages/mcp-tools` 是 Codex ACP 可挂载的 MCP stdio 工具服务。Codex 通过它看到 Noma 的工具 schema，实际副作用再转发到桌面端本地 bridge。

## 职责

- 从 `@noma/shared/agent/tool-schemas` 加载工具 schema。
- 过滤不适合暴露给 Codex 的内部工具。
- 通过 MCP stdio 协议响应 `tools/list` 和 `tools/call`。
- 将工具调用转发到桌面端本地 HTTP bridge。

## 非职责

- 不直接写本地数据库。
- 不直接执行系统通知、任务调度或连接器动作。
- 不输出普通日志到 stdout，stdout 必须留给 MCP JSON-RPC。

## 命令

```bash
pnpm --filter @noma/mcp-tools build
pnpm --filter @noma/mcp-tools typecheck
pnpm --filter @noma/mcp-tools lint
```
