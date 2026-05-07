# @noma/shared 编辑指南

本文件约束 `packages/shared` 内的后续修改。

## 必守边界

- 只有两个以上 app/package 都需要的稳定协议才放入本包。
- 不加入运行时副作用，不访问网络、文件系统、数据库或 Electron API。
- JSON schema 变更必须考虑 server、desktop、mcp-tools 和 eval 的兼容性。
- Supabase 类型更新要来自 schema 生成结果或明确迁移，不手写猜测字段。

## 验证

```bash
pnpm --filter @noma/shared build
pnpm --filter @noma/shared typecheck
```
