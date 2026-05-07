# @noma/connector 编辑指南

本文件约束 `packages/connector` 内的后续修改。更细的历史规则见同目录 `AGENTS.md`。

## 必守边界

- 连接器不调用模型，不做最终业务决策。
- 连接器不得 import `electron`、`react`、`@noma/desktop`、`@noma/server`、DB client 或 UI 框架。
- 所有副作用通过宿主注入的 `ConnectorContext` / `ConnectorRuntimeHost` 完成。
- 测试默认全离线，真实网络只走 `scripts/live-smoke.ts`。
- 日志不得输出 token、cookie、OAuth code、refresh token。

## 新增连接器规则

- 先写 `ConnectorDescriptor`，再写 runtime 代码。
- 在 `src/registry.ts` 注册，在 `src/index.ts` 导出。
- 配置字段中凭据必须标记 `secret: true`。
- 轮询连接器必须实现去重、cursor 或等价水位。
- Webhook 连接器必须实现签名验证和重放保护。
- 同步补 `tests/connectors/<name>.test.ts` 和必要的 live smoke 配置。

## Runtime 规则

- 共享实例按 connector name 和 identity params 区分。
- `updateConfig` 优先于 stop+restart，避免丢失内存状态。
- `removeUsage` 移除最后一个 usage 时必须 stop 实例。
- 定时器必须在 `stop()` 中清理，避免 vitest worker 卡住。

## 验证

```bash
pnpm --filter @noma/connector build
pnpm --filter @noma/connector test
pnpm --filter @noma/connector test:live
```
