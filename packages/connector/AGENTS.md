# @noma/connector — 编辑规则

先看 `README.md` 了解全貌。本文件是编辑约束。

## 硬性规则

1. **禁止宿主依赖。** 不得 import `electron`、`next`、`@noma/desktop`、`@noma/server`、`@noma/web`、任何 DB client 或 UI 框架。需要副作用就扩展 `ConnectorContext` / `ConnectorRuntimeHost` 接口，由宿主注入。

2. **测试全离线。** `tests/connectors/*.test.ts` 必须用 `installFetchMock`。真实网络走 `scripts/live-smoke.ts`。

3. **清理定时器。** 连接器在 `start()` 里起 `setInterval`，测试必须在 `afterEach` 调 `stop()`。泄漏的 interval 会卡死 vitest worker。

4. **不写废话注释。** 只在 why 不显然时加注释（变通方案、隐式约束、反直觉行为）。

## 约定

- `src/app/` 一个文件一个 descriptor，导出 `<name>Descriptor`，helper 不导出。
- `taskRequired` 字段由上游 agent 的 `addConnectorUsage` 强制执行，descriptor 只声明。
- 凭据字段标 `secret: true`。
- 优先实现 `updateConfig`；runtime 的 stop+restart 回退能用但会丢内存状态（cursor、刷新后的 token）。
- Identity 字段 = `taskRequired && type === "string" && !secret`。改动 identity 字段会导致实例分裂或碰撞。

## 改 runtime

四条路径：

1. 新实例 — `instanceKey` 无已有记录
2. 已有实例 + 同一 usage id — 幂等无操作
3. 已有实例 + 新 usage id — 聚合配置 → `updateConfig` 或 stop+restart
4. `removeUsage` — 最后一个 usage 移除时 stop，否则重新聚合

`tests/runtime.test.ts` 用 `makeFakeDescriptor` 覆盖全部路径。加新路径时同步扩展 fake 和测试。

## 改连接器 checklist

- [ ] 空凭据：`start()` 打 log 后正常返回，不抛异常
- [ ] 正常路径：emit 正确事件类型，包含 `title`、`sub` 及类型化字段
- [ ] HTTP 错误：打 warn，不从 `start()` 抛出
- [ ] 去重/游标：跨 poll 持久化，第二次 poll 不重复 emit
- [ ] `updateConfig`：`pollIntervalSec` 变化重置定时器；identity 字段变化由 runtime 处理
- [ ] 以上每项都有对应测试

## 改冒烟脚本

`scripts/live-smoke.ts` 只做单实例冒烟，不涉及 runtime 多租户。需要更复杂的场景另起脚本。

## 快速参考

| 文件 | 用途 |
|------|------|
| `vitest.config.ts` | `pool: "forks"`, `restoreMocks: true` |
| `tsconfig.json` | 构建（仅 src） |
| `tsconfig.test.json` | 类型检查（src + tests + scripts） |
| `tests/helpers/` | mock 工具集，通过 `index.ts` 统一导出 |
