# @noma/shared

`packages/shared` 保存跨 app/package 共享的稳定协议和静态配置。

## 职责

- 模型列表、模型解析和模型展示元数据。
- 内置连接器元信息。
- Agent 工具 schema JSON。
- 聊天流协议和 adapter 类型。
- Supabase 类型。

## 边界

- 只放稳定共享内容，不放具体业务流程。
- 不依赖 Electron、Hono route、连接器 runtime 或 ACP bridge。
- 不保存密钥、用户数据或运行时状态。

## 命令

```bash
pnpm --filter @noma/shared build
pnpm --filter @noma/shared typecheck
pnpm --filter @noma/shared lint
```
