# Server App

`apps/server` 是 Noma AI 的服务端应用，使用 Hono + Supabase。本目录代码已从 `/Users/janlay/noma-ai/apps/server` 拷贝接入，提供 OAuth、OpenAI proxy、连接器授权配置和通知通道能力。登录注册和用户请求鉴权已移除。

## 职责

- OAuth provider callback。
- 设备注册和授权状态同步。
- OpenAI-compatible 模型代理。
- 通知通道和 IM fan-out。
- 最小审计元数据，例如请求时间、provider、设备标识和投递状态。

## 非职责

- 不保存 ACP 会话正文。
- 不保存连接器事件原文。
- 不运行事件 Agent。
- 不作为连接器长期数据仓库。
- 不替代桌面端本地任务数据库。

## 推荐 API 分组

```text
/healthz                 # 健康检查
/api/channels/*          # Slack/Lark/Telegram 等通道
/api/entities/*          # 跨设备实体与观察
/api/session/*           # 服务端 session memory 兼容接口
/api/connectors/*        # 官方连接器配置与 OAuth
/api/channel-configs/*   # 通道配置
/api/settings/*          # 用户设置
/api/v1/*                # OpenAI-compatible proxy
/api/notifications/*     # 通知
```

## Supabase 使用边界

Supabase 可以保存：

- 设备记录。
- OAuth 授权状态。
- Webhook relay 的最小投递元数据。

Supabase 不保存：

- 用户对话。
- 事件 payload 原文。
- 任务推理上下文。
- 连接器 refresh token 的明文。

## Webhook Relay

Webhook relay 是可选能力，用于 provider 不能直接发送到桌面端的情况。

处理流程：

1. 接收 provider Webhook。
2. 验证签名、时间戳和重放保护。
3. 按设备或用户授权状态定位桌面端。
4. 短暂转发事件。
5. 记录最小投递状态。
6. 不持久化事件原文。

## 开发命令

后续实现时保持命令入口：

```bash
pnpm --filter @noma/server dev
pnpm --filter @noma/server build
pnpm --filter @noma/server typecheck
pnpm --filter @noma/server lint
```

默认读取 `apps/server/.env`。本地默认端口是 `3677`，如果被占用可临时执行：

```bash
PORT=3678 pnpm --filter @noma/server start
```

## Local User

`NOMA_LOCAL_USER_ID` 是服务端写入 Supabase 业务表时使用的固定本地用户 UUID。没有登录注册后，服务端不会从请求中解析用户身份；所有业务路由都使用该 UUID 做手动 `user_id` 范围过滤。

本地 smoke 没有真实用户时会回退到 `00000000-0000-0000-0000-000000000000`。业务表仍保留 `user_id` 字段用于范围过滤，但不再依赖 Supabase Auth 用户表。
