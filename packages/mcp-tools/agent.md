# @noma/mcp-tools 编辑指南

本文件约束 `packages/mcp-tools` 内的后续修改。

## 必守边界

- stdout 只能输出 MCP 协议内容，日志写 stderr。
- 工具 schema 的单一来源是 `@noma/shared/agent/tool-schemas`。
- 不在本包内实现真实副作用，副作用必须转发到桌面端 bridge。
- bridge 地址和令牌必须来自环境变量或上层配置，不能硬编码。

## 修改工具暴露

- 隐藏工具要通过明确 allow/deny 规则处理。
- 新工具需要先更新 shared schema，再更新桌面端 bridge 实现。
- 错误响应必须是 MCP 客户端可读的结构化错误文本。

## 验证

```bash
pnpm --filter @noma/mcp-tools build
```
