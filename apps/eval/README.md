# Eval App

`apps/eval` 用于自动化测试 Noma AI 的 Agent 行为、连接器事件处理和 ACP 集成。当前已落地 smoke eval：读取 `@noma/connector` 注册表，校验关键内置连接器存在，并验证 `@noma/event-agent` 的事件契约可被消费。

## 职责

- 回放连接器事件。
- 验证事件标准化、去重和 cursor 行为。
- 验证任务认领连接器后的生命周期。
- 验证事件 Agent 的结构化决策。
- 验证高风险动作确认门禁。
- 验证 ACP session 引用和多会话行为。

## 评估类型

```text
connector-normalization   # provider payload -> NormalizedConnectorEvent
connector-scheduler       # polling/webhook 调度、cursor、去重
task-claim                # 任务认领、暂停、恢复、释放连接器
event-decision            # 事件 Agent 输出结构化决策
action-policy             # 权限、确认、幂等与副作用控制
acp-integration           # ACP session 创建、引用与读取路径
```

## Fixture 规则

- 使用脱敏数据。
- 不提交真实 token、邮件正文、私有仓库内容或聊天记录。
- 每个 fixture 都要标注来源 connector、事件类型、预期决策和风险等级。
- 对时间敏感的 fixture 使用固定时钟。

## 开发命令

后续实现时保持命令入口：

```bash
pnpm --filter @noma/eval dev
pnpm --filter @noma/eval eval:main
pnpm --filter @noma/eval test
pnpm --filter @noma/eval lint
```

## 验收重点

- 同一 fixture 多次运行结果一致。
- 幂等事件不会重复触发动作。
- 高风险动作不会绕过用户确认。
- 事件 Agent 输出不符合 schema 时会失败，而不是被静默接受。
