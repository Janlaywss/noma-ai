# Server Agent 指南

本文件约束 `apps/server` 内的后续修改。

## 必守边界

- 服务端代码来源是 `/Users/janlay/noma-ai/apps/server`。后续同步上游时，不要覆盖本目录 README、agent.md 和本仓库 workspace 配置。
- 服务端不保存用户 ACP 会话正文、连接器事件原文或任务推理上下文。
- 新增 API 前先确认它是否必须在云端运行；能在桌面端本地完成的逻辑不要放到服务端。
- Hono route 保持薄层，业务逻辑拆到明确模块。
- 登录注册和请求鉴权已移除；服务端必须使用 `NOMA_LOCAL_USER_ID` 手动限定 user_id 范围。
- 使用 admin Supabase client 的读写必须显式加 `user_id` 过滤，不能依赖 RLS 隔离。
- Supabase 业务表不应重新引入 `auth.users` 外键或 `auth.uid()` RLS 策略。
- Webhook relay 只能保存最小审计信息，不保存原始 payload。
- OpenAI proxy 可以转发模型请求，但不得记录完整用户对话内容。

## 安全规则

- 所有 OAuth callback 必须校验 state。
- Webhook 必须校验签名、时间戳和重放保护。
- 不在日志输出 token、cookie、authorization header、OAuth code。
- 对桌面端设备投递事件时，需要校验设备归属和授权状态。

## 接口规则

- API 响应使用稳定 JSON schema。
- 错误响应包含机器可读 `code` 和用户可读 `message`。
- 破坏性接口需要明确权限检查。
- 与桌面端共享的协议变更必须同步更新 `apps/desktop/README.md` 和相关类型定义。
- 共享模型、工具 schema 和通用类型优先从 `@noma/shared` 引入。
