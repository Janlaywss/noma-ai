# @noma/event-agent 编辑指南

本文件约束 `packages/event-agent` 内的后续修改。

## 必守边界

- 模型输出不可信，进入副作用执行前必须由上层做 schema、权限和风险校验。
- 本包只提供事件 Agent 运行时能力，不直接执行桌面端系统动作。
- 不记录完整敏感 payload，除非上层明确传入并要求持久化。
- 不引入 Electron、React、Hono route 或 Supabase client 作为核心依赖。

## 协议规则

- `AgentRunEvent` 是上层 UI、ACP bridge 和 eval 的稳定契约，新增 kind 必须兼容旧消费者。
- Tool schema 必须是模型可读、机器可校验的 JSON schema 子集。
- SSE parser 要容忍分片、空行和错误帧。
- prompt 改动要尽量可测试，避免把业务策略硬编码在不可复用文本中。

## 验证

```bash
pnpm --filter @noma/event-agent build
pnpm --filter @noma/eval eval:main
```
